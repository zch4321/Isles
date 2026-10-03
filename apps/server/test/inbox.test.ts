import { messageKey } from '@isles/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { agentRoot } from '../src/codex/environment.js';
import {
  MockHarness,
  testCatalog,
  testConfig,
  parseMessageText,
  type Envelope,
} from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

const identities = new WeakMap<Client, { privateChannelId: string; agentId: string }>();

type App = Awaited<ReturnType<typeof buildApp>>;
type Inbox = Envelope & { has_more: boolean };
type History = Envelope['channels'][number] & {
  nextAfter: number | null;
  nextBefore: number | null;
};

async function connect(app: App, agentId: string) {
  const token = await app.isles.runtime.environment.token(
    agentRoot(app.isles.runtime.environment.dataDir, app.isles.store.getAgent(agentId)),
  );
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  const client = new Client({ name: 'inbox-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/${agentId}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as Transport,
  );
  cleanups.push(() => client.close());
  identities.set(client, {
    privateChannelId: app.isles.store.getAgent(agentId).channelId,
    agentId,
  });
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError).not.toBe(true);
  const identity = identities.get(client)!;
  const parsed = parseMessageText(
    (response.content as { text: string }[])[0]!.text,
    identity.privateChannelId,
    identity.agentId,
  );
  return (
    name === 'read_messages'
      ? {
          ...parsed.channels[0],
          messages: parsed.channels[0]?.messages ?? [],
          nextAfter: parsed.nextAfter,
          nextBefore: parsed.nextBefore,
        }
      : parsed
  ) as T;
}
const receivedIds = (inbox: Inbox) =>
  inbox.channels.flatMap((channel) =>
    channel.messages.map((message) =>
      messageKey({ channelId: channel.channel_id, seq: message.seq }),
    ),
  );

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'isles-inbox-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const harness = new MockHarness();
  const open = async () => {
    const app = await buildApp({
      config: testConfig(dir),
      catalog: testCatalog,
      clientFactory: harness.factory,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => app.close());
    return app;
  };
  const app = await open();
  const create = async (name: string) => {
    const agent = await app.isles.runtime.createAgent({
      name,
      model: 'test-model',
      reasoningEffort: 'max',
    });
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    return app.isles.store.publicAgent(agent.id);
  };
  const say = (channelId: string, body: string) =>
    app.isles.runtime.send(channelId, { body, clientId: randomUUID() });
  const group = (name: string, memberIds: string[]) =>
    app.isles.runtime.createGroup('user', { name, memberIds });
  const status = (channelId: string, seq: number, agentId: string) =>
    app.isles.store
      .listMessages(channelId)
      .find((message) => message.seq === seq)!
      .deliveries.find((delivery) => delivery.agentId === agentId)?.status;
  return { app, harness, open, create, say, group, status };
}

