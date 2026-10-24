import type { DeliveryStatus } from '@isles/contracts';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/database.js';
import { deliveries, runs } from '../src/storage/schema.js';
import { Store } from '../src/storage/store.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups.length = 0;
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'isles-agent-deletion-'));
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
    store.updateAgent(agent.id, {
      status: 'ready',
      threadId: `thread-${agent.id}`,
      threadCreationAttempted: true,
    });
    return store.getAgent(agent.id);
  };
  const say = (channelId: string, body: string) =>
    store.saveMessage(channelId, { type: 'user' }, { body, clientId: randomUUID() });
  return { dir, store, open, create, say };
}

describe('Agent logical deletion', () => {
  it('removes memberships, cancels unfinished deliveries, expires questions and preserves history and files', () => {
    const { store, create, say } = fixture();
    const a = create('历史成员');
    const b = create('保留成员');
    const group = store.createGroup('user', '讨论', [a.id, b.id]);
    const outside = store.createGroup('user', '未加入', [b.id]);
    const privateMessage = say(a.channelId, '待执行的私聊');
    const run = store.startRun(a.id, a.threadId!)!.run;
    store.acceptRun(run.id, 'turn-1');
    store.updateItems(run.id, [
      {
        id: 'item-1',
        type: 'reasoning',
        status: 'completed',
        text: '记录',
      },
    ]);
    const question = store.createQuestion(a.id, run.id, 'turn-1', 1, [
      {
        id: 'choice',
        header: '决定',
        question: '选一个',
        options: [],
        isOther: false,
        isSecret: false,
        multiSelect: false,
      },
    ]);
    const authored = store.saveMessage(
      group.id,
      { type: 'agent', id: a.id },
      { body: '历史发言', clientId: 'authored' },
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
        .set({ status })
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
    const file = join(a.workspace, 'retained.txt');
    writeFileSync(file, 'keep this workspace');
    const outsideBefore = store.listMessages(outside.id);
    const cursor = store.cursor();
    const unsubscribe = store.subscribe(() => {
      // Observers see the complete deletion after the transaction commits.
      expect(store.getAgent(a.id).status).toBe('deleted');
      expect(store.channelsOf(a.id)).toEqual([]);
      expect(store.getQuestion(question).status).toBe('expired');
    });

    expect(store.deleteAgent(a.id)).toMatchObject({
      id: a.id,
      name: a.name,
      status: 'deleted',
      desiredState: 'stopped',
      canCreateGroups: false,
      error: null,
      threadId: a.threadId,
      workspace: a.workspace,
    });
    unsubscribe();
    expect(store.listAgents().map((agent) => agent.id)).toEqual([b.id]);
    expect(store.listAgents(true).map((agent) => agent.id)).toEqual([a.id, b.id]);
    expect(store.memberIds(a.channelId)).toEqual([]);
    expect(store.memberIds(group.id)).toEqual([b.id]);
    expect(store.listMessages(a.channelId)).toMatchObject([
      { ...privateMessage, deliveries: [{ agentId: a.id, status: 'accepted' }] },
    ]);
    expect(store.listMessages(group.id).find((m) => m.seq === authored.seq)).toEqual(authored);
    for (const [index, message] of seeded.entries()) {
      const expected = index < 4 ? 'cancelled' : statuses[index];
      expect(
        store.listMessages(group.id).find((m) => m.seq === message.seq)!.deliveries,
      ).toContainEqual({ agentId: a.id, status: expected });
    }
    expect(store.listMessages(group.id).at(-1)).toMatchObject({
      sender: 'system',
      body: '用户删除了 历史成员，该 Agent 已退出群聊。',
      deliveries: [{ agentId: b.id, status: 'queued' }],
    });
    expect(store.listMessages(outside.id)).toEqual(outsideBefore);
    expect(store.agentDetail(a.id)).toMatchObject({
      agent: { status: 'deleted' },
      runs: [{ id: run.id, status: 'interrupted', items: [{ id: 'item-1', text: '记录' }] }],
      questions: [],
    });
    expect(store.getQuestion(question).status).toBe('expired');
    expect(readFileSync(file, 'utf8')).toBe('keep this workspace');
    expect(store.getAgent(a.id).nativeHome).toBe(a.nativeHome);
    expect(store.eventsAfter(cursor)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent',
          agentId: a.id,
          data: { status: 'deleted', desiredState: 'stopped', canCreateGroups: false, error: null },
        }),
        expect.objectContaining({ type: 'channel', agentId: a.id, channelId: group.id }),
        expect.objectContaining({
          type: 'delivery',
          agentId: a.id,
          channelId: group.id,
          data: { status: 'cancelled' },
        }),
        expect.objectContaining({ type: 'question', agentId: a.id, data: { status: 'expired' } }),
      ]),
    );
  });

  it('keeps deletion notices readable without waking the remaining group members', () => {
    const { store, create } = fixture();
    const a = create('A');
    const b = create('B');
    const group = store.createGroup('user', '群', [a.id, b.id]);
    store.deleteAgent(a.id);
    expect(store.hasPendingMessages(a.id)).toBe(false);
    expect(store.hasPendingMessages(b.id)).toBe(false);
    expect(
      store.receiveMessages(b.id, { channelId: group.id, limit: 10 }).input[0]!.messages,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: '用户删除了 A，该 Agent 已退出群聊。' }),
      ]),
    );
    expect(store.startRun(a.id, a.threadId!)).toBeUndefined();
  });

  it('rejects deleted private-chat writes and new group memberships while history remains readable', () => {
    const { store, create, say } = fixture();
    const a = create('A');
    const b = create('B');
    const before = say(a.channelId, '保留历史');
    const group = store.createGroup('user', '群', [b.id]);
    store.deleteAgent(a.id);
    for (const sender of [{ type: 'user' as const }, { type: 'agent' as const, id: a.id }])
      expect(() =>
        store.saveMessage(a.channelId, sender, { body: '拒绝', clientId: 'after' }),
      ).toThrow('私聊历史只读');
    expect(() => store.createGroup('user', '拒绝', [a.id])).toThrow('只能添加已有的 Agent');
    expect(() => store.createGroup(a.id, '拒绝', [b.id])).toThrow('只能添加已有的 Agent');
    expect(() => store.addMembers(group.id, 'user', [a.id])).toThrow('只能添加已有的 Agent');
    expect(() => store.updateAgent(a.id, { status: 'ready', desiredState: 'running' })).toThrow(
      '该 Agent 已删除',
    );
    expect(() =>
      store.saveMessage(group.id, { type: 'agent', id: a.id }, { body: '拒绝', clientId: 'group' }),
    ).toThrow('只能在自己所在的频道发言');
    expect(store.channelDetail(a.channelId).messages).toMatchObject([{ body: before.body }]);
    expect(store.publicAgent(a.id).name).toBe('A');
  });

  it('is idempotent and survives reopening and boot recovery without restoring deleted Agents', () => {
    const { store, open, create, say } = fixture();
    const a = create('A');
    say(a.channelId, '运行记录');
    const run = store.startRun(a.id, a.threadId!)!.run;
    const deleted = store.deleteAgent(a.id);
    const cursor = store.cursor();
    expect(store.deleteAgent(a.id)).toEqual(deleted);
    expect(store.cursor()).toBe(cursor);
    // Simulate a stale active run from an interrupted callback; boot must not resurrect identity.
    store.database.db
      .update(runs)
      .set({ status: 'running', finishedAt: null })
      .where(eq(runs.id, run.id))
      .run();
    store.database.sqlite.close();
    const reopened = open();
    reopened.recoverOnBoot();
    expect(reopened.publicAgent(a.id)).toEqual(deleted);
    expect(reopened.getRun(run.id)).toMatchObject({ status: 'interrupted' });
    expect(reopened.getRun(run.id).finishedAt).not.toBeNull();
    expect(reopened.listAgents()).toEqual([]);
    expect(reopened.memberIds(a.channelId)).toEqual([]);
    expect(reopened.hasPendingMessages(a.id)).toBe(false);
    expect(reopened.listMessages(a.channelId)[0]!.deliveries).toEqual([
      { agentId: a.id, status: 'cancelled' },
    ]);
  });

  it('rolls the entire deletion back when an event cannot be stored', () => {
    const { store, create, say } = fixture();
    const a = create('A');
    const group = store.createGroup('user', '群', [a.id]);
    say(a.channelId, '待处理');
    const before = store.publicAgent(a.id);
    const cursor = store.cursor();
    store.database.sqlite.exec(`
      CREATE TRIGGER reject_deletion_event BEFORE INSERT ON events
      WHEN NEW.type = 'agent' AND json_extract(NEW.data, '$.status') = 'deleted'
      BEGIN SELECT RAISE(ABORT, 'test event failure'); END;
    `);
    expect(() => store.deleteAgent(a.id)).toThrow('test event failure');
    expect(store.publicAgent(a.id)).toEqual(before);
    expect(store.memberIds(a.channelId)).toEqual([a.id]);
    expect(store.memberIds(group.id)).toEqual([a.id]);
    expect(store.listMessages(a.channelId)[0]!.deliveries).toEqual([
      { agentId: a.id, status: 'queued' },
    ]);
    expect(store.listMessages(group.id)).toHaveLength(1);
    expect(store.cursor()).toBe(cursor);
  });
});
