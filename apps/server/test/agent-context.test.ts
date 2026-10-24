import { ConfigManager } from '@isles/config';
import type { Agent } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type {
  HarnessAdapter,
  HarnessContextUsage,
  HarnessHandlers,
  HarnessSession,
  HarnessTurnInput,
} from '../src/harness/types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ContextSession implements HarnessSession {
  id = '';
  turnId = '';
  closed = false;
  submissions: HarnessTurnInput[] = [];
  resumes: string[] = [];
  constructor(
    readonly adapter: ContextAdapter,
    readonly handlers: HarnessHandlers,
  ) {}
  async createSession(onCreated: (id: string) => void) {
    const id = this.adapter.reusedId ?? `context-session-${++this.adapter.creations}`;
    if (this.adapter.failBeforeId) throw new Error('Native creation outcome unknown');
    this.id = id;
    this.adapter.persisted.add(id);
    onCreated(id);
    await this.adapter.creationGate;
    if (this.adapter.exitAfterId) this.handlers.exit(new Error('Native exited while initializing'));
    if (this.adapter.failAfterId) throw new Error('Native initialization failed');
    return id;
  }
  async resumeSession(id: string) {
    if (!this.adapter.persisted.has(id)) throw new Error('Native session missing');
    this.id = id;
    this.resumes.push(id);
    await this.adapter.resumeGate;
    return id;
  }
  async submit(input: HarnessTurnInput) {
    this.submissions.push(input);
    this.turnId = `context-turn-${randomUUID()}`;
    this.handlers.event({ type: 'turn_started', sessionId: this.id, turnId: this.turnId });
    return { turnId: this.turnId };
  }
  complete() {
    this.handlers.event({
      type: 'turn_completed',
      sessionId: this.id,
      turnId: this.turnId,
      status: 'completed',
      error: null,
    });
  }
  context(usage: HarnessContextUsage | null, sessionId = this.id) {
    this.handlers.event({ type: 'context_usage', sessionId, usage });
  }
  async interrupt() {}
  answer() {}
  rejectQuestion() {}
  async close() {
    this.closed = true;
    await this.adapter.closeGate;
  }
}

class ContextAdapter implements HarnessAdapter {
  readonly descriptor = {
    id: 'context-fixture',
    displayName: 'Context fixture',
    configuration: null,
    capabilities: {
      sessionResume: true,
      interrupt: true,
      steer: false,
      userQuestions: true,
      nativeSubagents: false,
      mcp: true,
      workspaceInstructions: true,
    },
  };
  readonly catalog = {
    status: async () => ({
      available: true,
      authenticated: true,
      version: 'fixture',
      binaryPath: null,
      error: null,
    }),
    models: async () => [
      {
        id: 'context-model',
        model: 'context-model',
        displayName: 'Context model',
        description: '',
        supportedReasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        isDefault: true,
      },
    ],
  };
  readonly sessions: ContextSession[] = [];
  readonly persisted = new Set<string>();
  creations = 0;
  reusedId: string | undefined;
  creationGate: Promise<void> | undefined;
  resumeGate: Promise<void> | undefined;
  closeGate: Promise<void> | undefined;
  failBeforeId = false;
  failAfterId = false;
  exitAfterId = false;
  exitInConnect = false;
  constructor(readonly nativeHome: string) {}
  async connect(
    _agent: Parameters<HarnessAdapter['connect']>[0],
    _baseUrl: string,
    handlers: HarnessHandlers,
  ) {
    const session = new ContextSession(this, handlers);
    this.sessions.push(session);
    handlers.connected(session);
    if (this.exitInConnect) handlers.exit(new Error('Native exited during preparation'));
    return session;
  }
  invalidate() {}
  latest() {
    return this.sessions.at(-1)!;
  }
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-agent-context-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = new ConfigManager({
    configFilePath: join(root, 'config.toml'),
    homeDir: root,
    environment: { ISLES_DATA_DIR: root },
  });
  const adapter = new ContextAdapter(join(root, 'native'));
  const open = async () => {
    const app = await buildApp({
      config,
      runtimeUrl: 'http://127.0.0.1:1',
      adapterFactory: () => [adapter],
    });
    cleanups.push(() => app.close());
    return app;
  };
  const app = await open();
  const response = await app.inject({
    method: 'POST',
    url: '/api/agents',
    payload: {
      harness: adapter.descriptor.id,
      name: 'Context agent',
      model: 'context-model',
      reasoningEffort: 'high',
      canCreateGroups: true,
    },
  });
  expect(response.statusCode).toBe(201);
  const agent = response.json<Agent>();
  await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
  const reset = () => app.inject({ method: 'POST', url: `/api/agents/${agent.id}/new-session` });
  const detail = () => app.isles.store.agentDetail(agent.id);
  const send = (body: string) =>
    app.isles.runtime.send(agent.channelId, { body, clientId: randomUUID() });
  return { root, app, adapter, agent, reset, detail, send, open };
}

