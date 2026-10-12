import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function bridgeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-dsh-context-bridge-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const frames: { method: string; params: Record<string, unknown> }[] = [];
  let request!: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  class Transport {
    notify(method: string, params: Record<string, unknown>) {
      frames.push({ method, params });
    }
    onRequest(callback: typeof request) {
      request = callback;
    }
    start() {}
    close() {}
    async flush() {}
  }
  // Replace the carrier package loader; execute the unchanged native plugin body.
  // The meter is the native service boundary, not Isles' reconstruction of usage.
  const dependencyKey = `__islesBridge_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const push = vi.fn();
  const interruptedBlocks = vi.fn((): { type: string; text: string }[] => []);
  const dependencies = {
    '@deepseek-ai/dsh-sdk-protocol': { JsonRpcLineTransport: Transport },
    '@deepseek-ai/dsh-llm': {
      createUserMessage: vi.fn(),
      BlockAssembler: class {
        push = push;
        interruptedBlocks = interruptedBlocks;
      },
    },
    '@deepseek-ai/dsh-agent': { installModelSelection: vi.fn() },
    '@deepseek-ai/dsh-user-questions': { UserQuestionError: Error },
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[dependencyKey] = dependencies;
  cleanups.push(async () => {
    delete globals[dependencyKey];
  });
  const source = await readFile(new URL('../resources/dsh-bridge.mjs', import.meta.url), 'utf8');
  const path = join(root, 'bridge.mjs');
  await writeFile(
    path,
    source.replace(
      'const native = (name) => import(pathToFileURL(carrierRequire.resolve(name)).href);',
      `const native = async (name) => globalThis[${JSON.stringify(dependencyKey)}][name];`,
    ),
  );
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const session = { id: 'root-session', header: { cwd: root }, snapshotEvents: () => [] };
  const agent = {
    id: 'root-agent',
    session,
    inbox: { nextStep: [], nextTurn: [] },
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  };
  const children = new Map<typeof agent, typeof agent>();
  const setPermissions = vi.fn();
  let measured = { totalTokens: 600, baseline: { kind: 'usage' }, surfaceDeltaTokens: 0 };
  const measure = vi.fn(() => measured);
  const warnings = vi.fn();
  const ctx = {
    get(name: string) {
      if (name === 'loader') return { await: async () => {} };
      if (name === 'tokenMeter') return { measure };
      return undefined;
    },
    logger: { warn: warnings },
    permissionPresets: { set: setPermissions },
    root: { fiber: { dispose: async () => {} } },
    inject(_names: string[], callback: (scope: unknown) => void) {
      callback({
        systemPrompt: {
          getContextOrder: () => 10,
          context: (section: { order: number }) => {
            if (!Number.isFinite(section.order))
              throw new TypeError('prompt context order must be finite');
          },
        },
      });
    },
    tools: { get: () => ({}) },
    llm: {
      resolveCallConfig: vi.fn(async (selection: unknown) => selection),
      resolveModelInfo: vi.fn(async () => ({ context: { contextWindow: 4000 } })),
    },
    agents: {
      get: (id: string) => [agent, ...children.keys()].find((entry) => entry.id === id),
      list: () => [agent, ...children.keys()],
      isOwnedBy: (id: string, parent: typeof agent) =>
        [...children].some(([child, owner]) => child.id === id && owner === parent),
      resume: async ({ setup }: { setup: (ctx: unknown, agent: unknown) => void }) => {
        setup(ctx, agent);
        return { dispose: async () => {} };
      },
    },
    on(name: string, listener: (...args: unknown[]) => void) {
      listeners.set(name, listener);
      return () => {};
    },
    effect() {},
  };
  const module = await import(pathToFileURL(path).href);
  module.apply(ctx, { sharedDir: join(root, 'shared'), exit: vi.fn() });
  const emit = (nativeSession: unknown, event: Record<string, unknown>) =>
    listeners.get('session/event')!(nativeSession, event);
  return {
    root,
    request,
    session,
    frames,
    measure,
    llm: ctx.llm,
    warnings,
    emit,
    push,
    interruptedBlocks,
    agent,
    setPermissions,
    approval(params: Record<string, unknown>) {
      return listeners.get('approval/request')!({ agent, ...params }, () => 'unavailable');
    },
    childApproval(params: Record<string, unknown>) {
      const child = { ...agent, id: 'child-agent', session: { ...session, id: 'child-session' } };
      children.set(child, agent);
      listeners.get('agent/created')!({ agent: child });
      return listeners.get('approval/request')!({ agent: child, ...params }, () => 'unavailable');
    },
    stream(frame: Record<string, unknown>) {
      listeners.get('agent/assistant-stream')!({ agent, frame });
    },
    measurement(value: typeof measured) {
      measured = value;
    },
  };
}

describe('DSH bridge native context meter', () => {
  it('restores native measurement and reports latest calls and compacted surface instead of cumulative billing', async () => {
    const f = await bridgeFixture();
    const opened = await f.request('isles/session/resume', {
      sessionId: f.session.id,
      cwd: f.root,
      dangerFullAccess: false,
      selection: { provider: 'fixture', model: 'model' },
    });
    expect(opened).toMatchObject({
      contextUsage: { usedTokens: 600, maxTokens: 4000, estimated: false },
    });
    expect(f.llm.resolveCallConfig).toHaveBeenCalledWith({ provider: 'fixture', model: 'model' });
    expect(f.llm.resolveModelInfo).toHaveBeenCalledWith('fixture', 'model');
    f.emit({ ...f.session, id: 'child-session' }, { type: 'assistant/message', seq: 1, data: {} });
    expect(f.frames).toHaveLength(0);
    f.measurement({ totalTokens: 350, baseline: { kind: 'usage' }, surfaceDeltaTokens: 0 });
    f.emit(f.session, { type: 'request/context', seq: 2, data: { contextWindow: 8000 } });
    expect(f.frames.at(-1)?.params).toMatchObject({
      sessionId: f.session.id,
      event: {
        type: 'context_usage',
        usage: { usedTokens: 350, maxTokens: 8000, estimated: false },
      },
    });
    // Meter already includes disjoint input/cache/output buckets. A raw cumulative
    // or reasoning token field must not be added to that calibrated measurement.
    f.emit(f.session, {
      type: 'assistant/message',
      seq: 3,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: { content: [] },
        usage: {
          inputTokens: 99999,
          cacheReadTokens: 9999,
          outputTokens: 999,
          reasoningTokens: 999,
        },
      },
    });
    expect(
      f.frames
        .filter((frame) => (frame.params.event as { type: string }).type === 'context_usage')
        .at(-1)?.params,
    ).toMatchObject({ event: { usage: { usedTokens: 350 } } });
    f.measurement({ totalTokens: 90, baseline: { kind: 'usage' }, surfaceDeltaTokens: -260 });
    f.emit(f.session, { type: 'compaction/end', seq: 4, data: { totalTokens: 50000 } });
    expect(f.frames.at(-1)?.params).toMatchObject({
      event: { usage: { usedTokens: 90, estimated: true } },
    });
    f.emit(f.session, { type: 'request/context', seq: 5, data: {} });
    expect(f.frames.at(-1)?.params).toMatchObject({ event: { usage: { maxTokens: null } } });
    expect(f.measure).toHaveBeenCalledWith(f.session);
  });

  it('keeps restored usage available when capacity metadata cannot be read', async () => {
    const f = await bridgeFixture();
    f.llm.resolveModelInfo.mockRejectedValue(new Error('secret-provider-diagnostic'));
    const opened = await f.request('isles/session/resume', {
      sessionId: f.session.id,
      cwd: f.root,
      dangerFullAccess: false,
      selection: { provider: 'fixture', model: 'model', reasoningEffort: 'high' },
    });
    expect(opened).toMatchObject({
      contextUsage: { usedTokens: 600, maxTokens: null, estimated: false },
    });
    expect(f.llm.resolveCallConfig).toHaveBeenCalledWith({
      provider: 'fixture',
      model: 'model',
      reasoningEffort: 'high',
    });
    expect(f.warnings).toHaveBeenCalledWith('Isles DSH context model read failed');
    expect(JSON.stringify(f.warnings.mock.calls)).not.toContain('secret-provider-diagnostic');
    f.emit(f.session, { type: 'request/context', seq: 1, data: { contextWindow: 8000 } });
    expect(f.frames.at(-1)?.params).toMatchObject({
      event: { usage: { usedTokens: 600, maxTokens: 8000 } },
    });
  });

  it('marks native fallback estimates and contains measurement failures without provider diagnostics', async () => {
    const f = await bridgeFixture();
    f.measurement({ totalTokens: 40, baseline: { kind: 'estimated' }, surfaceDeltaTokens: 0 });
    const params = {
      sessionId: f.session.id,
      cwd: f.root,
      dangerFullAccess: false,
      selection: { provider: 'fixture', model: 'model' },
    };
    expect(await f.request('isles/session/resume', params)).toMatchObject({
      contextUsage: { usedTokens: 40, estimated: true },
    });
    f.measure.mockImplementation(() => {
      throw new Error('secret-provider-diagnostic');
    });
    expect(() =>
      f.emit(f.session, { type: 'request/context', seq: 1, data: { contextWindow: 4000 } }),
    ).not.toThrow();
    expect(f.warnings).toHaveBeenCalledWith('Isles DSH context usage read failed');
    expect(JSON.stringify(f.warnings.mock.calls)).not.toContain('secret-provider-diagnostic');
  });
});

describe('DSH bridge native permissions', () => {
  async function open(f: Awaited<ReturnType<typeof bridgeFixture>>, dangerFullAccess = false) {
    await f.request('isles/session/resume', {
      sessionId: f.session.id,
      cwd: f.root,
      dangerFullAccess,
      selection: { provider: 'fixture', model: 'model' },
    });
    f.emit(f.session, { type: 'turn/start', seq: 1, data: { turn: 'turn-1' } });
  }

  it('pins Isles mode for restored root and spawned children independently of native defaults', async () => {
    const f = await bridgeFixture();
    await open(f, true);
    expect(f.setPermissions).toHaveBeenCalledWith(f.session, 'danger-full-access');
    const pending = f.childApproval({ toolName: 'write' });
    expect(f.setPermissions).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'child-session' }),
      'danger-full-access',
    );
    const frame = f.frames.find((entry) => entry.method === 'isles/permission')!;
    await f.request('isles/permission/reject', {
      sessionId: f.session.id,
      requestId: frame.params.requestId,
      expectedTurnId: 'turn-1',
    });
    await expect(pending).resolves.toBe('rejected');
  });

  it('grants one operation, checks owner and turn, and consumes the approval only once', async () => {
    const f = await bridgeFixture();
    await open(f);
    const pending = f.approval({ toolName: 'bash', callId: 'call-1', reason: 'Exact operation' });
    const frame = f.frames.find((entry) => entry.method === 'isles/permission')!;
    const params = {
      sessionId: f.session.id,
      requestId: frame.params.requestId,
      expectedTurnId: 'turn-1',
      allow: true,
    };
    expect(
      await f.request('isles/permission/answer', { ...params, sessionId: 'other-session' }),
    ).toMatchObject({ rejected: true });
    expect(
      await f.request('isles/permission/answer', { ...params, expectedTurnId: 'old-turn' }),
    ).toMatchObject({ rejected: true });
    expect(await f.request('isles/permission/answer', { ...params, allow: 'yes' })).toMatchObject({
      rejected: true,
    });
    expect(await f.request('isles/permission/answer', params)).toEqual({});
    await expect(pending).resolves.toBe('allowed-once');
    expect(await f.request('isles/permission/answer', params)).toMatchObject({ rejected: true });
    expect(
      f.frames.some(
        (entry) => (entry.params.event as { type?: string })?.type === 'question_expired',
      ),
    ).toBe(false);
    expect(f.setPermissions).toHaveBeenCalledTimes(1);
  });

  it.each(['abort', 'end', 'interrupt', 'close'])(
    'expires pending approvals on %s and refuses late answers',
    async (kind) => {
      const f = await bridgeFixture();
      await open(f);
      const controller = new AbortController();
      const pending = f.approval({ toolName: 'write', signal: controller.signal });
      const frame = f.frames.find((entry) => entry.method === 'isles/permission')!;
      if (kind === 'abort') controller.abort();
      else if (kind === 'end')
        f.emit(f.session, {
          type: 'turn/end',
          seq: 2,
          data: { turn: 'turn-1', reason: { kind: 'completed' } },
        });
      else if (kind === 'interrupt')
        await f.request('isles/session/interrupt', {
          sessionId: f.session.id,
          expectedTurnId: 'turn-1',
        });
      else await f.request('shutdown', {});
      await expect(pending).resolves.toBe('cancelled');
      expect(
        f.frames.filter(
          (entry) => (entry.params.event as { type?: string })?.type === 'question_expired',
        ),
      ).toHaveLength(1);
      expect(
        await f.request('isles/permission/answer', {
          sessionId: f.session.id,
          requestId: frame.params.requestId,
          expectedTurnId: 'turn-1',
          allow: true,
        }),
      ).toMatchObject({ rejected: true });
    },
  );
});

describe('DSH bridge assistant streams', () => {
  it('forwards only raw text and reasoning deltas and persists the native final snapshot once', async () => {
    const f = await bridgeFixture();
    await f.request('isles/session/resume', {
      sessionId: f.session.id,
      cwd: f.root,
      dangerFullAccess: false,
      selection: { provider: 'fixture', model: 'model' },
    });
    const measuredBeforeStream = f.measure.mock.calls.length;
    f.stream({ type: 'start', attemptId: 'attempt-1', turn: 1, step: 2, revision: 0 });
    const chunks = [
      { type: 'reasoning-delta', index: 0, text: 'Think' },
      { type: 'text-delta', index: 1, text: 'Hello' },
      { type: 'text-delta', index: 1, text: ' 中文' },
      { type: 'reasoning-delta', index: 0, text: ' more' },
      { type: 'text-delta', index: 1, text: '' },
      { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'shell', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    chunks.forEach((chunk, revision) =>
      f.stream({ type: 'chunk', attemptId: 'attempt-1', revision: revision + 1, chunk }),
    );
    expect(f.push.mock.calls.map(([chunk]) => chunk)).toEqual(chunks);
    expect(f.interruptedBlocks).not.toHaveBeenCalled();
    expect(f.measure).toHaveBeenCalledTimes(measuredBeforeStream);
    const deltas = f.frames.map((frame) => frame.params.event);
    expect(deltas).toEqual([
      {
        type: 'item_delta',
        turnId: '1',
        append: false,
        item: { id: 'reasoning:1:2', type: 'reasoning', status: 'running', text: 'Think' },
      },
      {
        type: 'item_delta',
        turnId: '1',
        append: false,
        item: { id: 'assistant:1:2', type: 'agentMessage', status: 'running', text: 'Hello' },
      },
      {
        type: 'item_delta',
        turnId: '1',
        append: true,
        item: { id: 'assistant:1:2', type: 'agentMessage', status: 'running', text: ' 中文' },
      },
      {
        type: 'item_delta',
        turnId: '1',
        append: true,
        item: { id: 'reasoning:1:2', type: 'reasoning', status: 'running', text: ' more' },
      },
    ]);
    expect(new Set(f.frames.map((frame) => frame.params.eventId)).size).toBe(4);
    f.emit(f.session, {
      type: 'assistant/message',
      seq: 10,
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [
            { type: 'reasoning', text: 'Think more' },
            { type: 'text', text: 'Hello 中文' },
          ],
        },
      },
    });
    const frameCount = f.frames.length;
    f.stream({
      type: 'end',
      attemptId: 'attempt-1',
      revision: 8,
      outcome: { kind: 'committed', eventType: 'assistant/message' },
    });
    expect(f.frames).toHaveLength(frameCount);
    expect(f.interruptedBlocks).not.toHaveBeenCalled();
    expect(f.frames.slice(4).map((frame) => frame.params.event)).toEqual([
      {
        type: 'item',
        turnId: '1',
        append: false,
        item: {
          id: 'assistant:1:2',
          type: 'agentMessage',
          status: 'completed',
          text: 'Hello 中文',
        },
      },
      {
        type: 'item',
        turnId: '1',
        append: false,
        item: { id: 'reasoning:1:2', type: 'reasoning', status: 'completed', text: 'Think more' },
      },
    ]);
  });

  it('replaces each previous attempt prefix on retry while keeping final item identities stable', async () => {
    const f = await bridgeFixture();
    await f.request('isles/session/resume', {
      sessionId: f.session.id,
      cwd: f.root,
      dangerFullAccess: false,
      selection: { provider: 'fixture', model: 'model' },
    });
    const chunk = (attemptId: string, revision: number, type: string, text: string) =>
      f.stream({
        type: 'chunk',
        attemptId,
        revision,
        chunk: { type, index: type === 'reasoning-delta' ? 0 : 1, text },
      });
    f.stream({ type: 'start', attemptId: 'initial', turn: 1, step: 2, revision: 0 });
    chunk('initial', 1, 'text-delta', 'Old answer');
    chunk('initial', 2, 'reasoning-delta', 'Old thought');
    f.interruptedBlocks.mockReturnValue([
      { type: 'text', text: 'Old answer' },
      { type: 'reasoning', text: 'Old thought' },
    ]);
    f.stream({
      type: 'end',
      attemptId: 'initial',
      revision: 3,
      outcome: { kind: 'committed', eventType: 'assistant/attempt' },
    });
    f.stream({ type: 'start', attemptId: 'retry', turn: 1, step: 2, revision: 4 });
    chunk('retry', 5, 'text-delta', '');
    chunk('retry', 6, 'text-delta', 'New');
    chunk('retry', 7, 'text-delta', ' answer');
    chunk('retry', 8, 'reasoning-delta', 'New');
    chunk('retry', 9, 'reasoning-delta', ' thought');
    const events = f.frames.map((frame) => frame.params.event) as {
      type: string;
      append: boolean;
      item: { id: string; text: string };
    }[];
    expect(
      events.slice(4).map((event) => ({
        id: event.item.id,
        text: event.item.text,
        append: event.append,
      })),
    ).toEqual([
      { id: 'assistant:1:2', text: '', append: false },
      { id: 'reasoning:1:2', text: '', append: false },
      { id: 'assistant:1:2', text: 'New', append: false },
      { id: 'assistant:1:2', text: ' answer', append: true },
      { id: 'reasoning:1:2', text: 'New', append: false },
      { id: 'reasoning:1:2', text: ' thought', append: true },
    ]);
    const cumulative = new Map<string, string>();
    for (const event of events)
      cumulative.set(
        event.item.id,
        (event.append ? (cumulative.get(event.item.id) ?? '') : '') + event.item.text,
      );
    expect([...cumulative]).toEqual([
      ['assistant:1:2', 'New answer'],
      ['reasoning:1:2', 'New thought'],
    ]);
    f.emit(f.session, {
      type: 'assistant/message',
      seq: 10,
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [
            { type: 'text', text: 'New answer' },
            { type: 'reasoning', text: 'New thought' },
          ],
        },
      },
    });
    expect(f.frames.slice(-2).map((frame) => frame.params.event)).toMatchObject([
      { type: 'item', append: false, item: { id: 'assistant:1:2', text: 'New answer' } },
      { type: 'item', append: false, item: { id: 'reasoning:1:2', text: 'New thought' } },
    ]);
  });

  it('clears abandoned reasoning when a retry only returns text and clears attempt tracking on turn end', async () => {
    const f = await bridgeFixture();
    await f.request('isles/session/resume', {
      sessionId: f.session.id,
      cwd: f.root,
      dangerFullAccess: false,
      selection: { provider: 'fixture', model: 'model' },
    });
    f.stream({ type: 'start', attemptId: 'with-reasoning', turn: 1, step: 2, revision: 0 });
    f.stream({
      type: 'chunk',
      attemptId: 'with-reasoning',
      revision: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: 'Abandoned thought' },
    });
    f.interruptedBlocks.mockReturnValue([{ type: 'reasoning', text: 'Abandoned thought' }]);
    f.stream({
      type: 'end',
      attemptId: 'with-reasoning',
      revision: 2,
      outcome: { kind: 'committed', eventType: 'assistant/attempt' },
    });
    const firstAttemptFrameCount = f.frames.length;
    f.stream({ type: 'start', attemptId: 'text-only', turn: 1, step: 2, revision: 3 });
    expect(f.frames.slice(firstAttemptFrameCount).map((frame) => frame.params.event)).toEqual([
      {
        type: 'item_delta',
        turnId: '1',
        append: false,
        item: { id: 'reasoning:1:2', type: 'reasoning', status: 'running', text: '' },
      },
    ]);
    f.stream({
      type: 'chunk',
      attemptId: 'text-only',
      revision: 4,
      chunk: { type: 'text-delta', index: 0, text: 'Final answer' },
    });
    f.emit(f.session, {
      type: 'assistant/message',
      seq: 5,
      data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Final answer' }] } },
    });
    expect(
      f.frames
        .filter((frame) => (frame.params.event as { type: string }).type === 'item')
        .map((frame) => frame.params.event),
    ).toEqual([
      {
        type: 'item',
        turnId: '1',
        append: false,
        item: {
          id: 'assistant:1:2',
          type: 'agentMessage',
          status: 'completed',
          text: 'Final answer',
        },
      },
    ]);
    f.stream({
      type: 'end',
      attemptId: 'text-only',
      revision: 5,
      outcome: { kind: 'committed', eventType: 'assistant/message' },
    });
    f.emit(f.session, {
      type: 'turn/end',
      seq: 6,
      data: { turn: 1, reason: { kind: 'completed' } },
    });
    const completedFrameCount = f.frames.length;
    f.stream({ type: 'start', attemptId: 'after-completion', turn: 1, step: 2, revision: 6 });
    expect(f.frames).toHaveLength(completedFrameCount);
  });

  it('keeps an incomplete native snapshot transient until the turn completes', async () => {
    const f = await bridgeFixture();
    await f.request('isles/session/resume', {
      sessionId: f.session.id,
      cwd: f.root,
      dangerFullAccess: false,
      selection: { provider: 'fixture', model: 'model' },
    });
    f.stream({ type: 'start', attemptId: 'attempt-2', turn: 3, step: 1, revision: 0 });
    f.stream({
      type: 'chunk',
      attemptId: 'attempt-2',
      revision: 1,
      chunk: { type: 'text-delta', index: 0, text: 'Partial' },
    });
    f.interruptedBlocks.mockReturnValue([
      { type: 'text', text: 'Partial' },
      { type: 'text', text: 'closed block' },
      { type: 'reasoning', text: 'unfinished thought' },
    ]);
    f.stream({
      type: 'end',
      attemptId: 'attempt-2',
      revision: 2,
      outcome: { kind: 'discarded' },
    });
    expect(f.interruptedBlocks).toHaveBeenCalledTimes(1);
    expect(f.frames.slice(1).map((frame) => frame.params.event)).toEqual([
      {
        type: 'item_delta',
        turnId: '3',
        append: false,
        item: {
          id: 'assistant:3:1',
          type: 'agentMessage',
          status: 'failed',
          text: 'Partial\nclosed block',
        },
      },
      {
        type: 'item_delta',
        turnId: '3',
        append: false,
        item: {
          id: 'reasoning:3:1',
          type: 'reasoning',
          status: 'failed',
          text: 'unfinished thought',
        },
      },
    ]);
    f.emit(f.session, {
      type: 'turn/end',
      seq: 20,
      data: { turn: 3, reason: { kind: 'aborted' } },
    });
    expect(f.frames.at(-1)?.params.event).toMatchObject({
      type: 'turn_completed',
      turnId: '3',
      status: 'interrupted',
    });
    expect(f.frames.some((frame) => (frame.params.event as { type: string }).type === 'item')).toBe(
      false,
    );
    const completedFrameCount = f.frames.length;
    f.stream({ type: 'start', attemptId: 'after-abort', turn: 3, step: 1, revision: 3 });
    expect(f.frames).toHaveLength(completedFrameCount);
  });
});
