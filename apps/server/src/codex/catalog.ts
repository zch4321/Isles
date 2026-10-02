import type { CodexStatus, Model } from '@isles/contracts';
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
export interface Catalog {
  status(): Promise<CodexStatus>;
  models(): Promise<Model[]>;
  invalidate?(): void;
}
export class NativeCatalog implements Catalog {
  private cache: { status: CodexStatus; models: Model[]; time: number } | undefined;
  private fetching: Promise<{ status: CodexStatus; models: Model[] }> | undefined;
  private revision = 0;
  constructor(
    private environment: NativeEnvironment,
    private dataDir: string,
  ) {}
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
      const result = await fetching;
      if (this.revision === revision) this.cache = { ...result, time: Date.now() };
      return result;
    } finally {
      if (this.fetching === fetching) this.fetching = undefined;
    }
  }
  private async fetch() {
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
