import type { Model } from '@isles/contracts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CachedCatalog, type CatalogSnapshot } from '../shared/catalog-cache.js';
import { AcpRpcError, initializeAcp, type AcpClientFactory, type AcpConnection } from './client.js';
import type { AcpHarness } from './harness.js';
import {
  newSessionResultSchema,
  selectValues,
  sessionStateSchema,
  type AcpConfigOption,
  type AcpInitializeResult,
} from './protocol.js';

/**
 * Reads models and thinking levels from a throwaway session in a fixed folder under the
 * Isles data directory. The session is deleted afterwards; no turn runs in it.
 */
export class AcpCatalog extends CachedCatalog {
  constructor(
    private harness: AcpHarness,
    private factory: AcpClientFactory,
  ) {
    super();
  }
  protected async fetch(): Promise<CatalogSnapshot> {
    const name = this.harness.descriptor.displayName;
    let version: string | null = null;
    let client: AcpConnection | undefined;
    try {
      const command = await this.harness.executable(true);
      version = command.version;
      await this.harness.learnSecrets();
      const cwd = join(this.harness.dataDir, 'acp-catalog', this.harness.descriptor.id);
      await mkdir(cwd, { recursive: true });
      client = this.factory(
        command,
        cwd,
        {
          notification: () => {},
          exit: () => {},
          request: (id) => client?.reject(id, -32601, 'Catalog does not accept native requests'),
        },
        this.harness.log.child({ scope: 'catalog' }),
      );
      const initialized = await initializeAcp(client, name);
      const authenticated = await this.harness.authenticated(client);
      return {
        status: {
          available: true,
          authenticated,
          version,
          binaryPath: this.harness.binaryPath,
          error: authenticated ? null : `本机 ${name} 尚未登录，请先在原生 CLI 完成登录。`,
        },
        models: authenticated ? await this.readModels(client, cwd, initialized) : [],
      };
    } catch (error) {
      this.harness.log.warn({ err: error }, `${name} status check failed`);
      return {
        status: {
          available: false,
          authenticated: false,
          version,
          binaryPath: this.harness.binaryPath,
          error: this.harness.redactor.text(error),
        },
        models: [],
      };
    } finally {
      await client?.close();
    }
  }
  private async readModels(client: AcpConnection, cwd: string, initialized: AcpInitializeResult) {
    const session = newSessionResultSchema.parse(
      await client.request('session/new', { cwd, mcpServers: [] }),
    );
    try {
      let options = session.configOptions ?? [];
      const selector = options.find((option) => option.category === 'model');
      if (!selector)
        return [
          {
            ...(await model(client, session.sessionId, 'default', 'Default', '', options)),
            isDefault: true,
          },
        ] satisfies Model[];
      const models: Model[] = [];
      for (const entry of selectValues(selector)) {
        const current = options.find((option) => option.id === selector.id)?.currentValue;
        if (current !== entry.value)
          options =
            sessionStateSchema.parse(
              await client.request('session/set_config_option', {
                sessionId: session.sessionId,
                configId: selector.id,
                value: entry.value,
              }),
            ).configOptions ?? options;
        models.push({
          ...(await model(
            client,
            session.sessionId,
            entry.value,
            entry.name,
            entry.description ?? '',
            options,
          )),
          isDefault: entry.value === selector.currentValue,
        });
      }
      return models;
    } finally {
      const capabilities = initialized.agentCapabilities?.sessionCapabilities;
      const method = capabilities?.delete
        ? 'session/delete'
        : capabilities?.close
          ? 'session/close'
          : undefined;
      if (method)
        await client
          .request(method, { sessionId: session.sessionId })
          .catch((error: unknown) =>
            this.harness.log.warn({ err: error }, 'Failed to remove the catalog session'),
          );
    }
  }
}

/** Models without a thinking selector keep the native setting, reported as `default`. */
async function model(
  client: AcpConnection,
  sessionId: string,
  id: string,
  displayName: string,
  description: string,
  options: AcpConfigOption[],
) {
  const thinking = options.find((option) => option.category === 'thought_level');
  const levels = selectValues(thinking).map((level) => level.value);
  let current = thinking?.currentValue;
  // Kimi appends its retained current value to the new model's options, even when
  // that model rejects it. Verify it in this disposable session before publishing it.
  if (thinking && typeof current === 'string' && levels.includes(current)) {
    const retained = current;
    try {
      const state = sessionStateSchema.parse(
        await client.request('session/set_config_option', {
          sessionId,
          configId: thinking.id,
          value: current,
        }),
      );
      current =
        state.configOptions?.find((option) => option.id === thinking.id)?.currentValue ?? retained;
    } catch (error) {
      if (!(error instanceof AcpRpcError) || error.code !== -32602) throw error;
      levels.splice(levels.indexOf(retained), 1);
    }
  }
  return {
    id,
    model: id,
    displayName,
    description,
    supportedReasoningEfforts: levels.length ? levels : ['default'],
    defaultReasoningEffort: !levels.length
      ? 'default'
      : typeof current === 'string' && levels.includes(current)
        ? current
        : levels.at(-1)!,
  };
}