describe('Agent context and explicit new sessions', () => {
  it('persists idle native usage, accepts compaction decreases and filters other sessions and invalid counts', async () => {
    const f = await fixture();
    const session = f.adapter.latest();
    expect(f.detail().contextUsage).toBeNull();
    session.context({ usedTokens: 1200, maxTokens: 10_000, estimated: false });
    session.context({ usedTokens: 9000, maxTokens: 10_000, estimated: false }, 'other-session');
    session.context({ usedTokens: -1, maxTokens: 10_000, estimated: false });
    expect(f.detail().contextUsage).toMatchObject({
      sessionId: session.id,
      usedTokens: 1200,
      maxTokens: 10_000,
      estimated: false,
    });
    session.context(null);
    expect(f.detail().contextUsage).toBeNull();
    session.context({ usedTokens: 300, maxTokens: null, estimated: true });
    await f.app.close();
    const reopened = await f.open();
    expect(reopened.isles.store.agentDetail(f.agent.id).contextUsage).toMatchObject({
      sessionId: session.id,
      usedTokens: 300,
      maxTokens: null,
      estimated: true,
    });
    expect(reopened.isles.store.agentDetail(f.agent.id).runs).toEqual([]);
  });

  it('creates a distinct session while retaining messages, execution history, memberships and workspace files', async () => {
    const f = await fixture();
    const old = f.adapter.latest();
    const group = f.app.isles.runtime.createGroup('user', {
      name: 'Kept group',
      memberIds: [f.agent.id],
    });
    const file = join(f.detail().agent.workspace, 'retained.txt');
    await writeFile(file, 'kept');
    f.send('Earlier conversation');
    await expect.poll(() => old.submissions.length).toBe(1);
    old.context({ usedTokens: 1100, maxTokens: 20_000, estimated: false });
    old.complete();
    await expect.poll(() => f.detail().agent.status).toBe('ready');
    const history = f.detail().runs;
    const response = await f.reset();
    expect(response.statusCode).toBe(200);
    expect(response.json<Agent>()).toMatchObject({
      id: f.agent.id,
      channelId: f.agent.channelId,
      workspace: f.detail().agent.workspace,
      model: 'context-model',
      canCreateGroups: true,
      desiredState: 'running',
      status: 'ready',
    });
    const current = f.adapter.latest();
    expect(current.id).not.toBe(old.id);
    expect(old.closed).toBe(true);
    expect(f.adapter.persisted.has(old.id)).toBe(true);
    expect(f.detail().contextUsage).toBeNull();
    expect(f.detail().runs).toEqual(history);
    expect(f.app.isles.store.publicChannel(group.id).memberIds).toContain(f.agent.id);
    expect(await readFile(file, 'utf8')).toBe('kept');
    expect(f.app.isles.store.listMessages(f.agent.channelId)).toMatchObject([
      { sender: 'user', body: 'Earlier conversation' },
      { sender: 'system', body: '已新建会话，后续消息使用新的上下文。' },
    ]);
    expect(f.detail().pendingMessageCount).toBe(0);
    old.context({ usedTokens: 99_999, maxTokens: 100_000, estimated: false });
    old.handlers.exit(new Error('Late old process exit'));
    expect(f.detail().contextUsage).toBeNull();
    expect(f.detail().agent.status).toBe('ready');
    f.send('Fresh conversation');
    await expect.poll(() => current.submissions.length).toBe(1);
    expect(current.submissions[0]!.sessionId).toBe(current.id);
    expect(current.submissions[0]!.text).toContain('Fresh conversation');
    expect(current.submissions[0]!.text).not.toContain('Earlier conversation');
    expect(old.submissions).toHaveLength(1);
    current.complete();
  });

  it('rejects running and waiting executions without interrupting or replacing them', async () => {
    const f = await fixture();
    f.send('Keep executing');
    const old = f.adapter.latest();
    await expect.poll(() => old.submissions.length).toBe(1);
    expect((await f.reset()).statusCode).toBe(409);
    old.handlers.question({
      sessionId: old.id,
      turnId: old.turnId,
      requestId: 'choice',
      questions: [
        {
          id: 'choice',
          question: 'Choose',
          header: 'Choice',
          isOther: false,
          isSecret: false,
          multiSelect: false,
          options: [{ label: 'Continue', description: 'Continue' }],
        },
      ],
    });
    expect(f.detail().runs[0]!.status).toBe('waiting');
    expect((await f.reset()).statusCode).toBe(409);
    expect(f.detail().agent.threadId).toBe(old.id);
    expect(old.closed).toBe(false);
    expect(f.adapter.creations).toBe(1);
    old.complete();
  });

  it('cancels queued private and paused group messages while retaining their history and stopped intent', async () => {
    const f = await fixture();
    await f.app.isles.runtime.stop(f.agent.id);
    f.send('Queued private message');
    expect(f.detail().pendingMessageCount).toBe(1);
    const group = f.app.isles.runtime.createGroup('user', {
      name: 'Paused group',
      memberIds: [f.agent.id],
    });
    f.app.isles.store.updateChannel(group.id, { paused: true });
    f.app.isles.runtime.send(group.id, { body: 'Parked group message', clientId: randomUUID() });
    expect(f.detail().pendingMessageCount).toBe(2);
    expect((await f.reset()).statusCode).toBe(200);
    expect(f.detail().pendingMessageCount).toBe(0);
    expect(f.detail().agent).toMatchObject({ desiredState: 'stopped', status: 'stopped' });
    for (const [channelId, body] of [
      [f.agent.channelId, 'Queued private message'],
      [group.id, 'Parked group message'],
    ])
      expect(f.app.isles.store.listMessages(channelId!)).toContainEqual(
        expect.objectContaining({
          body,
          deliveries: [{ agentId: f.agent.id, status: 'cancelled' }],
        }),
      );
    expect(f.app.isles.store.publicChannel(group.id)).toMatchObject({
      paused: true,
      memberIds: [f.agent.id],
    });
    expect(f.adapter.creations).toBe(2);
    await f.app.isles.runtime.resume(f.agent.id);
    await expect.poll(() => f.detail().agent.status).toBe('ready');
    f.app.isles.runtime.updateChannel(group.id, { paused: false });
    f.send('After clearing queued messages');
    const current = f.adapter.latest();
    await expect.poll(() => current.submissions.length).toBe(1);
    expect(current.submissions[0]!.text).toContain('After clearing queued messages');
    expect(current.submissions[0]!.text).not.toContain('Queued private message');
    expect(current.submissions[0]!.text).not.toContain('Parked group message');
    current.complete();
  });

  it('cancels claimed but unexecuted input at the storage boundary and preserves later input', async () => {
    const f = await fixture();
    await f.app.isles.runtime.stop(f.agent.id);
    const claimedMessage = f.send('Claimed before execution');
    const claimed = f.app.isles.store.startRun(f.agent.id, f.detail().agent.threadId!);
    expect(claimed!.input[0]!.messages[0]!.deliveries).toEqual([
      { agentId: f.agent.id, status: 'submitting' },
    ]);
    f.send('Queued before the boundary');
    f.app.isles.store.beginNewSession(f.agent.id);
    const later = f.send('Queued after the boundary');
    expect(f.detail().pendingMessageCount).toBe(1);
    expect(f.app.isles.store.listMessages(f.agent.channelId)).toMatchObject([
      { seq: claimedMessage.seq, deliveries: [{ status: 'cancelled' }] },
      { deliveries: [{ status: 'cancelled' }] },
      { seq: later.seq, deliveries: [{ status: 'queued' }] },
    ]);
    // The receipt confirms the original input while the later message stays queued.
    f.app.isles.store.acceptRun(claimed!.run.id, 'late-old-turn');
    expect(f.app.isles.store.listMessages(f.agent.channelId)[0]!.deliveries).toEqual([
      { agentId: f.agent.id, status: 'accepted' },
    ]);
    expect(f.app.isles.store.listMessages(f.agent.channelId)[2]!).toMatchObject({
      seq: later.seq,
      deliveries: [{ status: 'queued' }],
    });
  });

  it('settles old steer admissions and expires their native questions at the boundary', async () => {
    const f = await fixture();
    await f.app.isles.runtime.stop(f.agent.id);
    f.send('Initial stored claim');
    const claimed = f.app.isles.store.startRun(f.agent.id, f.detail().agent.threadId!)!;
    f.app.isles.store.acceptRun(claimed.run.id, 'stored-turn');
    f.app.isles.store.updateAgent(f.agent.id, {
      steerEnabled: true,
      desiredState: 'running',
      status: 'running',
    });
    // Save through Store so this isolated admission never invokes a harness turn.
    f.app.isles.store.saveMessage(
      f.agent.channelId,
      { type: 'user' },
      { body: 'Pending old steer', clientId: randomUUID() },
    );
    const batch = f.app.isles.store.claimSteer(f.agent.id, claimed.run.id, 'stored-turn')!;
    const questionId = f.app.isles.store.createQuestion(
      f.agent.id,
      claimed.run.id,
      'stored-turn',
      'stale-request',
      [
        {
          id: 'choice',
          header: 'Choice',
          question: 'Choose',
          isOther: true,
          isSecret: false,
          multiSelect: false,
          options: null,
        },
      ],
    );
    f.app.isles.store.beginNewSession(f.agent.id);
    expect(f.detail().pendingMessageCount).toBe(0);
    expect(f.detail().questions).toEqual([]);
    expect(f.app.isles.store.getQuestion(questionId).status).toBe('expired');
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/agents/${f.agent.id}/questions/${questionId}/answer`,
          payload: { answers: { choice: { answers: ['Continue'] } } },
        })
      ).statusCode,
    ).toBe(409);
    expect(f.app.isles.store.getSteer(batch.id).status).toBe('uncertain');
    f.app.isles.store.rejectSteer(batch.id, 'Late refusal');
    f.app.isles.store.acceptSteer(batch.id, 'stored-turn');
    expect(f.app.isles.store.listMessages(f.agent.channelId)[1]!.deliveries).toEqual([
      { agentId: f.agent.id, status: 'accepted' },
    ]);
  });

  it.each(['creating', 'recovering'] as const)(
    'allows replacement when displayed %s status has no actual initialization task',
    async (status) => {
      const f = await fixture();
      f.app.isles.store.updateAgent(f.agent.id, { status });
      expect((await f.reset()).statusCode).toBe(200);
      expect(f.adapter.creations).toBe(2);
    },
  );

  it('waits for an actual native recovery task before allowing replacement', async () => {
    const f = await fixture();
    await f.app.isles.runtime.stop(f.agent.id);
    const gate = deferred();
    f.adapter.resumeGate = gate.promise;
    await f.app.isles.runtime.resume(f.agent.id);
    try {
      await expect.poll(() => f.adapter.latest().resumes.length).toBe(1);
      expect((await f.reset()).statusCode).toBe(409);
      expect(f.adapter.creations).toBe(1);
    } finally {
      gate.resolve();
    }
    await expect.poll(() => f.detail().agent.status).toBe('ready');
    expect((await f.reset()).statusCode).toBe(200);
  });

  it('preserves stopped intent when creating and after process restart', async () => {
    const f = await fixture();
    await f.app.isles.runtime.stop(f.agent.id);
    const response = await f.reset();
    expect(response.statusCode).toBe(200);
    expect(response.json<Agent>()).toMatchObject({ desiredState: 'stopped', status: 'stopped' });
    const sessionId = response.json<Agent>().threadId;
    await f.app.close();
    const reopened = await f.open();
    expect(reopened.isles.store.publicAgent(f.agent.id)).toMatchObject({
      threadId: sessionId,
      desiredState: 'stopped',
      status: 'stopped',
    });
    expect(f.adapter.creations).toBe(2);
    await reopened.isles.runtime.resume(f.agent.id);
    await expect.poll(() => reopened.isles.store.publicAgent(f.agent.id).status).toBe('ready');
    expect(f.adapter.latest().resumes).toEqual([sessionId]);
    expect(f.adapter.creations).toBe(2);
  });

  it('serializes replacement against management and sends newly arriving inputs only to the new session', async () => {
    const f = await fixture();
    const old = f.adapter.latest();
    const group = f.app.isles.runtime.createGroup('user', {
      name: 'Paused at replacement',
      memberIds: [f.agent.id],
    });
    f.app.isles.runtime.updateChannel(group.id, { paused: true });
    f.app.isles.runtime.send(group.id, {
      body: 'Parked before replacement',
      clientId: randomUUID(),
    });
    const gate = deferred();
    f.adapter.creationGate = gate.promise;
    const replacement = f.reset();
    try {
      await expect.poll(() => f.adapter.creations).toBe(2);
      expect(f.detail().agent.status).toBe('creating');
      expect(f.app.isles.store.listMessages(group.id)[0]!.deliveries).toEqual([
        { agentId: f.agent.id, status: 'cancelled' },
      ]);
      expect((await f.reset()).statusCode).toBe(409);
      for (const action of ['stop', 'resume'])
        expect(
          (await f.app.inject({ method: 'POST', url: `/api/agents/${f.agent.id}/${action}` }))
            .statusCode,
        ).toBe(409);
      expect(
        (await f.app.inject({ method: 'DELETE', url: `/api/agents/${f.agent.id}` })).statusCode,
      ).toBe(409);
      expect(
        (
          await f.app.inject({
            method: 'PATCH',
            url: `/api/agents/${f.agent.id}`,
            payload: { name: 'Concurrent edit' },
          })
        ).statusCode,
      ).toBe(409);
      f.send('Arrived during replacement');
      expect(f.detail().pendingMessageCount).toBe(1);
      expect(old.submissions).toEqual([]);
      expect(f.adapter.latest().submissions).toEqual([]);
    } finally {
      gate.resolve();
    }
    expect((await replacement).statusCode).toBe(200);
    const current = f.adapter.latest();
    await expect.poll(() => current.submissions.length).toBe(1);
    expect(current.submissions[0]!.sessionId).toBe(current.id);
    expect(current.submissions[0]!.text).toContain('Arrived during replacement');
    expect(current.submissions[0]!.text).not.toContain('Parked before replacement');
    expect(old.submissions).toEqual([]);
    current.complete();
  });

  it('fences old callbacks before awaiting native shutdown', async () => {
    const f = await fixture();
    const old = f.adapter.latest();
    const gate = deferred();
    f.adapter.closeGate = gate.promise;
    const replacement = f.reset();
    try {
      await expect.poll(() => old.closed).toBe(true);
      old.handlers.exit(new Error('Old client exited during close'));
      old.context({ usedTokens: 10_000, maxTokens: 20_000, estimated: false });
      old.handlers.question({
        sessionId: old.id,
        turnId: 'late-old-turn',
        requestId: 'late-old-question',
        questions: [
          {
            id: 'late',
            header: 'Late',
            question: 'Old question',
            isOther: true,
            isSecret: false,
            multiSelect: false,
            options: null,
          },
        ],
      });
      expect(f.detail().contextUsage).toBeNull();
      expect(f.detail().questions).toEqual([]);
      expect(f.detail().agent.status).toBe('creating');
    } finally {
      f.adapter.closeGate = undefined;
      gate.resolve();
    }
    expect((await replacement).statusCode).toBe(200);
    expect(f.detail().agent.status).toBe('ready');
  });

  it('retains a newly allocated session on initialization failure and resumes that exact session', async () => {
    const f = await fixture();
    const oldId = f.adapter.latest().id;
    f.adapter.failAfterId = true;
    const response = await f.reset();
    expect(response.statusCode).toBe(503);
    const failed = f.detail().agent;
    expect(failed.threadId).not.toBe(oldId);
    expect(failed).toMatchObject({ desiredState: 'stopped', status: 'error' });
    expect(f.app.isles.store.listMessages(f.agent.channelId)).toEqual([]);
    f.adapter.failAfterId = false;
    await f.app.isles.runtime.resume(f.agent.id);
    await expect.poll(() => f.detail().agent.status).toBe('ready');
    expect(f.adapter.latest().resumes).toEqual([failed.threadId]);
    expect(f.adapter.creations).toBe(2);
  });

  it('reports a newly created connection exiting during initialization as failure', async () => {
    const f = await fixture();
    const previous = f.adapter.latest().id;
    f.adapter.exitAfterId = true;
    expect((await f.reset()).statusCode).toBe(503);
    expect(f.detail().agent).toMatchObject({ desiredState: 'stopped', status: 'error' });
    expect(f.detail().agent.threadId).not.toBe(previous);
    expect(f.app.isles.store.listMessages(f.agent.channelId)).toEqual([]);
  });

  it('does not reattach a connection that exited before native session creation', async () => {
    const f = await fixture();
    f.adapter.exitInConnect = true;
    expect((await f.reset()).statusCode).toBe(503);
    expect(f.detail().agent).toMatchObject({
      threadId: null,
      desiredState: 'stopped',
      status: 'error',
    });
    expect(f.adapter.creations).toBe(1);
    expect(f.app.isles.store.listMessages(f.agent.channelId)).toEqual([]);
  });

  it('settles an interrupted replacement without failing runtime shutdown', async () => {
    const f = await fixture();
    const previous = f.adapter.latest();
    const gate = deferred();
    f.adapter.closeGate = gate.promise;
    const replacement = f.reset();
    await expect.poll(() => previous.closed).toBe(true);
    const closing = f.app.isles.runtime.close();
    f.adapter.closeGate = undefined;
    gate.resolve();
    expect((await replacement).statusCode).toBe(503);
    await expect(closing).resolves.toBeUndefined();
    expect(f.detail().agent).toMatchObject({
      threadId: null,
      desiredState: 'stopped',
      status: 'error',
    });
    expect(f.app.isles.store.listMessages(f.agent.channelId)).toEqual([]);
  });

  it('keeps uncertain creation from silently restoring the old session or creating another one on resume', async () => {
    const f = await fixture();
    const oldId = f.adapter.latest().id;
    f.adapter.failBeforeId = true;
    expect((await f.reset()).statusCode).toBe(503);
    expect(f.detail().agent).toMatchObject({ threadId: null, status: 'error' });
    const resume = await f.app.inject({ method: 'POST', url: `/api/agents/${f.agent.id}/resume` });
    expect(resume.statusCode).toBe(409);
    expect(f.adapter.creations).toBe(2);
    f.adapter.failBeforeId = false;
    expect((await f.reset()).statusCode).toBe(200);
    expect(f.detail().agent.threadId).not.toBe(oldId);
  });

  it('refuses a native adapter that reuses the previous session id', async () => {
    const f = await fixture();
    f.adapter.reusedId = f.adapter.latest().id;
    expect((await f.reset()).statusCode).toBe(503);
    expect(f.detail().agent.threadId).toBeNull();
    expect(f.detail().agent.error).toContain('原会话 ID');
    expect(f.app.isles.store.listMessages(f.agent.channelId)).toEqual([]);
  });
});
