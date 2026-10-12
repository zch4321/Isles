import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeAdapter } from '../src/harness/opencode/adapter.js';
import { OpenCodeHttpError, readSse } from '../src/harness/opencode/client.js';
import { OpenCodeEnvironment } from '../src/harness/opencode/environment.js';
import type { OpenCodePermissionRule } from '../src/harness/opencode/protocol.js';
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
    dangerFullAccess: false,
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
  async function runningFixture() {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.native.onRequest = ({ path, body }) => {
      if (!path.endsWith('/prompt')) return;
      const receipt = inboxReceipt(id, 'permission', (body as { id: string }).id);
      f.native.execution(id);
      f.native.deliver(id, receipt.data.id);
      return receipt;
    };
    const { turnId } = await session.submit(f.input(id));
    return { ...f, session, id, turnId };
  }
  function ask(f: Awaited<ReturnType<typeof runningFixture>>, requestID: string, sessionID = f.id) {
    f.native.emit(
      f.native.frame(sessionID, 'permission.asked', {
        id: requestID,
        action: 'edit',
        resources: ['/external/document.txt'],
        save: ['*'],
        source: { type: 'tool', messageID: 'message', id: 'write' },
      }),
    );
  }
  function decide(allowed: boolean) {
    return { answers: { permission: { answers: [allowed ? '允许本次' : '拒绝'] } } };
  }
  it('allows own and shared file tools, asks about other paths and preserves native non-edit policies', async () => {
    const f = await fixture();
    f.agent.workspace = join(f.root, 'workspace', 'agents', f.agent.id, 'workspace');
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const rules = f.native.sessions.get(id)!.permissions as OpenCodePermissionRule[];
    // OpenCode v2 wildcard evaluation: last whole-resource match wins, '*' includes '/'.
    const match = (value: string, pattern: string) =>
      new RegExp(
        `^${pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replaceAll('*', '.*')
          .replaceAll('?', '.')}$`,
      ).test(value);
    const effect = (action: string, resource: string) =>
      rules.findLast((rule) => match(action, rule.action) && match(resource, rule.resource))
        ?.effect;
    expect(effect('edit', 'notes/draft.txt')).toBe('allow');
    expect(effect('edit', '../../agents/other/file.txt')).toBe('ask');
    expect(effect('edit', '/external/document.txt')).toBe('ask');
    expect(effect('edit', 'C:/external/document.txt')).toBe('ask');
    expect(effect('edit', join(f.config.current.sharedDir, 'report.txt'))).toBe('allow');
    expect(
      effect('edit', join(relative(f.agent.workspace, f.config.current.sharedDir), 'report.txt')),
    ).toBe('allow');
    expect(effect('external_directory', `${f.config.current.sharedDir}/*`)).toBe('allow');
    expect(effect('shell', 'python script.py')).toBeUndefined();
    expect(effect('read', '/reference/readme.txt')).toBeUndefined();
    expect(effect('external_directory', '/other/*')).toBeUndefined();
  });
  it('sets full access only for the configured Agent session', async () => {
    const f = await fixture();
    f.agent.dangerFullAccess = true;
    const session = await f.connect();
    const id = await session.createSession(() => {});
    expect(f.native.sessions.get(id)!.permissions).toEqual([
      { action: '*', resource: '*', effect: 'allow' },
    ]);
    expect(JSON.parse(f.native.env.OPENCODE_CONFIG_CONTENT!).permissions).toBeUndefined();
  });
  it('approves a native child permission once, then refuses duplicate answers', async () => {
    const f = await runningFixture();
    const child = 'ses_permission_child';
    f.native.emit(f.native.frame(child, 'session.created', { parentID: f.id }));
    ask(f, 'per_child', child);
    expect(f.questions).toMatchObject([
      {
        sessionId: f.id,
        turnId: f.turnId,
        requestId: 'per_child',
        questions: [{ id: 'permission', options: [{ label: '允许本次' }, { label: '拒绝' }] }],
      },
    ]);
    f.session.answer('per_child', decide(true));
    f.session.answer('per_child', decide(true));
    await vi.waitFor(() =>
      expect(f.native.calls).toContainEqual({
        method: 'POST',
        path: `/api/session/${child}/permission/per_child/reply`,
        body: { decision: 'once' },
      }),
    );
    expect(
      f.native.calls.filter((call) => call.path.endsWith('/permission/per_child/reply')),
    ).toHaveLength(1);
    expect(f.events).not.toContainEqual({
      type: 'question_expired',
      sessionId: f.id,
      turnId: f.turnId,
      requestId: 'per_child',
    });
  });
  it('rejects all pending permissions in the same native session without granting a child request', async () => {
    const f = await runningFixture();
    const child = 'ses_permission_child';
    f.native.emit(f.native.frame(child, 'session.created', { parentID: f.id }));
    ask(f, 'per_first');
    ask(f, 'per_second');
    ask(f, 'per_child', child);
    f.session.answer('per_first', decide(false));
    f.session.answer('per_second', decide(true));
    await vi.waitFor(() =>
      expect(f.native.calls).toContainEqual({
        method: 'POST',
        path: `/api/session/${f.id}/permission/per_first/reply`,
        body: { decision: 'reject' },
      }),
    );
    expect(
      f.native.calls.filter((call) => call.path.includes('/permission/per_second/reply')),
    ).toEqual([]);
    expect(
      f.events.filter((event) => event.type === 'question_expired').map((event) => event.requestId),
    ).toEqual(['per_second']);
    expect(f.native.permissions.has('per_child')).toBe(true);
  });
  it('expires permissions settled by another native client and ignores a late Isles answer', async () => {
    const f = await runningFixture();
    ask(f, 'per_external');
    f.native.emit(
      f.native.frame(f.id, 'permission.replied', { requestID: 'per_external', reply: 'once' }),
    );
    f.session.answer('per_external', decide(true));
    expect(
      f.native.calls.filter((call) => call.path.includes('/permission/per_external/reply')),
    ).toEqual([]);
    expect(f.events).toContainEqual({
      type: 'question_expired',
      sessionId: f.id,
      turnId: f.turnId,
      requestId: 'per_external',
    });
  });
  it('expires native rejected siblings and permissions owned by an ended child only', async () => {
    const f = await runningFixture();
    const child = 'ses_permission_child';
    f.native.emit(f.native.frame(child, 'session.created', { parentID: f.id }));
    ask(f, 'per_first');
    ask(f, 'per_second');
    ask(f, 'per_child', child);
    f.native.emit(
      f.native.frame(child, 'form.created', {
        form: {
          id: 'frm_child_pending',
          sessionID: child,
          title: 'Child question',
          fields: [{ key: 'text', type: 'string', title: 'Next step' }],
        },
      }),
    );
    f.native.emit(
      f.native.frame(f.id, 'permission.replied', { requestID: 'per_first', reply: 'reject' }),
    );
    f.session.answer('per_second', decide(true));
    expect(
      f.native.calls.filter((call) => call.path.includes('/permission/per_second/reply')),
    ).toEqual([]);
    f.native.emit(f.native.frame(child, 'session.execution.interrupted'));
    await vi.waitFor(() =>
      expect(f.native.calls).toContainEqual({
        method: 'POST',
        path: `/api/session/${child}/permission/per_child/reply`,
        body: { decision: 'reject' },
      }),
    );
    expect(
      f.events.filter((event) => event.type === 'question_expired').map((event) => event.requestId),
    ).toEqual(['per_first', 'per_second', 'frm_child_pending', 'per_child']);
    f.session.answer('frm_child_pending', { answers: { text: { answers: ['late'] } } });
    expect(
      f.native.calls.filter((call) => call.path.endsWith('/form/frm_child_pending/reply')),
    ).toEqual([]);
    expect(f.events.some((event) => event.type === 'turn_completed')).toBe(false);
  });
  it('publishes an early permission once after execution starts and rejects dismissal', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.native.onRequest = ({ path, body }) => {
      if (!path.endsWith('/prompt')) return;
      f.native.emit(
        f.native.frame(id, 'permission.asked', {
          id: 'per_early',
          action: 'shell',
          resources: ['git push'],
        }),
      );
      expect(f.questions).toEqual([]);
      f.native.execution(id);
      f.native.emit(
        f.native.frame(id, 'permission.asked', {
          id: 'per_early',
          action: 'shell',
          resources: ['git push'],
        }),
      );
      const receipt = inboxReceipt(id, 'early', (body as { id: string }).id);
      f.native.deliver(id, receipt.data.id);
      return receipt;
    };
    await session.submit(f.input(id));
    expect(f.questions).toHaveLength(1);
    expect(() =>
      session.answer('per_early', { answers: { permission: { answers: ['always'] } } }),
    ).toThrow('请选择');
    session.rejectQuestion('per_early', 'dismissed');
    await vi.waitFor(() =>
      expect(f.native.calls).toContainEqual({
        method: 'POST',
        path: `/api/session/${id}/permission/per_early/reply`,
        body: { decision: 'reject' },
      }),
    );
  });
  it.each(['finish', 'interrupt', 'close'] as const)(
    'rejects and expires pending permissions on %s',
    async (operation) => {
      const f = await runningFixture();
      ask(f, 'per_cleanup');
      if (operation === 'finish')
        f.native.emit(f.native.frame(f.id, 'session.execution.succeeded'));
      if (operation === 'interrupt') await f.session.interrupt(f.id, f.turnId);
      if (operation === 'close') await f.session.close();
      await vi.waitFor(() =>
        expect(f.native.calls).toContainEqual({
          method: 'POST',
          path: `/api/session/${f.id}/permission/per_cleanup/reply`,
          body: { decision: 'reject' },
        }),
      );
      expect(f.events).toContainEqual({
        type: 'question_expired',
        sessionId: f.id,
        turnId: f.turnId,
        requestId: 'per_cleanup',
      });
      f.session.answer('per_cleanup', decide(true));
      expect(
        f.native.calls.filter((call) => call.path.endsWith('/permission/per_cleanup/reply')),
      ).toHaveLength(1);
    },
  );
  it('rejects unknown-session permissions and permissions outside an active turn', async () => {
    const f = await runningFixture();
    ask(f, 'per_unknown', 'ses_unowned');
    f.native.emit(f.native.frame(f.id, 'session.execution.succeeded'));
    ask(f, 'per_idle');
    await vi.waitFor(() =>
      expect(
        f.native.calls.filter(
          (call) => call.path.includes('/permission/') && call.path.endsWith('/reply'),
        ),
      ).toHaveLength(2),
    );
    expect(f.questions).toEqual([]);
    expect(f.native.permissions.size).toBe(0);
  });
  it('updates existing descendants on resume, follows pagination and rejects recovered pending permissions', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const info = f.native.sessions.get(id)!;
    const child = {
      ...info,
      id: 'ses_child_existing',
      parentID: id,
      permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    };
    const next = { ...child, id: 'ses_child_next' };
    const grandchild = { ...child, id: 'ses_grandchild', parentID: child.id };
    for (const value of [child, next, grandchild]) f.native.sessions.set(value.id, value);
    f.native.permissions.set('per_recovered', {
      id: 'per_recovered',
      sessionID: grandchild.id,
      action: 'shell',
      resources: ['git push'],
    });
    f.native.onRequest = ({ method, path }) => {
      if (method !== 'GET' || !path.startsWith('/api/session?')) return;
      const query = new URLSearchParams(path.split('?')[1]);
      if (query.get('parentID') !== id) return;
      return query.has('cursor')
        ? { data: [next], cursor: {} }
        : { data: [child], cursor: { next: 'page2' } };
    };
    await session.resumeSession(id);
    for (const value of [child, next, grandchild]) {
      expect(f.native.sessions.get(value.id)!.permissions).toEqual(
        f.native.sessions.get(id)!.permissions,
      );
    }
    expect(f.native.calls).toContainEqual({
      method: 'POST',
      path: `/api/session/${grandchild.id}/permission/per_recovered/reply`,
      body: { decision: 'reject' },
    });
    expect(f.questions).toEqual([]);
  });

  it('ignores output fragments without context reads and publishes ended snapshots and tool boundaries', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.native.onRequest = ({ path, body }) => {
      if (!path.endsWith('/prompt')) return;
      const receipt = inboxReceipt(id, 'stream-boundaries', (body as { id: string }).id);
      f.native.execution(id);
      f.native.deliver(id, receipt.data.id);
      return receipt;
    };
    await session.submit(f.input(id));
    const before = f.events.length;
    const reads = f.native.calls.filter((call) => call.path.endsWith('/context')).length;
    for (const type of ['session.text.started', 'session.text.delta', 'session.reasoning.delta'])
      f.native.emit(
        f.native.frame(id, type, { assistantMessageID: 'message', ordinal: 0, text: 'partial' }),
      );
    f.native.emit(
      f.native.frame(id, 'session.tool.input.delta', {
        assistantMessageID: 'message',
        id: 'tool',
        delta: '{}',
      }),
    );
    expect(f.events).toHaveLength(before);
    expect(f.native.calls.filter((call) => call.path.endsWith('/context'))).toHaveLength(reads);
    for (const type of ['session.text.ended', 'session.reasoning.ended'])
      f.native.emit(
        f.native.frame(id, type, { assistantMessageID: 'message', ordinal: 0, text: 'Complete' }),
      );
    f.native.emit(
      f.native.frame(id, 'session.tool.input.started', {
        assistantMessageID: 'message',
        id: 'tool',
        name: 'isles.send_message',
      }),
    );
    f.native.emit(
      f.native.frame(id, 'session.tool.called', {
        assistantMessageID: 'message',
        id: 'tool',
        input: { body: 'Sent' },
      }),
    );
    f.native.emit(
      f.native.frame(id, 'session.tool.success', {
        assistantMessageID: 'message',
        id: 'tool',
        content: [{ type: 'text', text: 'Done' }],
      }),
    );
    expect(f.events.slice(before)).toMatchObject([
      { type: 'item', append: false, item: { type: 'agentMessage', status: 'completed' } },
      { type: 'item', append: false, item: { type: 'reasoning', status: 'completed' } },
      { type: 'item', append: false, item: { type: 'mcpToolCall', status: 'running' } },
      { type: 'item', append: false, item: { type: 'mcpToolCall', status: 'completed' } },
    ]);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('restores the latest main-session context call, including cache and reasoning, without session billing totals', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const tokens = { input: 100, output: 20, reasoning: 30, cache: { read: 400, write: 50 } };
    f.native.onRequest = ({ path }) => {
      if (path === '/api/model') return { data: [{ ...fixtureModel, limit: { context: 2000 } }] };
      if (path.endsWith('/context'))
        return {
          data: [
            {
              type: 'assistant',
              tokens: { ...tokens, input: 9000 },
              model: { providerID: 'fixture', id: fixtureModel.id },
            },
            {
              type: 'compaction',
              status: 'completed',
              tokens: { ...tokens, input: 10000 },
              summary: 'summary',
              recent: '',
            },
            { type: 'assistant', tokens, model: { providerID: 'fixture', id: fixtureModel.id } },
          ],
        };
    };
    await session.resumeSession(id);
    expect(f.events).toContainEqual({
      type: 'context_usage',
      sessionId: id,
      usage: { usedTokens: 600, maxTokens: 2000, estimated: false },
    });
    const count = f.native.calls.filter((call) => call.path.endsWith('/context')).length;
    f.native.emit(f.native.frame('ses_child', 'session.step.ended', { tokens }));
    f.native.emit(
      f.native.frame(id, 'session.usage.updated', { tokens: { ...tokens, input: 999999 } }),
    );
    await Promise.resolve();
    expect(f.native.calls.filter((call) => call.path.endsWith('/context'))).toHaveLength(count);
  });

  it('refreshes idle usage after calls and compaction, ignores compaction billing and uses the selected window', async () => {
    const f = await fixture();
    const session = await f.connect();
    let messages: Record<string, unknown>[] = [];
    f.native.onRequest = ({ path }) => {
      if (path === '/api/model')
        return {
          data: [
            { ...fixtureModel, limit: { context: 1000 } },
            { ...fixtureModel, id: 'large-model', limit: { context: 4000 } },
          ],
        };
      if (path.endsWith('/context')) return { data: messages };
    };
    const id = await session.createSession(() => {});
    messages = [
      {
        type: 'assistant',
        model: { providerID: 'fixture', id: fixtureModel.id },
        tokens: { input: 120, output: 20, reasoning: 10, cache: { read: 30, write: 20 } },
      },
    ];
    f.native.emit(f.native.frame(id, 'session.step.ended'));
    await vi.waitFor(() =>
      expect(f.events.at(-1)).toMatchObject({
        type: 'context_usage',
        usage: { usedTokens: 200, maxTokens: 1000, estimated: false },
      }),
    );
    f.native.emit(
      f.native.frame(id, 'session.model.selected', {
        model: { providerID: 'fixture', id: 'large-model' },
      }),
    );
    await vi.waitFor(() => expect(f.events.at(-1)).toMatchObject({ usage: { maxTokens: 4000 } }));
    messages = [
      {
        type: 'compaction',
        status: 'completed',
        summary: 'short summary',
        recent: 'recent',
        tokens: { input: 9999, output: 999, reasoning: 90, cache: { read: 99, write: 99 } },
      },
    ];
    f.native.emit(f.native.frame(id, 'session.compaction.ended', { tokens: messages[0]!.tokens }));
    await vi.waitFor(() =>
      expect(f.events.at(-1)).toMatchObject({
        type: 'context_usage',
        usage: { maxTokens: 4000, estimated: true },
      }),
    );
    const usage = f.events.at(-1)!;
    expect(usage.type === 'context_usage' && usage.usage?.usedTokens).toBeGreaterThan(0);
    expect(usage.type === 'context_usage' && usage.usage?.usedTokens).toBeLessThan(100);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('clears opaque native compaction occupancy until a fresh call reports the retained window', async () => {
    const f = await fixture();
    const session = await f.connect();
    const tokens = { input: 200, output: 20, reasoning: 10, cache: { read: 50, write: 20 } };
    let messages: Record<string, unknown>[] = [];
    f.native.onRequest = ({ path }) => {
      if (path === '/api/model') return { data: [{ ...fixtureModel, limit: { context: 4000 } }] };
      if (path.endsWith('/context')) return { data: messages };
    };
    const id = await session.createSession(() => {});
    messages = [{ type: 'assistant', tokens }];
    f.native.emit(f.native.frame(id, 'session.step.ended'));
    await vi.waitFor(() =>
      expect(f.events.at(-1)).toMatchObject({
        type: 'context_usage',
        usage: { usedTokens: 300, estimated: false },
      }),
    );
    messages = [
      {
        type: 'compaction',
        status: 'completed',
        summary: '',
        recent: '',
        providerContext: { content: [{ type: 'compaction', encryptedContent: 'opaque-window' }] },
        tokens: { ...tokens, input: 99999 },
      },
    ];
    f.native.emit(f.native.frame(id, 'session.compaction.ended', { tokens: messages[0]!.tokens }));
    await vi.waitFor(() =>
      expect(f.events.at(-1)).toEqual({ type: 'context_usage', sessionId: id, usage: null }),
    );
    const beforeResume = f.events.length;
    await session.resumeSession(id);
    expect(f.events.slice(beforeResume)).toEqual([
      { type: 'context_usage', sessionId: id, usage: null },
    ]);
    messages.push({ type: 'assistant', tokens });
    f.native.emit(f.native.frame(id, 'session.step.ended'));
    await vi.waitFor(() =>
      expect(f.events.at(-1)).toMatchObject({
        type: 'context_usage',
        usage: { usedTokens: 300, maxTokens: 4000, estimated: false },
      }),
    );
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('keeps metric read failures separate from the native execution connection', async () => {
    const f = await fixture();
    const session = await f.connect();
    f.native.onRequest = ({ path }) => {
      if (path.endsWith('/context')) throw new Error('metrics unavailable');
    };
    const id = await session.createSession(() => {});
    f.native.emit(f.native.frame(id, 'session.step.ended'));
    await Promise.resolve();
    expect(f.handlers.exit).not.toHaveBeenCalled();
    expect(f.native.closed).toBe(false);
  });

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
