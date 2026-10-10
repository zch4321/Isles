import type { Model } from '@isles/contracts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CachedCatalog, type CatalogSnapshot } from '../shared/catalog-cache.js';
import { KimiWebClient, type KimiWebClientFactory, type KimiWebConnection } from './web-client.js';
import type { KimiWebEnvironment } from './web-environment.js';

const modelsSchema = z.object({
  items: z.array(
    z.object({
      provider: z.string(),
      model: z.string().min(1),
      display_name: z.string().optional(),
      capabilities: z.array(z.string()).optional(),
      support_efforts: z.array(z.string()).optional(),
      default_effort: z.string().optional(),
    }),
  ),
});
const configSchema = z.object({ default_model: z.string().optional() });
const authSchema = z.object({
  models_ready: z.boolean(),
  managed_provider: z.object({ name: z.string(), status: z.string() }).nullable(),
});

/** Reads native model metadata without creating a session or sending a prompt. */
export class KimiWebCatalog extends CachedCatalog {
  constructor(
    private environment: KimiWebEnvironment,
    private factory: KimiWebClientFactory = (...args) => new KimiWebClient(...args),
  ) {
    super();
  }

  protected async fetch(): Promise<CatalogSnapshot> {
    let version: string | null = null;
    let client: KimiWebConnection | undefined;
    try {
      const command = await this.environment.executable(true);
      version = command.version;
      await this.environment.learnSecrets();
      const cwd = join(this.environment.dataDir, 'kimi-web-catalog');
      await mkdir(cwd, { recursive: true });
      client = this.factory(
        command,
        cwd,
        this.environment.env,
        { event: () => {}, exit: () => {} },
        this.environment.redactor,
        this.environment.log.child({ scope: 'catalog' }),
      );
      await client.start();
      const [rawModels, rawConfig, rawAuth] = await Promise.all([
        client.request('GET', '/api/v1/models'),
        client.request('GET', '/api/v1/config'),
        client.request('GET', '/api/v1/auth'),
      ]);
      const catalog = modelsSchema.parse(rawModels);
      const config = configSchema.parse(rawConfig);
      const auth = authSchema.parse(rawAuth);
      const authenticated = auth.models_ready;
      const models: Model[] = authenticated
        ? catalog.items.map((entry) => {
            const levels = entry.support_efforts?.length ? [...entry.support_efforts] : ['default'];
            const selected =
              entry.default_effort && levels.includes(entry.default_effort)
                ? entry.default_effort
                : levels[Math.floor(levels.length / 2)]!;
            return {
              id: entry.model,
              model: entry.model,
              displayName: entry.display_name ?? entry.model,
              description: entry.provider,
              supportedReasoningEfforts: levels,
              defaultReasoningEffort: selected,
              isDefault: entry.model === config.default_model,
            };
          })
        : [];
      return {
        status: {
          available: true,
          authenticated,
          version,
          binaryPath: this.environment.binaryPath,
          error: authenticated ? null : '本机 Kimi Code 尚未登录，请先在原生 CLI 完成登录。',
        },
        models,
      };
    } catch (error) {
      this.environment.log.warn(
        { err: this.environment.redactor.text(error) },
        'Kimi Code web catalog failed',
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
