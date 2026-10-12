import type { ConfigManager } from '@isles/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import type { AgentRecord } from '../../storage/store.js';
import { AgentWorkspace, agentRoot, MCP_TOKEN_ENV } from '../../runtime/workspace.js';
import type { Logger } from '../../logging.js';
import type { CliExecutable } from '../shared/executable.js';
import { findDshExecutable } from './executable.js';

export interface DshSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}
export interface DshRuntime {
  args: string[];
  env: Record<string, string>;
}

/** Shared native configuration and login; one SDK runtime and workspace per Agent. */
export class DshEnvironment {
  readonly home: string;
  readonly log: Logger;
  private selected: CliExecutable | undefined;
  private discovery: Promise<CliExecutable> | undefined;
  constructor(
    readonly config: ConfigManager,
    readonly workspace: AgentWorkspace,
  ) {
    this.home = config.current.cli.dsh.home;
    this.log = workspace.log.child({ harness: 'dsh' });
  }
  get nativeHome() {
    return this.home;
  }
  get redactor() {
    return this.workspace.redactor;
  }
  get binaryPath() {
    return this.selected?.path ?? null;
  }
  configuration() {
    return this.config.cliConfiguration('dsh');
  }
  async configure(binaryPath: string | null) {
    const value = await this.config.configureCliBinary('dsh', binaryPath);
    this.invalidate();
    return value;
  }
  invalidate() {
    this.selected = undefined;
    this.discovery = undefined;
  }
  async executable(refresh = false) {
    if (refresh) this.invalidate();
    this.discovery ??= findDshExecutable({ binary: this.config.current.cli.dsh.binaryPath });
    const discovery = this.discovery;
    try {
      const command = await discovery;
      if (this.discovery === discovery) this.selected = command;
      return command;
    } catch (error) {
      if (this.discovery === discovery) this.discovery = undefined;
      throw error;
    }
  }
  private async yaml(path: string): Promise<unknown> {
    try {
      const document = parseDocument(await readFile(path, 'utf8'), { logLevel: 'silent' });
      if (document.errors.length) throw new Error(`无法解析 DSH 配置：${path}`);
      return document.toJS() as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async learnSecrets(cwd: string) {
    this.redactor.add(process.env);
    const credentials = await this.yaml(join(this.home, '.credentials.yaml'));
    // OAuth payloads use adapter-owned names such as access/refresh; collect their
    // values explicitly, without treating them as product settings or logging them.
    this.redactor.add({ token: credentials });
    for (const path of [
      join(this.home, 'cordis.patch.yml'),
      join(this.home, 'profiles/sdk/cordis.patch.yml'),
      join(this.home, 'profiles/desktop/cordis.patch.yml'),
    ])
      this.redactor.add(await this.yaml(path));
    for (const path of [join(this.home, '.env'), join(cwd, '.env')]) {
      try {
        const values: Record<string, string> = {};
        for (const line of (await readFile(path, 'utf8')).split('\n')) {
          const match = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(line);
          if (match) values[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
        }
        this.redactor.add(values);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  /** The Desktop profile owns its saved picker selection, independently of SDK defaults. */
  async desktopSelection(): Promise<DshSelection | undefined> {
    const patch = await this.yaml(join(this.home, 'profiles/desktop/cordis.patch.yml'));
    if (!Array.isArray(patch)) return;
    const entry = patch.find((row: unknown) => object(row)?.id === 'agent-default-model') as
      { config?: unknown } | undefined;
    const selection = object(entry?.config);
    if (typeof selection?.provider !== 'string' || typeof selection.model !== 'string') return;
    return {
      provider: selection.provider,
      model: selection.model,
      ...(typeof selection.reasoningEffort === 'string'
        ? { reasoningEffort: selection.reasoningEffort }
        : {}),
    };
  }
  async runtime(cwd: string, agent?: AgentRecord, baseUrl?: string): Promise<DshRuntime> {
    if (agent) await this.workspace.prepareWorkspace(agent);
    await this.learnSecrets(cwd);
    const dir = agent
      ? agentRoot(this.workspace.dataDir, agent)
      : join(this.workspace.dataDir, 'dsh-catalog');
    await mkdir(dir, { recursive: true });
    const inserted: Record<string, unknown>[] = [
      {
        id: 'isles-fs-shared',
        name: fileURLToPath(new URL('../../../resources/dsh-fs-shared.mjs', import.meta.url)),
        config: { cwd, sharedDir: this.workspace.sharedDir },
      },
      {
        id: 'isles-sandbox-shared',
        name: fileURLToPath(new URL('../../../resources/dsh-sandbox-shared.mjs', import.meta.url)),
        config: { sharedDir: this.workspace.sharedDir },
      },
      {
        id: 'isles-dsh-bridge',
        name: fileURLToPath(new URL('../../../resources/dsh-bridge.mjs', import.meta.url)),
        config: { sharedDir: this.workspace.sharedDir },
      },
      {
        id: 'isles-user-question-tool',
        name: '@deepseek-ai/dsh-tool-ask-user',
      },
    ];
    const env: Record<string, string> = { DSH_HOME: this.home };
    if (agent && baseUrl) {
      const token = await this.workspace.token(dir);
      env[MCP_TOKEN_ENV] = token;
      inserted.push({
        id: 'isles-mcp',
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          serverName: 'isles',
          transport: 'streamable-http',
          url: `${baseUrl}/mcp/${agent.id}`,
          headers: { Authorization: `Bearer ${token}` },
          failOnStartupError: true,
        },
      });
    }
    const patch = join(dir, 'dsh-overlay.json');
    // JSON is a YAML subset: the native --patch loader owns composition. Only
    // Isles-owned files contain this overlay; the native home stays user-owned.
    const permissions = agent?.dangerFullAccess ? 'danger-full-access' : 'workspace-write';
    const rows: Record<string, unknown>[] = [
      { id: 'sdk-jsonrpc-server', disabled: true },
      { id: 'sandbox-policy', config: { mode: permissions, workspaceRoot: cwd } },
      { id: 'approval', config: { policy: agent?.dangerFullAccess ? 'never' : 'ask' } },
      {
        id: 'permission',
        config: {
          defaultPreset: permissions,
          presets: {
            'read-only': { sandbox: 'read-only', approval: 'ask' },
            'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
            'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
          },
        },
      },
      // Native patch names assert the existing plugin identity; they cannot
      // replace it. Disable the originals and insert the shared providers.
      { id: 'fs-sandbox', disabled: true },
      { id: 'sandbox', disabled: true },
      { insert: inserted },
    ];
    await writeFile(patch, JSON.stringify(rows), { mode: 0o600 });
    return { args: ['--profile', 'sdk', '--patch', patch], env };
  }
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
