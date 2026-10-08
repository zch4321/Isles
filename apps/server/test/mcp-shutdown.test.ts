import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { agentRoot } from '../src/runtime/workspace.js';
import { codexAdapters, MockHarness, testConfig } from './helpers.js';

it('closes active MCP SSE streams before waiting for the HTTP server to shut down', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isles-mcp-shutdown-'));
  const config = testConfig(root);
  const harness = new MockHarness();
  const app = await buildApp({ config, adapterFactory: codexAdapters(undefined, harness.factory) });
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const agent = await app.isles.runtime.createAgent({
      harness: 'codex',
      name: 'MCP shutdown',
      model: 'test-model',
      reasoningEffort: 'high',
    });
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('ready'));
    const token = (
      await readFile(join(agentRoot(config.current.dataDir, agent), 'isles-mcp-token'), 'utf8')
    ).trim();
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp/${agent.id}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const closing = app.close();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Application shutdown waited on an active MCP stream')),
        2_000,
      );
    });
    await Promise.race([closing, timeout]);
    expect(harness.clients[0]?.closed).toBe(true);
    await response.body?.cancel();
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
