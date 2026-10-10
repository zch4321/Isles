import type { ConfigManager } from '@isles/config';
import type { HarnessDescriptor } from '@isles/contracts';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { agentRoot, type AgentWorkspace } from '../../runtime/workspace.js';
import type { AgentRecord } from '../../storage/store.js';
import { KimiEnvironment } from './environment.js';

const mcpConfigSchema = z
  .object({ mcpServers: z.record(z.string(), z.unknown()).optional() })
  .passthrough();

/** Shares native settings and login; Isles MCP configuration belongs to each workspace. */
export class KimiWebEnvironment {
  readonly descriptor: HarnessDescriptor = {
    id: 'kimi',
    displayName: 'Kimi Code',
    configuration: 'cli-path',
    capabilities: {
      sessionResume: true,
      interrupt: true,
      steer: true,
      userQuestions: true,
      nativeSubagents: true,
      mcp: true,
      workspaceInstructions: true,
    },
  };
  private readonly native: KimiEnvironment;
  constructor(
    readonly config: ConfigManager,
    readonly workspace: AgentWorkspace,
  ) {
    this.native = new KimiEnvironment(config, workspace);
  }
  get home() {
    return this.native.home;
  }
  get log() {
    return this.native.log;
  }
  get redactor() {
    return this.native.redactor;
  }
  get dataDir() {
    return this.native.dataDir;
  }
  get env() {
    return this.native.env;
  }
  get binaryPath() {
    return this.native.binaryPath;
  }
  executable(refresh = false) {
    return this.native.executable(refresh);
  }
  invalidate() {
    this.native.invalidate();
  }
  learnSecrets() {
    return this.native.learnSecrets();
  }

  async prepare(agent: AgentRecord, baseUrl: string): Promise<Record<string, string>> {
    await this.workspace.prepareWorkspace(agent);
    const token = await this.workspace.token(agentRoot(this.dataDir, agent));
    const dir = join(agent.workspace, '.kimi-code');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'mcp.json');
    let config: z.infer<typeof mcpConfigSchema> = {};
    try {
      config = mcpConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(`无法读取 Kimi Code 工作区 MCP 配置：${path}`, { cause: error });
    }
    const next = {
      ...config,
      mcpServers: {
        ...config.mcpServers,
        isles: { url: `${baseUrl}/mcp/${agent.id}`, bearerTokenEnvVar: 'ISLES_KIMI_MCP_TOKEN' },
      },
    };
    const temporary = join(dir, `.mcp.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return { ...this.env, ISLES_KIMI_MCP_TOKEN: token };
  }
}
