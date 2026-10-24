import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/database.js';
import { Store } from '../src/storage/store.js';
import type { MessageRef } from '@isles/contracts';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});

async function fixture(steerEnabled?: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'isles-steer-storage-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  let database = openDatabase(data);
  cleanup.push(() => {
    if (database.sqlite.open) database.sqlite.close();
  });
  let store = new Store(database, join(root, 'workspace'));
  const agent = store.createAgent({
    harness: 'codex',
    name: 'Steer agent',
    model: 'test-model',
    reasoningEffort: 'high',
    canCreateGroups: false,
    nativeHome: 'test-native-home',
    ...(steerEnabled === undefined ? {} : { steerEnabled }),
  });
  store.updateAgent(agent.id, { status: 'running', threadId: 'native-thread' });
  const send = (channelId = agent.channelId, body = 'new input', mentions?: string[]) =>
    store.saveMessage(
      channelId,
      { type: 'user' },
      { body, clientId: randomUUID(), ...(mentions ? { mentions } : {}) },
    );
  send();
  const run = store.startRun(agent.id, 'native-thread')!.run;
  store.acceptRun(run.id, 'turn-one');
  const claim = () => store.claimSteer(agent.id, run.id, 'turn-one');
  const status = (ref: MessageRef) =>
    store
      .listMessages(ref.channelId, { after: ref.seq - 1, limit: 1 })[0]!
      .deliveries.find((d) => d.agentId === agent.id)!.status;
  const delivery = (ref: MessageRef) =>
    database.sqlite
      .prepare(
        'SELECT status, run_id, turn_id, steer_id FROM deliveries WHERE agent_id = ? AND channel_id = ? AND seq = ?',
      )
      .get(agent.id, ref.channelId, ref.seq);
  return {
    store,
    agent,
    run,
    send,
    claim,
    status,
    delivery,
    reopen: () => {
      database.sqlite.close();
      database = openDatabase(data);
      store = new Store(database, join(root, 'workspace'));
      return store;
    },
  };
}

