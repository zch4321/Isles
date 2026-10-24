import { ConfigManager } from '@isles/config';
import type { Agent, HarnessDescriptor, QuestionAnswer } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type {
  HarnessAdapter,
  HarnessHandlers,
  HarnessSession,
  HarnessTurnInput,
  HarnessSteerInput,
} from '../src/harness/types.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Session implements HarnessSession {
  submissions: HarnessTurnInput[] = [];
  answers: { id: string | number; answer: QuestionAnswer }[] = [];
  rejected: (string | number)[] = [];
  interruptions: string[] = [];
  closed = false;
  sequence = 0;
  submitHook?: (input: HarnessTurnInput) => Promise<{ turnId: string }>;
  steerHook?: (input: HarnessSteerInput) => Promise<{ turnId: string }>;
  constructor(readonly handlers: HarnessHandlers) {}
  async createSession(created: (id: string) => void) {
    created('opaque-session');
    this.start('replayed-turn');
    this.handlers.event({
      type: 'context_usage',
      sessionId: 'opaque-session',
      usage: { usedTokens: 42, maxTokens: 1000, estimated: false },
    });
    return 'opaque-session';
  }
  async resumeSession(id: string) {
    this.start('replayed-turn');
    return id;
  }
  async submit(input: HarnessTurnInput) {
    this.submissions.push(input);
    if (this.submitHook) return this.submitHook(input);
    const turnId = `input-${++this.sequence}`;
    this.start(turnId);
    return { turnId };
  }
  async steer(input: HarnessSteerInput) {
    return this.steerHook ? this.steerHook(input) : { turnId: input.expectedTurnId };
  }
  start(turnId: string, sessionId = 'opaque-session') {
    this.handlers.event({ type: 'turn_started', sessionId, turnId });
  }
  complete(turnId: string, sessionId = 'opaque-session') {
    this.handlers.event({
      type: 'turn_completed',
      sessionId,
      turnId,
      status: 'completed',
      error: null,
    });
  }
  item(turnId: string, text: string, sessionId = 'opaque-session', streaming = false) {
    this.handlers.event({
      type: streaming ? 'item_delta' : 'item',
      sessionId,
      turnId,
      append: true,
      item: {
        id: 'opaque-item',
        type: 'agentMessage',
        text,
        status: streaming ? 'running' : 'completed',
      },
    });
  }
  question(turnId: string, sessionId = 'opaque-session') {
    this.handlers.question({
      turnId,
      sessionId,
      requestId: 'opaque-request',
      questions: [
        {
          id: 'choice',
          header: 'Choice',
          question: 'Continue?',
          isOther: true,
          isSecret: false,
          multiSelect: false,
          options: null,
        },
      ],
    });
  }
  async interrupt(sessionId: string, turnId: string) {
    this.interruptions.push(`${sessionId}/${turnId}`);
  }
  answer(id: string | number, answer: QuestionAnswer) {
    this.answers.push({ id, answer });
  }
  rejectQuestion(id: string | number) {
    this.rejected.push(id);
  }
  async close() {
    this.closed = true;
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-native-activities-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sessions = new Map<string, Session>();
  const config = new ConfigManager({
    configFilePath: join(root, 'config.toml'),
    homeDir: root,
    environment: { ISLES_DATA_DIR: root },
  });
  const app = await buildApp({
    config,
    runtimeUrl: 'http://127.0.0.1:1',
    adapterFactory: () =>
      ['first', 'second'].map((id): HarnessAdapter => ({
        descriptor: {
          id,
          displayName: id,
          configuration: null,
          capabilities: {
            steer: true,
            sessionResume: true,
            interrupt: true,
            userQuestions: true,
            nativeSubagents: true,
            mcp: true,
            workspaceInstructions: true,
          },
        } satisfies HarnessDescriptor,
        nativeHome: root,
        invalidate: () => {},
        catalog: {
          status: async () => ({
            available: true,
            authenticated: true,
            version: 'fixture',
            binaryPath: null,
            error: null,
          }),
          models: async () => [
            {
              id: 'model',
              model: 'model',
              displayName: 'Model',
              description: '',
              supportedReasoningEfforts: ['high'],
              defaultReasoningEffort: 'high',
              isDefault: true,
            },
          ],
        },
        connect: async (agent, _url, handlers) => {
          const session = new Session(handlers);
          sessions.set(agent.id, session);
          handlers.connected(session);
          session.start('connection-replay');
          return session;
        },
      })),
  });
  cleanups.push(() => app.close());
  const create = async (harness = 'first', steerEnabled = false) => {
    const agent = await app.isles.runtime.createAgent({
      harness,
      name: harness,
      model: 'model',
      reasoningEffort: 'high',
      steerEnabled,
    });
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    return agent;
  };
  const send = (agent: Agent, body = 'Message') =>
    app.isles.runtime.send(agent.channelId, { body, clientId: randomUUID() });
  const deliveries = (agent: Agent) =>
    app.isles.store.listMessages(agent.channelId).map((message) => message.deliveries[0]!.status);
  const detail = (agent: Agent) => app.isles.store.agentDetail(agent.id);
  const session = (agent: Agent) => sessions.get(agent.id)!;
  return { app, create, send, deliveries, detail, session };
}

