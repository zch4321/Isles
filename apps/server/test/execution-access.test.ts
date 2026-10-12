import type { Agent } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/storage/database.js';
import { Store } from '../src/storage/store.js';
import { codexAdapters, MockHarness, testConfig } from './helpers.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'isles-execution-access-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe('Agent native execution access', () => {
  it('persists each Agent setting across restarts, preserving native identity and the database baseline', async () => {
    const root = await temporary();
    const data = join(root, 'data');
    const workspace = join(root, 'workspace');
    let database = openDatabase(data);
    cleanups.push(() => database.sqlite.close());
    let store = new Store(database, workspace);
    const input = {
      harness: 'codex',
      name: 'Native access',
      model: 'test-model',
      reasoningEffort: 'high',
      nativeHome: join(root, 'native'),
      canCreateGroups: false,
    };
    const ordinary = store.createAgent(input);
    const full = store.createAgent({ ...input, name: 'Full access', dangerFullAccess: true });
    store.updateAgent(full.id, { threadId: 'fixed-native-session' });
    const baseline = database.sqlite.prepare('SELECT * FROM __drizzle_migrations').all();
    expect(ordinary.dangerFullAccess).toBe(false);
    expect(full.dangerFullAccess).toBe(true);
    const reopen = () => {
      database.sqlite.close();
      database = openDatabase(data);
      store = new Store(database, workspace);
    };
    reopen();
    expect(store.getAgent(ordinary.id).dangerFullAccess).toBe(false);
    expect(store.getAgent(full.id)).toMatchObject({
      dangerFullAccess: true,
      threadId: 'fixed-native-session',
      workspace: full.workspace,
      channelId: full.channelId,
    });
    store.updateAgent(full.id, { dangerFullAccess: false });
    store.updateAgent(full.id, { name: 'Renamed', status: 'ready' });
    reopen();
    expect(store.getAgent(full.id)).toMatchObject({ dangerFullAccess: false, name: 'Renamed' });
    expect(database.sqlite.prepare('SELECT * FROM __drizzle_migrations').all()).toEqual(baseline);
  });

  it('applies edits to the next execution while keeping the current native run and session', async () => {
    const root = await temporary();
    const harness = new MockHarness();
    const app = await buildApp({
      config: testConfig(root),
      runtimeUrl: 'http://127.0.0.1:1',
      adapterFactory: codexAdapters(undefined, harness.factory),
    });
    harness.useStore(app.isles.store);
    cleanups.push(() => app.close());
    const agent = await app.isles.runtime.createAgent({
      harness: 'codex',
      name: 'Access test',
      model: 'test-model',
      reasoningEffort: 'high',
    });
    await expect.poll(() => app.isles.store.getAgent(agent.id).status).toBe('ready');
    const fixed = app.isles.store.getAgent(agent.id).threadId;
    for (const mode of [true, false]) {
      app.isles.runtime.send(agent.channelId, {
        body: 'Start native execution',
        clientId: randomUUID(),
      });
      await expect
        .poll(() => app.isles.store.agentDetail(agent.id).runs[0]?.status)
        .toBe('running');
      const before = harness.latest(agent.id);
      const currentMode = before.agent.dangerFullAccess;
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${agent.id}`,
        payload: { dangerFullAccess: mode },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<Agent>().dangerFullAccess).toBe(mode);
      expect(before.closed).toBe(false);
      expect(before.agent.dangerFullAccess).toBe(currentMode);
      before.complete();
      await expect.poll(() => harness.latest(agent.id).agent.dangerFullAccess).toBe(mode);
      await expect.poll(() => app.isles.store.getAgent(agent.id).status).toBe('ready');
      expect(before.closed).toBe(true);
      expect(app.isles.store.getAgent(agent.id).threadId).toBe(fixed);
      const guidance = await readFile(join(agent.workspace, 'AGENTS.md'), 'utf8');
      expect(guidance.includes('Native execution uses full access.')).toBe(mode);
    }
  });

  it('routes native approval to the existing question API and expires it on stop', async () => {
    const root = await temporary();
    const harness = new MockHarness();
    const app = await buildApp({
      config: testConfig(root),
      runtimeUrl: 'http://127.0.0.1:1',
      adapterFactory: codexAdapters(undefined, harness.factory),
    });
    harness.useStore(app.isles.store);
    cleanups.push(() => app.close());
    const agent = await app.isles.runtime.createAgent({
      harness: 'codex',
      name: 'Native approval',
      model: 'test-model',
      reasoningEffort: 'high',
    });
    await expect.poll(() => app.isles.store.getAgent(agent.id).status).toBe('ready');
    app.isles.runtime.send(agent.channelId, { body: 'Run command', clientId: randomUUID() });
    await expect.poll(() => app.isles.store.agentDetail(agent.id).runs[0]?.status).toBe('running');
    const client = harness.latest(agent.id);
    const ask = (id: number) =>
      client.handlers.request(id, 'item/commandExecution/requestApproval', {
        threadId: client.threadId,
        turnId: client.turnId,
        itemId: `command-${id}`,
        command: 'write outside workspace',
        cwd: agent.workspace,
        reason: 'Native approval required',
      });
    ask(601);
    const first = app.isles.store.agentDetail(agent.id).questions[0]!;
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/questions/${first.id}/answer`,
      payload: { answers: { permission: { answers: ['自定义批准'] } } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(client.responses).toHaveLength(0);
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/questions/${first.id}/answer`,
      payload: { answers: { permission: { answers: ['允许本次'] } } },
    });
    expect(accepted.statusCode).toBe(200);
    expect(client.responses).toContainEqual({ id: 601, result: { decision: 'accept' } });
    expect(app.isles.store.getQuestion(first.id).status).toBe('answered');
    ask(602);
    const stopped = app.isles.store.agentDetail(agent.id).questions[0]!;
    await app.isles.runtime.stop(agent.id);
    expect(app.isles.store.getQuestion(stopped.id).status).toBe('expired');
    const late = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/questions/${stopped.id}/answer`,
      payload: { answers: { permission: { answers: ['允许本次'] } } },
    });
    expect(late.statusCode).toBe(409);
    expect(client.responses).not.toContainEqual({ id: 602, result: { decision: 'accept' } });
  });
});
