import type { DeliveryStatus } from '@isles/contracts';
import { and, eq, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/database.js';
import { channelMembers, channels, deliveries, events } from '../src/storage/schema.js';
import { Store } from '../src/storage/store.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups.length = 0;
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'isles-group-deletion-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => {
    const database = openDatabase(join(dir, 'data'));
    cleanups.push(() => {
      if (database.sqlite.open) database.sqlite.close();
    });
    return new Store(database, join(dir, 'workspace'));
  };
  const store = open();
  const create = (name: string) => {
    const agent = store.createAgent({
      harness: 'codex',
      name,
      model: 'test-model',
      reasoningEffort: 'high',
      canCreateGroups: true,
      nativeHome: join(dir, 'native'),
    });
    store.updateAgent(agent.id, { status: 'ready', threadId: `thread-${agent.id}` });
    return store.getAgent(agent.id);
  };
  const say = (channelId: string, body: string) =>
    store.saveMessage(channelId, { type: 'user' }, { body, clientId: randomUUID() });
  return { store, open, create, say };
}

describe('group logical deletion', () => {
  it('atomically retires only the group while preserving native runs, questions, authors and files', () => {
    const { store, create, say } = fixture();
    const a = create('A');
    const b = create('B');
    const group = store.createGroup('user', '删除的群', [a.id, b.id]);
    const outside = store.createGroup('user', '保留的群', [a.id, b.id]);
    say(group.id, '群输入');
    say(a.channelId, '私聊输入');
    say(outside.id, '其他群输入');
    const run = store.startRun(a.id, a.threadId!)!.run;
    store.acceptRun(run.id, 'native-turn');
    store.updateItems(run.id, [
      {
        id: 'reasoning',
        type: 'reasoning',
        status: 'completed',
        text: '保留原生记录',
      },
    ]);
    const question = store.createQuestion(a.id, run.id, 'native-turn', 1, [
      {
        id: 'choice',
        header: '选择',
        question: '继续吗？',
        options: [],
        isOther: false,
        isSecret: false,
        multiSelect: false,
      },
    ]);
    const authored = store.saveMessage(
      group.id,
      { type: 'agent', id: a.id },
      { body: '保留作者', clientId: 'authored' },
    );
    const statuses: DeliveryStatus[] = [
      'queued',
      'skipped',
      'submitting',
      'steering',
      'accepted',
      'received',
      'failed',
      'uncertain',
      'cancelled',
    ];
    const seeded = statuses.map((status) => {
      const message = say(group.id, status);
      store.database.db
        .update(deliveries)
        .set({ status, runId: run.id, turnId: 'native-turn' })
        .where(
          and(
            eq(deliveries.agentId, a.id),
            eq(deliveries.channelId, group.id),
            eq(deliveries.seq, message.seq),
          ),
        )
        .run();
      return message;
    });
    mkdirSync(a.workspace, { recursive: true });
    const file = join(a.workspace, 'history.txt');
    writeFileSync(file, 'keep workspace');
    const beforeAgents = store.listAgents(true);
    const beforeRun = store.getRun(run.id);
    const beforePrivate = store.channelDetail(a.channelId);
    const beforeOutside = store.channelDetail(outside.id);
    const beforeSeq = store.getChannel(group.id).nextMessageSeq;
    const cursor = store.cursor();
    let observations = 0;
    const unsubscribe = store.subscribe(() => {
      observations++;
      expect(store.publicChannel(group.id)).toMatchObject({ paused: true, memberIds: [] });
      expect(store.groupDeletedAt(group.id)).not.toBeNull();
      expect(store.memberIds(group.id)).toEqual([]);
      expect(
        store.database.db
          .select()
          .from(deliveries)
          .where(eq(deliveries.channelId, group.id))
          .all()
          .some((d) => ['queued', 'skipped', 'submitting', 'steering'].includes(d.status)),
      ).toBe(false);
    });

    const deleted = store.deleteGroup(group.id);
    unsubscribe();
    expect(observations).toBeGreaterThan(0);
    expect(deleted).toMatchObject({
      id: group.id,
      name: group.name,
      paused: true,
      memberIds: [],
      deletedAt: expect.any(String),
    });
    expect(store.listChannels().map((c) => c.id)).not.toContain(group.id);
    expect(store.listChannels(true).map((c) => c.id)).toContain(group.id);
    expect(store.channelsOf(a.id).map((c) => c.id)).toEqual([a.channelId, outside.id]);
    expect(store.channelsOf(b.id).map((c) => c.id)).toEqual([b.channelId, outside.id]);
    expect(store.publicChannel(a.channelId).deletedAt).toBeNull();
    expect(store.listAgents(true)).toEqual(beforeAgents);
    expect(store.getRun(run.id)).toEqual(beforeRun);
    expect(store.getQuestion(question).status).toBe('pending');
    expect(store.channelDetail(a.channelId)).toEqual({ ...beforePrivate, cursor: store.cursor() });
    expect(store.channelDetail(outside.id)).toEqual({ ...beforeOutside, cursor: store.cursor() });
    expect(store.listMessages(group.id).find((m) => m.seq === authored.seq)).toMatchObject({
      sender: 'agent',
      senderId: a.id,
      body: '保留作者',
    });
    expect(store.listMessages(group.id).at(-1)).toMatchObject({
      seq: beforeSeq,
      sender: 'system',
      body: '用户删除了群聊，聊天历史已保留。',
      deliveries: expect.arrayContaining([
        { agentId: a.id, status: 'cancelled' },
        { agentId: b.id, status: 'cancelled' },
      ]),
    });
    expect(store.getChannel(group.id).nextMessageSeq).toBe(beforeSeq + 1);
    expect(readFileSync(file, 'utf8')).toBe('keep workspace');
    expect(store.getAgent(a.id).nativeHome).toBe(a.nativeHome);
    const deletionEvents = store.eventsAfter(cursor);
    expect(deletionEvents.find((e) => e.type === 'group_deleted')).toMatchObject({
      channelId: group.id,
      createdAt: deleted.deletedAt,
    });
    expect(deletionEvents.filter((e) => e.type === 'delivery')).toHaveLength(2);
    expect(deletionEvents.filter((e) => e.type === 'delivery')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelId: group.id,
          agentId: a.id,
          data: { status: 'cancelled' },
        }),
        expect.objectContaining({
          channelId: group.id,
          agentId: b.id,
          data: { status: 'cancelled' },
        }),
      ]),
    );

    store.finishRun(run.id, 'completed', 'uncertain');
    for (const [index, message] of seeded.entries()) {
      const delivery = store.database.db
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.agentId, a.id),
            eq(deliveries.channelId, group.id),
            eq(deliveries.seq, message.seq),
          ),
        )
        .get()!;
      expect(delivery).toMatchObject({
        status: index < 4 ? 'cancelled' : statuses[index],
        runId: run.id,
        turnId: 'native-turn',
      });
    }
    expect(store.getRun(run.id)).toMatchObject({
      status: 'completed',
      threadId: a.threadId,
      inputs: beforeRun.inputs,
      items: beforeRun.items,
    });
    expect(store.listMessages(a.channelId)[0]!.deliveries).toEqual([
      { agentId: a.id, status: 'accepted' },
    ]);
    expect(
      store.eventsAfter(deletionEvents.at(-1)!.id).filter((e) => e.type === 'delivery'),
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ channelId: group.id })]));
  });

  it('keeps deleted history read-only before deduplication and rejects all group mutations', () => {
    const { store, create } = fixture();
    const a = create('A');
    const group = store.createGroup('user', '群', [a.id]);
    const input = { body: '原始输入', clientId: 'same-id' };
    store.saveMessage(group.id, { type: 'user' }, input);
    store.deleteGroup(group.id);
    const cursor = store.cursor();
    for (const operation of [
      () => store.updateChannel(group.id, { name: '新名称' }),
      () => store.updateChannel(group.id, { paused: true }),
      () => store.updateChannel(group.id, { paused: false }),
      () => store.addMembers(group.id, 'user', [a.id]),
      () => store.addMembers(group.id, a.id, []),
      () => store.removeMember(group.id, a.id),
    ])
      expect(operation).toThrow(
        expect.objectContaining({ statusCode: 410, message: '群聊已删除' }),
      );
    for (const sender of [{ type: 'user' as const }, { type: 'agent' as const, id: a.id }])
      expect(() => store.saveMessage(group.id, sender, input)).toThrow(
        expect.objectContaining({ statusCode: 409, message: '群聊已删除，历史只读' }),
      );
    expect(() => store.deleteGroup(a.channelId)).toThrow(
      expect.objectContaining({ statusCode: 400, message: '私聊不能删除' }),
    );
    expect(() => store.deleteGroup('missing')).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
    expect(store.channelDetail(group.id).messages).toHaveLength(3);
    expect(store.cursor()).toBe(cursor);
  });

  it('is idempotent and remains deleted across reopening, boot and stale scheduling records', () => {
    const { store, open, create, say } = fixture();
    const a = create('A');
    const group = store.createGroup('user', '群', [a.id]);
    const message = say(group.id, '群输入');
    say(a.channelId, '私聊输入');
    const run = store.startRun(a.id, a.threadId!)!.run;
    const deleted = store.deleteGroup(group.id);
    const cursor = store.cursor();
    expect(store.deleteGroup(group.id)).toEqual(deleted);
    expect(store.cursor()).toBe(cursor);
    store.database.sqlite.close();
    const reopened = open();
    reopened.recoverOnBoot();
    expect(reopened.publicChannel(group.id)).toEqual(deleted);
    expect(reopened.getRun(run.id)).toMatchObject({ status: 'uncertain', threadId: a.threadId });
    expect(reopened.listMessages(group.id).find((m) => m.seq === message.seq)!.deliveries).toEqual([
      { agentId: a.id, status: 'cancelled' },
    ]);
    expect(reopened.listMessages(a.channelId)[0]!.deliveries).toEqual([
      { agentId: a.id, status: 'uncertain' },
    ]);

    // A marker is authoritative even if stale callback/data bypasses normal domain mutations.
    reopened.database.db
      .insert(channelMembers)
      .values({
        channelId: group.id,
        agentId: a.id,
        addedBy: 'user',
        joinedAt: new Date().toISOString(),
      })
      .run();
    reopened.database.db
      .update(channels)
      .set({ paused: false })
      .where(eq(channels.id, group.id))
      .run();
    reopened.database.db
      .update(deliveries)
      .set({ status: 'queued' })
      .where(eq(deliveries.channelId, group.id))
      .run();
    // Removing replayable SSE history must retain the permanent terminal marker.
    reopened.database.db.delete(events).where(ne(events.type, 'group_deleted')).run();
    expect(reopened.groupDeletedAt(group.id)).toBe(deleted.deletedAt);
    expect(reopened.listChannels().map((c) => c.id)).not.toContain(group.id);
    expect(reopened.channelsOf(a.id).map((c) => c.id)).toEqual([a.channelId]);
    expect(reopened.hasPendingMessages(a.id)).toBe(false);
    expect(reopened.startRun(a.id, a.threadId!)).toBeUndefined();
    expect(reopened.receiveMessages(a.id, { limit: 10 })).toEqual({ input: [], hasMore: false });
    expect(reopened.receiveMessages(a.id, { channelId: group.id, limit: 10 })).toEqual({
      input: [],
      hasMore: false,
    });
    reopened.markMessagesReceived(a.id, [message]);
    expect(reopened.listMessages(group.id).find((m) => m.seq === message.seq)!.deliveries).toEqual([
      { agentId: a.id, status: 'queued' },
    ]);
  });

  it('rolls back every deletion change if the durable marker cannot be stored', () => {
    const { store, create, say } = fixture();
    const a = create('A');
    const group = store.createGroup('user', '群', [a.id]);
    say(group.id, '待处理');
    const before = store.channelDetail(group.id);
    store.database.sqlite.exec(`
      CREATE TRIGGER reject_group_deletion BEFORE INSERT ON events
      WHEN NEW.type = 'group_deleted'
      BEGIN SELECT RAISE(ABORT, 'test marker failure'); END;
    `);
    const observed: unknown[] = [];
    const unsubscribe = store.subscribe((event) => observed.push(event));
    expect(() => store.deleteGroup(group.id)).toThrow('test marker failure');
    unsubscribe();
    expect(observed).toEqual([]);
    expect(store.channelDetail(group.id)).toEqual(before);
    expect(store.groupDeletedAt(group.id)).toBeNull();
    expect(store.getChannel(group.id).nextMessageSeq).toBe(3);
    expect(store.hasPendingMessages(a.id)).toBe(true);
  });
});
