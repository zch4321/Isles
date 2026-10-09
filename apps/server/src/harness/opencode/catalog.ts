import type { Model } from '@isles/contracts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CachedCatalog, type CatalogSnapshot } from '../shared/catalog-cache.js';
import { OpenCodeClient, type OpenCodeClientFactory, type OpenCodeConnection } from './client.js';
import type { OpenCodeEnvironment } from './environment.js';
import { defaultModelResponseSchema, modelKey, modelsResponseSchema } from './protocol.js';

const providerLabels: Record<string, string> = {
  'opencode-go': 'Go（订阅）',
  opencode: 'Zen（按量）',
};

export class OpenCodeCatalog extends CachedCatalog {
  constructor(
    private environment: OpenCodeEnvironment,
    private factory: OpenCodeClientFactory = (...args) => new OpenCodeClient(...args),
  ) {
    super();
  }
  protected async fetch(): Promise<CatalogSnapshot> {
    let version: string | null = null;
    let client: OpenCodeConnection | undefined;
    try {
      const command = await this.environment.executable(true);
      version = command.version;
      const cwd = join(this.environment.workspace.dataDir, 'opencode-catalog');
      await this.environment.learnSecrets(cwd);
      await mkdir(cwd, { recursive: true });
      client = this.factory(
        command,
        cwd,
        this.environment.env,
        { exit: () => {} },
        this.environment.redactor,
        this.environment.log.child({ scope: 'catalog' }),
      );
      await client.start();
      await this.environment.learnCredentials(client);
      const query = `?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`;
      // Native integration.list waits for Plugin.awaitActivation in this exact location;
      // model.list itself returns an early snapshot while providers are still activating.
      await client.request('GET', `/api/integration${query}`);
      const catalog = modelsResponseSchema.parse(await client.request('GET', `/api/model${query}`));
      const selected = defaultModelResponseSchema.parse(
        await client.request('GET', `/api/model/default${query}`),
      ).data;
      const models: Model[] = catalog.data
        .filter((model) => model.enabled)
        .map((model) => ({
          id: modelKey(model),
          model: modelKey(model),
          displayName: `${providerLabels[model.providerID] ?? model.providerID} · ${model.name}`,
          description: modelKey(model),
          supportedReasoningEfforts: ['default', ...model.variants.map((variant) => variant.id)],
          defaultReasoningEffort: 'default',
          isDefault: selected !== undefined && modelKey(model) === modelKey(selected),
        }));
      const authenticated = models.length > 0;
      return {
        status: {
          available: true,
          authenticated,
          version,
          binaryPath: this.environment.binaryPath,
          error: authenticated
            ? null
            : 'OpenCode 暂无可用模型，请在原生 CLI 配置提供商或完成登录。',
        },
        models,
      };
    } catch (error) {
      this.environment.log.warn(
        { err: this.environment.redactor.text(error) },
        'OpenCode status check failed',
      );
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
