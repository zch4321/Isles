import type { Model } from '@isles/contracts';
import { z } from 'zod';
import { mkdir } from 'node:fs/promises';
import { CachedCatalog, type CatalogSnapshot } from '../harness/catalog-cache.js';
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

export class ClaudeCatalog extends CachedCatalog {
  constructor(private environment: ClaudeEnvironment) {
    super();
  }
  protected async fetch(): Promise<CatalogSnapshot> {
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
        this.environment.log.child({ scope: 'catalog' }),
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
      this.environment.log.warn({ err: error }, 'Claude Code status check failed');
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
}
