import type { ConfigManager } from '@isles/config';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import type { AgentRecord } from '../../storage/store.js';
import { AgentWorkspace, agentRoot, MCP_TOKEN_ENV } from '../../runtime/workspace.js';
import type { Logger } from '../../logging.js';
import type { CliExecutable } from '../shared/executable.js';
import type { OpenCodeConnection } from './client.js';
import { findOpenCodeExecutable } from './executable.js';
import { credentialsResponseSchema } from './protocol.js';

/** Native config and login database remain shared; each Agent owns its server and Session. */
export class OpenCodeEnvironment {
  readonly home: string;
  readonly nativeHome: string;
  readonly log: Logger;
  private selected: CliExecutable | undefined;
  private discovery: Promise<CliExecutable> | undefined;
  constructor(
    readonly config: ConfigManager,
    readonly workspace: AgentWorkspace,
  ) {
    this.home = config.current.cli.opencode.home;
    this.nativeHome = config.current.cli.opencode.databasePath!;
    this.log = workspace.log.child({ harness: 'opencode' });
  }
  get redactor() {
    return this.workspace.redactor;
  }
  get binaryPath() {
    return this.selected?.path ?? null;
  }
  get env(): Record<string, string> {
    return { OPENCODE_CONFIG_DIR: this.home, OPENCODE_DB: this.nativeHome };
  }
  configuration() {
    return this.config.cliConfiguration('opencode');
  }
  async configure(binaryPath: string | null) {
    const value = await this.config.configureCliBinary('opencode', binaryPath);
    this.invalidate();
    return value;
  }
  invalidate() {
    this.discovery = undefined;
    this.selected = undefined;
  }
  async executable(refresh = false) {
    if (refresh) this.invalidate();
    this.discovery ??= findOpenCodeExecutable({
      binary: this.config.current.cli.opencode.binaryPath,
    });
    const discovery = this.discovery;
    try {
      const result = await discovery;
      if (this.discovery === discovery) this.selected = result;
      return result;
    } catch (error) {
      if (this.discovery === discovery) this.discovery = undefined;
      throw error;
    }
  }
  async learnSecrets(cwd = process.cwd()) {
    this.redactor.add(process.env);
    const files = [join(this.home, 'opencode.json'), join(this.home, 'opencode.jsonc')];
    if (process.env.OPENCODE_CONFIG) files.push(resolve(cwd, process.env.OPENCODE_CONFIG));
    for (const file of new Set(files)) {
      try {
        this.redactor.add(readConfig(await readFile(file, 'utf8'), file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (process.env.OPENCODE_CONFIG_CONTENT)
      this.redactor.add(readConfig(process.env.OPENCODE_CONFIG_CONTENT, 'OPENCODE_CONFIG_CONTENT'));
  }
  /** Read-only secret discovery through the native API; values are used solely for redaction. */
  async learnCredentials(client: OpenCodeConnection) {
    const response = credentialsResponseSchema.parse(
      await client.request('GET', '/api/credential'),
    );
    for (const credential of response.data) this.redactor.add({ token: credential.value });
  }
  async prepare(agent: AgentRecord, baseUrl: string): Promise<Record<string, string>> {
    await this.workspace.prepareWorkspace(agent);
    await this.learnSecrets(agent.workspace);
    const token = await this.workspace.token(agentRoot(this.workspace.dataDir, agent));
    this.redactor.add({ token });
    const content = process.env.OPENCODE_CONFIG_CONTENT
      ? readConfig(process.env.OPENCODE_CONFIG_CONTENT, 'OPENCODE_CONFIG_CONTENT')
      : {};
    const mcp = object(content.mcp);
    return {
      ...this.env,
      [MCP_TOKEN_ENV]: token,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...content,
        mcp: {
          ...mcp,
          servers: {
            ...object(mcp.servers),
            isles: {
              type: 'remote',
              url: `${baseUrl}/mcp/${agent.id}`,
              headers: { Authorization: `Bearer ${token}` },
              oauth: false,
              timeout: { startup: 20_000, execution: 60_000 },
            },
          },
        },
      }),
    };
  }
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function readConfig(text: string, source: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`无法解析 OpenCode 配置：${source}`);
  return value as Record<string, unknown>;
}
