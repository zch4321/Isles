import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { agentRoot } from '../src/codex/environment.js';
import { MockHarness, testCatalog, parseMessageText } from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups.length = 0;
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'isles-runtime-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const harness = new MockHarness();
  const open = () =>
    buildApp({
      dataDir: dir,
      catalog: testCatalog,
      clientFactory: harness.factory,
      runtimeUrl: 'http://127.0.0.1:1',
    });
  const app = await open();
  cleanups.push(() => app.close());
  const create = async (name = '测试 Agent', canCreateGroups = false) => {
    const result = await app.isles.runtime.createAgent({
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
  it('refuses to run when native discovery does not load the workspace guidance, without replacing the thread', async () => {
    const { app, harness } = await fixture();
    harness.missingGuidance = true;
    const agent = await app.isles.runtime.createAgent({
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
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
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

  it('marks unknown acceptance on crash/restart and never blindly redelivers it', async () => {
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
    expect(store.publicAgent(agent.id).status).toBe('error');
    expect(harness.turns).toBe(1);
    await restarted.isles.runtime.resume(agent.id);
    await expect.poll(() => harness.turns).toBe(2);
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
    const token = await app.isles.runtime.environment.token(
      agentRoot(app.isles.store.getAgent(agent.id)),
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
