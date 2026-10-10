import { ConfigManager } from '@isles/config';
import type {
  Agent,
  HarnessCapabilities,
  HarnessDescriptor,
  Model,
  QuestionAnswer,
} from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  HarnessSubmissionRejected,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessHandlers,
  type HarnessRequestId,
  type HarnessSession,
  type HarnessTurnInput,
} from '../src/harness/types.js';
import type { AgentWorkspace } from '../src/runtime/workspace.js';

const capabilities: HarnessCapabilities = {
  steer: false,
  sessionResume: true,
  interrupt: true,
  userQuestions: true,
  nativeSubagents: true,
  mcp: true,
  workspaceInstructions: true,
};
const nativeId = 'shared-native-id';

class FakeSession implements HarnessSession {
  closed = false;
  closes = 0;
  resumed: string[] = [];
  submissions: HarnessTurnInput[] = [];
  interruptions: { sessionId: string; turnId: string }[] = [];
  answers: { requestId: HarnessRequestId; answer: QuestionAnswer }[] = [];
  rejected: HarnessRequestId[] = [];
  turnId = '';
  constructor(
    readonly adapter: FakeAdapter,
    readonly handlers: HarnessHandlers,
  ) {}
  async createSession(onCreated: (id: string) => void) {
    this.adapter.creations++;
    onCreated(nativeId);
    this.adapter.persisted.add(nativeId);
    if (this.adapter.creationFailure) throw this.adapter.creationFailure;
    return nativeId;
  }
  async resumeSession(id: string) {
    if (!this.adapter.persisted.has(id)) throw new Error('Native session is missing');
    this.resumed.push(id);
    return id;
  }
  async submit(input: HarnessTurnInput) {
    this.submissions.push(input);
    this.turnId = `turn-${this.submissions.length}`;
    if (this.adapter.failure && !this.adapter.startedBeforeFailure) throw this.adapter.failure;
    this.emit({ type: 'turn_started', sessionId: input.sessionId, turnId: this.turnId });
    if (this.adapter.failure) throw this.adapter.failure;
    return { turnId: this.turnId };
  }
  emit(event: HarnessEvent) {
    this.handlers.event(event);
  }
  complete() {
    this.emit({
      type: 'turn_completed',
      sessionId: nativeId,
      turnId: this.turnId,
      status: 'completed',
      error: null,
    });
  }
  question(requestId: HarnessRequestId, sessionId = nativeId, turnId = this.turnId) {
    this.handlers.question({
      sessionId,
      turnId,
      requestId,
      questions: [
        {
          id: 'choice',
          header: 'Choice',
          question: 'Continue?',
          isOther: false,
          isSecret: false,
          multiSelect: false,
          options: [{ label: 'Continue', description: 'Keep working' }],
        },
      ],
    });
  }
  async interrupt(sessionId: string, turnId: string) {
    this.interruptions.push({ sessionId, turnId });
  }
  answer(requestId: HarnessRequestId, answer: QuestionAnswer) {
    this.answers.push({ requestId, answer });
  }
  rejectQuestion(requestId: HarnessRequestId) {
    this.rejected.push(requestId);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.closes++;
  }
}

