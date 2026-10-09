import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeAdapter } from '../src/harness/opencode/adapter.js';
import { OpenCodeHttpError, readSse } from '../src/harness/opencode/client.js';
import { OpenCodeEnvironment } from '../src/harness/opencode/environment.js';
import {
  HarnessSubmissionRejected,
  type HarnessEvent,
  type HarnessHandlers,
  type HarnessQuestion,
  type HarnessSession,
} from '../src/harness/types.js';
import { AgentWorkspace } from '../src/runtime/workspace.js';
import type { AgentRecord } from '../src/storage/store.js';
import { fixtureModel, inboxReceipt, opencodeConfig, OpenCodeFixture } from './opencode-fixture.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-opencode-adapter-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const { config, binary } = await opencodeConfig(root);
  const native = new OpenCodeFixture();
  const environment = new OpenCodeEnvironment(config, new AgentWorkspace(config));
  const adapter = new OpenCodeAdapter(environment, native.factory);
  const agent: AgentRecord = {
    id: randomUUID(),
    channelId: randomUUID(),
    name: 'OpenCode fixture',
    harness: 'opencode',
    model: 'fixture/fixture-model',
    reasoningEffort: 'high',
    workspace: join(root, 'workspace'),
    nativeHome: environment.nativeHome,
    threadId: null,
    threadCreationAttempted: false,
    canCreateGroups: false,
    steerEnabled: false,
    desiredState: 'running',
    status: 'creating',
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const events: HarnessEvent[] = [];
  const questions: HarnessQuestion[] = [];
  const handlers: HarnessHandlers = {
    connected: vi.fn((session: HarnessSession) => {
      cleanups.push(() => session.close());
    }),
    event: (event) => events.push(event),
    question: (question) => questions.push(question),
    exit: vi.fn(),
  };
  const connect = async () => {
    const session = await adapter.connect(agent, 'http://127.0.0.1:4310', handlers);
    return session;
  };
  const input = (sessionId: string, text = 'hello') => ({
    sessionId,
    runId: randomUUID(),
    text,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    workspace: agent.workspace,
  });
  return {
    root,
    config,
    binary,
    native,
    adapter,
    agent,
    events,
    questions,
    handlers,
    connect,
    input,
  };
}

