import type { Model } from '@isles/contracts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CachedCatalog, type CatalogSnapshot } from '../shared/catalog-cache.js';
import { DshClient, type DshClientFactory, type DshConnection } from './client.js';
import type { DshEnvironment } from './environment.js';
import { catalogSchema } from './protocol.js';

export class DshCatalog extends CachedCatalog {
  constructor(
    private environment: DshEnvironment,
    private factory: DshClientFactory = (...args) => new DshClient(...args),
  ) {
    super();
  }
  protected async fetch(): Promise<CatalogSnapshot> {
    let version: string | null = null;
    let client: DshConnection | undefined;
    try {
      const command = await this.environment.executable(true);
      version = command.version;
      const cwd = join(this.environment.workspace.dataDir, 'dsh-catalog');
      await mkdir(cwd, { recursive: true });
      const runtime = await this.environment.runtime(cwd);
      client = this.factory(
        command,
        cwd,
        runtime,
        { notification: () => {}, exit: () => {} },
        this.environment.redactor,
        this.environment.log.child({ scope: 'catalog' }),
      );
      const catalog = catalogSchema.parse(await client.request('isles/catalog', {}));
      const selected = (await this.environment.desktopSelection()) ?? catalog.defaultSelection;
      const models: Model[] = catalog.models.map((model) => {
        const isDefault = selected?.provider === model.provider && selected.model === model.id;
        const efforts = model.reasoning?.efforts.map(({ id }) => id) ?? [];
        const effort =
          isDefault && selected?.reasoningEffort
            ? selected.reasoningEffort
            : model.reasoning?.defaultEffort;
        return {
          id: `${model.provider}/${model.id}`,
          model: `${model.provider}/${model.id}`,
          displayName: model.name,
          description: model.description ?? model.provider,
          supportedReasoningEfforts: ['default', ...efforts.filter((id) => id !== 'default')],
          defaultReasoningEffort: effort && efforts.includes(effort) ? effort : 'default',
          isDefault,
        };
      });
      const authenticated = models.length > 0;
      return {
        status: {
          available: true,
          authenticated,
          version,
          binaryPath: this.environment.binaryPath,
          error: authenticated
            ? null
            : 'DSH 暂无可用模型，请在桌面版或原生配置中完成登录与模型配置。',
        },
        models,
      };
    } catch (error) {
      this.environment.log.warn(
        { err: this.environment.redactor.text(error) },
        'DSH catalog failed',
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
