import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigManager } from '@isles/config';
import { parse } from 'smol-toml';
import { findCodexExecutable, type CodexExecutable } from './executable.js';
import { Redactor } from '../errors.js';
import type { AgentRecord } from '../storage/store.js';
import { prepareGuidance } from '../runtime/guidance.js';

/** Environment variable the native MCP client reads the Agent's bearer token from. */
export const MCP_TOKEN_ENV = 'ISLES_MCP_TOKEN';
/** Agent credentials belong to application data, independently of working files. */
export const agentRoot = (dataDir: string, agent: Pick<AgentRecord, 'id'>) =>
  join(dataDir, 'agents', agent.id);

export class NativeEnvironment {
  private discovery: Promise<CodexExecutable> | undefined;
  private selected: CodexExecutable | undefined;
  /**
   * The human's own Codex home. Every Agent runs in it, sharing configuration, login,
   * plugins and long-term memories; each keeps its own thread, so context is never shared.
   */
  readonly home: string;
  readonly dataDir: string;
  readonly sharedDir: string;
  readonly redactor = new Redactor();
  constructor(readonly config: ConfigManager) {
    this.home = config.current.codexHome;
    this.dataDir = config.current.dataDir;
    this.sharedDir = config.current.sharedDir;
  }
  async version() {
    return (await this.executable(true)).version;
  }
  get binaryPath() {
    return this.selected?.path ?? null;
  }
  configuration() {
    return this.config.codexConfiguration();
  }
  async configure(binaryPath: string | null) {
    const configuration = await this.config.configureCodexBinary(binaryPath);
    this.discovery = undefined;
    this.selected = undefined;
    return configuration;
  }
  async executable(refresh = false): Promise<CodexExecutable> {
    if (refresh) {
      this.discovery = undefined;
      this.selected = undefined;
    }
    if (!this.discovery) {
      this.discovery = findCodexExecutable({ binary: this.config.current.codexBinaryPath });
    }
    const discovery = this.discovery;
    try {
      const executable = await discovery;
      if (this.discovery === discovery) this.selected = executable;
      return executable;
    } catch (error) {
      if (this.discovery === discovery) this.discovery = undefined;
      throw error;
    }
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
  async prepareWorkspace(agent: AgentRecord) {
    await mkdir(agent.workspace, { recursive: true });
    await mkdir(this.sharedDir, { recursive: true });
    await writeFile(join(agent.workspace, '.isles-root'), 'Isles Agent workspace\n');
    await prepareGuidance(agent, this.sharedDir);
  }
  /** Prepares the workspace and returns the environment of the Agent's native process. */
  async launch(agent: AgentRecord): Promise<Record<string, string>> {
    await this.prepareWorkspace(agent);
    await this.learnSecrets();
    return {
      CODEX_HOME: this.home,
      [MCP_TOKEN_ENV]: await this.token(agentRoot(this.dataDir, agent)),
    };
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