describe('continuous native activity observation', () => {
  it('records autonomous root turns and child output after the input turn ends, while child activity leaves the root queue available', async () => {
    const f = await fixture();
    const agent = await f.create();
    const native = f.session(agent);
    expect(f.detail(agent).runs).toEqual([]);
    expect(f.detail(agent).contextUsage).toMatchObject({ usedTokens: 42, maxTokens: 1000 });
    f.send(agent);
    await expect.poll(() => f.deliveries(agent)).toEqual(['accepted']);
    native.start('child-turn', 'child-session');
    native.complete('input-1');
    expect(f.detail(agent).agent.status).toBe('running');
    native.item('child-turn', 'Background continues', 'child-session');
    f.send(agent, 'Root is available');
    await expect.poll(() => f.deliveries(agent)).toEqual(['accepted', 'accepted']);
    native.complete('input-2');
    native.complete('child-turn', 'child-session');
    expect(f.detail(agent).agent.status).toBe('ready');
    native.start('autonomous-root');
    native.item('autonomous-root', 'Woke up');
    native.complete('autonomous-root');
    const runs = f.detail(agent).runs;
    expect(runs.find((run) => run.turnId === 'child-turn')).toMatchObject({
      inputs: [],
      status: 'completed',
      items: [expect.objectContaining({ text: 'Background continues' })],
    });
    expect(runs.find((run) => run.turnId === 'autonomous-root')).toMatchObject({
      inputs: [],
      status: 'completed',
      items: [expect.objectContaining({ text: 'Woke up' })],
    });
    expect(f.deliveries(agent)).toEqual(['accepted', 'accepted']);
    const cursor = f.app.isles.store.cursor();
    native.item('child-turn', 'Late duplicate', 'child-session');
    expect(f.app.isles.store.cursor()).toBe(cursor);
  });

  it('keeps independent background questions live after the parent ends and expires only their native activity', async () => {
    const f = await fixture();
    const agent = await f.create();
    const native = f.session(agent);
    f.send(agent);
    await expect.poll(() => f.deliveries(agent)).toEqual(['accepted']);
    native.question('child-turn', 'child-session');
    const question = f.detail(agent).questions[0]!;
    const child = f.detail(agent).runs.find((run) => run.id === question.runId)!;
    expect(child).toMatchObject({
      threadId: 'child-session',
      turnId: 'child-turn',
      inputs: [],
      status: 'waiting',
    });
    native.complete('input-1');
    expect(f.detail(agent).questions).toHaveLength(1);
    f.app.isles.runtime.answer(agent.id, question.id, {
      answers: { choice: { answers: ['Continue'] } },
    });
    expect(native.answers).toHaveLength(1);
    native.question('child-turn', 'child-session');
    native.handlers.event({
      type: 'question_expired',
      sessionId: 'child-session',
      turnId: 'child-turn',
      requestId: 'opaque-request',
    });
    expect(f.detail(agent).questions).toEqual([]);
    expect(f.app.isles.store.getQuestion(question.id).status).toBe('answered');
  });

  it.each(['stop', 'exit', 'shutdown'] as const)(
    'closes all root and child activity on %s while accepted deliveries stay accepted',
    async (ending) => {
      const f = await fixture();
      const agent = await f.create();
      const native = f.session(agent);
      f.send(agent);
      await expect.poll(() => f.deliveries(agent)).toEqual(['accepted']);
      native.start('child-turn', 'child-session');
      native.item('child-turn', 'Partial background', 'child-session', true);
      native.question('child-turn', 'child-session');
      if (ending === 'stop') await f.app.isles.runtime.stop(agent.id);
      else if (ending === 'exit') native.handlers.exit(new Error('Disconnected'));
      else await f.app.isles.runtime.close();
      expect(
        f
          .detail(agent)
          .runs.every((run) => run.status === (ending === 'stop' ? 'interrupted' : 'uncertain')),
      ).toBe(true);
      expect(f.detail(agent).questions).toEqual([]);
      expect(f.deliveries(agent)).toEqual(['accepted']);
      const cursor = f.app.isles.store.cursor();
      native.start('after-disconnect');
      native.item('child-turn', 'Obsolete', 'child-session');
      expect(f.app.isles.store.cursor()).toBe(cursor);
      if (ending === 'stop')
        expect(native.interruptions).toEqual([
          'opaque-session/input-1',
          'child-session/child-turn',
        ]);
    },
  );

  it('binds input only after its exact ACK and records unrelated root events as native activity', async () => {
    const f = await fixture();
    const agent = await f.create();
    const native = f.session(agent);
    const ack = deferred<{ turnId: string }>();
    native.submitHook = () => ack.promise;
    f.send(agent);
    await expect.poll(() => native.submissions.length).toBe(1);
    native.start('autonomous');
    native.item('autonomous', 'Independent');
    native.complete('autonomous');
    native.item('confirmed-input', 'Exact input output');
    native.complete('confirmed-input');
    expect(f.deliveries(agent)).toEqual(['submitting']);
    expect(f.detail(agent).runs).toHaveLength(1);
    ack.resolve({ turnId: 'confirmed-input' });
    await expect.poll(() => f.deliveries(agent)).toEqual(['accepted']);
    expect(f.detail(agent).runs.find((run) => run.turnId === 'confirmed-input')).toMatchObject({
      status: 'completed',
      inputs: [expect.anything()],
      items: [expect.objectContaining({ text: 'Exact input output' })],
    });
    expect(f.detail(agent).runs.find((run) => run.turnId === 'autonomous')).toMatchObject({
      inputs: [],
      status: 'completed',
    });
  });

  it('stops an unconfirmed submission and accepts its exact late ACK without reopening native activity', async () => {
    const f = await fixture();
    const agent = await f.create();
    const native = f.session(agent);
    const ack = deferred<{ turnId: string }>();
    native.submitHook = () => ack.promise;
    f.send(agent);
    await expect.poll(() => native.submissions.length).toBe(1);
    native.start('unconfirmed');
    await f.app.isles.runtime.stop(agent.id);
    expect(f.deliveries(agent)).toEqual(['cancelled']);
    ack.resolve({ turnId: 'unconfirmed' });
    await expect.poll(() => f.deliveries(agent)).toEqual(['accepted']);
    expect(f.detail(agent).runs).toHaveLength(1);
    expect(f.detail(agent).runs[0]).toMatchObject({ turnId: 'unconfirmed', status: 'interrupted' });
    expect(f.detail(agent).agent.status).toBe('stopped');
  });

  it('keeps opaque native identities scoped to their own Agent and harness', async () => {
    const f = await fixture();
    const first = await f.create('first');
    const second = await f.create('second');
    f.session(first).start('same-turn');
    f.session(second).start('same-turn');
    f.session(first).item('same-turn', 'First adapter');
    f.session(second).item('same-turn', 'Second adapter');
    expect(f.detail(first).runs[0]).toMatchObject({
      inputs: [],
      items: [expect.objectContaining({ text: 'First adapter' })],
    });
    expect(f.detail(second).runs[0]).toMatchObject({
      inputs: [],
      items: [expect.objectContaining({ text: 'Second adapter' })],
    });
    expect(f.detail(first).runs[0]!.id).not.toBe(f.detail(second).runs[0]!.id);
  });

  it('binds a queued steer receipt to the actual later native turn', async () => {
    const f = await fixture();
    const agent = await f.create('first', true);
    const native = f.session(agent);
    f.send(agent);
    await expect.poll(() => f.deliveries(agent)).toEqual(['accepted']);
    native.steerHook = async () => {
      native.complete('input-1');
      native.start('later-turn');
      return { turnId: 'later-turn' };
    };
    f.send(agent, 'Queued by native');
    await expect.poll(() => f.deliveries(agent)).toEqual(['accepted', 'accepted']);
    const messages = f.app.isles.store.listMessages(agent.channelId);
    const actual = f.detail(agent).runs.find((run) => run.turnId === 'later-turn')!;
    expect(actual.inputs).toEqual([
      { channelId: agent.channelId, messageSeqs: [messages[1]!.seq] },
    ]);
    expect(f.detail(agent).runs.find((run) => run.turnId === 'input-1')!.status).toBe('completed');
  });

  it('confirms a late steer receipt after stop without reopening its newly reported native turn', async () => {
    const f = await fixture();
    const agent = await f.create('first', true);
    const native = f.session(agent);
    f.send(agent);
    await expect.poll(() => f.deliveries(agent)).toEqual(['accepted']);
    const ack = deferred<{ turnId: string }>();
    native.steerHook = () => ack.promise;
    f.send(agent, 'Native queued input');
    await expect.poll(() => f.deliveries(agent)).toEqual(['accepted', 'steering']);
    await f.app.isles.runtime.stop(agent.id);
    ack.resolve({ turnId: 'late-actual-turn' });
    await expect.poll(() => f.deliveries(agent)).toEqual(['accepted', 'accepted']);
    expect(f.detail(agent).runs.find((run) => run.turnId === 'late-actual-turn')).toMatchObject({
      status: 'interrupted',
      inputs: [expect.anything()],
    });
    expect(f.app.isles.store.hasActiveRun(agent.id)).toBe(false);
    expect(f.detail(agent).agent.status).toBe('stopped');
    await f.app.isles.runtime.resume(agent.id);
    await expect.poll(() => f.detail(agent).agent.status).toBe('ready');
  });

  it('waits for background activity before reconnecting changed configuration and delivering the next root input', async () => {
    const f = await fixture();
    const agent = await f.create();
    const old = f.session(agent);
    old.start('background', 'child-session');
    await f.app.isles.runtime.updateAgent(agent.id, { name: 'Updated guidance' });
    f.send(agent);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.deliveries(agent)).toEqual(['queued']);
    expect(old.closed).toBe(false);
    old.complete('background', 'child-session');
    await expect.poll(() => f.deliveries(agent)).toEqual(['accepted']);
    expect(old.closed).toBe(true);
    expect(f.session(agent)).not.toBe(old);
    expect(f.session(agent).submissions).toHaveLength(1);
  });

  it.each(['completed', 'interrupted', 'exit'] as const)(
    'settles discrete running items on native %s while preserving the separate child lifecycle',
    async (ending) => {
      const f = await fixture();
      const agent = await f.create();
      const native = f.session(agent);
      native.start('parent');
      native.handlers.event({
        type: 'item',
        sessionId: 'opaque-session',
        turnId: 'parent',
        append: false,
        item: { id: 'spawn', type: 'subAgentActivity', status: 'running', text: '' },
      });
      native.start('child', 'child-session');
      if (ending === 'exit') native.handlers.exit(new Error('Disconnected'));
      else
        native.handlers.event({
          type: 'turn_completed',
          sessionId: 'opaque-session',
          turnId: 'parent',
          status: ending,
          error: null,
        });
      expect(f.detail(agent).runs.find((run) => run.turnId === 'parent')!.items).toEqual([
        {
          id: 'spawn',
          type: 'subAgentActivity',
          status: ending === 'exit' ? 'failed' : ending,
          text: '',
        },
      ]);
      expect(f.detail(agent).runs.find((run) => run.turnId === 'child')!.status).toBe(
        ending === 'exit' ? 'uncertain' : 'running',
      );
    },
  );
});
