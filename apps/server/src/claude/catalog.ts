import type { HarnessStatus, Model } from '@isles/contracts';
import { z } from 'zod';
import { mkdir } from 'node:fs/promises';
import type { HarnessCatalog } from '../harness/types.js';
import { ClaudeClient } from './client.js';
import type { ClaudeEnvironment } from './environment.js';

const catalogSchema = z.object({
  models: z.array(
    z.object({
      value: z.string().min(1),
      displayName: z.string(),
      description: z.string().optional(),
      supportsEffort: z.boolean().optional(),
      supportedEffortLevels: z.array(z.string().min(1)).optional(),
    }),
  ),
});

export class ClaudeCatalog implements HarnessCatalog {
  private cache: { status: HarnessStatus; models: Model[]; time: number } | undefined;
  private fetching: Promise<{ status: HarnessStatus; models: Model[] }> | undefined;
  private revision = 0;
  constructor(private environment: ClaudeEnvironment) {}
  invalidate() {
    this.cache = undefined;
    this.fetching = undefined;
    this.revision++;
  }
  private async read() {
    if (this.cache && Date.now() - this.cache.time < 30_000) return this.cache;
    if (this.fetching) return this.fetching;
    const revision = this.revision;
    const fetching = this.fetch();
    this.fetching = fetching;
    try {
      const value = await fetching;
      if (revision === this.revision) this.cache = { ...value, time: Date.now() };
      return value;
    } finally {
      if (this.fetching === fetching) this.fetching = undefined;
    }
  }
  private async fetch() {
    let version: string | null = null;
    let client: ClaudeClient | undefined;
    try {
      const command = await this.environment.executable(true);
      version = command.version;
      await this.environment.learnSecrets();
      const authenticated = await this.environment.authentication(command);
      await mkdir(this.environment.workspace.dataDir, { recursive: true });
      client = new ClaudeClient(
        command,
        [],
        this.environment.workspace.dataDir,
        this.environment.env,
        {
          event: () => {},
          cancel: () => {},
          exit: () => {},
          request: (id) => client?.reject(id, 'Catalog does not accept interactive requests'),
        },
        this.environment.redactor,
      );
      const catalog = catalogSchema.parse(await client.control('initialize', { hooks: null }));
      const models: Model[] = catalog.models.map((model, index) => ({
        id: model.value,
        model: model.value,
        displayName: model.displayName,
        description: model.description ?? '',
        supportedReasoningEfforts: [
          'default',
          ...(model.supportsEffort ? (model.supportedEffortLevels ?? []) : []),
        ],
        defaultReasoningEffort: 'default',
        isDefault:
          model.value === 'default' ||
          (index === 0 && !catalog.models.some((m) => m.value === 'default')),
      }));
      return {
        status: {
          available: true,
          authenticated,
          version,
          binaryPath: this.environment.binaryPath,
          error: authenticated ? null : '本机 Claude Code 尚未认证，请先在原生 CLI 完成登录。',
        },
        models,
      };
    } catch (error) {
      return {
        status: {
          available: false,
          authenticated: false,
          version,
          binaryPath: this.environment.binaryPath,
          error: this.environment.redactor.text(error),
        },
        models: [],
      };
    } finally {
      await client?.close();
    }
  }
  async status() {
    return (await this.read()).status;
  }
  async models() {
    return (await this.read()).models;
  }
}
