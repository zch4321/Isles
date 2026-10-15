import type { Agent } from '@isles/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { HarnessCatalog } from '../src/harness/types.js';
import { openDatabase } from '../src/storage/database.js';
import { Store, type NewAgent } from '../src/storage/store.js';
import { MockHarness, codexAdapters, testCatalog, testConfig } from './helpers.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
const input = {
  harness: 'codex',
  name: 'sol',
  model: 'test-model',
  reasoningEffort: 'high',
};
const storedInput: NewAgent = {
  ...input,
  canCreateGroups: false,
  nativeHome: 'test-native-home',
};
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'isles-agent-batch-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function storage() {
  const root = await directory();
  const database = openDatabase(root);
  cleanups.push(() => database.sqlite.close());
  return new Store(database, join(root, 'workspace'));
}
async function fixture(catalog: HarnessCatalog = testCatalog, steer = true) {
  const root = await directory();
  const harness = new MockHarness();
  const app = await buildApp({
    config: testConfig(root),
    runtimeUrl: 'http://127.0.0.1:1',
    adapterFactory: (workspace, config) => {
      const adapters = codexAdapters(catalog, harness.factory)(workspace, config);
      adapters[0]!.descriptor.capabilities.steer = steer;
      return adapters;
    },
  });
  harness.useStore(app.isles.store);
  cleanups.push(() => app.close());
  const create = (payload: Record<string, unknown> = input) =>
    app.inject({ method: 'POST', url: '/api/agents/batch', payload });
  return { app, harness, create };
}