describe('steer delivery storage', () => {
  it.each(['completed', 'interrupted', 'failed', 'uncertain'] as const)(
    'preserves a %s native activity when its question answer is persisted after completion',
    async (status) => {
      const f = await fixture(true);
      const questionId = f.store.createQuestion(
        f.agent.id,
        f.run.id,
        'turn-one',
        'native-question',
        [
          {
            id: 'choice',
            header: 'Choice',
            question: 'Choose a result',
            isOther: true,
            isSecret: false,
            multiSelect: false,
            options: null,
          },
        ],
      );
      expect(f.store.getRun(f.run.id).status).toBe('waiting');
      // The native answer callback can end the turn before Runtime persists the answer.
      f.store.finishRun(
        f.run.id,
        status,
        status === 'interrupted' ? 'cancelled' : 'uncertain',
        'native end',
      );
      const terminal = f.store.getRun(f.run.id);
      const answers = { answers: { choice: { answers: ['result'] } } };
      f.store.answerQuestion(questionId, answers);
      expect(f.store.getQuestion(questionId)).toMatchObject({
        status: 'answered',
        answer: JSON.stringify(answers),
      });
      expect(f.store.getRun(f.run.id)).toEqual(terminal);
    },
  );

  it('resumes a live waiting activity after its final question is answered', async () => {
    const f = await fixture(true);
    const questionId = f.store.createQuestion(f.agent.id, f.run.id, 'turn-one', 'native-question', [
      {
        id: 'choice',
        header: 'Choice',
        question: 'Choose a result',
        isOther: true,
        isSecret: false,
        multiSelect: false,
        options: null,
      },
    ]);
    f.store.answerQuestion(questionId, { answers: { choice: { answers: ['result'] } } });
    expect(f.store.getRun(f.run.id)).toMatchObject({ status: 'running', finishedAt: null });
  });

  it('observes autonomous activity once without claiming queued messages or changing Agent state', async () => {
    const f = await fixture(true);
    const queued = f.send();
    f.store.updateAgent(f.agent.id, { desiredState: 'stopped', status: 'stopped' });
    const cursor = f.store.cursor();
    const observed = f.store.observeRun(f.agent.id, 'native-thread', 'automatic-turn');
    expect(observed).toMatchObject({
      status: 'running',
      turnId: 'automatic-turn',
      inputs: [],
      items: [],
    });
    expect(f.store.observeRun(f.agent.id, 'native-thread', 'automatic-turn')).toEqual(observed);
    expect(f.store.eventsAfter(cursor).filter((event) => event.type === 'run')).toHaveLength(1);
    expect(f.store.findNativeRun(f.agent.id, 'native-thread', 'automatic-turn')).toEqual(observed);
    expect(f.store.findNativeRun(f.agent.id, 'other-session', 'automatic-turn')).toBeUndefined();
    expect(f.store.findNativeRun(randomUUID(), 'native-thread', 'automatic-turn')).toBeUndefined();
    expect(f.status(queued)).toBe('queued');
    expect(f.store.getAgent(f.agent.id)).toMatchObject({
      desiredState: 'stopped',
      status: 'stopped',
    });
    f.store.finishRun(observed.id, 'failed', 'failed', 'background failure');
    expect(f.store.observeRun(f.agent.id, 'native-thread', 'automatic-turn').status).toBe('failed');
    expect(f.status(queued)).toBe('queued');
  });

  it.each(['completed', 'interrupted', 'failed', 'uncertain'] as const)(
    'keeps delivered messages accepted after a %s activity',
    async (status) => {
      const f = await fixture(true);
      const message = f.send();
      const batch = f.claim()!;
      f.store.acceptSteer(batch.id, 'turn-one');
      f.store.finishRun(f.run.id, status, status === 'interrupted' ? 'cancelled' : 'uncertain');
      expect(f.status(message)).toBe('accepted');
      const first = f.store.getRun(f.run.id).inputs[0]!;
      expect(f.status({ channelId: first.channelId, seq: first.messageSeqs[0]! })).toBe('accepted');
      expect(f.store.getRun(f.run.id).status).toBe(status);
    },
  );

  it.each(['completed', 'interrupted', 'failed', 'uncertain'] as const)(
    'records a late initial receipt without reopening a %s activity',
    async (status) => {
      const f = await fixture(true);
      f.store.finishRun(f.run.id, 'completed', 'uncertain');
      const message = f.send();
      const next = f.store.startRun(f.agent.id, 'native-thread')!.run;
      f.store.updateAgent(f.agent.id, { desiredState: 'stopped', status: 'stopped' });
      f.store.finishRun(
        next.id,
        status,
        status === 'interrupted' ? 'cancelled' : 'uncertain',
        'terminal',
      );
      const terminal = f.store.getRun(next.id);
      f.store.acceptRun(next.id, 'late-turn');
      expect(f.store.getRun(next.id)).toMatchObject({
        status,
        error: terminal.error,
        finishedAt: terminal.finishedAt,
        turnId: 'late-turn',
      });
      expect(f.status(message)).toBe('accepted');
      expect(f.store.getAgent(f.agent.id)).toMatchObject({
        desiredState: 'stopped',
        status: 'stopped',
      });
      expect(() => f.store.acceptRun(next.id, 'other-turn')).toThrow('turn');
    },
  );

  it('binds a confirmed steer to its actual native activity and retains the target audit', async () => {
    const f = await fixture(true);
    const message = f.send();
    const batch = f.claim()!;
    f.store.finishRun(f.run.id, 'completed', 'uncertain');
    const actual = f.store.observeRun(f.agent.id, 'native-thread', 'automatic-next');
    f.store.finishRun(actual.id, 'failed', 'failed', 'model failed after receipt');
    f.store.acceptSteer(batch.id, 'automatic-next', actual.id);
    expect(f.delivery(message)).toMatchObject({
      status: 'accepted',
      run_id: actual.id,
      turn_id: 'automatic-next',
      steer_id: batch.id,
    });
    expect(f.store.getRun(actual.id)).toMatchObject({
      status: 'failed',
      inputs: [{ channelId: message.channelId, messageSeqs: [message.seq] }],
    });
    expect(f.store.getRun(f.run.id).inputs.flatMap((input) => input.messageSeqs)).not.toContain(
      message.seq,
    );
    expect(f.store.getSteer(batch.id)).toMatchObject({
      runId: f.run.id,
      turnId: 'turn-one',
      status: 'accepted',
    });
  });

  it('does not accept a steer receipt from another root session', async () => {
    const f = await fixture(true);
    const message = f.send();
    const batch = f.claim()!;
    const other = f.store.observeRun(f.agent.id, 'different-session', 'other-turn');
    expect(() => f.store.acceptSteer(batch.id, 'other-turn', other.id)).toThrow('turn');
    expect(f.status(message)).toBe('steering');
  });

  it.each(['delete-agent', 'delete-group', 'new-session'] as const)(
    'retains confirmed delivery facts after %s',
    async (action) => {
      const f = await fixture(true);
      const group = f.store.createGroup('user', 'confirmed delivery', [f.agent.id]);
      f.store.receiveMessages(f.agent.id, { limit: 100 });
      const message = f.send(group.id);
      f.store.acceptSteer(f.claim()!.id, 'turn-one');
      if (action === 'delete-agent') f.store.deleteAgent(f.agent.id);
      else if (action === 'delete-group') f.store.deleteGroup(group.id);
      else f.store.beginNewSession(f.agent.id);
      expect(f.status(message)).toBe('accepted');
    },
  );

  it('confirms only included steer references after their group membership was removed', async () => {
    const f = await fixture(true);
    const group = f.store.createGroup('user', 'trimmed delivery', [f.agent.id]);
    f.store.receiveMessages(f.agent.id, { limit: 100 });
    const messages = Array.from({ length: 14 }, () => f.send(group.id));
    const batch = f.claim()!;
    f.store.removeMember(group.id, f.agent.id);
    f.store.acceptSteer(batch.id, 'turn-one');
    for (const message of messages.slice(0, 4)) expect(f.status(message)).toBe('cancelled');
    for (const message of messages.slice(4)) expect(f.status(message)).toBe('accepted');
  });

  it('defaults steering off, allows editing it, and refuses wrong or terminal run targets', async () => {
    const f = await fixture();
    const message = f.send();
    expect(f.store.getAgent(f.agent.id).steerEnabled).toBe(false);
    expect(f.claim()).toBeUndefined();
    f.store.updateAgent(f.agent.id, { steerEnabled: true });
    expect(f.store.publicAgent(f.agent.id).steerEnabled).toBe(true);
    expect(f.store.claimSteer(f.agent.id, f.run.id, 'other-turn')).toBeUndefined();
    expect(f.store.claimSteer(f.agent.id, 'missing-run', 'turn-one')).toBeUndefined();
    const other = f.store.createAgent({
      harness: 'codex',
      name: 'Other',
      model: 'test-model',
      reasoningEffort: 'high',
      canCreateGroups: false,
      steerEnabled: true,
      nativeHome: 'test-native-home',
    });
    f.store.updateAgent(other.id, { status: 'running' });
    expect(f.store.claimSteer(other.id, f.run.id, 'turn-one')).toBeUndefined();
    f.store.updateAgent(f.agent.id, { desiredState: 'stopped' });
    expect(f.claim()).toBeUndefined();
    f.store.updateAgent(f.agent.id, { desiredState: 'running' });
    f.store.finishRun(f.run.id, 'completed', 'uncertain');
    expect(f.claim()).toBeUndefined();
    expect(f.status(message)).toBe('queued');
  });

  it.each(['steer-first', 'receipt-first'] as const)(
    'atomically claims without duplicate MCP receipt (%s)',
    async (order) => {
      const f = await fixture(true);
      const message = f.send();
      const steer = () => f.claim();
      const receipt = () => f.store.receiveMessages(f.agent.id, { limit: 1 });
      if (order === 'steer-first') {
        const batch = steer()!;
        expect(batch.input.flatMap((c) => c.messages).map((m) => m.seq)).toEqual([message.seq]);
        expect(receipt().input).toEqual([]);
        // History can display it, but does not mark a claimed steer received.
        f.store.markMessagesReceived(f.agent.id, [message]);
        expect(f.status(message)).toBe('steering');
        expect(steer()).toBeUndefined();
        f.store.acceptRun(f.run.id, 'turn-one');
        expect(f.status(message)).toBe('steering');
        f.store.acceptSteer(batch.id, 'turn-one');
        expect(f.status(message)).toBe('accepted');
      } else {
        expect(
          receipt()
            .input.flatMap((c) => c.messages)
            .map((m) => m.seq),
        ).toEqual([message.seq]);
        expect(steer()).toBeUndefined();
        expect(f.status(message)).toBe('received');
      }
    },
  );

  it('keeps steering pending after native completion, and accepts only the expected turn', async () => {
    const f = await fixture(true);
    const message = f.send();
    const batch = f.claim()!;
    f.store.finishRun(f.run.id, 'completed', 'uncertain');
    expect(f.status(message)).toBe('steering');
    expect(f.store.getSteer(batch.id).status).toBe('pending');
    expect(() => f.store.acceptSteer(batch.id, 'wrong-turn')).toThrow('turn');
    expect(f.status(message)).toBe('steering');
    f.store.acceptSteer(batch.id, 'turn-one');
    expect(f.status(message)).toBe('accepted');
    expect(f.store.getSteer(batch.id).status).toBe('accepted');
    f.store.rejectSteer(batch.id, 'late rejection');
    expect(f.status(message)).toBe('accepted');
    expect(f.store.startRun(f.agent.id, 'native-thread')).toBeUndefined();
  });

  it('rejects a completed-turn steer into the next input without retaining its old binding', async () => {
    const f = await fixture(true);
    const message = f.send();
    const batch = f.claim()!;
    f.store.finishRun(f.run.id, 'completed', 'uncertain');
    f.store.rejectSteer(batch.id, 'turn already finished');
    expect(f.delivery(message)).toEqual({
      status: 'queued',
      run_id: null,
      turn_id: null,
      steer_id: null,
    });
    expect(f.store.getSteer(batch.id).included).toEqual([
      { channelId: message.channelId, seq: message.seq },
    ]);
    const next = f.store.startRun(f.agent.id, 'native-thread')!;
    expect(next.input.flatMap((c) => c.messages).map((m) => m.seq)).toEqual([message.seq]);
    f.store.acceptRun(next.run.id, 'turn-two');
    f.store.acceptSteer(batch.id, 'turn-one');
    expect(f.delivery(message)).toMatchObject({
      status: 'accepted',
      run_id: next.run.id,
      turn_id: 'turn-two',
      steer_id: null,
    });
  });

  it('settles an ACK after native failure against the same failed run', async () => {
    const f = await fixture(true);
    const message = f.send();
    const batch = f.claim()!;
    f.store.finishRun(f.run.id, 'failed', 'failed', 'model failure');
    expect(f.status(message)).toBe('steering');
    f.store.acceptSteer(batch.id, 'turn-one');
    expect(f.status(message)).toBe('accepted');
  });

  it('records a late confirmed receipt without requeueing an unknown outcome', async () => {
    const f = await fixture(true);
    const message = f.send();
    const batch = f.claim()!;
    f.store.uncertainSteer(batch.id, 'connection lost');
    f.store.rejectSteer(batch.id, 'late rejection');
    f.store.acceptSteer(batch.id, 'turn-one');
    expect(f.status(message)).toBe('accepted');
    expect(f.store.getSteer(batch.id).status).toBe('accepted');
    expect(f.store.receiveMessages(f.agent.id, { limit: 100 }).input).toEqual([]);
    f.store.finishRun(f.run.id, 'completed', 'uncertain');
    expect(f.store.startRun(f.agent.id, 'native-thread')).toBeUndefined();
  });

  it.each(['stop', 'shutdown', 'delete-agent', 'stop-after-complete'] as const)(
    'keeps the run terminal while a late receipt confirms delivery (%s)',
    async (action) => {
      const f = await fixture(true);
      const message = f.send();
      const batch = f.claim()!;
      if (action === 'delete-agent') f.store.deleteAgent(f.agent.id);
      else if (action === 'shutdown')
        f.store.finishRun(f.run.id, 'uncertain', 'uncertain', 'shutdown');
      else {
        if (action === 'stop-after-complete') f.store.finishRun(f.run.id, 'completed', 'uncertain');
        f.store.updateAgent(f.agent.id, { desiredState: 'stopped', status: 'stopped' });
        f.store.finishRun(f.run.id, 'interrupted', 'cancelled');
      }
      const expected = action === 'delete-agent' ? 'cancelled' : 'uncertain';
      expect(f.status(message)).toBe(expected);
      expect(f.store.getSteer(batch.id).status).toBe('uncertain');
      f.store.acceptSteer(batch.id, 'turn-one');
      f.store.rejectSteer(batch.id, 'late refusal');
      expect(f.status(message)).toBe('accepted');
      expect(f.store.getAgent(f.agent.id).desiredState).toBe(
        action === 'shutdown' ? 'running' : 'stopped',
      );
    },
  );

  it.each([
    ['delete-group', 'accept'],
    ['delete-group', 'reject'],
    ['remove-member', 'accept'],
    ['remove-member', 'reject'],
  ] as const)('records confirmed group delivery after %s and late %s', async (action, outcome) => {
    const f = await fixture(true);
    const group = f.store.createGroup('user', 'group', [f.agent.id]);
    f.store.receiveMessages(f.agent.id, { limit: 100 });
    const message = f.send(group.id);
    const privateMessage = f.send();
    const batch = f.claim()!;
    if (action === 'delete-group') f.store.deleteGroup(group.id);
    else f.store.removeMember(group.id, f.agent.id);
    expect(f.status(message)).toBe('cancelled');
    if (outcome === 'accept') f.store.acceptSteer(batch.id, 'turn-one');
    else f.store.rejectSteer(batch.id, 'late refusal');
    f.store.markMessagesReceived(f.agent.id, [message]);
    expect(f.status(message)).toBe(outcome === 'accept' ? 'accepted' : 'cancelled');
    expect(f.status(privateMessage)).toBe(outcome === 'accept' ? 'accepted' : 'queued');
  });

  it('does not revive trimmed skipped references after membership revocation', async () => {
    const f = await fixture(true);
    const group = f.store.createGroup('user', 'trim and remove', [f.agent.id]);
    f.store.receiveMessages(f.agent.id, { limit: 100 });
    const messages = Array.from({ length: 14 }, () => f.send(group.id));
    const batch = f.claim()!;
    expect(f.status(messages[0]!)).toBe('skipped');
    f.store.removeMember(group.id, f.agent.id);
    f.store.rejectSteer(batch.id, 'late refusal');
    for (const message of messages) expect(f.status(message)).toBe('cancelled');
    expect(f.store.getSteer(batch.id).skipped).toHaveLength(4);
  });

  it('continues a mixed active and paused backlog after definite rejection without discarding input', async () => {
    const f = await fixture(true);
    const active = f.store.createGroup('user', 'active', [f.agent.id]);
    const paused = f.store.createGroup('user', 'paused', [f.agent.id]);
    f.store.receiveMessages(f.agent.id, { limit: 100 });
    f.store.updateChannel(paused.id, { paused: true });
    const pausedMessage = f.send(paused.id);
    const messages = Array.from({ length: 14 }, () => f.send(active.id));
    const batch = f.claim()!;
    expect(batch.input).toHaveLength(1);
    f.store.rejectSteer(batch.id, 'not accepted');
    const page = f.store.receiveMessages(f.agent.id, { channelId: active.id, limit: 2 });
    expect(page.input[0]!.messages.map((m) => m.seq)).toEqual(
      messages.slice(0, 2).map((m) => m.seq),
    );
    expect(page.hasMore).toBe(true);
    expect(f.status(pausedMessage)).toBe('queued');
    const retried = f.claim()!;
    expect(retried.input[0]!.skipped).toBe(2);
    expect(retried.input[0]!.messages.map((m) => m.seq)).toEqual(
      messages.slice(-10).map((m) => m.seq),
    );
    f.store.acceptSteer(retried.id, 'turn-one');
    f.store.finishRun(f.run.id, 'completed', 'uncertain');
    for (const message of messages.slice(-10)) expect(f.status(message)).toBe('accepted');
    expect(f.status(pausedMessage)).toBe('queued');
  });

  it('uses recent ten plus mentions and private user input, and rolls back only unread references', async () => {
    const f = await fixture(true);
    const group = f.store.createGroup('user', 'trim group', [f.agent.id]);
    f.store.receiveMessages(f.agent.id, { limit: 100 });
    const messages = Array.from({ length: 16 }, (_, i) =>
      f.send(group.id, `Group ${i}`, i === 1 ? [f.agent.id] : undefined),
    );
    const privateMessages = Array.from({ length: 13 }, (_, i) =>
      f.send(f.agent.channelId, `Private ${i}`),
    );
    const batch = f.claim()!;
    const groupInput = batch.input.find((c) => c.channel.id === group.id)!;
    expect(groupInput.messages.map((m) => m.seq)).toEqual([
      messages[1]!.seq,
      ...messages.slice(-10).map((m) => m.seq),
    ]);
    expect(groupInput.skipped).toBe(5);
    expect(batch.input.find((c) => c.channel.id === f.agent.channelId)!.messages).toHaveLength(13);
    expect(
      f.store.getRun(f.run.id).inputs.find((c) => c.channelId === group.id)!.messageSeqs,
    ).toEqual(groupInput.messages.map((m) => m.seq));
    // History consumes a skipped reference, while an included reference stays steering.
    f.store.markMessagesReceived(f.agent.id, [messages[0]!, messages[1]!]);
    expect(f.status(messages[0]!)).toBe('received');
    expect(f.status(messages[1]!)).toBe('steering');
    f.store.rejectSteer(batch.id, 'definite native refusal');
    expect(f.status(messages[0]!)).toBe('received');
    for (const m of [...messages.slice(1), ...privateMessages]) expect(f.status(m)).toBe('queued');
    const audit = f.store.getSteer(batch.id);
    expect(audit.included).toHaveLength(24);
    expect(audit.skipped).toHaveLength(5);
    expect(JSON.stringify(audit)).not.toContain('Private');
    const page = f.store.receiveMessages(f.agent.id, { limit: 3 });
    expect(page.input.flatMap((c) => c.messages)).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    const remainder = f.claim()!;
    expect(
      remainder.input
        .flatMap((c) => c.messages)
        .some((m) =>
          page.input
            .flatMap((c) => c.messages)
            .some((p) => p.channelId === m.channelId && p.seq === m.seq),
        ),
    ).toBe(false);
  });

  it('leaves paused groups queued, while active private input can steer', async () => {
    const f = await fixture(true);
    const group = f.store.createGroup('user', 'paused', [f.agent.id]);
    f.store.receiveMessages(f.agent.id, { limit: 100 });
    f.store.updateChannel(group.id, { paused: true });
    const groupMessage = f.send(group.id);
    const privateMessage = f.send();
    const batch = f.claim()!;
    expect(batch.input.map((c) => c.channel.id)).toEqual([f.agent.channelId]);
    expect(f.status(groupMessage)).toBe('queued');
    expect(f.status(privateMessage)).toBe('steering');
    f.store.acceptSteer(batch.id, 'turn-one');
    f.store.finishRun(f.run.id, 'completed', 'uncertain');
    expect(f.status(privateMessage)).toBe('accepted');
    expect(f.status(groupMessage)).toBe('queued');
  });

  it.each(['active', 'completed'] as const)(
    'recovers pending ACKs to uncertain after reopening (%s run)',
    async (state) => {
      const f = await fixture(true);
      const message = f.send();
      const batch = f.claim()!;
      if (state === 'completed') f.store.finishRun(f.run.id, 'completed', 'uncertain');
      const recovered = f.reopen();
      recovered.recoverOnBoot();
      expect(recovered.getSteer(batch.id)).toMatchObject({
        status: 'uncertain',
        included: [{ channelId: message.channelId, seq: message.seq }],
      });
      expect(recovered.getAgent(f.agent.id)).toMatchObject({ status: 'recovering', error: null });
      expect(f.status(message)).toBe('uncertain');
      recovered.acceptSteer(batch.id, 'turn-one');
      recovered.rejectSteer(batch.id, 'late refusal');
      expect(f.status(message)).toBe('accepted');
      expect(recovered.startRun(f.agent.id, 'native-thread')).toBeUndefined();
    },
  );

  it.each(['stopped', 'deleted'] as const)(
    'does not overwrite %s Agent state during pending ACK recovery',
    async (state) => {
      const f = await fixture(true);
      const message = f.send();
      const batch = f.claim()!;
      f.store.finishRun(f.run.id, 'completed', 'uncertain');
      if (state === 'deleted') f.store.deleteAgent(f.agent.id);
      else f.store.updateAgent(f.agent.id, { desiredState: 'stopped', status: 'stopped' });
      const recovered = f.reopen();
      recovered.recoverOnBoot();
      expect(recovered.getAgent(f.agent.id).status).toBe(state);
      expect(recovered.getSteer(batch.id).status).toBe('uncertain');
      expect(f.status(message)).toBe(state === 'deleted' ? 'cancelled' : 'uncertain');
    },
  );
});