function sseChunks(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('OpenCode native SSE', () => {
  it('preserves UTF-8 and CRLF frame boundaries across byte-sized transport chunks', async () => {
    const text =
      ': heartbeat\r\nevent: ignored\r\ndata: {"text":\r\ndata: "中文"}\r\n\r\ndata: {"next":true}\r\n\r\n';
    const bytes = new TextEncoder().encode(text);
    const frames: unknown[] = [];
    await readSse(sseChunks(Array.from(bytes, (byte) => Uint8Array.of(byte))), (frame) =>
      frames.push(frame),
    );
    expect(frames).toEqual([{ text: '中文' }, { next: true }]);
  });
  it('refuses a truncated delivery confirmation and invalid JSON instead of accepting them', async () => {
    const encoder = new TextEncoder();
    const frames: unknown[] = [];
    await expect(
      readSse(sseChunks([encoder.encode('data: {"type":"session.inbox.delivered"}\n')]), (frame) =>
        frames.push(frame),
      ),
    ).rejects.toThrow('完整帧');
    await expect(
      readSse(sseChunks([encoder.encode('data: {bad json}\n\n')]), (frame) => frames.push(frame)),
    ).rejects.toThrow();
    expect(frames).toEqual([]);
  });
});

describe('OpenCode v2 adapter', () => {
  it('reads enabled native models, default and variants without executing a prompt', async () => {
    const f = await fixture();
    f.native.onRequest = ({ path }) => {
      if (path.split('?')[0] === '/api/model')
        return { data: [fixtureModel, { ...fixtureModel, id: 'disabled', enabled: false }] };
    };
    expect(await f.adapter.catalog.status()).toMatchObject({
      available: true,
      authenticated: true,
      version: 'opencode v2.0.25',
      binaryPath: f.binary,
    });
    expect(await f.adapter.catalog.models()).toEqual([
      expect.objectContaining({
        model: 'fixture/fixture-model',
        supportedReasoningEfforts: ['default', 'high', 'max'],
        defaultReasoningEffort: 'default',
        isDefault: true,
      }),
    ]);
    expect(f.native.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(f.native.calls.filter((call) => call.path.split('?')[0] === '/api/model')).toHaveLength(
      1,
    );
    const initialization = f.native.calls.findIndex(
      (call) => call.path.split('?')[0] === '/api/integration',
    );
    const modelRead = f.native.calls.findIndex((call) => call.path.split('?')[0] === '/api/model');
    expect(initialization).toBeGreaterThan(-1);
    expect(modelRead).toBeGreaterThan(initialization);
    expect(f.native.closed).toBe(true);
  });

  it('reports an enabled CLI with no usable models as unauthenticated', async () => {
    const f = await fixture();
    f.native.onRequest = ({ path }) => {
      if (path.split('?')[0] === '/api/model') return { data: [] };
    };
    expect(await f.adapter.catalog.status()).toMatchObject({
      available: true,
      authenticated: false,
      error: expect.stringContaining('暂无可用模型'),
    });
    expect(await f.adapter.catalog.models()).toEqual([]);
  });

  it('creates a fixed native session and restores that ID without creating a replacement or a model turn', async () => {
    const f = await fixture();
    const session = await f.connect();
    const saved: string[] = [];
    const id = await session.createSession((value) => saved.push(value));
    expect(id).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(saved).toEqual([id]);
    expect(
      f.native.calls.find((call) => call.method === 'POST' && call.path === '/api/session'),
    ).toMatchObject({
      body: {
        id,
        location: { directory: f.agent.workspace },
        model: { providerID: 'fixture', id: 'fixture-model', variant: 'high' },
      },
    });
    expect(f.events).toEqual([]);
    await session.close();
    const resumed = await f.connect();
    expect(await resumed.resumeSession(id)).toBe(id);
    expect(
      f.native.calls.filter((call) => call.method === 'POST' && call.path === '/api/session'),
    ).toHaveLength(1);
    expect(f.native.calls.filter((call) => call.path.endsWith('/prompt'))).toEqual([]);
    expect(JSON.parse(f.native.env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      mcp: { servers: { isles: { url: `http://127.0.0.1:4310/mcp/${f.agent.id}` } } },
    });
  });

  it('refuses a missing persisted session without allocating another native session', async () => {
    const f = await fixture();
    const session = await f.connect();
    await expect(session.resumeSession('ses_missing')).rejects.toThrow('Native session missing');
    expect(
      f.native.calls.filter((call) => call.method === 'POST' && call.path === '/api/session'),
    ).toEqual([]);
  });

  it('waits for native subscription readiness before exposing the session and uses no archival log', async () => {
    const f = await fixture();
    f.native.autoConnected = false;
    let ready = false;
    const connecting = f.connect();
    void connecting.then(
      () => {
        ready = true;
      },
      () => {},
    );
    await vi.waitFor(() => expect(f.native.watchers.has('/api/event')).toBe(true));
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(f.native.calls.filter((call) => call.method === 'POST')).toEqual([]);
    f.native.emit(f.native.frame('ses_unbound', 'session.execution.started'));
    expect(f.events).toEqual([]);
    f.native.connected();
    const session = await connecting;
    const id = await session.createSession(() => {});
    expect(id).toMatch(/^ses_/);
    expect([...f.native.watchers.keys()]).toEqual(['/api/event']);
    expect(f.native.calls.some((call) => call.path.includes('/log'))).toBe(false);
    expect(f.events).toEqual([]);
  });

  it.each([true, false])(
    'waits for durable inbox delivery whether it precedes the HTTP response (%s)',
    async (eventFirst) => {
      const f = await fixture();
      const session = await f.connect();
      const id = await session.createSession(() => {});
      const receipt = inboxReceipt(id, 'hello');
      let turnID = '';
      f.native.onRequest = ({ path, body }) => {
        if (!path.endsWith('/prompt')) return;
        receipt.data.id = (body as { id: string }).id;
        if (eventFirst) {
          turnID = f.native.execution(id);
          f.native.deliver(id, receipt.data.id);
        }
        return receipt;
      };
      const pending = session.submit(f.input(id));
      let settled = false;
      void pending.then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.waitFor(() =>
        expect(f.native.calls.some((call) => call.path.endsWith('/prompt'))).toBe(true),
      );
      if (!eventFirst) {
        expect(settled).toBe(false);
        turnID = f.native.execution(id);
        f.native.deliver(id, 'msg_unrelated');
        await Promise.resolve();
        expect(settled).toBe(false);
        f.native.deliver(id, receipt.data.id);
      }
      await expect(pending).resolves.toEqual({ turnId: turnID });
      expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([
        { type: 'turn_started', sessionId: id, turnId: turnID },
      ]);
      f.native.emit(f.native.frame(id, 'session.execution.succeeded'));
      await vi.waitFor(() =>
        expect(f.events).toContainEqual({
          type: 'turn_completed',
          sessionId: id,
          turnId: turnID,
          status: 'completed',
          error: null,
        }),
      );
    },
  );

  it('changes native model and variant only for a new submission', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    let started = false;
    f.native.onRequest = ({ path, body }) => {
      if (!path.endsWith('/prompt')) return;
      const receipt = inboxReceipt(
        id,
        (body as { text: string }).text,
        (body as { id: string }).id,
      );
      if (!started) {
        f.native.execution(id);
        started = true;
      }
      f.native.deliver(id, receipt.data.id);
      return receipt;
    };
    const { turnId } = await session.submit({ ...f.input(id), reasoningEffort: 'max' });
    expect(f.native.calls.filter((call) => call.path.endsWith('/model'))).toContainEqual(
      expect.objectContaining({
        body: { model: { providerID: 'fixture', id: 'fixture-model', variant: 'max' } },
      }),
    );
    const modelChanges = f.native.calls.filter((call) => call.path.endsWith('/model')).length;
    await session.steer!({
      sessionId: id,
      expectedTurnId: turnId,
      batchId: randomUUID(),
      text: 'more',
    });
    expect(f.native.calls.filter((call) => call.path.endsWith('/model'))).toHaveLength(
      modelChanges,
    );
    f.native.emit(f.native.frame(id, 'session.execution.succeeded'));
    started = false;
    await session.submit({
      ...f.input(id, 'next'),
      model: 'another/nested/model',
      reasoningEffort: 'default',
    });
    expect(f.native.calls.filter((call) => call.path.endsWith('/model')).at(-1)).toMatchObject({
      body: { model: { providerID: 'another', id: 'nested/model' } },
    });
  });

  it('keeps a steer pending until the exact active execution consumes its inbox item', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    let receipt = inboxReceipt(id, 'initial');
    let initial = true;
    f.native.onRequest = ({ path, body }) => {
      if (!path.endsWith('/prompt')) return;
      receipt.data.id = (body as { id: string }).id;
      if (initial) {
        f.native.execution(id);
        f.native.deliver(id, receipt.data.id);
        initial = false;
      }
      return receipt;
    };
    const { turnId } = await session.submit(f.input(id));
    receipt = inboxReceipt(id, 'update');
    const steering = {
      sessionId: id,
      expectedTurnId: turnId,
      batchId: randomUUID(),
      text: 'update',
    };
    const pending = session.steer!(steering);
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.waitFor(() =>
      expect(f.native.calls.filter((call) => call.path.endsWith('/prompt'))).toHaveLength(2),
    );
    expect(settled).toBe(false);
    f.native.emit(
      f.native.frame('ses_native_subagent', 'session.inbox.delivered', {
        inboxID: receipt.data.id,
      }),
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    f.native.deliver(id, receipt.data.id);
    await expect(pending).resolves.toEqual({ turnId });
    await expect(session.steer!(steering)).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
    expect(f.native.calls.filter((call) => call.path.endsWith('/prompt')).at(-1)).toMatchObject({
      body: { text: 'update', delivery: 'steer' },
    });
    await expect(
      session.steer!({
        sessionId: id,
        expectedTurnId: 'evt_wrong',
        batchId: randomUUID(),
        text: 'late',
      }),
    ).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    expect(f.native.calls.filter((call) => call.path.endsWith('/prompt'))).toHaveLength(2);
  });

  it('preserves an uncertain result when a steer is consumed by a different native execution', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    let receipt = inboxReceipt(id, 'initial');
    let initial = true;
    f.native.onRequest = ({ path, body }) => {
      if (!path.endsWith('/prompt')) return;
      receipt.data.id = (body as { id: string }).id;
      if (initial) {
        f.native.execution(id);
        f.native.deliver(id, receipt.data.id);
        initial = false;
      }
      return receipt;
    };
    const { turnId } = await session.submit(f.input(id));
    receipt = inboxReceipt(id, 'crossed');
    const pending = session.steer!({
      sessionId: id,
      expectedTurnId: turnId,
      batchId: randomUUID(),
      text: 'crossed',
    });
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(f.native.calls.filter((call) => call.path.endsWith('/prompt'))).toHaveLength(2),
    );
    f.native.emit(f.native.frame(id, 'session.execution.succeeded'));
    f.native.execution(id);
    f.native.deliver(id, receipt.data.id);
    await expect(pending).rejects.not.toBeInstanceOf(HarnessSubmissionRejected);
    expect(f.handlers.exit).toHaveBeenCalledTimes(1);
  });

  it('treats native global stream loss before delivery as uncertain and closes the connection', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.native.onRequest = ({ path, body }) =>
      path.endsWith('/prompt') ? inboxReceipt(id, 'lost', (body as { id: string }).id) : undefined;
    const pending = session.submit(f.input(id));
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(f.native.calls.some((call) => call.path.endsWith('/prompt'))).toBe(true),
    );
    f.native.loseEvents();
    await expect(pending).rejects.not.toBeInstanceOf(HarnessSubmissionRejected);
    await vi.waitFor(() => expect(f.native.closed).toBe(true));
    expect(f.handlers.exit).toHaveBeenCalledTimes(1);
  });
  it.each([400, 500])(
    'distinguishes native HTTP %s refusal from an uncertain submission',
    async (status) => {
      const f = await fixture();
      const session = await f.connect();
      const id = await session.createSession(() => {});
      f.native.onRequest = ({ path }) => {
        if (path.endsWith('/prompt')) throw new OpenCodeHttpError(status, 'native refusal');
      };
      const pending = session.submit(f.input(id));
      if (status === 400) await expect(pending).rejects.toBeInstanceOf(HarnessSubmissionRejected);
      else await expect(pending).rejects.not.toBeInstanceOf(HarnessSubmissionRejected);
      expect(f.events).toEqual([]);
    },
  );

  it.each(['id', 'sessionID'])(
    'refuses a native inbox response with a different %s',
    async (field) => {
      const f = await fixture();
      const session = await f.connect();
      const id = await session.createSession(() => {});
      f.native.onRequest = ({ path, body }) => {
        if (!path.endsWith('/prompt')) return;
        const receipt = inboxReceipt(id, 'mismatch', (body as { id: string }).id);
        if (field === 'id') receipt.data.id = 'msg_someone_else';
        else receipt.data.sessionID = 'ses_someone_else';
        return receipt;
      };
      await expect(session.submit(f.input(id))).rejects.toThrow('身份无效');
      expect(f.events).toEqual([]);
    },
  );

  it('refuses mismatched aggregate metadata on a root session committed event', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.native.onRequest = ({ path, body }) =>
      path.endsWith('/prompt')
        ? inboxReceipt(id, 'pending', (body as { id: string }).id)
        : undefined;
    const pending = session.submit(f.input(id));
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(f.native.calls.some((call) => call.path.endsWith('/prompt'))).toBe(true),
    );
    const invalid = f.native.frame(id, 'session.execution.started');
    invalid.durable!.aggregateID = 'ses_someone_else';
    f.native.emit(invalid);
    await expect(pending).rejects.toThrow('session 身份无效');
    expect(f.handlers.exit).toHaveBeenCalledTimes(1);
    expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([]);
  });

  it('withdraws pending native input before interrupting and refuses later steer', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    let first = true;
    let pendingID = '';
    f.native.onRequest = ({ method, path, body }) => {
      if (path.endsWith('/prompt')) {
        const receipt = inboxReceipt(
          id,
          (body as { text: string }).text,
          (body as { id: string }).id,
        );
        if (first) {
          first = false;
          f.native.execution(id);
          f.native.deliver(id, receipt.data.id);
        } else pendingID = receipt.data.id;
        return receipt;
      }
      if (method === 'DELETE' && path.endsWith(`/inbox/${pendingID}`)) {
        f.native.emit(f.native.frame(id, 'session.inbox.cancelled', { inboxID: pendingID }));
        return {};
      }
      if (path.endsWith('/interrupt?resume=false')) {
        f.native.emit(f.native.frame(id, 'session.execution.interrupted'));
        return {};
      }
    };
    const { turnId } = await session.submit(f.input(id));
    const pending = session.steer!({
      sessionId: id,
      expectedTurnId: turnId,
      batchId: randomUUID(),
      text: 'pending',
    });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(pendingID).not.toBe(''));
    await session.interrupt(id, turnId);
    await expect(pending).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    const deletion = f.native.calls.findIndex(
      (call) => call.method === 'DELETE' && call.path.endsWith(`/inbox/${pendingID}`),
    );
    const interrupted = f.native.calls.findIndex((call) =>
      call.path.endsWith('/interrupt?resume=false'),
    );
    expect(deletion).toBeGreaterThan(-1);
    expect(interrupted).toBeGreaterThan(deletion);
    expect(f.events).toContainEqual({
      type: 'turn_completed',
      sessionId: id,
      turnId,
      status: 'interrupted',
      error: null,
    });
    await expect(
      session.steer!({
        sessionId: id,
        expectedTurnId: turnId,
        batchId: randomUUID(),
        text: 'late',
      }),
    ).rejects.toBeInstanceOf(HarnessSubmissionRejected);
  });

  it('maps text and multiselect questions to native field values, including a native child session', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.native.onRequest = ({ path, body }) => {
      if (!path.endsWith('/prompt')) return;
      const receipt = inboxReceipt(id, 'ask', (body as { id: string }).id);
      f.native.execution(id);
      f.native.deliver(id, receipt.data.id);
      return receipt;
    };
    const { turnId } = await session.submit(f.input(id));
    const child = 'ses_native_child';
    f.native.emit(f.native.frame(child, 'session.created', { parentID: id }));
    f.native.emit(
      f.native.frame(child, 'form.created', {
        form: {
          id: 'frm_choice',
          sessionID: child,
          title: 'Next step',
          fields: [
            { key: 'message', type: 'string', title: 'Message', custom: true },
            {
              key: 'choices',
              type: 'multiselect',
              title: 'Pick options',
              options: [
                { value: 'one', label: 'First' },
                { value: 'two', label: 'Second' },
              ],
            },
          ],
        },
      }),
    );
    expect(f.questions).toMatchObject([
      {
        sessionId: id,
        turnId,
        requestId: 'frm_choice',
        questions: [
          { id: 'message', multiSelect: false, isOther: true },
          { id: 'choices', multiSelect: true, options: [{ label: 'First' }, { label: 'Second' }] },
        ],
      },
    ]);
    session.answer('frm_choice', {
      answers: { message: { answers: ['Free text'] }, choices: { answers: ['Second', 'First'] } },
    });
    await vi.waitFor(() =>
      expect(f.native.calls).toContainEqual({
        method: 'POST',
        path: `/api/session/${child}/form/frm_choice/reply`,
        body: { answer: { message: 'Free text', choices: ['two', 'one'] } },
      }),
    );
    session.answer('frm_choice', { answers: { message: { answers: ['duplicate'] } } });
    expect(f.native.calls.filter((call) => call.path.endsWith('/reply'))).toHaveLength(1);
  });

  it('keeps main and native child execution details attached to the original platform turn', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.native.onRequest = ({ path, body }) => {
      if (!path.endsWith('/prompt')) return;
      const receipt = inboxReceipt(id, 'details', (body as { id: string }).id);
      f.native.execution(id);
      f.native.deliver(id, receipt.data.id);
      return receipt;
    };
    const { turnId } = await session.submit(f.input(id));
    f.native.emit(
      f.native.frame(id, 'session.text.ended', {
        assistantMessageID: 'msg_answer',
        ordinal: 0,
        text: 'Hello',
      }),
    );
    const child = 'ses_native_child';
    f.native.emit(f.native.frame(child, 'session.created', { parentID: id }));
    f.native.emit(
      f.native.frame(child, 'session.tool.input.started', {
        assistantMessageID: 'msg_child',
        id: 'tool_1',
        name: 'isles.send_message',
      }),
    );
    f.native.emit(
      f.native.frame(child, 'session.tool.success', {
        assistantMessageID: 'msg_child',
        id: 'tool_1',
        content: [{ type: 'text', text: 'Sent' }],
      }),
    );
    expect(f.events.filter((event) => event.type === 'item')).toMatchObject([
      { sessionId: id, turnId, item: { type: 'agentMessage', text: 'Hello' } },
      {
        sessionId: id,
        turnId,
        item: { type: 'mcpToolCall', status: 'completed', text: 'isles.send_message\nSent' },
      },
    ]);
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
  });

  it('reports an unexpected stream EOF once and keeps an intentional close quiet', async () => {
    const unexpected = await fixture();
    const unexpectedSession = await unexpected.connect();
    await unexpectedSession.createSession(() => {});
    for (const [path, watcher] of unexpected.native.watchers)
      if (path.split('?')[0] === '/api/event') watcher.end();
    await vi.waitFor(() => expect(unexpected.handlers.exit).toHaveBeenCalledTimes(1));
    const intentional = await fixture();
    const intentionalSession = await intentional.connect();
    await intentionalSession.createSession(() => {});
    await intentionalSession.close();
    expect(intentional.handlers.exit).not.toHaveBeenCalled();
  });
  it('refuses to resume a native session with unconsumed inbox items without a replacement or resubmission', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const pending = inboxReceipt(id, 'unknown previous delivery');
    f.native.onRequest = ({ path }) =>
      path.endsWith('/inbox') ? { data: [pending.data] } : undefined;
    await expect(session.resumeSession(id)).rejects.toThrow('待处理输入');
    expect(
      f.native.calls.filter((call) => call.method === 'POST' && call.path === '/api/session'),
    ).toHaveLength(1);
    expect(f.native.calls.filter((call) => call.path.endsWith('/prompt'))).toEqual([]);
  });
  it('does not construct or start a native connection after close during executable discovery', async () => {
    const f = await fixture();
    const command = await f.adapter.environment.executable();
    let resolve: (value: typeof command) => void = () => {};
    const discovery = new Promise<typeof command>((done) => {
      resolve = done;
    });
    const executable = vi.spyOn(f.adapter.environment, 'executable').mockReturnValue(discovery);
    const factory = vi.fn(f.native.factory);
    const start = vi.spyOn(f.native, 'start');
    const adapter = new OpenCodeAdapter(f.adapter.environment, factory);
    const pending = adapter.connect(f.agent, 'http://127.0.0.1:4310', f.handlers);
    void pending.catch(() => {});
    await vi.waitFor(() => expect(executable).toHaveBeenCalled());
    const published = vi.mocked(f.handlers.connected).mock.calls[0]![0];
    await published.close();
    resolve(command);
    await expect(pending).rejects.toThrow('连接已关闭');
    expect(factory).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('waits for outstanding HTTP admission before withdrawing pending input and interrupting', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    let first = true;
    let pendingID = '';
    let release = () => {};
    const admitted = new Promise<void>((done) => {
      release = done;
    });
    f.native.onRequest = async ({ method, path, body }) => {
      if (path.endsWith('/prompt')) {
        const receipt = inboxReceipt(
          id,
          (body as { text: string }).text,
          (body as { id: string }).id,
        );
        if (first) {
          first = false;
          f.native.execution(id);
          f.native.deliver(id, receipt.data.id);
          return receipt;
        }
        pendingID = receipt.data.id;
        await admitted;
        return receipt;
      }
      if (method === 'DELETE' && path.endsWith(`/inbox/${pendingID}`)) {
        f.native.emit(f.native.frame(id, 'session.inbox.cancelled', { inboxID: pendingID }));
        return {};
      }
      if (path.endsWith('/interrupt?resume=false')) {
        f.native.emit(f.native.frame(id, 'session.execution.interrupted'));
        return {};
      }
    };
    const { turnId } = await session.submit(f.input(id));
    const steering = session.steer!({
      sessionId: id,
      expectedTurnId: turnId,
      batchId: randomUUID(),
      text: 'admission pending',
    });
    void steering.catch(() => {});
    await vi.waitFor(() => expect(pendingID).not.toBe(''));
    const stopping = session.interrupt(id, turnId);
    await Promise.resolve();
    expect(f.native.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(f.native.calls.some((call) => call.path.endsWith('/interrupt?resume=false'))).toBe(
      false,
    );
    release();
    await stopping;
    await expect(steering).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    expect(
      f.native.calls
        .filter((call) => call.method === 'DELETE' || call.path.endsWith('/interrupt?resume=false'))
        .map((call) => call.path),
    ).toEqual([
      `/api/session/${id}/inbox/${pendingID}`,
      `/api/session/${id}/interrupt?resume=false`,
    ]);
    expect(f.handlers.exit).not.toHaveBeenCalled();
    expect(f.native.closed).toBe(false);
  });

  it('publishes a native question once when its global form event precedes the durable execution start', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    let turnId = '';
    f.native.onRequest = ({ path, body }) => {
      if (!path.endsWith('/prompt')) return;
      const receipt = inboxReceipt(id, 'early form', (body as { id: string }).id);
      const form = f.native.frame(id, 'form.created', {
        form: {
          id: 'frm_early',
          sessionID: id,
          title: 'Next step',
          fields: [{ key: 'message', type: 'string', title: 'Message' }],
        },
      });
      f.native.emit(form);
      expect(f.questions).toEqual([]);
      turnId = f.native.execution(id);
      f.native.emit(form);
      f.native.deliver(id, receipt.data.id);
      return receipt;
    };
    await session.submit(f.input(id));
    expect(f.questions).toHaveLength(1);
    expect(f.questions[0]).toMatchObject({ sessionId: id, turnId, requestId: 'frm_early' });
    session.answer('frm_early', { answers: { message: { answers: ['Continue'] } } });
    await vi.waitFor(() =>
      expect(f.native.calls).toContainEqual({
        method: 'POST',
        path: `/api/session/${id}/form/frm_early/reply`,
        body: { answer: { message: 'Continue' } },
      }),
    );
  });

  it.each([400, 500])(
    'retains a proven durable delivery when HTTP %s arrives later',
    async (status) => {
      const f = await fixture();
      const session = await f.connect();
      const id = await session.createSession(() => {});
      let turnId = '';
      f.native.onRequest = ({ path, body }) => {
        if (!path.endsWith('/prompt')) return;
        turnId = f.native.execution(id);
        f.native.deliver(id, (body as { id: string }).id);
        throw new OpenCodeHttpError(status, 'Late HTTP failure');
      };
      await expect(session.submit(f.input(id))).resolves.toEqual({ turnId: expect.any(String) });
      expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([
        { type: 'turn_started', sessionId: id, turnId },
      ]);
      expect(f.handlers.exit).not.toHaveBeenCalled();
      expect(f.native.closed).toBe(false);
    },
  );

  it('closes its owned connection after an unknown HTTP admission outcome', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.native.onRequest = ({ path }) => {
      if (path.endsWith('/prompt')) throw new Error('Transport lost after write');
    };
    await expect(session.submit(f.input(id))).rejects.not.toBeInstanceOf(HarnessSubmissionRejected);
    await vi.waitFor(() => expect(f.native.closed).toBe(true));
    expect(f.handlers.exit).toHaveBeenCalledTimes(1);
    expect(
      f.native.calls.some((call) => call.method === 'DELETE' && call.path.includes('/inbox/')),
    ).toBe(true);
  });
  it('refuses uncommitted execution events instead of producing an input receipt', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.native.onRequest = ({ path, body }) =>
      path.endsWith('/prompt')
        ? inboxReceipt(id, 'pending', (body as { id: string }).id)
        : undefined;
    const pending = session.submit(f.input(id));
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(f.native.calls.some((call) => call.path.endsWith('/prompt'))).toBe(true),
    );
    const event = f.native.frame(id, 'session.execution.started');
    delete event.durable;
    f.native.emit(event);
    await expect(pending).rejects.toThrow('缺少提交确认');
    await vi.waitFor(() => expect(f.native.closed).toBe(true));
    expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([]);
    expect(f.handlers.exit).toHaveBeenCalledTimes(1);
  });

  it('deduplicates committed execution and detail events by native session sequence', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.native.onRequest = ({ path, body }) => {
      if (!path.endsWith('/prompt')) return;
      const receipt = inboxReceipt(id, 'deduplication', (body as { id: string }).id);
      const started = f.native.frame(id, 'session.execution.started');
      f.native.emit(started);
      f.native.emit(started);
      f.native.deliver(id, receipt.data.id);
      return receipt;
    };
    const { turnId } = await session.submit(f.input(id));
    const text = f.native.frame(id, 'session.text.ended', {
      assistantMessageID: 'msg_reply',
      ordinal: 0,
      text: 'One response',
    });
    f.native.emit(text);
    f.native.emit(text);
    expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([
      { type: 'turn_started', sessionId: id, turnId },
    ]);
    expect(f.events.filter((event) => event.type === 'item')).toHaveLength(1);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });
});