describe('Agent batch creation', () => {
  it('creates independent Agents with one validated configuration and starts every session', async () => {
    const catalog = {
      status: vi.fn(testCatalog.status),
      models: vi.fn(testCatalog.models),
    };
    const { app, harness, create } = await fixture(catalog);
    const response = await create({
      ...input,
      count: 3,
      canCreateGroups: true,
      steerEnabled: true,
      dangerFullAccess: true,
    });
    expect(response.statusCode).toBe(201);
    const agents = response.json<{ agents: Agent[] }>().agents;
    expect(agents.map((agent) => agent.name)).toEqual(['sol-1', 'sol-2', 'sol-3']);
    expect(catalog.status).toHaveBeenCalledTimes(1);
    expect(catalog.models).toHaveBeenCalledTimes(1);
    for (const field of ['id', 'channelId', 'workspace'] as const)
      expect(new Set(agents.map((agent) => agent[field])).size).toBe(3);
    for (const agent of agents) {
      expect(agent).toMatchObject({
        harness: 'codex',
        model: 'test-model',
        reasoningEffort: 'high',
        canCreateGroups: true,
        steerEnabled: true,
        dangerFullAccess: true,
      });
      await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
      expect(harness.latest(agent.id).calls[0]!.method).toBe('thread/start');
    }
    expect(new Set(agents.map((agent) => app.isles.store.getAgent(agent.id).nativeHome)).size).toBe(
      1,
    );
    expect(
      new Set(agents.map((agent) => app.isles.store.publicAgent(agent.id).threadId)).size,
    ).toBe(3);
  });

  it('defaults to one numbered Agent while retaining explicit-name single creation', async () => {
    const { app, create } = await fixture();
    const single = await app.inject({ method: 'POST', url: '/api/agents', payload: input });
    expect(single.statusCode).toBe(201);
    expect(single.json().name).toBe('sol');
    const batch = await create({ ...input, name: '  sol  ' });
    expect(batch.statusCode).toBe(201);
    expect(batch.json().agents).toMatchObject([
      { name: 'sol-1', canCreateGroups: false, steerEnabled: false, dangerFullAccess: false },
    ]);
  });

  it('continues after the largest canonical suffix across deleted Agents and gaps', async () => {
    const store = await storage();
    const prefix = 'sol.[x]-2';
    for (const name of [
      `${prefix}-1`,
      `${prefix}-7`,
      `${prefix}-00099`,
      `${prefix}-0`,
      `${prefix}-+40`,
      `${prefix}-1.5`,
      `${prefix}-12extra`,
      'solax-2-99',
      `other-${prefix}-100`,
    ])
      store.createAgent({ ...storedInput, name });
    const deleted = store.createAgent({ ...storedInput, name: `${prefix}-9` });
    store.deleteAgent(deleted.id);
    expect(
      store.createAgents({ ...storedInput, name: prefix }, 2).map((agent) => agent.name),
    ).toEqual([`${prefix}-10`, `${prefix}-11`]);
    expect(store.createAgents({ ...storedInput, name: 'some name ' }, 1)[0]!.name).toBe(
      'some name -1',
    );
  });

  it('increments large integer suffixes without losing precision', async () => {
    const store = await storage();
    store.createAgent({ ...storedInput, name: 'sol-9007199254740993' });
    expect(store.createAgents(storedInput, 2).map((agent) => agent.name)).toEqual([
      'sol-9007199254740994',
      'sol-9007199254740995',
    ]);
  });

  it('validates every generated length before inserting or publishing an event', async () => {
    const store = await storage();
    const prefix = 'a'.repeat(78);
    store.createAgent({ ...storedInput, name: `${prefix}-8` });
    const cursor = store.cursor();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(() => store.createAgents({ ...storedInput, name: prefix }, 2)).toThrow('请缩短名称前缀');
    expect(store.listAgents()).toHaveLength(1);
    expect(store.cursor()).toBe(cursor);
    expect(listener).not.toHaveBeenCalled();
    const huge = '9'.repeat(76);
    store.createAgent({ ...storedInput, name: `sol-${huge}` });
    expect(() => store.createAgents(storedInput, 1)).toThrow('请缩短名称前缀');
    expect(store.listAgents()).toHaveLength(2);
  });

  it('commits the whole batch before publishing its first event and rolls back an insert failure', async () => {
    const store = await storage();
    const visibleCounts: number[] = [];
    const unsubscribe = store.subscribe(() => visibleCounts.push(store.listAgents().length));
    store.createAgents(storedInput, 3);
    expect(visibleCounts).toEqual([3, 3, 3, 3, 3, 3]);
    unsubscribe();
    const cursor = store.cursor();
    const listener = vi.fn();
    store.subscribe(listener);
    store.database.sqlite.exec(`
      CREATE TEMP TRIGGER reject_second_agent BEFORE INSERT ON agents
      WHEN NEW.name = 'rollback-2'
      BEGIN SELECT RAISE(ABORT, 'batch insert rejected'); END;
    `);
    expect(() => store.createAgents({ ...storedInput, name: 'rollback' }, 3)).toThrow(
      'batch insert rejected',
    );
    expect(store.listAgents()).toHaveLength(3);
    expect(store.listChannels()).toHaveLength(3);
    expect(store.cursor()).toBe(cursor);
    expect(listener).not.toHaveBeenCalled();
  });

  it('allocates distinct suffixes for simultaneous requests after catalog awaits', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const models = vi.fn(async () => {
      await gate;
      return testCatalog.models();
    });
    const { create } = await fixture({ ...testCatalog, models });
    const requests = [create({ ...input, count: 2 }), create({ ...input, count: 2 })];
    const results = Promise.all(requests);
    await vi.waitFor(() => expect(models).toHaveBeenCalledTimes(2));
    release();
    const responses = await results;
    expect(responses.map((response) => response.statusCode)).toEqual([201, 201]);
    const names = responses.flatMap((response) =>
      response.json().agents.map((agent: Agent) => agent.name),
    );
    expect(names.sort()).toEqual(['sol-1', 'sol-2', 'sol-3', 'sol-4']);
  });

  it('rejects malformed input and overlong generated names without creating any Agents', async () => {
    const { app, harness, create } = await fixture();
    for (const payload of [
      { ...input, count: 0 },
      { ...input, count: 1.5 },
      { ...input, count: 51 },
      { ...input, count: '3' },
      { ...input, count: 2, unexpected: true },
      { ...input, name: ' ' },
      { ...input, name: 'a'.repeat(81) },
      { ...input, name: 'a'.repeat(79) },
    ]) {
      expect((await create(payload)).statusCode).toBe(400);
      expect(app.isles.store.listAgents()).toEqual([]);
      expect(app.isles.store.cursor()).toBe(0);
      expect(harness.clients).toHaveLength(0);
    }
  });

  it.each([{ model: 'missing' }, { reasoningEffort: 'missing' }, { harness: 'missing' }])(
    'rejects an unavailable catalog selection %j before inserting',
    async (selection) => {
      const { app, harness, create } = await fixture();
      const response = await create({ ...input, count: 3, ...selection });
      expect(response.statusCode).toBe(selection.harness ? 404 : 400);
      expect(app.isles.store.listAgents()).toEqual([]);
      expect(harness.clients).toHaveLength(0);
    },
  );

  it('rejects unavailable authentication and unsupported steering before inserting', async () => {
    const unavailable = await fixture({
      ...testCatalog,
      status: async () => ({ ...(await testCatalog.status()), authenticated: false }),
    });
    expect((await unavailable.create({ ...input, count: 3 })).statusCode).toBe(503);
    expect(unavailable.app.isles.store.listAgents()).toEqual([]);
    const unsupported = await fixture(testCatalog, false);
    expect((await unsupported.create({ ...input, count: 3, steerEnabled: true })).statusCode).toBe(
      400,
    );
    expect(unsupported.app.isles.store.listAgents()).toEqual([]);
  });
});
