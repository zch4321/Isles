import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/database.js';
import {
  agents,
  channelMembers,
  channels,
  deliveries,
  events,
  messages,
  questions,
  runItems,
  runs,
} from '../src/storage/schema.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
const time = '2026-10-03T00:00:00.000Z';

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'isles-database-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'data');
  const database = openDatabase(dataDir);
  cleanups.push(() => {
    if (database.sqlite.open) database.sqlite.close();
  });
  return { ...database, dataDir };
}

function agent(id: string) {
  return {
    id,
    name: id,
    model: 'test-model',
    reasoningEffort: 'high',
    workspace: `workspace-${id}`,
    nativeHome: `home-${id}`,
    status: 'ready' as const,
    createdAt: time,
    updatedAt: time,
  };
}

function group(id: string) {
  return {
    id,
    kind: 'group' as const,
    name: id,
    createdBy: 'user',
    createdAt: time,
    updatedAt: time,
  };
}

function message(channelId: string, seq: number, clientId = `client-${seq}`) {
  return {
    channelId,
    seq,
    sender: 'user' as const,
    senderId: 'user',
    body: `Message ${seq}`,
    clientId,
    createdAt: time,
  };
}

describe('database baseline', () => {
  it('initializes the current schema in a new data directory', async () => {
    const { sqlite } = await fixture();
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all(),
    ).toEqual(
      [
        '__drizzle_migrations',
        'agents',
        'channel_members',
        'channels',
        'deliveries',
        'events',
        'messages',
        'questions',
        'run_items',
        'runs',
      ].map((name) => ({ name })),
    );
    expect(sqlite.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get()).toEqual({
      count: 1,
    });
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    const messageColumns = sqlite.pragma('table_info(messages)') as {
      name: string;
      type: string;
      pk: number;
    }[];
    expect(messageColumns.filter((column) => column.pk).map((column) => column.name)).toEqual([
      'channel_id',
      'seq',
    ]);
    expect(messageColumns.find((column) => column.name === 'reply_to')?.type).toBe('INTEGER');
    expect(messageColumns.map((column) => column.name)).not.toContain('id');
  });

  it('reopens the current database without reapplying the baseline or changing stored data', async () => {
    const { db, sqlite, dataDir } = await fixture();
    db.insert(agents)
      .values({ ...agent('a'), threadId: 'native-thread' })
      .run();
    db.insert(channels)
      .values({ ...group('left'), nextMessageSeq: 8 })
      .run();
    db.insert(messages).values(message('left', 7)).run();
    const expectedAgent = db.select().from(agents).all();
    const expectedChannel = db.select().from(channels).all();
    const expectedMessage = db.select().from(messages).all();
    const migrations = sqlite.prepare('SELECT * FROM __drizzle_migrations').all();
    sqlite.close();

    const reopened = openDatabase(dataDir);
    cleanups.push(() => reopened.sqlite.close());
    expect(reopened.db.select().from(agents).all()).toEqual(expectedAgent);
    expect(reopened.db.select().from(channels).all()).toEqual(expectedChannel);
    expect(reopened.db.select().from(messages).all()).toEqual(expectedMessage);
    expect(reopened.sqlite.prepare('SELECT * FROM __drizzle_migrations').all()).toEqual(migrations);
    expect(reopened.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('enforces channel-scoped message identity, positive sequences and sender-scoped deduplication', async () => {
    const { db } = await fixture();
    db.insert(channels)
      .values([group('left'), group('right')])
      .run();
    db.insert(messages)
      .values(message('left', 1, 'same-client'))
      .run();
    db.insert(messages)
      .values(message('right', 1, 'same-client'))
      .run();
    expect(() =>
      db
        .insert(messages)
        .values(message('left', 1, 'another-client'))
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      db
        .insert(messages)
        .values(message('left', 2, 'same-client'))
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    for (const seq of [0, -1])
      expect(() => db.insert(messages).values(message('left', seq)).run()).toThrow(
        /CHECK constraint failed/,
      );
    db.insert(messages)
      .values({ ...message('left', 2, 'same-client'), sender: 'agent', senderId: 'a' })
      .run();
    db.insert(messages)
      .values({ ...message('left', 3, 'same-client'), sender: 'agent', senderId: 'b' })
      .run();
    expect(() => db.insert(messages).values(message('missing', 1)).run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('requires replies to reference a message in the same channel', async () => {
    const { db, sqlite } = await fixture();
    db.insert(channels)
      .values([group('left'), group('right')])
      .run();
    db.insert(messages).values(message('left', 1)).run();
    db.insert(messages).values(message('right', 2)).run();
    expect(() =>
      db
        .insert(messages)
        .values({ ...message('left', 3), replyTo: 2 })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      db
        .insert(messages)
        .values({ ...message('left', 3), replyTo: 99 })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    db.insert(messages)
      .values({ ...message('left', 3), replyTo: 1 })
      .run();
    expect(() =>
      sqlite.prepare('DELETE FROM messages WHERE channel_id = ? AND seq = ?').run('left', 1),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('requires deliveries to reference the receiving agent and exact channel sequence', async () => {
    const { db, sqlite } = await fixture();
    db.insert(agents)
      .values([agent('a'), agent('b')])
      .run();
    db.insert(channels)
      .values([group('left'), group('right')])
      .run();
    db.insert(messages)
      .values([message('left', 1), message('right', 2)])
      .run();
    const delivery = {
      channelId: 'left',
      seq: 1,
      agentId: 'a',
      status: 'queued' as const,
      updatedAt: time,
    };
    db.insert(deliveries).values(delivery).run();
    db.insert(deliveries)
      .values({ ...delivery, agentId: 'b' })
      .run();
    expect(() => db.insert(deliveries).values(delivery).run()).toThrow(/UNIQUE constraint failed/);
    for (const invalid of [
      { ...delivery, agentId: 'missing' },
      { ...delivery, channelId: 'right' },
      { ...delivery, seq: 2 },
      { ...delivery, channelId: 'missing' },
    ])
      expect(() => db.insert(deliveries).values(invalid).run()).toThrow(
        /FOREIGN KEY constraint failed/,
      );
    expect(() =>
      sqlite.prepare('DELETE FROM messages WHERE channel_id = ? AND seq = ?').run('left', 1),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('preserves agent uniqueness, channel shape and membership relationships', async () => {
    const { db } = await fixture();
    db.insert(agents)
      .values({ ...agent('a'), threadId: 'native-thread' })
      .run();
    expect(() =>
      db
        .insert(agents)
        .values({ ...agent('b'), threadId: 'native-thread' })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      db
        .insert(agents)
        .values({ ...agent('b'), harness: 'other' })
        .run(),
    ).toThrow(/CHECK constraint failed/);
    db.insert(agents).values(agent('b')).run();
    const privateChannel = {
      ...group('private-a'),
      kind: 'private' as const,
      name: null,
      agentId: 'a',
    };
    db.insert(channels).values(privateChannel).run();
    expect(() =>
      db
        .insert(channels)
        .values({ ...privateChannel, id: 'duplicate-private' })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    for (const invalid of [
      { ...privateChannel, id: 'unnamed-group', kind: 'group' as const, agentId: null },
      { ...group('named-private'), kind: 'private' as const, agentId: 'b' },
      { ...group('agent-group'), agentId: 'b' },
    ])
      expect(() => db.insert(channels).values(invalid).run()).toThrow(/CHECK constraint failed/);
    const member = { channelId: 'private-a', agentId: 'a', addedBy: 'user', joinedAt: time };
    db.insert(channelMembers).values(member).run();
    expect(() => db.insert(channelMembers).values(member).run()).toThrow(
      /UNIQUE constraint failed/,
    );
    expect(() =>
      db
        .insert(channelMembers)
        .values({ ...member, agentId: 'missing' })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      db
        .insert(channelMembers)
        .values({ ...member, channelId: 'missing' })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('preserves run, question and event foreign keys', async () => {
    const { db, sqlite } = await fixture();
    db.insert(agents).values(agent('a')).run();
    const run = {
      id: 'run',
      agentId: 'a',
      threadId: 'thread',
      status: 'running' as const,
      createdAt: time,
    };
    expect(() =>
      db
        .insert(runs)
        .values({ ...run, agentId: 'missing' })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    db.insert(runs).values(run).run();
    const item = {
      key: 'key',
      runId: 'run',
      id: 'item',
      type: 'message',
      status: 'completed',
      text: 'text',
    };
    expect(() =>
      db
        .insert(runItems)
        .values({ ...item, runId: 'missing' })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    db.insert(runItems).values(item).run();
    const question = {
      id: 'question',
      agentId: 'a',
      runId: 'run',
      nativeRequestId: 'request',
      turnId: 'turn',
      status: 'pending' as const,
      definition: '{}',
      createdAt: time,
    };
    for (const invalid of [
      { ...question, agentId: 'missing' },
      { ...question, runId: 'missing' },
    ])
      expect(() => db.insert(questions).values(invalid).run()).toThrow(
        /FOREIGN KEY constraint failed/,
      );
    db.insert(questions).values(question).run();
    const event = { type: 'agent' as const, agentId: 'a', data: '{}', createdAt: time };
    expect(() =>
      db
        .insert(events)
        .values({ ...event, agentId: 'missing' })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      db
        .insert(events)
        .values({ ...event, channelId: 'missing' })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    db.insert(events).values(event).run();
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});