describe('MCP inbox delivery', () => {
  it('binds the private alias and resolves numeric replies within the target channel', async () => {
    const { app, create, say, group } = await fixture();
    const a = await create('A');
    const first = say(a.channelId, 'Private first');
    const room = group('Group', [a.id]);
    const client = await connect(app, a.id);
    const send = async (channelId: string, body: string, replyTo: unknown, clientId: string) =>
      client.callTool({ name: 'send_message', arguments: { channelId, body, replyTo, clientId } });
    const privateReply = await send('private', 'Private reply', first.seq, 'reply');
    expect(privateReply.isError).not.toBe(true);
    expect(JSON.parse((privateReply.content as { text: string }[])[0]!.text)).toEqual({
      channel_id: a.channelId,
      seq: 2,
    });
    expect((await send(room.id, 'Group reply', 1, 'reply')).isError).not.toBe(true);
    expect(app.isles.store.listMessages(a.channelId)[1]).toMatchObject({
      channelId: a.channelId,
      seq: 2,
      replyTo: 1,
      body: 'Private reply',
    });
    expect(app.isles.store.listMessages(room.id)[1]).toMatchObject({
      channelId: room.id,
      seq: 2,
      replyTo: 1,
      body: 'Group reply',
    });
    await send('private', 'Private reply', first.seq, 'reply');
    expect(app.isles.store.listMessages(a.channelId)).toHaveLength(2);
    expect((await send('private', 'Bad reply', randomUUID(), 'bad')).isError).toBe(true);
    expect((await send('private', 'Missing sequence', 999, 'missing')).isError).toBe(true);
    const history = await call<History>(client, 'read_messages', { channelId: 'private' });
    expect(history.channel_id).toBe(a.channelId);
    expect(history.messages.map((message) => message.body)).toEqual([
      'Private first',
      'Private reply',
    ]);
  });

  it('receives only returned messages for the caller and immediately schedules only the unread remainder', async () => {
    const { app, harness, create, say, group, status } = await fixture();
    const a = await create('A');
    const b = await create('B');
    const room = group('讨论', [a.id, b.id]);
    const initial = say(room.id, '开始');
    const one = say(room.id, '第一条未读');
    const two = say(room.id, '第二条未读');
    const three = say(room.id, '第三条未读');
    const client = await connect(app, a.id);
    const cursor = app.isles.store.cursor();

    const inbox = await call<Inbox>(client, 'receive_messages', { channelId: room.id, limit: 1 });
    expect(receivedIds(inbox)).toEqual([messageKey(one)]);
    expect(inbox.has_more).toBe(true);
    expect(inbox.channels[0]).toMatchObject({
      channel_id: room.id,
      kind: 'group',
      skipped_unread: 0,
    });
    // The extra pagination lookahead row is never acknowledged.
    expect(status(room.id, one.seq, a.id)).toBe('received');
    expect(status(room.id, two.seq, a.id)).toBe('queued');
    expect(status(room.id, one.seq, b.id)).toBe('queued');
    const history = await call<History>(client, 'read_messages', {
      channelId: room.id,
      after: one.seq,
      limit: 1,
    });
    expect(history.messages.map((message) => message.seq)).toEqual([two.seq]);
    expect(history.nextAfter).toBe(two.seq);
    expect(status(room.id, two.seq, a.id)).toBe('received');
    expect(status(room.id, three.seq, a.id)).toBe('queued');
    // Reading input already assigned to a native run does not change its lifecycle.
    await call(client, 'read_messages', { channelId: room.id, before: one.seq, limit: 1 });
    expect(status(room.id, initial.seq, a.id)).toBe('accepted');
    expect(app.isles.store.eventsAfter(cursor)).toMatchObject([
      { type: 'delivery', agentId: a.id, channelId: room.id, data: { status: 'received' } },
      { type: 'delivery', agentId: a.id, channelId: room.id, data: { status: 'received' } },
    ]);
    expect(harness.turns).toBe(2);

    harness.latest(a.id).complete();
    await expect.poll(() => harness.bodies(a.id).length).toBe(2);
    expect(harness.bodies(a.id)[1]).toEqual([three.body]);
    expect(harness.bodies(b.id)).toHaveLength(1);
    harness.latest(a.id).complete();
    await expect.poll(() => app.isles.store.publicAgent(a.id).status).toBe('ready');
    expect(harness.bodies(a.id)).toHaveLength(2);
    harness.latest(b.id).complete();
    await expect.poll(() => harness.bodies(b.id).length).toBe(2);
    expect(harness.bodies(b.id)[1]).toEqual([one.body, two.body, three.body]);
  });

  it('atomically drains an inbox across channels, including explicit reads of paused groups, without an extra turn', async () => {
    const { app, harness, create, say, group } = await fixture();
    const a = await create('A');
    say(a.channelId, '长任务');
    const first = group('第一群', [a.id]);
    const second = group('暂停群', [a.id]);
    app.isles.runtime.updateChannel(second.id, { paused: true });
    say(first.id, '群内更新');
    say(second.id, '暂停期间的更新');
    say(a.channelId, '私聊更新');
    const expected = [a.channelId, first.id, second.id].flatMap((channelId) =>
      app.isles.store
        .listMessages(channelId)
        .filter((message) =>
          message.deliveries.some(
            (delivery) => delivery.agentId === a.id && delivery.status === 'queued',
          ),
        )
        .map((message) => messageKey(message)),
    );
    const client = await connect(app, a.id);
    const pages = await Promise.all([
      call<Inbox>(client, 'receive_messages', { limit: 1 }),
      call<Inbox>(client, 'receive_messages', { limit: 1 }),
    ]);
    expect(pages.every((page) => page.has_more)).toBe(true);
    expect(new Set(pages.flatMap(receivedIds)).size).toBe(2);
    pages.push(await call<Inbox>(client, 'receive_messages'));
    expect(pages.at(-1)!.has_more).toBe(false);
    expect(pages.flatMap(receivedIds).sort()).toEqual(expected.sort());
    expect(await call<Inbox>(client, 'receive_messages')).toMatchObject({
      type: 'isles.messages',
      channels: [],
      has_more: false,
    });

    harness.latest(a.id).complete();
    await expect.poll(() => app.isles.store.publicAgent(a.id).status).toBe('ready');
    expect(harness.turns).toBe(1);
    app.isles.runtime.updateChannel(second.id, { paused: false });
    // The resume notice alone is not a reason to create a new native turn.
    expect(harness.turns).toBe(1);
    expect(app.isles.store.agentDetail(a.id).runs).toHaveLength(1);
  });

  it('persists partial history receipts across restart and resumes only unread messages of a paused group on the same thread', async () => {
    const { app, harness, open, create, say, group, status } = await fixture();
    const a = await create('A');
    say(a.channelId, '处理长任务');
    const room = group('暂停讨论', [a.id]);
    app.isles.runtime.updateChannel(room.id, { paused: true });
    const unread = say(room.id, '尚未读到');
    const read = say(room.id, '主动读到');
    const client = await connect(app, a.id);
    const history = await call<History>(client, 'read_messages', { channelId: room.id, limit: 1 });
    expect(history.messages.map((message) => message.seq)).toEqual([read.seq]);
    expect(history.nextBefore).toBe(read.seq);
    expect(status(room.id, unread.seq, a.id)).toBe('queued');
    expect(status(room.id, read.seq, a.id)).toBe('received');
    harness.latest(a.id).complete();
    await expect.poll(() => app.isles.store.publicAgent(a.id).status).toBe('ready');
    expect(harness.turns).toBe(1);
    await client.close();
    await app.close();

    const reopened = await open();
    await expect.poll(() => reopened.isles.store.publicAgent(a.id).status).toBe('ready');
    expect(reopened.isles.store.publicAgent(a.id).threadId).toBe(a.threadId);
    expect(
      reopened.isles.store.listMessages(room.id).find((message) => message.seq === read.seq)!
        .deliveries,
    ).toEqual([{ agentId: a.id, status: 'received' }]);
    expect(harness.turns).toBe(1);
    reopened.isles.runtime.updateChannel(room.id, { paused: false });
    await expect.poll(() => harness.turns).toBe(2);
    expect(harness.bodies(a.id)[1]).toContain(unread.body);
    expect(harness.bodies(a.id)[1]).not.toContain(read.body);
  });

  it('rejects foreign channels, removed membership, invalid reads and stopped inbox access without consuming messages', async () => {
    const { app, create, say, group, status } = await fixture();
    const a = await create('A');
    const b = await create('B');
    say(a.channelId, '长任务');
    const pending = say(a.channelId, '保留未读');
    const shared = group('曾经加入', [a.id, b.id]);
    const outside = group('其他群', [b.id]);
    const removed = say(shared.id, '移出前未读');
    app.isles.runtime.removeMember(shared.id, a.id);
    const client = await connect(app, a.id);
    for (const channelId of [b.channelId, outside.id, shared.id]) {
      for (const name of ['read_messages', 'receive_messages'])
        expect((await client.callTool({ name, arguments: { channelId } })).isError).toBe(true);
    }
    expect(
      (
        await client.callTool({
          name: 'read_messages',
          arguments: { channelId: a.channelId, before: 10, after: 0 },
        })
      ).isError,
    ).toBe(true);
    expect(
      (await client.callTool({ name: 'receive_messages', arguments: { limit: 0 } })).isError,
    ).toBe(true);
    expect(status(a.channelId, pending.seq, a.id)).toBe('queued');
    expect(status(shared.id, removed.seq, a.id)).toBe('cancelled');
    await app.isles.runtime.stop(a.id);
    expect((await client.callTool({ name: 'receive_messages', arguments: {} })).isError).toBe(true);
    expect(status(a.channelId, pending.seq, a.id)).toBe('queued');
    expect(app.isles.store.publicAgent(a.id).desiredState).toBe('stopped');
  });
});
