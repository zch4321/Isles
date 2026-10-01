import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'smol-toml';
import { Redactor } from '../errors.js';
import type { AgentRecord } from '../storage/store.js';

export interface NativeOptions {
  binary?: string;
  home?: string;
}
/** Environment variable the native MCP client reads the Agent's bearer token from. */
export const MCP_TOKEN_ENV = 'ISLES_MCP_TOKEN';
/** The Isles-owned directory of an Agent, holding its workspace and MCP token. */
export const agentRoot = (agent: Pick<AgentRecord, 'workspace'>) => dirname(agent.workspace);

const exec = promisify(execFile);
export class NativeEnvironment {
  readonly binary: string;
  /**
   * The human's own Codex home. Every Agent runs in it, sharing configuration, login,
   * plugins and long-term memories; each keeps its own thread, so context is never shared.
   */
  readonly home: string;
  readonly redactor = new Redactor();
  constructor(options: NativeOptions = {}) {
    this.binary = options.binary ?? process.env.ISLES_CODEX_BIN ?? 'codex';
    this.home = resolve(
      options.home ??
        process.env.ISLES_CODEX_HOME ??
        process.env.CODEX_HOME ??
        join(homedir(), '.codex'),
    );
  }
  async version() {
    return (await exec(this.binary, ['--version'], { timeout: 10_000 })).stdout.trim();
  }
  private async privateFile(path: string, body: string) {
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }
  async token(dir: string): Promise<string> {
    const path = join(dir, 'isles-mcp-token');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let token: string;
    try {
      token = (await readFile(path, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      token = randomBytes(32).toString('hex');
      await this.privateFile(path, token);
    }
    this.redactor.add(token);
    return token;
  }
  /**
   * Native errors and tool output may echo credentials from the shared home. They are
   * read only to scrub them; nothing in the home is copied or written.
   */
  async learnSecrets() {
    for (const [file, read] of [
      ['auth.json', JSON.parse],
      ['config.toml', parse],
    ] as const) {
      let value: unknown;
      try {
        value = read(await readFile(join(this.home, file), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error(`无法读取原生 Codex ${file}`, { cause: error });
      }
      this.redactor.add(value);
      const providers = (value as { model_providers?: Record<string, { env_key?: unknown }> })
        .model_providers;
      for (const provider of Object.values(providers ?? {}))
        if (typeof provider?.env_key === 'string') this.redactor.add(process.env[provider.env_key]);
    }
  }
  /** Prepares the workspace and returns the environment of the Agent's native process. */
  async launch(agent: AgentRecord): Promise<Record<string, string>> {
    await mkdir(agent.workspace, { recursive: true });
    await writeFile(join(agent.workspace, '.isles-root'), 'Isles Agent workspace\n');
    await this.learnSecrets();
    return { CODEX_HOME: this.home, [MCP_TOKEN_ENV]: await this.token(agentRoot(agent)) };
  }
  /**
   * Settings layered over the shared config for one Agent's thread. Dotted keys override
   * single entries, so the human's own MCP servers and features stay as configured.
   */
  threadConfig(agent: AgentRecord, baseUrl: string) {
    return {
      'mcp_servers.isles': {
        url: `${baseUrl}/mcp/${agent.id}`,
        bearer_token_env_var: MCP_TOKEN_ENV,
        startup_timeout_sec: 20,
        tool_timeout_sec: 60,
      },
      // Stop project discovery at the workspace instead of the enclosing Isles repository.
      project_root_markers: ['.isles-root', '.git'],
      // Trusted for this thread only, so Codex does not record the workspace in config.toml.
      projects: { [agent.workspace]: { trust_level: 'trusted' } },
    };
  }
}
