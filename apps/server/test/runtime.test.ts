import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { HarnessCatalog } from '../src/harness/types.js';
import { agentRoot } from '../src/runtime/workspace.js';
import {
  MockHarness,
  codexAdapters,
  testCatalog,
  testConfig,
  parseMessageText,
} from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups.length = 0;
});
async function fixture(catalog: HarnessCatalog = testCatalog) {
  const dir = await mkdtemp(join(tmpdir(), 'isles-runtime-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const harness = new MockHarness();
  const open = async () => {
    const opened = await buildApp({
      config: testConfig(dir),
      adapterFactory: codexAdapters(catalog, harness.factory),
      runtimeUrl: 'http://127.0.0.1:1',
    });
    harness.useStore(opened.isles.store);
    return opened;
  };
  const app = await open();
  cleanups.push(() => app.close());
  const create = async (name = '测试 Agent', canCreateGroups = false) => {
    const result = await app.isles.runtime.createAgent({
      harness: 'codex',
      name,
      model: 'test-model',
      reasoningEffort: 'max',
      canCreateGroups,
    });
    await expect.poll(() => app.isles.store.publicAgent(result.id).status).toBe('ready');
    return app.isles.store.publicAgent(result.id);
  };
  const say = (channelId: string, body: string, extra: { mentions?: string[] } = {}) =>
    app.isles.runtime.send(channelId, { body, clientId: randomUUID(), ...extra });
  const group = (name: string, memberIds: string[]) =>
    app.isles.runtime.createGroup('user', { name, memberIds });
  /** Delivery status of each channel message for one Agent. */
  const deliveries = (channelId: string, agentId: string) =>
    app.isles.store
      .listMessages(channelId)
      .map((m) => m.deliveries.find((d) => d.agentId === agentId)?.status);
  const ready = (id: string) =>
    expect.poll(() => app.isles.store.publicAgent(id).status).toBe('ready');
  return { dir, app, harness, create, open, say, group, deliveries, ready };
}

describe('durable runtime with simulated Codex', () => {
  it('renames an idle Agent and refreshes guidance on its original thread without changing omitted fields', async () => {
    const { app, harness, create, ready } = await fixture();
    const agent = await create('Before');
    const originalClient = harness.latest(agent.id);
    const renamed = await app.isles.runtime.updateAgent(agent.id, { name: 'After' });
    expect(renamed).toMatchObject({
      id: agent.id,
      name: 'After',
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      canCreateGroups: agent.canCreateGroups,
      workspace: agent.workspace,
      threadId: agent.threadId,
    });
    await expect.poll(() => harness.clients.length).toBe(2);
    await ready(agent.id);
    expect(originalClient.closed).toBe(true);
    expect(harness.latest(agent.id).calls[0]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: agent.threadId },
    });
    expect(await readFile(join(agent.workspace, 'AGENTS.md'), 'utf8')).toContain(
      'Agent name: "After"',
    );
    const cursor = app.isles.store.cursor();
    await app.isles.runtime.updateAgent(agent.id, { name: 'After' });
    expect(app.isles.store.cursor()).toBe(cursor);
    expect(harness.clients).toHaveLength(2);
  });

  it('applies busy model edits to the next turn while preserving the active turn and native thread', async () => {
    const catalog: HarnessCatalog = {
      ...testCatalog,
      models: async () => [
        ...(await testCatalog.models()),
        {
          ...(await testCatalog.models())[0]!,
          id: 'second-model',
          model: 'second-model',
          supportedReasoningEfforts: ['high'],
        },
      ],
    };
    const { app, harness, create, say, ready } = await fixture(catalog);
    const agent = await create();
    say(agent.channelId, 'First turn');
    const originalClient = harness.latest(agent.id);
    await app.isles.runtime.updateAgent(agent.id, {
      model: 'second-model',
      reasoningEffort: 'high',
    });
    expect(originalClient.closed).toBe(false);
    expect(originalClient.calls.find((call) => call.method === 'turn/start')).toMatchObject({
      params: { model: 'test-model', effort: 'max', threadId: agent.threadId },
    });
    expect(app.isles.store.publicAgent(agent.id).status).toBe('running');
    say(agent.channelId, 'Next turn');
    originalClient.complete();
    await expect.poll(() => harness.turns).toBe(2);
    expect(originalClient.closed).toBe(true);
    const nextClient = harness.latest(agent.id);
    expect(nextClient.calls[0]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: agent.threadId, model: 'second-model' },
    });
    expect(nextClient.calls.find((call) => call.method === 'turn/start')).toMatchObject({
      params: { model: 'second-model', effort: 'high', threadId: agent.threadId },
    });
    nextClient.complete();
    await ready(agent.id);
    expect(
      harness.clients
        .flatMap((client) => client.calls)
        .filter((call) => call.method === 'thread/start'),
    ).toHaveLength(1);
  });

  it('refreshes edits made during initial connection before the first turn without replacing its persisted thread', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'isles-runtime-edit-connecting-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const harness = new MockHarness();
    let releaseConnection: (() => void) | undefined;
    const guidance: string[] = [];
    const app = await buildApp({
      config: testConfig(dir),
      adapterFactory: codexAdapters(testCatalog, async (agent, handlers, baseUrl, connecting) => {
        guidance.push(await readFile(join(agent.workspace, 'AGENTS.md'), 'utf8'));
        if (!agent.threadId)
          await new Promise<void>((resolve) => {
            releaseConnection = resolve;
          });
        return harness.factory(agent, handlers, baseUrl, connecting);
      }),
      runtimeUrl: 'http://127.0.0.1:1',
    });
    harness.useStore(app.isles.store);
    cleanups.push(() => app.close());
    const agent = await app.isles.runtime.createAgent({
      harness: 'codex',
      name: 'Before connection',
      model: 'test-model',
      reasoningEffort: 'max',
    });
    await expect.poll(() => Boolean(releaseConnection)).toBe(true);
    expect(harness.clients).toHaveLength(0);
    expect(guidance[0]).toContain('Agent name: "Before connection"');
    await app.isles.runtime.updateAgent(agent.id, {
      name: 'After connection',
      reasoningEffort: 'high',
    });
    app.isles.runtime.send(agent.channelId, { body: 'First input', clientId: 'connecting-input' });
    releaseConnection!();
    await expect.poll(() => harness.turns).toBe(1);
    expect(harness.clients).toHaveLength(2);
    expect(guidance[1]).toContain('Agent name: "After connection"');
    const initialClient = harness.clients[0]!;
    expect(initialClient.closed).toBe(true);
    expect(initialClient.calls.map((call) => call.method)).toEqual([
      'thread/start',
      'thread/inject_items',
    ]);
    const refreshedClient = harness.latest(agent.id);
    expect(refreshedClient.calls[0]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: initialClient.threadId },
    });
    expect(refreshedClient.calls.find((call) => call.method === 'turn/start')).toMatchObject({
      params: { effort: 'high', threadId: initialClient.threadId },
    });
    expect(app.isles.store.publicAgent(agent.id)).toMatchObject({
      name: 'After connection',
      threadId: initialClient.threadId,
      workspace: agent.workspace,
    });
    expect(harness.persistedThreads.size).toBe(1);
    refreshedClient.complete();
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
  });

  it('rejects invalid partial edits atomically and keeps stopped Agents stopped after valid edits', async () => {
    const { app, harness, create } = await fixture();
    const agent = await create();
    await app.isles.runtime.stop(agent.id);
    const before = app.isles.store.publicAgent(agent.id);
    const cursor = app.isles.store.cursor();
    for (const payload of [
      {},
      { name: '' },
      { status: 'ready' },
      { model: 'missing', name: 'Bad rename' },
      { reasoningEffort: 'unsupported', canCreateGroups: true },
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${agent.id}`,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(app.isles.store.publicAgent(agent.id)).toEqual(before);
    }
    expect(app.isles.store.cursor()).toBe(cursor);
    const changed = await app.isles.runtime.updateAgent(agent.id, {
      name: 'Stopped rename',
      reasoningEffort: 'high',
      canCreateGroups: true,
    });
    expect(changed).toMatchObject({
      name: 'Stopped rename',
      reasoningEffort: 'high',
      canCreateGroups: true,
      desiredState: 'stopped',
      status: 'stopped',
      threadId: agent.threadId,
      workspace: agent.workspace,
    });
    expect(harness.clients).toHaveLength(1);
  });

  it('edits names and permissions without fetching an unavailable model catalog', async () => {
    let unavailable = false;
    const catalog: HarnessCatalog = {
      status: async () => {
        if (unavailable) throw new Error('Catalog must not be fetched for this edit');
        return testCatalog.status();
      },
      models: async () => {
        if (unavailable) throw new Error('Catalog must not be fetched for this edit');
        return testCatalog.models();
      },
    };
    const { app, create } = await fixture(catalog);
    const agent = await create();
    unavailable = true;
    const edited = await app.isles.runtime.updateAgent(agent.id, {
      name: 'Offline rename',
      canCreateGroups: true,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
    });
    expect(edited).toMatchObject({
      name: 'Offline rename',
      canCreateGroups: true,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
    });
  });

  it('validates a delayed model edit against the latest reasoning effort and never applies its other fields on rejection', async () => {
    let releaseModels: (() => void) | undefined;
    let delayModels = false;
    const catalog: HarnessCatalog = {
      ...testCatalog,
      models: async () => {
        if (delayModels) {
          delayModels = false;
          await new Promise<void>((resolve) => {
            releaseModels = resolve;
          });
        }
        return [
          ...(await testCatalog.models()),
          {
            ...(await testCatalog.models())[0]!,
            id: 'max-model',
            model: 'max-model',
            supportedReasoningEfforts: ['max'],
          },
        ];
      },
    };
    const { app, create } = await fixture(catalog);
    const agent = await create();
    await app.isles.runtime.stop(agent.id);
    delayModels = true;
    const delayed = app.isles.runtime.updateAgent(agent.id, {
      model: 'max-model',
      name: 'Rejected rename',
    });
    const rejection = expect(delayed).rejects.toMatchObject({ statusCode: 400 });
    await expect.poll(() => Boolean(releaseModels)).toBe(true);
    await app.isles.runtime.updateAgent(agent.id, { reasoningEffort: 'high' });
    releaseModels!();
    await rejection;
    expect(app.isles.store.publicAgent(agent.id)).toMatchObject({
      name: agent.name,
      model: agent.model,
      reasoningEffort: 'high',
      desiredState: 'stopped',
    });
  });

  it('deletes a waiting Agent through the API, revokes its MCP identity and retains read-only history across restart', async () => {
    const { app, harness, create, say, group, open } = await fixture();
    const agent = await create('Retained author');
    const other = await create('Survivor');
    const shared = group('Discussion', [agent.id, other.id]);
    const privateFile = join(agent.workspace, 'retain.txt');
    const sharedFile = join(app.isles.runtime.workspace.sharedDir, 'retain.txt');
    await writeFile(privateFile, 'personal');
    await writeFile(sharedFile, 'shared');
    const token = await app.isles.runtime.workspace.token(
      agentRoot(app.isles.runtime.workspace.dataDir, agent),
    );
    say(agent.channelId, 'Running input');
    await expect.poll(() => harness.turns).toBe(1);
    const client = harness.latest(agent.id);
    app.isles.runtime.publish(agent.id, agent.channelId, {
      body: 'Retained reply',
      clientId: 'retained-reply',
    });
    client.question();
    const question = app.isles.store.agentDetail(agent.id).questions[0]!;
    say(agent.channelId, 'Queued input');
    const deleted = await app.inject({ method: 'DELETE', url: `/api/agents/${agent.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      id: agent.id,
      status: 'deleted',
      desiredState: 'stopped',
      threadId: agent.threadId,
      workspace: agent.workspace,
    });
    expect(client.closed).toBe(true);
    expect(client.calls.map((call) => call.method)).toContain('turn/interrupt');
    expect(app.isles.store.getQuestion(question.id).status).toBe('expired');
    expect(app.isles.store.memberIds(shared.id)).toEqual([other.id]);
    expect(
      (await app.inject('/api/agents')).json().agents.map((a: { id: string }) => a.id),
    ).toEqual([other.id]);
    expect((await app.inject('/api/agents?includeDeleted=true')).json().agents).toHaveLength(2);
    expect((await app.inject('/api/agents?includeDeleted=yes')).statusCode).toBe(400);
    const detail = (await app.inject(`/api/agents/${agent.id}`)).json();
    expect(detail).toMatchObject({
      agent: { name: 'Retained author' },
      runs: [{ status: 'interrupted' }],
      questions: [],
    });
    expect(
      app.isles.store.channelDetail(agent.channelId).messages.map((message) => message.body),
    ).toEqual(['Running input', 'Retained reply', 'Queued input']);
    expect(await readFile(privateFile, 'utf8')).toBe('personal');
    expect(await readFile(sharedFile, 'utf8')).toBe('shared');
    for (const operation of ['stop', 'resume'])
      expect(
        (await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/${operation}` }))
          .statusCode,
      ).toBe(410);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/agents/${agent.id}`,
          payload: { name: 'Revived' },
        })
      ).statusCode,
    ).toBe(410);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/channels/${agent.channelId}/messages`,
          payload: { body: 'Rejected', clientId: 'deleted-input' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/mcp/${agent.id}`,
          headers: { authorization: `Bearer ${token}` },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(() =>
      app.isles.runtime.publish(agent.id, shared.id, {
        body: 'Rejected',
        clientId: 'deleted-reply',
      }),
    ).toThrow('Agent 已删除');
    expect(() => app.isles.runtime.receiveMessages(agent.id, { limit: 50 })).toThrow(
      'Agent 已删除',
    );
    const cursor = app.isles.store.cursor();
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/agents/${agent.id}` })).statusCode,
    ).toBe(200);
    expect(app.isles.store.cursor()).toBe(cursor);
    const clientsBefore = harness.clients.filter(
      (candidate) => candidate.agent.id === agent.id,
    ).length;
    await app.close();
    const restored = await open();
    cleanups.push(() => restored.close());
    await expect.poll(() => restored.isles.store.publicAgent(other.id).status).toBe('ready');
    expect(restored.isles.store.publicAgent(agent.id)).toMatchObject({
      status: 'deleted',
      threadId: agent.threadId,
    });
    expect(harness.clients.filter((candidate) => candidate.agent.id === agent.id)).toHaveLength(
      clientsBefore,
    );
    expect(restored.isles.store.listAgents().map((candidate) => candidate.id)).toEqual([other.id]);
    expect(restored.isles.store.agentDetail(agent.id).runs).toEqual(detail.runs);
  });

  it('blocks management and private input while deletion waits for an initial native connection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'isles-runtime-delete-connecting-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const harness = new MockHarness();
    let releaseConnection: (() => void) | undefined;
    const app = await buildApp({
      config: testConfig(dir),
      adapterFactory: codexAdapters(testCatalog, async (agent, handlers, baseUrl, connecting) => {
        await new Promise<void>((resolve) => {
          releaseConnection = resolve;
        });
        return harness.factory(agent, handlers, baseUrl, connecting);
      }),
      runtimeUrl: 'http://127.0.0.1:1',
    });
    harness.useStore(app.isles.store);
    cleanups.push(() => app.close());
    cleanups.push(async () => {
      releaseConnection?.();
    });
    const agent = await app.isles.runtime.createAgent({
      harness: 'codex',
      name: 'Connecting',
      model: 'test-model',
      reasoningEffort: 'high',
    });
    await expect.poll(() => Boolean(releaseConnection)).toBe(true);
    const deleting = app.isles.runtime.deleteAgent(agent.id);
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('stopped');
    await expect(app.isles.runtime.resume(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      app.isles.runtime.updateAgent(agent.id, { name: 'Revived' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(app.isles.runtime.deleteAgent(agent.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(() =>
      app.isles.runtime.send(agent.channelId, { body: 'Rejected', clientId: 'connecting-delete' }),
    ).toThrow('正在删除');
    releaseConnection!();
    expect(await deleting).toMatchObject({ status: 'deleted', threadId: null, name: 'Connecting' });
    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0]!.closed).toBe(true);
    expect(harness.clients[0]!.calls).toEqual([]);
  });

  it('rejects a delayed model edit when the Agent was deleted during catalog validation', async () => {
    let delay = false;
    let releaseModels: (() => void) | undefined;
    const catalog: HarnessCatalog = {
      ...testCatalog,
      models: async () => {
        if (delay)
          await new Promise<void>((resolve) => {
            releaseModels = resolve;
          });
        return testCatalog.models();
      },
    };
    const { app, create } = await fixture(catalog);
    const agent = await create();
    delay = true;
    const edit = app.isles.runtime.updateAgent(agent.id, {
      reasoningEffort: 'high',
      name: 'Rejected rename',
    });
    const rejection = expect(edit).rejects.toMatchObject({ statusCode: 410 });
    await expect.poll(() => Boolean(releaseModels)).toBe(true);
    await app.isles.runtime.deleteAgent(agent.id);
    releaseModels!();
    await rejection;
    expect(app.isles.store.publicAgent(agent.id)).toMatchObject({
      status: 'deleted',
      name: agent.name,
      reasoningEffort: 'max',
    });
  });

  it('cannot resume an Agent when deletion begins while its native process is closing', async () => {
    const { app, harness, create } = await fixture();
    const agent = await create();
    let releaseClose: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    cleanups.push(async () => {
      releaseClose?.();
    });
    const client = harness.latest(agent.id);
    let closing = false;
    client.close = async () => {
      closing = true;
      await closed;
      client.closed = true;
    };
    const resume = app.isles.runtime.resume(agent.id);
    const rejection = expect(resume).rejects.toMatchObject({ statusCode: 409 });
    await expect.poll(() => closing).toBe(true);
    const deleting = app.isles.runtime.deleteAgent(agent.id);
    releaseClose!();
    await rejection;
    expect(await deleting).toMatchObject({ status: 'deleted', desiredState: 'stopped' });
    expect(harness.clients).toHaveLength(1);
  });

  it('keeps an Agent stopped when a later stop supersedes a resume waiting on native close', async () => {
    const { app, harness, create } = await fixture();
    const agent = await create();
    let releaseClose: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    cleanups.push(async () => {
      releaseClose?.();
    });
    const client = harness.latest(agent.id);
    let closing = false;
    client.close = async () => {
      closing = true;
      await closed;
      client.closed = true;
    };
    const resume = app.isles.runtime.resume(agent.id);
    const rejection = expect(resume).rejects.toMatchObject({ statusCode: 409 });
    await expect.poll(() => closing).toBe(true);
    const stopping = app.isles.runtime.stop(agent.id);
    releaseClose!();
    await Promise.all([rejection, stopping]);
    expect(app.isles.store.publicAgent(agent.id)).toMatchObject({
      status: 'stopped',
      desiredState: 'stopped',
      threadId: agent.threadId,
    });
    expect(harness.clients).toHaveLength(1);
    await app.isles.runtime.resume(agent.id);
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    expect(harness.clients).toHaveLength(2);
    expect(harness.latest(agent.id).calls[0]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: agent.threadId },
    });
  });

  it('keeps individual workspaces and data-backed tokens while sharing files across Agents', async () => {
    const { app, dir, create, open } = await fixture();
    const first = await create('Writer');
    const second = await create('Reader');
    const { workspace: environment } = app.isles.runtime;
    expect(first.workspace).toBe(join(dir, 'workspace', 'agents', first.id, 'workspace'));
    expect(second.workspace).toBe(join(dir, 'workspace', 'agents', second.id, 'workspace'));
    const payloadPath = join(environment.sharedDir, 'handoff.txt');
    await writeFile(payloadPath, 'Shared handoff');
    for (const agent of [first, second]) {
      const rules = await readFile(join(agent.workspace, 'AGENTS.md'), 'utf8');
      expect(rules).toContain(JSON.stringify(environment.sharedDir));
      expect(await readFile(payloadPath, 'utf8')).toBe('Shared handoff');
      await environment.token(agentRoot(dir, agent));
      expect(await readdir(agentRoot(dir, agent))).toEqual(['isles-mcp-token']);
    }
    await app.close();
    const configFile = join(dir, 'config.toml');
    await writeFile(configFile, '[paths]\nworkspace_dir = "next-workspace"\n');
    const restored = await open();
    cleanups.push(() => restored.close());
    await expect.poll(() => restored.isles.store.publicAgent(first.id).status).toBe('ready');
    expect(restored.isles.store.publicAgent(first.id)).toMatchObject({
      workspace: first.workspace,
      threadId: first.threadId,
    });
    expect(await readFile(join(first.workspace, 'AGENTS.md'), 'utf8')).toContain(
      JSON.stringify(join(dir, 'next-workspace', 'shared')),
    );
    const third = await restored.isles.runtime.createAgent({
      harness: 'codex',
      name: 'New Agent',
      model: 'test-model',
      reasoningEffort: 'max',
    });
    await expect.poll(() => restored.isles.store.publicAgent(third.id).status).toBe('ready');
    expect(third.workspace).toBe(join(dir, 'next-workspace', 'agents', third.id, 'workspace'));
    expect(await readFile(payloadPath, 'utf8')).toBe('Shared handoff');
  });
  it('refuses to run when native discovery does not load the workspace guidance, without replacing the thread', async () => {
    const { app, harness } = await fixture();
    harness.missingGuidance = true;
    const agent = await app.isles.runtime.createAgent({
      harness: 'codex',
      name: 'Missing guidance',
      model: 'test-model',
      reasoningEffort: 'max',
    });
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('error');
    const failed = app.isles.store.publicAgent(agent.id);
    expect(failed.error).toContain('未确认加载工作目录的 AGENTS.md');
    expect(failed.threadId).toBe(`native-${agent.id}`);
    expect(harness.turns).toBe(0);
    harness.missingGuidance = false;
    await app.isles.runtime.resume(agent.id);
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    expect(app.isles.store.publicAgent(agent.id).threadId).toBe(failed.threadId);
    expect(harness.turns).toBe(0);
    expect(
      harness.clients
        .flatMap((client) => client.calls)
        .filter((call) => call.method === 'thread/start'),
    ).toHaveLength(1);
    expect(harness.latest(agent.id).calls[0]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: failed.threadId },
    });
  });

  it('deduplicates saved messages, merges busy private input into the next turn, and never puts native output in chat', async () => {
    const { app, harness, create, deliveries, ready } = await fixture();
    const agent = await create();
    const one = app.isles.runtime.send(agent.channelId, { body: '第一条', clientId: 'first' });
    const duplicate = app.isles.runtime.send(agent.channelId, {
      body: '第一条',
      clientId: 'first',
    });
    app.isles.runtime.send(agent.channelId, { body: '第二条', clientId: 'second' });
    app.isles.runtime.send(agent.channelId, { body: '第三条', clientId: 'third' });
    expect(duplicate.seq).toBe(one.seq);
    expect(harness.turns).toBe(1);
    expect(deliveries(agent.channelId, agent.id)).toEqual(['accepted', 'queued', 'queued']);
    harness.latest(agent.id).complete();
    await expect.poll(() => harness.turns).toBe(2);
    expect(harness.bodies(agent.id)).toEqual([['第一条'], ['第二条', '第三条']]);
    harness.latest(agent.id).complete();
    await ready(agent.id);
    expect(deliveries(agent.channelId, agent.id)).toEqual(['completed', 'completed', 'completed']);
    const detail = app.isles.store.agentDetail(agent.id);
    expect(detail.runs).toHaveLength(2);
    expect(detail.runs.every((r) => r.threadId === agent.threadId)).toBe(true);
    expect(detail.runs.map((r) => r.inputs[0]!.messageSeqs.length).sort()).toEqual([1, 2]);
    expect(detail.runs.flatMap((r) => r.items).map((i) => i.text)).toContain(
      '原生详情，不是正式回复',
    );
    expect(
      harness
        .latest(agent.id)
        .calls.filter((c) => c.method === 'turn/start')
        .map((c) => c.params.clientUserMessageId)
        .sort(),
    ).toEqual(detail.runs.map((r) => r.id).sort());
    expect(app.isles.store.listMessages(agent.channelId).map((m) => m.sender)).toEqual([
      'user',
      'user',
      'user',
    ]);
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/channels/${agent.channelId}/messages`,
      payload: { body: '不同正文', clientId: 'first' },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it('persists stop across restart and resumes queued input on the same thread without retrying cancellation', async () => {
    const { app, harness, create, open } = await fixture();
    const agent = await create();
    app.isles.runtime.send(agent.channelId, { body: '被取消的输入', clientId: 'cancel' });
    await app.isles.runtime.stop(agent.id);
    app.isles.runtime.send(agent.channelId, { body: '停止后消息', clientId: 'queued' });
    expect(harness.turns).toBe(1);
    await app.close();
    const restarted = await open();
    cleanups.push(() => restarted.close());
    expect(restarted.isles.store.publicAgent(agent.id).status).toBe('stopped');
    expect(
      restarted.isles.store.listMessages(agent.channelId).map((m) => m.deliveries[0]!.status),
    ).toEqual(['cancelled', 'queued']);
    await restarted.isles.runtime.resume(agent.id);
    await expect.poll(() => harness.turns).toBe(2);
    expect(harness.bodies(agent.id)[1]).toEqual(['停止后消息']);
    const client = harness.latest(agent.id);
    expect(client.calls[0]).toMatchObject({
      method: 'thread/resume',
      params: {
        threadId: agent.threadId,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        config: {
          'mcp_servers.isles': {
            url: `http://127.0.0.1:1/mcp/${agent.id}`,
            bearer_token_env_var: 'ISLES_MCP_TOKEN',
          },
        },
      },
    });
    expect(client.calls.some((c) => c.method === 'thread/start')).toBe(false);
    client.complete();
    await expect
      .poll(
        () =>
          restarted.isles.store.agentDetail(agent.id).runs.filter((r) => r.status === 'completed')
            .length,
      )
      .toBe(1);
    expect(restarted.isles.store.agentDetail(agent.id).runs).toHaveLength(2);
  });

  it('resumes an Agent after an authentication failure on startup without replaying its failed input', async () => {
    const { app, harness, create, open } = await fixture();
    const agent = await create();
    app.isles.runtime.send(agent.channelId, { body: 'Failed input', clientId: 'failed' });
    await expect.poll(() => harness.turns).toBe(1);
    const originalClient = harness.latest(agent.id);
    const error =
      'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.';
    originalClient.handlers.notification('turn/completed', {
      threadId: agent.threadId,
      turn: { id: originalClient.turnId, status: 'failed', error: { message: error } },
    });
    await expect.poll(() => app.isles.store.publicAgent(agent.id).error).toBe(error);
    app.isles.runtime.send(agent.channelId, { body: 'Queued input', clientId: 'queued' });
    await app.close();
    const restarted = await open();
    cleanups.push(() => restarted.close());
    await expect.poll(() => harness.turns).toBe(2);
    expect(originalClient.closed).toBe(true);
    expect(harness.latest(agent.id).calls[0]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: agent.threadId },
    });
    expect(harness.bodies(agent.id)).toEqual([['Failed input'], ['Queued input']]);
    expect(restarted.isles.store.publicAgent(agent.id)).toMatchObject({
      threadId: agent.threadId,
      error: null,
      status: 'running',
    });
    expect(
      restarted.isles.store.listMessages(agent.channelId).map((m) => m.deliveries[0]!.status),
    ).toEqual(['failed', 'accepted']);
    harness.latest(agent.id).complete();
    await expect.poll(() => restarted.isles.store.publicAgent(agent.id).status).toBe('ready');
    expect(
      harness.clients.flatMap((c) => c.calls).filter((c) => c.method === 'thread/start'),
    ).toHaveLength(1);
  });

  it('attempts startup recovery once per running Agent and retries failures on the next restart', async () => {
    const { app, harness, create, open } = await fixture();
    const missing = await create('Missing session');
    const healthy = await create('Healthy');
    const stopped = await create('Stopped');
    await app.isles.runtime.stop(stopped.id);
    await app.close();
    harness.persistedThreads.delete(missing.threadId!);
    const restarted = await open();
    cleanups.push(() => restarted.close());
    await expect.poll(() => restarted.isles.store.publicAgent(missing.id).status).toBe('error');
    await expect.poll(() => restarted.isles.store.publicAgent(healthy.id).status).toBe('ready');
    expect(restarted.isles.store.publicAgent(missing.id)).toMatchObject({
      threadId: missing.threadId,
      desiredState: 'running',
      error: 'no rollout found for thread id',
    });
    expect(restarted.isles.store.publicAgent(stopped.id).status).toBe('stopped');
    expect(harness.clients.filter((c) => c.agent.id === stopped.id)).toHaveLength(1);
    expect(harness.latest(missing.id).closed).toBe(true);
    restarted.isles.runtime.start('http://127.0.0.1:1');
    restarted.isles.runtime.send(missing.channelId, { body: 'Later input', clientId: 'later' });
    expect(harness.clients.filter((c) => c.agent.id === missing.id)).toHaveLength(2);
    expect(harness.clients.filter((c) => c.agent.id === healthy.id)).toHaveLength(2);
    expect(harness.turns).toBe(0);
    harness.persistedThreads.add(missing.threadId!);
    await restarted.close();
    const retried = await open();
    cleanups.push(() => retried.close());
    await expect.poll(() => harness.turns).toBe(1);
    expect(harness.bodies(missing.id)).toEqual([['Later input']]);
    expect(harness.clients.filter((c) => c.agent.id === missing.id)).toHaveLength(3);
    expect(
      harness.clients.flatMap((c) => c.calls).filter((c) => c.method === 'thread/start'),
    ).toHaveLength(3);
    harness.latest(missing.id).complete();
    await expect.poll(() => retried.isles.store.publicAgent(missing.id).status).toBe('ready');
  });

  it('automatically recovers after an interrupted run without redelivering uncertain input', async () => {
    const { app, harness, create, open } = await fixture();
    const agent = await create();
    const accepted = app.isles.runtime.send(agent.channelId, {
      body: '已被接受',
      clientId: 'accepted',
    });
    app.isles.runtime.send(agent.channelId, { body: '后续排队', clientId: 'pending' });
    await app.close();
    const restarted = await open();
    cleanups.push(() => restarted.close());
    const store = restarted.isles.store;
    expect(store.listMessages(agent.channelId)[0]!.deliveries[0]!.status).toBe('uncertain');
    expect(store.agentDetail(agent.id).runs[0]!.status).toBe('uncertain');
    await expect.poll(() => harness.turns).toBe(2);
    expect(store.publicAgent(agent.id)).toMatchObject({ threadId: agent.threadId, error: null });
    expect(harness.bodies(agent.id)[1]).toEqual(['后续排队']);
    expect(
      store
        .agentDetail(agent.id)
        .runs.filter((r) => r.inputs.some((i) => i.messageSeqs.includes(accepted.seq))),
    ).toHaveLength(1);
    harness.latest(agent.id).complete();
  });

  it('reports missing thread and native rejection, with no new-thread fallback', async () => {
    const { app, harness, create } = await fixture();
    const agent = await create();
    await app.isles.runtime.stop(agent.id);
    harness.failResume = true;
    await app.isles.runtime.resume(agent.id);
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('error');
    expect(app.isles.store.publicAgent(agent.id).threadId).toBe(agent.threadId);
    expect(
      harness.clients.flatMap((c) => c.calls).filter((c) => c.method === 'thread/start'),
    ).toHaveLength(1);
    harness.failResume = false;
    await app.isles.runtime.resume(agent.id);
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    harness.failTurn = 'reject';
    app.isles.runtime.send(agent.channelId, { body: '原生拒绝', clientId: 'reject' });
    await expect
      .poll(() => app.isles.store.listMessages(agent.channelId)[0]!.deliveries[0]!.status)
      .toBe('failed');
  });

  it('refuses to resume a thread that lives in another Codex home instead of starting a new one', async () => {
    const { app, harness, create } = await fixture();
    const agent = await create();
    await app.isles.runtime.stop(agent.id);
    app.isles.store.database.sqlite
      .prepare('update agents set native_home = ? where id = ?')
      .run('/old/private/codex', agent.id);
    await app.isles.runtime.resume(agent.id);
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('error');
    expect(app.isles.store.publicAgent(agent.id).error).toContain('/old/private/codex');
    expect(app.isles.store.publicAgent(agent.id).threadId).toBe(agent.threadId);
    expect(harness.clients.filter((c) => c.agent.id === agent.id)).toHaveLength(1);
  });

  it('marks lost turn acknowledgements uncertain without replaying them on explicit resume', async () => {
    const { app, harness, create } = await fixture();
    const agent = await create();
    harness.failTurn = 'unknown';
    app.isles.runtime.send(agent.channelId, { body: '确认丢失', clientId: 'lost-ack' });
    await expect
      .poll(() => app.isles.store.listMessages(agent.channelId)[0]!.deliveries[0]!.status)
      .toBe('uncertain');
    expect(app.isles.store.publicAgent(agent.id).status).toBe('error');
    harness.failTurn = undefined;
    await app.isles.runtime.resume(agent.id);
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    expect(
      harness.clients.flatMap((c) => c.calls).filter((c) => c.method === 'turn/start'),
    ).toHaveLength(1);
  });

  it('persists a neutral initialization once without a model turn and rejects a second owner before recovery writes', async () => {
    const { app, harness, create, open } = await fixture();
    const agent = await create();
    expect(harness.latest(agent.id).calls.map((c) => c.method)).toEqual([
      'thread/start',
      'thread/inject_items',
    ]);
    const rules = JSON.stringify(harness.latest(agent.id).calls[1]!.params);
    expect(rules).toContain('Isles session initialized.');
    expect(rules).not.toContain('Only call send_message');
    expect(harness.latest(agent.id).calls[0]!.params).not.toHaveProperty('developerInstructions');
    expect(await readFile(join(agent.workspace, 'AGENTS.md'), 'utf8')).toContain(
      'Only call send_message when you think a reply is needed.',
    );
    expect(app.isles.store.agentDetail(agent.id).runs).toEqual([]);
    expect(app.isles.store.listMessages(agent.channelId)).toEqual([]);
    app.isles.runtime.send(agent.channelId, { body: '仍在执行', clientId: 'live' });
    await expect
      .poll(() => app.isles.store.listMessages(agent.channelId)[0]!.deliveries[0]!.status)
      .toBe('accepted');
    const cursor = app.isles.store.cursor();
    await expect(open()).rejects.toThrow('另一个 Isles');
    expect(app.isles.store.cursor()).toBe(cursor);
    expect(app.isles.store.publicAgent(agent.id).status).toBe('running');
    await app.isles.runtime.stop(agent.id);
    await app.isles.runtime.resume(agent.id);
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    expect(
      harness.clients.flatMap((c) => c.calls).filter((c) => c.method === 'thread/inject_items'),
    ).toHaveLength(1);
  });

  it('routes answers only to a live native request, expires stale questions, and rejects unknown requests', async () => {
    const { app, harness, create } = await fixture();
    const agent = await create();
    app.isles.runtime.send(agent.channelId, { body: '提问', clientId: 'question' });
    const client = harness.latest(agent.id);
    client.question();
    const question = app.isles.store.agentDetail(agent.id).questions[0]!;
    expect(app.isles.store.agentDetail(agent.id).runs[0]!.status).toBe('waiting');
    expect(app.isles.store.channelDetail(agent.channelId).questions.map((q) => q.id)).toEqual([
      question.id,
    ]);
    const answer = (id: string, value: string) =>
      app.inject({
        method: 'POST',
        url: `/api/agents/${agent.id}/questions/${id}/answer`,
        payload: { answers: { choice: { answers: [value] } } },
      });
    expect((await answer(question.id, '无效选项')).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/agents/${agent.id}/questions/${question.id}/answer`,
          payload: { answers: { choice: { answers: ['继续', '结束'] } } },
        })
      ).statusCode,
    ).toBe(400);
    expect((await answer(question.id, '继续')).statusCode).toBe(200);
    expect(client.responses).toEqual([
      { id: 700, result: { answers: { choice: { answers: ['继续'] } } } },
    ]);
    client.question(701);
    const stale = app.isles.store.agentDetail(agent.id).questions[0]!;
    await app.isles.runtime.stop(agent.id);
    expect((await answer(stale.id, '继续')).statusCode).toBe(409);
    expect(client.responses).toHaveLength(1);
    await app.isles.runtime.resume(agent.id);
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    harness.latest(agent.id).handlers.request(702, 'unknown/request', {});
    expect(harness.latest(agent.id).rejections).toContain(702);
  });

  it('lets native sub-agents run and ask the human while their main turn is active', async () => {
    const { app, harness, create } = await fixture();
    const agent = await create();
    const rules = await readFile(join(agent.workspace, 'AGENTS.md'), 'utf8');
    expect(rules).toContain('Native sub-agents remain your own capability');
    expect(rules).not.toMatch(/Do not spawn|multi_agent/);
    app.isles.runtime.send(agent.channelId, { body: '交给子代理', clientId: 'delegate' });
    const client = harness.latest(agent.id);
    // A sub-agent's own turn events do not end the main run.
    client.handlers.notification('turn/completed', {
      threadId: 'child-thread',
      turn: { id: 'child-turn', status: 'completed', error: null },
    });
    expect(app.isles.store.agentDetail(agent.id).runs[0]!.status).toBe('running');
    client.question(800, { threadId: 'child-thread', turnId: 'child-turn' });
    const question = app.isles.store.agentDetail(agent.id).questions[0]!;
    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/questions/${question.id}/answer`,
      payload: { answers: { choice: { answers: ['继续'] } } },
    });
    expect(response.statusCode).toBe(200);
    expect(client.responses).toEqual([
      { id: 800, result: { answers: { choice: { answers: ['继续'] } } } },
    ]);
    expect(client.rejections).toEqual([]);
    client.complete();
    await expect
      .poll(() => app.isles.store.agentDetail(agent.id).runs[0]!.status)
      .toBe('completed');
  });

  it('immediately wakes every other group member and private chats, but not for system notices or self messages', async () => {
    const { app, harness, create, say, group, ready } = await fixture();
    const a = await create('A');
    const b = await create('B');
    const c = await create('C');
    const room = group('讨论组', [a.id, b.id]);
    expect(harness.turns).toBe(0);
    say(room.id, '一起看看', { mentions: [b.id] });
    expect(harness.turns).toBe(2);
    expect(harness.bodies(a.id)[0]!.at(-1)).toBe('一起看看');
    const forB = harness.inputs.find((i) => i.agentId === b.id)!.envelope.channels;
    expect(forB).toHaveLength(1);
    expect(forB[0]).toMatchObject({ channel_id: room.id, kind: 'group' });
    expect(forB[0]!.messages[0]!.sender.type).toBe('system');
    expect(forB[0]!.messages[1]!.mentions_you).toBe(true);
    expect(harness.bodies(c.id)).toEqual([]);

    harness.latest(a.id).complete();
    harness.latest(b.id).complete();
    await ready(a.id);
    await ready(b.id);
    const reply = app.isles.runtime.publish(a.id, room.id, { body: 'A 的看法', clientId: 'a-1' });
    expect(reply.deliveries.map((d) => d.agentId)).toEqual([b.id]);
    expect(harness.bodies(b.id)).toHaveLength(2);
    expect(harness.bodies(b.id)[1]).toEqual(['A 的看法']);
    expect(harness.inputs.at(-1)!.envelope.channels[0]!.messages[0]!.sender).toMatchObject({
      type: 'agent',
      id: a.id,
    });
    expect(harness.bodies(a.id)).toHaveLength(1);

    say(c.channelId, '私聊');
    expect(harness.bodies(c.id)).toEqual([['私聊']]);
  });

  it('merges busy input immediately after a turn without waiting for other members, including arrivals at turn completion', async () => {
    const { app, harness, create, say, group, ready } = await fixture();
    const a = await create('A');
    const b = await create('B');
    const room = group('持续讨论', [a.id, b.id]);
    say(room.id, '开始工作');
    expect(harness.turns).toBe(2);
    app.isles.runtime.publish(b.id, room.id, { body: 'B 的进展', clientId: 'progress' });
    say(room.id, '补充要求');
    expect(harness.turns).toBe(2);

    harness.latest(a.id).complete();
    // This arrives before the completion continuation can drain the pending queue.
    say(room.id, '刚结束时的新消息');
    await expect.poll(() => harness.bodies(a.id).length).toBe(2);
    expect(harness.bodies(a.id)[1]).toEqual(['B 的进展', '补充要求', '刚结束时的新消息']);
    expect(harness.bodies(b.id)).toHaveLength(1);
    expect(app.isles.store.publicAgent(b.id).status).toBe('running');

    harness.latest(a.id).complete();
    await ready(a.id);
    expect(harness.bodies(a.id)).toHaveLength(2);
    say(room.id, '空闲后的消息');
    expect(harness.bodies(a.id)[2]).toEqual(['空闲后的消息']);
  });

  it('merges unread channels into one turn: recent ten per channel plus earlier mentions, never repeated', async () => {
    const { app, harness, create, say, group, deliveries, ready } = await fixture();
    const a = await create('A');
    await app.isles.runtime.stop(a.id);
    const room = group('长群', [a.id]);
    say(room.id, '早先点名', { mentions: [a.id] });
    for (let i = 1; i <= 12; i++) say(room.id, `群消息 ${i}`);
    say(a.channelId, '私聊消息');
    await app.isles.runtime.resume(a.id);
    await expect.poll(() => harness.turns).toBe(1);
    const channels = harness.inputs[0]!.envelope.channels;
    expect(channels.map((c) => c.kind)).toEqual(['private', 'group']);
    expect(channels[0]!.messages.map((m) => m.body)).toEqual(['私聊消息']);
    expect(channels[1]!.messages.map((m) => m.body)).toEqual([
      '早先点名',
      ...Array.from({ length: 10 }, (_, i) => `群消息 ${i + 3}`),
    ]);
    expect(channels[1]!.messages[0]!.mentions_you).toBe(true);
    // The creation notice and the two oldest plain messages stay readable through history.
    expect(channels[1]!.skipped_unread).toBe(3);
    const statuses = deliveries(room.id, a.id);
    expect(statuses.filter((s) => s === 'skipped')).toHaveLength(3);
    expect(statuses.filter((s) => s === 'accepted')).toHaveLength(11);
    harness.latest(a.id).complete();
    await ready(a.id);
    say(a.channelId, '新的私聊');
    expect(harness.bodies(a.id)[1]).toEqual(['新的私聊']);
  });

  it('holds messages of a paused group until it resumes, without interrupting a running turn', async () => {
    const { app, harness, create, say, group, deliveries } = await fixture();
    const a = await create('A');
    const room = group('可暂停', [a.id]);
    say(room.id, '第一条');
    await expect.poll(() => harness.turns).toBe(1);
    expect(app.isles.runtime.updateChannel(room.id, { paused: true }).paused).toBe(true);
    expect(app.isles.store.agentDetail(a.id).runs[0]!.status).toBe('running');
    const held = say(room.id, '暂停期间');
    harness.latest(a.id).complete();
    await sleep(300);
    expect(harness.turns).toBe(1);
    expect(deliveries(room.id, a.id).at(-1)).toBe('queued');
    app.isles.runtime.updateChannel(room.id, { paused: false });
    await expect.poll(() => harness.turns).toBe(2);
    expect(harness.bodies(a.id)[1]).toContain(held.body);
    expect(
      app.isles.store
        .listMessages(room.id)
        .filter((m) => m.sender === 'system')
        .map((m) => m.body)
        .join('\n'),
    ).toMatch(/暂停了群讨论[\s\S]*继续了群讨论/);
  });

  it('deletes one group without interrupting a merged turn, its question or later private work, and keeps history after restart', async () => {
    const { app, harness, create, group, say, ready, open } = await fixture();
    const agent = await create('Shared Agent');
    await app.isles.runtime.stop(agent.id);
    const removed = group('Delete this group', [agent.id]);
    const retained = group('Keep this group', [agent.id]);
    const groupInput = say(removed.id, 'Group input');
    const privateInput = say(agent.channelId, 'Private input');
    const retainedInput = say(retained.id, 'Other group input');
    const file = join(agent.workspace, 'group-retained.txt');
    const sharedFile = join(app.isles.runtime.workspace.sharedDir, 'group-retained.txt');
    await writeFile(file, 'personal');
    await writeFile(sharedFile, 'shared');
    expect(
      (await app.inject({ method: 'PATCH', url: `/api/channels/${removed.id}`, payload: {} }))
        .statusCode,
    ).toBe(400);
    await app.isles.runtime.resume(agent.id);
    await expect.poll(() => harness.turns).toBe(1);
    const client = harness.latest(agent.id);
    client.question();
    const question = app.isles.store.agentDetail(agent.id).questions[0]!;
    const active = app.isles.store.agentDetail(agent.id).runs[0]!;
    const response = await app.inject({ method: 'DELETE', url: `/api/channels/${removed.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: removed.id,
      name: removed.name,
      deletedAt: expect.any(String),
      paused: true,
      memberIds: [],
    });
    expect(client.closed).toBe(false);
    expect(client.calls.some((call) => call.method === 'turn/interrupt')).toBe(false);
    expect(app.isles.store.publicAgent(agent.id)).toMatchObject({
      status: 'running',
      desiredState: 'running',
      threadId: agent.threadId,
      workspace: agent.workspace,
    });
    expect(app.isles.store.agentDetail(agent.id).questions).toContainEqual(question);
    expect(app.isles.store.channelDetail(agent.channelId).questions).toContainEqual(question);
    expect(app.isles.store.channelDetail(removed.id).questions).toEqual([]);
    expect(
      (await app.inject('/api/channels'))
        .json()
        .channels.map((channel: { id: string }) => channel.id),
    ).not.toContain(removed.id);
    expect(
      (await app.inject('/api/channels?includeDeleted=true'))
        .json()
        .channels.map((channel: { id: string }) => channel.id),
    ).toContain(removed.id);
    expect((await app.inject('/api/channels?includeDeleted=invalid')).statusCode).toBe(400);
    for (const payload of [{ name: 'Revive' }, { paused: false }])
      expect(
        (await app.inject({ method: 'PATCH', url: `/api/channels/${removed.id}`, payload }))
          .statusCode,
      ).toBe(410);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/channels/${removed.id}/messages`,
          payload: { body: 'Rejected', clientId: 'deleted-group' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/channels/${removed.id}/members`,
          payload: { agentIds: [agent.id] },
        })
      ).statusCode,
    ).toBe(410);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/channels/${removed.id}/members/${agent.id}`,
        })
      ).statusCode,
    ).toBe(410);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/channels/${agent.channelId}` })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/channels/${randomUUID()}` })).statusCode,
    ).toBe(404);
    const cursor = app.isles.store.cursor();
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/channels/${removed.id}` })).json(),
    ).toEqual(response.json());
    expect(app.isles.store.cursor()).toBe(cursor);
    app.isles.runtime.answer(agent.id, question.id, { answers: { choice: { answers: ['继续'] } } });
    expect(client.responses.at(-1)).toMatchObject({ id: 700 });
    say(agent.channelId, 'Next private input');
    client.complete();
    await expect.poll(() => harness.turns).toBe(2);
    expect(harness.bodies(agent.id)[1]).toEqual(['Next private input']);
    expect(app.isles.store.getRun(active.id)).toMatchObject({
      status: 'completed',
      inputs: active.inputs,
    });
    expect(
      app.isles.store.listMessages(removed.id).find((message) => message.seq === groupInput.seq)!
        .deliveries,
    ).toEqual([{ agentId: agent.id, status: 'cancelled' }]);
    for (const input of [privateInput, retainedInput])
      expect(
        app.isles.store.listMessages(input.channelId).find((message) => message.seq === input.seq)!
          .deliveries,
      ).toEqual([{ agentId: agent.id, status: 'completed' }]);
    client.complete();
    await ready(agent.id);
    const history = (await app.inject(`/api/channels/${removed.id}`)).json().messages;
    expect(history.map((message: { body: string }) => message.body)).toContain(groupInput.body);
    expect(await readFile(file, 'utf8')).toBe('personal');
    expect(await readFile(sharedFile, 'utf8')).toBe('shared');
    await app.close();
    const restored = await open();
    cleanups.push(() => restored.close());
    await expect.poll(() => restored.isles.store.publicAgent(agent.id).status).toBe('ready');
    expect(restored.isles.store.publicAgent(agent.id).threadId).toBe(agent.threadId);
    expect(restored.isles.store.publicChannel(removed.id).deletedAt).toBe(
      response.json().deletedAt,
    );
    expect(restored.isles.store.channelDetail(removed.id).messages).toEqual(history);
    expect(restored.isles.store.channelsOf(agent.id).map((channel) => channel.id)).toEqual([
      agent.channelId,
      retained.id,
    ]);
  });

  it('revokes all MCP access to a deleted group while keeping the same Agent able to send and read its private chat', async () => {
    const { app, harness, create, group, say, ready } = await fixture();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const agent = await create('Member', true);
    const removed = group('Deleted group', [agent.id]);
    const retained = group('Live group', [agent.id]);
    say(removed.id, 'Run before deletion');
    const token = await app.isles.runtime.workspace.token(
      agentRoot(app.isles.runtime.workspace.dataDir, agent),
    );
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No listener');
    const client = new Client({ name: 'group-deletion-test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${address.port}/mcp/${agent.id}`),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
      ) as Transport,
    );
    cleanups.push(() => client.close());
    app.isles.runtime.deleteGroup(removed.id);
    for (const [name, args] of [
      ['send_message', { channelId: removed.id, body: 'Rejected', clientId: 'closed-group' }],
      ['read_messages', { channelId: removed.id }],
      ['receive_messages', { channelId: removed.id }],
      ['invite_to_group', { channelId: removed.id, agentIds: [agent.id] }],
    ] as const)
      expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
    const listed = await client.callTool({ name: 'list_channels' });
    const ids = JSON.parse((listed.content as { text: string }[])[0]!.text).channels.map(
      (channel: { channel_id: string }) => channel.channel_id,
    );
    expect(ids).toEqual([agent.channelId, retained.id]);
    expect(
      (
        await client.callTool({
          name: 'send_message',
          arguments: {
            channelId: 'private',
            body: 'Private still works',
            clientId: 'private-after-group',
          },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (await client.callTool({ name: 'read_messages', arguments: { channelId: 'private' } }))
        .isError,
    ).not.toBe(true);
    expect(app.isles.store.listMessages(agent.channelId).at(-1)).toMatchObject({
      senderId: agent.id,
      body: 'Private still works',
    });
    harness.latest(agent.id).complete();
    await ready(agent.id);
    expect(app.isles.store.publicAgent(agent.id).threadId).toBe(agent.threadId);
  });

  it('manages groups over HTTP: new members read history, removal cancels unread, outsiders are refused', async () => {
    const { app, create, say, deliveries } = await fixture();
    const a = await create('A');
    const b = await create('B');
    await app.isles.runtime.stop(a.id);
    await app.isles.runtime.stop(b.id);
    const created = await app.inject({
      method: 'POST',
      url: '/api/channels',
      payload: { name: '项目组', memberIds: [a.id] },
    });
    expect(created.statusCode).toBe(201);
    const room = created.json<{ id: string; memberIds: string[] }>();
    expect(room.memberIds).toEqual([a.id]);
    const before = say(room.id, '入群前的消息');
    let response = await app.inject({
      method: 'POST',
      url: `/api/channels/${room.id}/members`,
      payload: { agentIds: [b.id] },
    });
    expect(response.json<{ memberIds: string[] }>().memberIds).toEqual([a.id, b.id]);
    // Joining grants history, not retroactive unread.
    expect(before.deliveries.map((d) => d.agentId)).toEqual([a.id]);
    say(room.id, '移除前未读', { mentions: [a.id] });
    response = await app.inject({
      method: 'DELETE',
      url: `/api/channels/${room.id}/members/${a.id}`,
    });
    expect(response.json<{ memberIds: string[] }>().memberIds).toEqual([b.id]);
    expect(deliveries(room.id, a.id).at(-2)).toBe('cancelled');
    await app.isles.runtime.resume(a.id);
    expect(() => app.isles.runtime.publish(a.id, room.id, { body: '越权', clientId: 'x' })).toThrow(
      '只能在自己所在的频道发言',
    );
    expect(() => say(room.id, '点名外人', { mentions: [a.id] })).toThrow('只能 @ 该频道的成员');
    expect(() =>
      app.isles.runtime.send(room.id, {
        body: '跨频道回复',
        clientId: randomUUID(),
        replyTo: 9999,
      }),
    ).toThrow('只能回复同一频道中的消息');
    response = await app.inject({
      method: 'PATCH',
      url: `/api/channels/${room.id}`,
      payload: { name: '新名字' },
    });
    expect(response.json<{ name: string }>().name).toBe('新名字');
    response = await app.inject({
      method: 'PATCH',
      url: `/api/channels/${a.channelId}`,
      payload: { paused: true },
    });
    expect(response.statusCode).toBe(400);
    const list = (await app.inject('/api/channels')).json<{
      channels: { id: string; kind: string; lastMessage: { sender: string; body: string } }[];
    }>();
    expect(list.channels.map((c) => c.kind)).toEqual(['private', 'private', 'group']);
    expect(list.channels.at(-1)!.lastMessage).toMatchObject({ sender: 'system' });
    expect(list.channels.at(-1)!.lastMessage.body).toContain('新名字');
  });

  it('binds MCP identity and membership, and shows group tools only while permitted', async () => {
    const { app, harness, create, group } = await fixture();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const agent = await create();
    const other = await create('另一个 Agent');
    const shared = group('共享群', [agent.id, other.id]);
    const outside = group('无关群', [other.id]);
    const token = await app.isles.runtime.workspace.token(
      agentRoot(app.isles.runtime.workspace.dataDir, app.isles.store.getAgent(agent.id)),
    );
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No listener');
    const url = new URL(`http://127.0.0.1:${address.port}/mcp/${agent.id}`);
    const unauthenticated = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(unauthenticated.status).toBe(401);
    const connect = async () => {
      const client = new Client({ name: 'isles-test', version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }) as Transport,
      );
      cleanups.push(() => client.close());
      return client;
    };
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      try {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as { text: string }[])[0]?.text ?? '';
        return { isError: Boolean(result.isError), text };
      } catch (error) {
        return { isError: true, text: String(error) };
      }
    };
    const tools = async (client: Client) =>
      (await client.listTools()).tools.map((t) => t.name).sort();
    let client = await connect();
    expect(await tools(client)).toEqual([
      'list_agents',
      'list_channels',
      'read_messages',
      'receive_messages',
      'send_message',
    ]);
    for (const channelId of [other.channelId, outside.id])
      expect(
        (await call(client, 'send_message', { channelId, body: '越权', clientId: 'cross' }))
          .isError,
      ).toBe(true);
    expect((await call(client, 'read_messages', { channelId: outside.id })).isError).toBe(true);
    const input = { channelId: shared.id, body: '正式 MCP 回复', clientId: 'mcp-reply' };
    await call(client, 'send_message', { ...input, mentions: [other.id] });
    await call(client, 'send_message', { ...input, mentions: [other.id] });
    const saved = app.isles.store.listMessages(shared.id).filter((m) => m.sender === 'agent');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ senderId: agent.id, body: input.body, mentions: [other.id] });
    expect(JSON.stringify(app.isles.store.agentDetail(agent.id))).not.toContain(token);
    const history = parseMessageText(
      (await call(client, 'read_messages', { channelId: shared.id })).text,
      agent.channelId,
      agent.id,
      harness.directory(),
    );
    expect(history.channels[0]!.messages.at(-1)).toMatchObject({
      body: input.body,
      sender: { type: 'agent', id: agent.id },
    });
    const channels = JSON.parse((await call(client, 'list_channels', {})).text).channels;
    expect(channels.map((c: { channel_id: string }) => c.channel_id).sort()).toEqual(
      [agent.channelId, shared.id].sort(),
    );
    expect((await call(client, 'create_group', { name: '私建', memberIds: [] })).isError).toBe(
      true,
    );

    const clients = harness.clients.filter((c) => c.agent.id === agent.id).length;
    let response = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      payload: { canCreateGroups: true },
    });
    expect(response.json<{ canCreateGroups: boolean }>().canCreateGroups).toBe(true);
    // The idle native process restarts on the same thread to reload its tool list.
    await expect
      .poll(() => harness.clients.filter((c) => c.agent.id === agent.id).length)
      .toBe(clients + 1);
    expect(harness.clients.filter((c) => c.agent.id === agent.id).at(-2)!.closed).toBe(true);
    expect(harness.latest(agent.id).calls[0]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: agent.threadId },
    });
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    client = await connect();
    expect(await tools(client)).toContain('create_group');
    expect(await tools(client)).toContain('invite_to_group');
    const made = JSON.parse(
      (await call(client, 'create_group', { name: 'Agent 建的群', memberIds: [] })).text,
    );
    expect(made.members.map((m: { id: string }) => m.id)).toEqual([agent.id]);
    const invited = JSON.parse(
      (await call(client, 'invite_to_group', { channelId: made.channel_id, agentIds: [other.id] }))
        .text,
    );
    expect(invited.members.map((m: { id: string }) => m.id)).toEqual([agent.id, other.id]);
    expect(app.isles.store.getChannel(made.channel_id).createdBy).toBe(agent.id);

    response = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      payload: { canCreateGroups: false },
    });
    expect(response.statusCode).toBe(200);
    // Revocation applies at once, even to a connection that listed the tools earlier.
    expect((await call(client, 'create_group', { name: '撤销后', memberIds: [] })).isError).toBe(
      true,
    );
  });

  it('paginates more than 500 durable events and resumes SSE from Last-Event-ID', async () => {
    const { app, create } = await fixture();
    const agent = await create();
    await app.isles.runtime.stop(agent.id);
    for (let i = 0; i < 620; i++)
      app.isles.store.saveMessage(
        agent.channelId,
        { type: 'user' },
        { body: `消息 ${i}`, clientId: randomUUID() },
      );
    let cursor = 0;
    const ids: number[] = [];
    do {
      const page = (await app.inject(`/api/events?after=${cursor}`)).json<{
        events: { id: number }[];
        cursor: number;
      }>();
      ids.push(...page.events.map((e) => e.id));
      cursor = page.cursor;
    } while (cursor < app.isles.store.cursor());
    expect(new Set(ids).size).toBe(app.isles.store.cursor());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No listener');
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events?after=0`, {
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(cursor - 2) },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    let chunk = '';
    while (!chunk.includes(`id: ${cursor}\n`))
      chunk += new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain(`id: ${cursor - 1}\n`);
    expect(chunk).not.toContain('id: 1\n');
    controller.abort();
    // A full replay can apply backpressure and close. It must never write again
    // after end, and the next connection can continue from its last received ID.
    const replay = await fetch(`http://127.0.0.1:${address.port}/api/events`, {
      headers: { Accept: 'text/event-stream' },
    });
    await replay.body!.cancel();
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  });
});