class FakeAdapter implements HarnessAdapter {
  readonly descriptor: HarnessDescriptor;
  readonly nativeHome: string;
  readonly sessions: { agentId: string; session: FakeSession }[] = [];
  readonly persisted = new Set<string>();
  readonly model: Model;
  creations = 0;
  invalidations = 0;
  creationFailure: Error | undefined;
  failure: Error | undefined;
  startedBeforeFailure = false;
  constructor(
    id: string,
    workspace: AgentWorkspace,
    config: ConfigManager,
    overrides: Partial<HarnessCapabilities> = {},
  ) {
    this.nativeHome = join(config.current.dataDir, 'fake-native');
    expect(workspace.dataDir).toBe(config.current.dataDir);
    this.descriptor = {
      id,
      displayName: `Fake ${id}`,
      configuration: null,
      capabilities: { ...capabilities, ...overrides },
    };
    this.model = {
      id: `${id}-model`,
      model: `${id}-model`,
      displayName: `Model ${id}`,
      description: '',
      supportedReasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
      isDefault: true,
    };
  }
  readonly catalog = {
    status: async () => ({
      available: true,
      authenticated: true,
      version: 'fake-1',
      binaryPath: null,
      error: null,
    }),
    models: async () => [this.model],
  };
  async connect(
    agent: Parameters<HarnessAdapter['connect']>[0],
    _baseUrl: string,
    handlers: HarnessHandlers,
  ) {
    const session = new FakeSession(this, handlers);
    this.sessions.push({ agentId: agent.id, session });
    handlers.connected(session);
    return session;
  }
  invalidate() {
    this.invalidations++;
  }
  latest(id: string) {
    return this.sessions.filter((entry) => entry.agentId === id).at(-1)!.session;
  }
  inputs(id: string) {
    return this.sessions
      .filter((entry) => entry.agentId === id)
      .flatMap((entry) => entry.session.submissions);
  }
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture(overrides: Partial<HarnessCapabilities> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'isles-semantic-harness-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = new ConfigManager({
    configFilePath: join(root, 'config.toml'),
    homeDir: root,
    environment: { ISLES_DATA_DIR: root },
  });
  let adapters: FakeAdapter[] | undefined;
  const open = async () => {
    const app = await buildApp({
      config,
      runtimeUrl: 'http://127.0.0.1:1',
      adapterFactory: (workspace, settings) =>
        (adapters ??= [
          new FakeAdapter('fake-a', workspace, settings, overrides),
          new FakeAdapter('fake-b', workspace, settings, {
            interrupt: false,
            nativeSubagents: false,
          }),
        ]),
    });
    cleanups.push(() => app.close());
    return app;
  };
  const app = await open();
  const [a, b] = adapters!;
  const payload = (adapter: FakeAdapter) => ({
    harness: adapter.descriptor.id,
    name: adapter.descriptor.displayName,
    model: adapter.model.model,
    reasoningEffort: 'high',
  });
  const create = async (adapter: FakeAdapter) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: payload(adapter),
    });
    expect(response.statusCode).toBe(201);
    const agent = response.json<Agent>();
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    return app.isles.store.publicAgent(agent.id);
  };
  const send = (agent: Agent, body: string) =>
    app.isles.runtime.send(agent.channelId, { body, clientId: randomUUID() });
  const delivery = (agent: Agent) =>
    app.isles.store
      .listMessages(agent.channelId)
      .map((message) => message.deliveries.find((entry) => entry.agentId === agent.id)!.status);
  return { root, config, app, open, a: a!, b: b!, payload, create, send, delivery };
}

