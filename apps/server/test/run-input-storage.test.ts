import type { Message, MessageRef } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/database.js';
import { Store } from '../src/storage/store.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-run-input-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  let database = openDatabase(data);
  cleanups.push(() => {
    if (database.sqlite.open) database.sqlite.close();
  });
  let store = new Store(database, join(root, 'workspace'));
  const agent = store.createAgent({
    harness: 'codex',
    name: 'Reader',
    model: 'test-model',
    reasoningEffort: 'high',
    canCreateGroups: false,
    steerEnabled: true,
    nativeHome: 'test-native-home',
  });
  store.updateAgent(agent.id, { status: 'running', threadId: 'native-thread' });
  const send = (channelId: string, body: string) =>
    store.saveMessage(channelId, { type: 'user' }, { body, clientId: randomUUID() });
  const status = (message: MessageRef) =>
    store
      .listMessages(message.channelId, { after: message.seq - 1, limit: 1 })[0]!
      .deliveries.find((delivery) => delivery.agentId === agent.id)?.status;
  return {
    get store() {
      return store;
    },
    agent,
    send,
    status,
    reopen() {
      database.sqlite.close();
      database = openDatabase(data);
      store = new Store(database, join(root, 'workspace'));
    },
  };
}

const references = (input: { messages: Message[] }[]) =>
  input.flatMap((entry) => entry.messages.map(({ channelId, seq }) => ({ channelId, seq })));

describe('run input admission', () => {
  it('requeues only live submitting deliveries and retains the original run inputs after retry', async () => {
    const f = await fixture();
    const group = f.store.createGroup('user', 'Group', [f.agent.id]);
    f.store.receiveMessages(f.agent.id, { channelId: group.id, limit: 100 });
    const privateMessage = f.send(f.agent.channelId, 'private');
    const groupMessage = f.send(group.id, 'group');
    const start = f.store.startRun(f.agent.id, 'native-thread')!;
    const refs = references(start.input);
    const originalInputs = structuredClone(start.run.inputs);
    expect(f.store.isRunInputPending(start.run.id, refs)).toBe(true);
    expect(f.store.isRunInputPending(start.run.id, refs, randomUUID())).toBe(false);
    f.store.removeMember(group.id, f.agent.id);
    expect(f.status(groupMessage)).toBe('cancelled');
    f.store.addMembers(group.id, 'user', [f.agent.id]);
    expect(f.store.isRunInputPending(start.run.id, refs)).toBe(false);
    const untouched = f.send(f.agent.channelId, 'later');
    const cursor = f.store.cursor();
    f.store.requeueRunInput(start.run.id);
    expect(f.status(privateMessage)).toBe('queued');
    expect(f.status(groupMessage)).toBe('cancelled');
    expect(f.status(untouched)).toBe('queued');
    expect(f.store.getRun(start.run.id).inputs).toEqual(originalInputs);
    expect(f.store.getRun(start.run.id)).not.toHaveProperty('inputRefs');
    expect(f.store.eventsAfter(cursor)).toContainEqual(
      expect.objectContaining({
        type: 'delivery',
        agentId: f.agent.id,
        channelId: f.agent.channelId,
        data: { runId: start.run.id, status: 'queued' },
      }),
    );
    f.store.finishRun(start.run.id, 'interrupted', 'cancelled');
    const retried = f.store.startRun(f.agent.id, 'native-thread')!;
    expect(references(retried.input)).toContainEqual({
      channelId: privateMessage.channelId,
      seq: privateMessage.seq,
    });
    expect(references(retried.input)).not.toContainEqual({
      channelId: groupMessage.channelId,
      seq: groupMessage.seq,
    });
    f.store.acceptRun(retried.run.id, 'second-turn');
    expect(f.store.getRun(start.run.id).inputs).toEqual(originalInputs);
    f.reopen();
    expect(f.store.getRun(start.run.id).inputs).toEqual(originalInputs);
  });

  it('checks exact steer batch, membership, status and run without changing steering', async () => {
    const f = await fixture();
    const group = f.store.createGroup('user', 'Group', [f.agent.id]);
    f.store.receiveMessages(f.agent.id, { channelId: group.id, limit: 100 });
    f.send(f.agent.channelId, 'initial');
    const run = f.store.startRun(f.agent.id, 'native-thread')!.run;
    f.store.acceptRun(run.id, 'turn-one');
    const privateMessage = f.send(f.agent.channelId, 'private steer');
    const groupMessage = f.send(group.id, 'group steer');
    const batch = f.store.claimSteer(f.agent.id, run.id, 'turn-one')!;
    const refs = references(batch.input);
    expect(f.store.isRunInputPending(run.id, refs, batch.id)).toBe(true);
    expect(f.store.isRunInputPending(run.id, refs)).toBe(false);
    expect(f.store.isRunInputPending(run.id, refs, randomUUID())).toBe(false);
    f.store.requeueRunInput(run.id);
    expect(f.status(privateMessage)).toBe('steering');
    f.store.removeMember(group.id, f.agent.id);
    f.store.addMembers(group.id, 'user', [f.agent.id]);
    expect(f.status(groupMessage)).toBe('cancelled');
    expect(f.store.isRunInputPending(run.id, refs, batch.id)).toBe(false);
    expect(f.store.isRunInputPending(run.id, [privateMessage], batch.id)).toBe(true);
    f.store.rejectSteer(batch.id, 'not submitted');
    expect(f.status(privateMessage)).toBe('queued');
    expect(f.status(groupMessage)).toBe('cancelled');
  });
});
