import type { Model } from '@isles/contracts';
import { CachedCatalog, type CatalogSnapshot } from '../harness/catalog-cache.js';
import { z } from 'zod';
import { StdioClient } from './client.js';
import type { NativeEnvironment } from './environment.js';

const modelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      model: z.string(),
      displayName: z.string(),
      description: z.string(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
      defaultReasoningEffort: z.string(),
      isDefault: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export class NativeCatalog extends CachedCatalog {
  constructor(
    private environment: NativeEnvironment,
    private dataDir: string,
  ) {
    super();
  }
  protected async fetch(): Promise<CatalogSnapshot> {
    let version: string | null = null;
    let client: StdioClient | undefined;
    try {
      const executable = await this.environment.executable(true);
      version = executable.version;
      await this.environment.learnSecrets();
      client = new StdioClient(
        executable,
        this.dataDir,
        { CODEX_HOME: this.environment.home },
        {
          notification: () => {},
          exit: () => {},
          request: (id) => client?.reject(id, 'Catalog does not support interactive requests'),
        },
        this.environment.redactor,
        this.environment.log.child({ scope: 'catalog' }),
      );
      await client.initialize();
      const account = z
        .object({ account: z.object({}).passthrough().nullable(), requiresOpenaiAuth: z.boolean() })
        .parse(await client.request('account/read', { refreshToken: false }));
      const authenticated = account.account !== null || !account.requiresOpenaiAuth;
      const models: Model[] = [];
      let cursor: string | null = null;
      do {
        const page = modelsSchema.parse(await client.request('model/list', { cursor, limit: 100 }));
        models.push(
          ...page.data.map((m) => ({
            ...m,
            supportedReasoningEfforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
          })),
        );
        cursor = page.nextCursor;
      } while (cursor);
      return {
        status: {
          available: true,
          authenticated,
          version,
          binaryPath: this.environment.binaryPath,
          error: authenticated ? null : '本机 Codex 尚未认证，请先在原生 CLI 完成登录。',
        },
        models,
      };
    } catch (error) {
      this.environment.log.warn({ err: error }, 'Codex status check failed');
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
