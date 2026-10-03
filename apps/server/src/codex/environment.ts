import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigManager } from '@isles/config';
import { parse } from 'smol-toml';
import { findCodexExecutable, type CodexExecutable } from './executable.js';
import type { AgentRecord } from '../storage/store.js';
import { AgentWorkspace, agentRoot, MCP_TOKEN_ENV } from '../runtime/workspace.js';

export class NativeEnvironment {
  private discovery: Promise<CodexExecutable> | undefined;
  private selected: CodexExecutable | undefined;
  /**
   * The human's own Codex home. Every Agent runs in it, sharing configuration, login,
   * plugins and long-term memories; each keeps its own thread, so context is never shared.
   */
  readonly home: string;
  constructor(
    readonly config: ConfigManager,
    readonly workspace: AgentWorkspace,
  ) {
    this.home = config.current.codexHome;
  }
  get redactor() {
    return this.workspace.redactor;
  }
  invalidate() {
    this.discovery = undefined;
    this.selected = undefined;
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
    this.invalidate();
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
    await this.workspace.prepareWorkspace(agent);
    await this.learnSecrets();
    return {
      CODEX_HOME: this.home,
      [MCP_TOKEN_ENV]: await this.workspace.token(agentRoot(this.workspace.dataDir, agent)),
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