describe('runtime with independent semantic harness adapters', () => {
  it('routes catalogs by registered harness and rejects missing, unknown, immutable or cross-harness configuration', async () => {
    const { app, a, b, payload, create } = await fixture();
    expect((await app.inject('/api/harnesses')).json().harnesses).toEqual([
      a.descriptor,
      b.descriptor,
    ]);
    expect((await app.inject('/api/harnesses/fake-a/status?refresh=true')).json()).toMatchObject({
      authenticated: true,
    });
    expect(a.invalidations).toBe(1);
    expect(b.invalidations).toBe(0);
    expect((await app.inject('/api/harnesses/fake-b/models')).json().models).toEqual([b.model]);
    expect((await app.inject('/api/harnesses/missing/models')).statusCode).toBe(404);
    const withoutHarness = {
      name: 'Missing harness',
      model: a.model.model,
      reasoningEffort: 'high',
    };
    expect(
      (await app.inject({ method: 'POST', url: '/api/agents', payload: withoutHarness }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agents',
          payload: { ...payload(a), harness: 'missing' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agents',
          payload: { ...payload(a), model: b.model.model },
        })
      ).statusCode,
    ).toBe(400);
    const agent = await create(a);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/agents/${agent.id}`,
          payload: { harness: b.descriptor.id },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/agents/${agent.id}`,
          payload: { model: b.model.model },
        })
      ).statusCode,
    ).toBe(400);
    expect(app.isles.store.publicAgent(agent.id)).toMatchObject({
      harness: a.descriptor.id,
      threadId: nativeId,
    });
  });

  it('rejects duplicate registration and every missing required capability without retaining a data lock', async () => {
    const { config, app, a } = await fixture();
    await app.close();
    await expect(buildApp({ config, adapterFactory: () => [a, a] })).rejects.toThrow('重复注册');
    for (const key of ['sessionResume', 'mcp', 'workspaceInstructions'] as const) {
      await expect(
        buildApp({
          config,
          adapterFactory: (workspace, settings) => [
            new FakeAdapter('invalid', workspace, settings, { [key]: false }),
          ],
        }),
      ).rejects.toThrow(key);
    }
    const reopened = await buildApp({ config, adapterFactory: () => [a] });
    cleanups.push(() => reopened.close());
    expect((await reopened.inject('/api/health')).statusCode).toBe(200);
  });

  it('persists identity before initialization fails and resumes equal native IDs through their own adapters after restart', async () => {
    const { app, a, b, payload, create, send, open } = await fixture();
    a.creationFailure = new Error('Initialization failed after persistence');
    const response = await app.inject({ method: 'POST', url: '/api/agents', payload: payload(a) });
    expect(response.statusCode).toBe(201);
    const agentA = response.json<Agent>();
    await expect.poll(() => app.isles.store.publicAgent(agentA.id).status).toBe('error');
    expect(app.isles.store.publicAgent(agentA.id).threadId).toBe(nativeId);
    const agentB = await create(b);
    expect(agentB.threadId).toBe(nativeId);
    expect(a.nativeHome).toBe(b.nativeHome);
    a.creationFailure = undefined;
    await app.isles.runtime.resume(agentA.id);
    await expect.poll(() => app.isles.store.publicAgent(agentA.id).status).toBe('ready');
    send(agentA, 'Only adapter A');
    send(agentB, 'Only adapter B');
    await expect.poll(() => a.inputs(agentA.id).length + b.inputs(agentB.id).length).toBe(2);
    expect(a.inputs(agentA.id)[0]!.text).toContain('Only adapter A');
    expect(a.inputs(agentA.id)[0]!.text).not.toContain('Only adapter B');
    expect(b.inputs(agentB.id)[0]!.model).toBe(b.model.model);
    a.latest(agentA.id).complete();
    b.latest(agentB.id).complete();
    await expect.poll(() => app.isles.store.publicAgent(agentA.id).status).toBe('ready');
    await expect.poll(() => app.isles.store.publicAgent(agentB.id).status).toBe('ready');
    await app.close();
    const restarted = await open();
    await expect.poll(() => restarted.isles.store.publicAgent(agentA.id).status).toBe('ready');
    await expect.poll(() => restarted.isles.store.publicAgent(agentB.id).status).toBe('ready');
    expect(a.latest(agentA.id).resumed).toEqual([nativeId]);
    expect(b.latest(agentB.id).resumed).toEqual([nativeId]);
    expect(a.creations).toBe(1);
    expect(b.creations).toBe(1);
  });

  it.each(['fake-a', 'fake-b'])(
    'keeps thousands of %s stream fragments off storage and notifications while discrete updates stay live',
    async (harnessId) => {
      const { app, a, b, create, send, delivery } = await fixture();
      const adapter = harnessId === 'fake-a' ? a : b;
      const agent = await create(adapter);
      send(agent, 'Stream without refresh');
      await expect.poll(() => delivery(agent)).toEqual(['accepted']);
      const session = adapter.latest(agent.id);
      const emit = (
        type: 'item' | 'item_delta',
        id: string,
        text: string,
        append = true,
        status = 'running',
        itemType = 'agentMessage',
      ) =>
        session.emit({
          type,
          sessionId: nativeId,
          turnId: session.turnId,
          append,
          item: { id, type: itemType, status, text },
        });
      emit('item', 'command', 'command: echo\n', false, 'running', 'commandExecution');
      const store = app.isles.store;
      const cursor = store.cursor();
      const notified = vi.fn();
      const unsubscribe = store.subscribe(notified);
      const read = vi.spyOn(store, 'getRun');
      for (let n = 0; n < 10_000; n++) {
        emit('item_delta', 'thought', 'x', true, 'running', 'reasoning');
        emit('item_delta', 'answer', `draft ${n}`, false);
        emit('item_delta', 'command', 'y', true, 'running', 'toolCall');
      }
      expect(read).not.toHaveBeenCalled();
      read.mockRestore();
      expect(store.cursor()).toBe(cursor);
      expect(notified).not.toHaveBeenCalled();
      expect(store.agentDetail(agent.id).runs[0]!.items).toEqual([
        { id: 'command', type: 'commandExecution', status: 'running', text: 'command: echo\n' },
      ]);
      const formal = app.isles.runtime.publish(agent.id, agent.channelId, {
        body: 'Formal message stays live',
        clientId: randomUUID(),
      });
      expect(store.listMessages(agent.channelId).at(-1)!.seq).toBe(formal.seq);
      expect(notified).toHaveBeenCalled();
      session.question('stream-question');
      expect(store.agentDetail(agent.id).questions).toHaveLength(1);
      app.isles.runtime.answer(agent.id, store.agentDetail(agent.id).questions[0]!.id, {
        answers: { choice: { answers: ['Continue'] } },
      });
      notified.mockClear();
      emit('item', 'thought', '', true, 'completed', 'reasoning');
      expect(notified.mock.calls.map(([event]) => event.type)).toEqual(['run']);
      expect(store.agentDetail(agent.id).runs[0]!.items).toContainEqual({
        id: 'thought',
        type: 'reasoning',
        status: 'completed',
        text: 'x'.repeat(10_000),
      });
      emit('item', 'answer', 'Final answer', false, 'completed');
      emit('item', 'command', '', true, 'completed', 'toolCall');
      session.complete();
      await expect.poll(() => store.publicAgent(agent.id).status).toBe('ready');
      const items = store.agentDetail(agent.id).runs[0]!.items;
      expect(items).toContainEqual({
        id: 'answer',
        type: 'agentMessage',
        status: 'completed',
        text: 'Final answer',
      });
      expect(items).toContainEqual({
        id: 'command',
        type: 'commandExecution',
        status: 'completed',
        text: 'command: echo\n' + 'y'.repeat(10_000),
      });
      const finalCursor = store.cursor();
      emit('item_delta', 'answer', 'late fragment');
      expect(store.cursor()).toBe(finalCursor);
      expect(store.agentDetail(agent.id).runs[0]!.items).toEqual(items);
      unsubscribe();
    },
  );

  it.each(['completed', 'failed', 'interrupted', 'stop', 'exit', 'shutdown'] as const)(
    'saves buffered partial output once on %s and redacts secrets split across chunks',
    async (boundary) => {
      const { app, a, create, send, delivery, open } = await fixture();
      const agent = await create(a);
      send(agent, 'Save partial output');
      await expect.poll(() => delivery(agent)).toEqual(['accepted']);
      const session = a.latest(agent.id);
      app.isles.runtime.workspace.redactor.add('fixture-output-secret');
      const cursor = app.isles.store.cursor();
      for (const text of ['Partial fixture-output-', 'secret result'])
        session.emit({
          type: 'item_delta',
          sessionId: nativeId,
          turnId: session.turnId,
          append: true,
          item: { id: 'partial', type: 'agentMessage', status: 'running', text },
        });
      expect(app.isles.store.cursor()).toBe(cursor);
      let observed = app;
      if (boundary === 'stop') await app.isles.runtime.stop(agent.id);
      else if (boundary === 'exit') session.handlers.exit(new Error('Fixture connection lost'));
      else if (boundary === 'shutdown') {
        await app.close();
        observed = await open();
      } else
        session.emit({
          type: 'turn_completed',
          sessionId: nativeId,
          turnId: session.turnId,
          status: boundary,
          error: boundary === 'failed' ? 'Fixture run failed' : null,
        });
      const run = observed.isles.store.agentDetail(agent.id).runs[0]!;
      expect(run.status).toBe(
        boundary === 'exit' || boundary === 'shutdown'
          ? 'uncertain'
          : boundary === 'stop'
            ? 'interrupted'
            : boundary,
      );
      expect(run.items).toEqual([
        {
          id: 'partial',
          type: 'agentMessage',
          status:
            boundary === 'exit'
              ? 'failed'
              : boundary === 'stop' || boundary === 'shutdown'
                ? 'interrupted'
                : boundary,
          text: 'Partial [redacted] result',
        },
      ]);
      expect(
        observed.isles.store
          .eventsAfter(cursor)
          .filter(
            (event) => event.type === 'run' && event.data.runId === run.id && !event.data.status,
          ),
      ).toHaveLength(
        boundary === 'completed' || boundary === 'failed' || boundary === 'interrupted' ? 2 : 1,
      );
    },
  );

  it.each(['start', 'ack'])(
    'keeps old turn output out of an unbound run until its native %s confirms the identity',
    async (binding) => {
      const { app, a, create, send, delivery } = await fixture();
      const agent = await create(a);
      send(agent, 'First turn');
      await expect.poll(() => delivery(agent)).toEqual(['accepted']);
      const session = a.latest(agent.id);
      const oldTurnId = session.turnId;
      session.complete();
      await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
      let release!: () => void;
      const ack = new Promise<void>((resolve) => {
        release = resolve;
      });
      session.submit = async (input) => {
        session.submissions.push(input);
        session.turnId = 'turn-2';
        await ack;
        return { turnId: session.turnId };
      };
      send(agent, 'Second turn');
      await expect.poll(() => session.submissions.length).toBe(2);
      const cursor = app.isles.store.cursor();
      const emit = (
        type: 'item' | 'item_delta',
        turnId: string,
        id: string,
        text: string,
        append = true,
        status = 'running',
      ) =>
        session.emit({
          type,
          sessionId: nativeId,
          turnId,
          append,
          item: { id, type: 'agentMessage', status, text },
        });
      emit('item_delta', oldTurnId, 'stale', 'Old fragment');
      emit('item', oldTurnId, 'stale', 'Old complete output', false, 'completed');
      emit('item_delta', session.turnId, 'answer', 'Current result');
      emit('item', session.turnId, 'answer', '', true, 'completed');
      expect(app.isles.store.cursor()).toBe(cursor);
      if (binding === 'start')
        session.emit({
          type: 'turn_started',
          sessionId: nativeId,
          turnId: session.turnId,
        });
      release();
      await expect.poll(() => delivery(agent)).toEqual(['completed', 'accepted']);
      const confirmed = app.isles.store.agentDetail(agent.id).runs[0]!;
      expect(confirmed.items).toEqual([
        {
          id: 'answer',
          type: 'agentMessage',
          status: 'completed',
          text: 'Current result',
        },
      ]);
      const completedItemCursor = app.isles.store.cursor();
      emit('item_delta', session.turnId, 'answer', 'Late duplicate');
      expect(app.isles.store.cursor()).toBe(completedItemCursor);
      session.complete();
      await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
      expect(app.isles.store.agentDetail(agent.id).runs[0]!.items).toEqual(confirmed.items);
    },
  );

  it.each([70_000, 150_000])(
    'preserves the newest bounded output for %i streamed characters',
    async (length) => {
      const { app, a, create, send, delivery } = await fixture();
      const agent = await create(a);
      send(agent, 'Long output');
      await expect.poll(() => delivery(agent)).toEqual(['accepted']);
      const session = a.latest(agent.id);
      const text = 'x'.repeat(length - 4) + 'TAIL';
      session.emit({
        type: 'item_delta',
        sessionId: nativeId,
        turnId: session.turnId,
        append: true,
        item: { id: 'long-output', type: 'agentMessage', status: 'running', text },
      });
      await app.isles.runtime.stop(agent.id);
      expect(app.isles.store.agentDetail(agent.id).runs[0]!.items[0]!.text).toBe(
        text.slice(-128_000),
      );
    },
  );

  it('stops both adapters by closing, uses optional interruption, and persists uncertain active work on shutdown', async () => {
    const { app, a, b, create, send, delivery, open } = await fixture();
    const first = await create(a);
    const second = await create(b);
    send(first, 'Stop A');
    send(second, 'Stop B');
    await expect.poll(() => delivery(first)).toEqual(['accepted']);
    await expect.poll(() => delivery(second)).toEqual(['accepted']);
    const sessionA = a.latest(first.id);
    const sessionB = b.latest(second.id);
    await app.isles.runtime.stop(first.id);
    await app.isles.runtime.stop(second.id);
    expect(sessionA.interruptions).toEqual([{ sessionId: nativeId, turnId: sessionA.turnId }]);
    expect(sessionB.interruptions).toEqual([]);
    expect(sessionA.closes).toBe(1);
    expect(sessionB.closes).toBe(1);
    await sessionA.close();
    await sessionB.close();
    expect(sessionA.closes).toBe(1);
    expect(sessionB.closes).toBe(1);
    expect(delivery(first)).toEqual(['cancelled']);
    expect(delivery(second)).toEqual(['cancelled']);
    await app.isles.runtime.resume(first.id);
    await expect.poll(() => app.isles.store.publicAgent(first.id).status).toBe('ready');
    send(first, 'Shutdown in flight');
    await expect.poll(() => delivery(first)).toEqual(['cancelled', 'accepted']);
    await app.close();
    const restarted = await open();
    await expect.poll(() => restarted.isles.store.publicAgent(first.id).status).toBe('ready');
    expect(restarted.isles.store.publicAgent(first.id)).toMatchObject({
      threadId: first.threadId,
      error: null,
    });
    expect(a.latest(first.id).resumed).toEqual([nativeId]);
    expect(restarted.isles.store.publicAgent(second.id).status).toBe('stopped');
    expect(
      restarted.isles.store
        .listMessages(first.channelId)
        .map((message) => message.deliveries[0]!.status),
    ).toEqual(['cancelled', 'uncertain']);
    expect(a.inputs(first.id)).toHaveLength(2);
    expect(b.inputs(second.id)).toHaveLength(1);
  });

  it('preserves stopped state when a late failure arrives before the submission acknowledgment', async () => {
    const { app, a, create, send, delivery } = await fixture();
    const agent = await create(a);
    const session = a.latest(agent.id);
    let releaseAck!: () => void;
    let releaseInterrupt!: () => void;
    const ack = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const submit = session.submit.bind(session);
    session.submit = async (input) => {
      const result = await submit(input);
      await ack;
      return result;
    };
    let lateEventSent = false;
    session.interrupt = async (sessionId, turnId) => {
      session.interruptions.push({ sessionId, turnId });
      await Promise.resolve();
      session.emit({
        type: 'turn_completed',
        sessionId,
        turnId,
        status: 'failed',
        error: 'late failure',
      });
      session.emit({
        type: 'item',
        sessionId,
        turnId,
        append: false,
        item: { id: 'late-item', type: 'text', status: 'completed', text: 'late item' },
      });
      lateEventSent = true;
      await interrupted;
    };
    send(agent, 'Stop before acknowledgment');
    await expect.poll(() => delivery(agent)).toEqual(['accepted']);
    const stopping = app.isles.runtime.stop(agent.id);
    try {
      await expect.poll(() => lateEventSent).toBe(true);
      expect(app.isles.store.publicAgent(agent.id)).toMatchObject({
        status: 'stopped',
        desiredState: 'stopped',
        error: null,
      });
      expect(app.isles.store.agentDetail(agent.id).runs[0]).toMatchObject({
        status: 'interrupted',
        items: [],
      });
      expect(delivery(agent)).toEqual(['cancelled']);
    } finally {
      releaseAck();
      releaseInterrupt();
      await stopping;
    }
  });

  it('gates native questions by capabilities and associates permitted child questions with the active main run', async () => {
    const { app, a, b, create, send } = await fixture();
    const first = await create(a);
    const second = await create(b);
    send(first, 'Question A');
    send(second, 'Question B');
    await expect.poll(() => a.inputs(first.id).length + b.inputs(second.id).length).toBe(2);
    const sessionA = a.latest(first.id);
    const sessionB = b.latest(second.id);
    sessionA.question('wrong-main', nativeId, 'wrong-turn');
    sessionA.question('child', 'native-child', 'child-turn');
    sessionB.question('child-disabled', 'native-child', 'child-turn');
    sessionB.question('main');
    expect(sessionA.rejected).toEqual(['wrong-main']);
    expect(sessionB.rejected).toEqual(['child-disabled']);
    const question = app.isles.store.agentDetail(first.id).questions[0]!;
    expect(question.runId).toBe(app.isles.store.agentDetail(first.id).runs[0]!.id);
    expect(app.isles.store.agentDetail(first.id).runs[0]!.turnId).toBe(sessionA.turnId);
    app.isles.runtime.answer(first.id, question.id, {
      answers: { choice: { answers: ['Continue'] } },
    });
    expect(sessionA.answers).toEqual([
      { requestId: 'child', answer: { answers: { choice: { answers: ['Continue'] } } } },
    ]);
    const disabled = await fixture({ userQuestions: false });
    const agent = await disabled.create(disabled.a);
    disabled.send(agent, 'Questions disabled');
    await expect.poll(() => disabled.a.inputs(agent.id).length).toBe(1);
    disabled.a.latest(agent.id).question('disabled');
    expect(disabled.a.latest(agent.id).rejected).toEqual(['disabled']);
    expect(disabled.app.isles.store.agentDetail(agent.id).questions).toEqual([]);
  });

  it('ignores events, questions and exits from an obsolete connection even when native session and turn IDs match', async () => {
    const { app, a, create, send } = await fixture();
    const agent = await create(a);
    send(agent, 'Old connection');
    await expect.poll(() => a.inputs(agent.id).length).toBe(1);
    const old = a.latest(agent.id);
    old.complete();
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    await app.isles.runtime.stop(agent.id);
    await app.isles.runtime.resume(agent.id);
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    send(agent, 'New connection');
    await expect.poll(() => a.inputs(agent.id).length).toBe(2);
    const current = a.latest(agent.id);
    expect(current).not.toBe(old);
    expect(current.turnId).toBe(old.turnId);
    old.complete();
    old.question('stale');
    old.handlers.exit(new Error('Obsolete exit'));
    old.emit({
      type: 'item',
      sessionId: nativeId,
      turnId: old.turnId,
      append: false,
      item: { id: 'stale-item', type: 'text', status: 'completed', text: 'obsolete' },
    });
    const detail = app.isles.store.agentDetail(agent.id);
    expect(detail.agent.status).toBe('running');
    expect(
      detail.runs.find((run) => run.turnId === current.turnId && !run.finishedAt),
    ).toMatchObject({ status: 'running', items: [] });
    expect(detail.questions).toEqual([]);
    current.complete();
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
  });

  it('separates definite refusal from uncertain submissions and never replays either input on explicit recovery', async () => {
    const { app, a, b, create, send, delivery } = await fixture();
    const first = await create(a);
    const second = await create(b);
    a.failure = new HarnessSubmissionRejected('Definite refusal');
    b.failure = new Error('Transport result unknown');
    send(first, 'Rejected');
    send(second, 'Uncertain');
    await expect.poll(() => delivery(first)).toEqual(['failed']);
    await expect.poll(() => delivery(second)).toEqual(['uncertain']);
    expect(app.isles.store.agentDetail(first.id).runs[0]!.status).toBe('failed');
    expect(app.isles.store.agentDetail(second.id).runs[0]!.status).toBe('uncertain');
    a.failure = undefined;
    b.failure = undefined;
    await app.isles.runtime.resume(first.id);
    await app.isles.runtime.resume(second.id);
    await expect.poll(() => app.isles.store.publicAgent(first.id).status).toBe('ready');
    await expect.poll(() => app.isles.store.publicAgent(second.id).status).toBe('ready');
    expect(a.inputs(first.id)).toHaveLength(1);
    expect(b.inputs(second.id)).toHaveLength(1);
    a.failure = new HarnessSubmissionRejected('Refusal after acceptance');
    a.startedBeforeFailure = true;
    send(first, 'Already accepted');
    await expect.poll(() => delivery(first)).toEqual(['failed', 'uncertain']);
    expect(
      app.isles.store.agentDetail(first.id).runs.find((run) => run.status === 'uncertain')!.turnId,
    ).toBeTruthy();
  });
});
