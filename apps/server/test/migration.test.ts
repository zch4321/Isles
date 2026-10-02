import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { copyFile, mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/database.js';
import { Store } from '../src/storage/store.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function legacy(brokenReply = false) {
  const dir = await mkdtemp(join(tmpdir(), 'isles-migration-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const migrationsFolder = join(dir, 'old-migrations');
  await mkdir(join(migrationsFolder, 'meta'), { recursive: true });
  await copyFile(
    new URL('../migrations/0000_baseline.sql', import.meta.url),
    join(migrationsFolder, '0000_baseline.sql'),
  );
  await writeFile(
    join(migrationsFolder, 'meta/_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: [
        { idx: 0, version: '6', when: 1790751084480, tag: '0000_baseline', breakpoints: true },
      ],
    }),
  );
  const old = new Database(join(dir, 'isles.sqlite'));
  cleanups.push(() => old.close());
  old.pragma('journal_mode = WAL');
  old.pragma('foreign_keys = ON');
  migrate(drizzle(old), { migrationsFolder });
  const agentId = randomUUID();
  const privateId = randomUUID();
  const groupId = randomUUID();
  const runId = randomUUID();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const time = '2026-10-02T00:00:00.000Z';
  old
    .prepare(
      `INSERT INTO agents (id,name,model,reasoning_effort,workspace,native_home,thread_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      agentId,
      'A',
      'test-model',
      'high',
      join(dir, 'workspace'),
      dir,
      'native-fixed',
      'ready',
      time,
      time,
    );
  old
    .prepare(
      `INSERT INTO channels (id,kind,name,agent_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(privateId, 'private', null, agentId, 'user', time, time);
  old
    .prepare(
      `INSERT INTO channels (id,kind,name,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    )
    .run(groupId, 'group', 'Group', 'user', time, time);
  for (const channelId of [privateId, groupId])
    old
      .prepare('INSERT INTO channel_members VALUES (?,?,?,?)')
      .run(channelId, agentId, 'user', time);
  const insert = old.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)');
  insert.run(ids[0], privateId, 1, 'user', 'user', 'Private first', 'one', null, '[]', time);
  insert.run(ids[1], groupId, 1, 'user', 'user', 'Group first', 'one', null, '[]', time);
  insert.run(
    ids[2],
    groupId,
    2,
    'agent',
    agentId,
    'Reply',
    'reply',
    brokenReply ? ids[0] : ids[1],
    JSON.stringify([agentId]),
    time,
  );
  old
    .prepare(
      'INSERT INTO runs (id,agent_id,thread_id,turn_id,status,created_at,finished_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(runId, agentId, 'native-fixed', 'turn-old', 'completed', time, time);
  old
    .prepare('INSERT INTO deliveries VALUES (?,?,?,?,?,?,?)')
    .run(ids[0], agentId, privateId, 'queued', null, null, time);
  old
    .prepare('INSERT INTO deliveries VALUES (?,?,?,?,?,?,?)')
    .run(ids[1], agentId, groupId, 'received', null, null, time);
  old
    .prepare('INSERT INTO deliveries VALUES (?,?,?,?,?,?,?)')
    .run(ids[2], agentId, groupId, 'completed', runId, 'turn-old', time);
  old
    .prepare('INSERT INTO events (type,agent_id,channel_id,data,created_at) VALUES (?,?,?,?,?)')
    .run('message', null, groupId, JSON.stringify({ messageId: ids[2], seq: 2 }), time);
  old.close();
  return { dir, agentId, privateId, groupId, runId, ids };
}

describe('channel sequence migration', () => {
  it('backs up the legacy database and preserves scoped replies, deliveries, runs, dedupe and event cursors', async () => {
    const { dir, agentId, privateId, groupId, runId, ids } = await legacy();
    const database = openDatabase(dir);
    cleanups.push(() => database.sqlite.close());
    expect(database.migrationBackup).toBeTruthy();
    const backup = new Database(database.migrationBackup!, { readonly: true });
    cleanups.push(() => backup.close());
    expect(backup.prepare('SELECT id FROM messages ORDER BY id').all()).toHaveLength(3);
    expect(backup.prepare('SELECT reply_to FROM messages WHERE id = ?').get(ids[2])).toEqual({
      reply_to: ids[1],
    });
    backup.close();
    const store = new Store(database, dir);
    expect(store.listMessages(privateId)[0]).toMatchObject({
      seq: 1,
      body: 'Private first',
      deliveries: [{ status: 'queued' }],
    });
    expect(store.listMessages(groupId)).toMatchObject([
      { seq: 1, body: 'Group first', deliveries: [{ status: 'received' }] },
      {
        seq: 2,
        replyTo: 1,
        body: 'Reply',
        mentions: [agentId],
        deliveries: [{ status: 'completed' }],
      },
    ]);
    expect(store.getRun(runId).inputs).toEqual([{ channelId: groupId, messageSeqs: [2] }]);
    expect(store.eventsAfter(0)).toMatchObject([{ id: 1, channelId: groupId, data: { seq: 2 } }]);
    expect(store.eventsAfter(0)[0]!.data).not.toHaveProperty('messageId');
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(
      (database.sqlite.pragma('table_info(messages)') as { name: string }[]).map(
        (column) => column.name,
      ),
    ).not.toContain('id');
    expect(
      store.saveMessage(groupId, { type: 'user' }, { body: 'Group first', clientId: 'one' }).seq,
    ).toBe(1);
    const appended = store.saveMessage(
      groupId,
      { type: 'user' },
      { body: 'After upgrade', clientId: 'new', replyTo: 2 },
    );
    expect(appended.seq).toBe(3);
    // An identity that has been allocated is never reused, even if a message is removed.
    database.sqlite.prepare('DELETE FROM deliveries WHERE channel_id = ? AND seq = 3').run(groupId);
    database.sqlite.prepare('DELETE FROM messages WHERE channel_id = ? AND seq = 3').run(groupId);
    expect(
      store.saveMessage(groupId, { type: 'user' }, { body: 'Next', clientId: 'next' }).seq,
    ).toBe(4);
    expect(
      store.saveMessage(privateId, { type: 'user' }, { body: 'Private next', clientId: 'new' }).seq,
    ).toBe(2);
    database.sqlite.close();
    const reopened = openDatabase(dir);
    cleanups.push(() => reopened.sqlite.close());
    expect(reopened.migrationBackup).toBeUndefined();
    expect(
      (await readdir(dir)).filter((name) => name.startsWith('isles-before-channel-seq-')),
    ).toHaveLength(1);
  });

  it('rolls back and keeps a backup when a legacy reply would cross channels', async () => {
    const { dir, ids } = await legacy(true);
    expect(() => openDatabase(dir)).toThrow('消息序号迁移失败，原事务已回滚');
    const old = new Database(join(dir, 'isles.sqlite'));
    cleanups.push(() => old.close());
    expect(old.prepare('SELECT reply_to FROM messages WHERE id = ?').get(ids[2])).toEqual({
      reply_to: ids[0],
    });
    expect(
      (old.pragma('table_info(channels)') as { name: string }[]).map((column) => column.name),
    ).not.toContain('next_message_seq');
    expect(old.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({ n: 1 });
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name LIKE '__new_%'").all()).toEqual(
      [],
    );
    expect(
      (await readdir(dir)).filter((name) => name.startsWith('isles-before-channel-seq-')),
    ).toHaveLength(1);
  });
});
