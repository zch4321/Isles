import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
  const createUserMessage = vi.fn((input: Record<string, unknown>) => ({
    id: randomUUID(),
    ...input,
  }));
  const saveImages = vi.fn(async (images: { data: Buffer; mediaType: string }[]) =>
    images.map((image, index) => ({
      attachmentId: `attachment-${index}`,
      mediaType: image.mediaType,
      bytes: image.data.length,
      width: 1,
      height: 1,
    })),
  );
  const dependencies = {
    '@deepseek-ai/dsh-sdk-protocol': { JsonRpcLineTransport: Transport },
    '@deepseek-ai/dsh-llm': {
      createUserMessage,
      BlockAssembler: class {
        push = push;
        interruptedBlocks = interruptedBlocks;
      },
    },
    '@deepseek-ai/dsh-agent': { installModelSelection: vi.fn() },
    '@deepseek-ai/dsh-user-questions': { UserQuestionError: Error },
    '@deepseek-ai/dsh-scope': { carrierKeyOf: (carrier: unknown) => carrier },
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
    source
      .replace(
        'const native = (name) => import(pathToFileURL(carrierRequire.resolve(name)).href);',
        `const native = async (name) => globalThis[${JSON.stringify(dependencyKey)}][name];`,
      )
      .replace(
        "'./dsh-shared-roots.mjs'",
        JSON.stringify(new URL('../resources/dsh-shared-roots.mjs', import.meta.url).href),
      ),
  );
  const listeners = new Map<string, (this: unknown, ...args: unknown[]) => void>();
  const history: Record<string, unknown>[] = [];
  const session = { id: 'root-session', header: { cwd: root }, snapshotEvents: () => history };
  const agent = {
    id: 'root-agent',
    session,
    inbox: { nextStep: [], nextTurn: [] },
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    followup: vi.fn(),
    steer: vi.fn(),
  };
  const children = new Map<typeof agent, typeof agent>();
  const setPermissions = vi.fn();
  let measured = { totalTokens: 600, baseline: { kind: 'usage' }, surfaceDeltaTokens: 0 };
  const measure = vi.fn(() => measured);
  const warnings = vi.fn();
  const drainDescendants = vi.fn(async () => {});
  let prompt!: (input: { agent: typeof agent }) => string;
  const ctx = {
    get(name: string) {
      if (name === 'loader') return { await: async () => {} };
      if (name === 'tokenMeter') return { measure };
      if (name === 'subagents') return { drainDescendants };
      if (name === 'attachments') return { saveImages };
      return undefined;
    },
    logger: { warn: warnings },
    permissionPresets: { set: setPermissions },
    root: { fiber: { dispose: async () => {} } },
    inject(_names: string[], callback: (scope: unknown) => void) {
      callback({
        systemPrompt: {
          getContextOrder: () => 10,
          context: (section: { order: number; text: typeof prompt }) => {
            prompt = section.text;
            if (!Number.isFinite(section.order))
              throw new TypeError('prompt context order must be finite');
          },
        },
      });
    },
    tools: { get: () => ({}) },
    llm: {
      resolveCallConfig: vi.fn(async (selection: unknown) => selection),
      resolveModelInfo: vi.fn(
        async (): Promise<{ context?: { contextWindow: number }; inputModalities?: string[] }> => ({
          context: { contextWindow: 4000 },
        }),
      ),
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
  const additionalDirs = [join(root, 'shared'), join(root, 'external workspace')];
  await Promise.all(additionalDirs.map((path) => mkdir(path)));
  module.apply(ctx, { additionalDirs, exit: vi.fn() });
  const emit = (nativeSession: unknown, event: Record<string, unknown>) =>
    listeners.get('session/event')!(nativeSession, event);
  return {
    root,
    request,
    session,
    history,
    frames,
    measure,
    llm: ctx.llm,
    warnings,
    emit,
    push,
    interruptedBlocks,
    createUserMessage,
    saveImages,
    agent,
    setPermissions,
    drainDescendants,
    additionalDirs,
    prompt: (target = agent) => prompt({ agent: target }),
    approval(params: Record<string, unknown>) {
      return listeners.get('approval/request')!({ agent, ...params }, () => 'unavailable');
    },
    childApproval(params: Record<string, unknown>) {
      const child = { ...agent, id: 'child-session', session: { ...session, id: 'child-session' } };
      children.set(child, agent);
      listeners.get('agent/created')!({ agent: child });
      listeners.get('subagent/start')!.call(agent, {
        runId: 'child-epoch',
        id: child.id,
        provider: 'spawn',
        local: true,
      });
      return listeners.get('approval/request')!({ agent: child, ...params }, () => 'unavailable');
    },
    child(id: string, parent = agent) {
      const child = { ...agent, id, session: { ...session, id } };
      children.set(child, parent);
      listeners.get('agent/created')!({ agent: child });
      return child;
    },
    subagent(type: 'start' | 'end', info: Record<string, unknown>, parent = agent) {
      listeners.get(`subagent/${type}`)!.call(parent, info);
    },
    stream(frame: Record<string, unknown>) {
      listeners.get('agent/assistant-stream')!({ agent, frame });
    },
    measurement(value: typeof measured) {
      measured = value;
    },
  };
}

describe('DSH bridge', () => {
  it('admits image bytes to native attachments and keeps steer text-only', async () => {
    const f = await bridgeFixture();
    await f.request('isles/session/resume', {
      sessionId: f.session.id,
      cwd: f.root,
      dangerFullAccess: false,
      selection: { provider: 'fixture', model: 'model' },
    });
    const images = [
      {
        id: 'image-1',
        label: 'channel A / message 1',
        path: 'workspace/.isles-images/a.png',
        mimeType: 'image/png',
        data: 'AQID',
      },
      {
        id: 'image-2',
        label: 'channel A / message 2',
        path: 'workspace/.isles-images/b.webp',
        mimeType: 'image/webp',
        data: 'BAUG',
      },
    ];
    await expect(
      f.request('isles/session/submit', {
        sessionId: f.session.id,
        messageId: 'input-1',
        text: 'Compare these',
        images,
      }),
    ).resolves.toEqual({ sessionId: f.session.id, messageId: 'input-1' });
    expect(f.saveImages).toHaveBeenCalledWith([
      { data: Buffer.from([1, 2, 3]), mediaType: 'image/png' },
      { data: Buffer.from([4, 5, 6]), mediaType: 'image/webp' },
    ]);
    expect(f.agent.followup).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: 'user', rpcId: 'isles:input-1' },
        content: [
          { type: 'text', text: 'Compare these' },
          {
            type: 'text',
            text: '图片 image-1（channel A / message 1）\n文件路径：workspace/.isles-images/a.png',
          },
          { type: 'image', attachment: expect.objectContaining({ attachmentId: 'attachment-0' }) },
          {
            type: 'text',
            text: '图片 image-2（channel A / message 2）\n文件路径：workspace/.isles-images/b.webp',
          },
          { type: 'image', attachment: expect.objectContaining({ attachmentId: 'attachment-1' }) },
        ],
      }),
    );
    f.emit(f.session, { type: 'turn/start', seq: 1, data: { turn: 1 } });
    const steer = {
      sessionId: f.session.id,
      expectedTurnId: '1',
      messageId: 'steer-1',
      text: 'Use workspace/.isles-images/a.png',
    };
    await expect(f.request('isles/session/steer', { ...steer, images })).resolves.toMatchObject({
      rejected: true,
    });
    await expect(f.request('isles/session/steer', steer)).resolves.toEqual({
      sessionId: f.session.id,
      messageId: 'steer-1',
    });
    expect(f.agent.steer).toHaveBeenCalledOnce();
    expect(f.agent.steer).toHaveBeenCalledWith(
      expect.objectContaining({ content: [{ type: 'text', text: steer.text }] }),
    );
    expect(f.saveImages).toHaveBeenCalledOnce();
  });

  it('validates image admission before enqueue and rechecks the turn after storage', async () => {
    const f = await bridgeFixture();
    await f.request('isles/session/resume', {
      sessionId: f.session.id,
      cwd: f.root,
      dangerFullAccess: false,
      selection: { provider: 'fixture', model: 'model' },
    });
    const image = {
      id: 'image-1',
      label: 'message 1',
      path: 'a.png',
      mimeType: 'image/png',
      data: 'AQID',
    };
    const params = { sessionId: f.session.id, messageId: 'input-1', text: 'Inspect' };
    for (const invalid of [
      { ...image, mimeType: 'image/svg+xml' },
      { ...image, data: 'AQID=' },
      { ...image, data: 'AB==' },
      { ...image, data: '' },
      { ...image, label: '' },
    ]) {
      const rejected = await f.request('isles/session/submit', { ...params, images: [invalid] });
      expect(rejected).toMatchObject({ rejected: true });
      expect(rejected).not.toHaveProperty('code');
    }
    expect(f.saveImages).not.toHaveBeenCalled();
    f.llm.resolveModelInfo.mockRejectedValueOnce(new Error('temporary model lookup failure'));
    await expect(
      f.request('isles/session/submit', { ...params, images: [image] }),
    ).resolves.toEqual({ rejected: true, reason: 'DSH 模型信息暂不可用，请重试' });
    expect(f.saveImages).not.toHaveBeenCalled();
    f.llm.resolveModelInfo.mockResolvedValueOnce({ inputModalities: ['text'] });
    await expect(
      f.request('isles/session/submit', { ...params, images: [image] }),
    ).resolves.toEqual({
      rejected: true,
      code: 'image_input_unsupported',
      reason: '请选择支持图片输入的 DSH 模型并恢复 Agent',
    });
    expect(f.saveImages).not.toHaveBeenCalled();
    let release!: (
      value: {
        attachmentId: string;
        mediaType: string;
        bytes: number;
        width: number;
        height: number;
      }[],
    ) => void;
    f.saveImages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.request('isles/session/submit', { ...params, images: [image] });
    await vi.waitFor(() => expect(f.saveImages).toHaveBeenCalledOnce());
    f.emit(f.session, { type: 'turn/start', seq: 1, data: { turn: 7 } });
    release([{ attachmentId: 'saved', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }]);
    await expect(pending).resolves.toMatchObject({ rejected: true });
    expect(f.agent.followup).not.toHaveBeenCalled();
  });

  it('accepts a full-size image without a base64 validation stack overflow', async () => {
    const f = await bridgeFixture();
    await f.request('isles/session/resume', {
      sessionId: f.session.id,
      cwd: f.root,
      dangerFullAccess: false,
      selection: { provider: 'fixture', model: 'model' },
    });
    const data = Buffer.alloc(10 * 1024 * 1024, 1);
    await expect(
      f.request('isles/session/submit', {
        sessionId: f.session.id,
        messageId: 'large-image',
        text: 'Inspect',
        images: [
          {
            id: 'large-image',
            label: 'message 1',
            path: 'large.png',
            mimeType: 'image/png',
            data: data.toString('base64'),
          },
        ],
      }),
    ).resolves.toEqual({ sessionId: f.session.id, messageId: 'large-image' });
    expect(f.saveImages.mock.calls[0]![0][0]!.data.equals(data)).toBe(true);
    expect(f.agent.followup).toHaveBeenCalledOnce();
  });
  it('shows all current allowed directories to the root and native child prompt context', async () => {
    const f = await bridgeFixture();
    await f.request('isles/session/resume', {
      sessionId: f.session.id,
      cwd: f.root,
      dangerFullAccess: false,
      selection: { provider: 'fixture', model: 'model' },
    });
    const directories = await Promise.all(
      [f.root, ...f.additionalDirs].map((path) => realpath(path)),
    );
    expect(f.prompt()).toContain(JSON.stringify(directories));
    expect(f.prompt(f.child('native-child'))).toContain(JSON.stringify(directories));
  });
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
      sessionId: 'child-session',
      requestId: frame.params.requestId,
      expectedTurnId: 'child-epoch',
    });
    await expect(pending).resolves.toBe('rejected');
  });

  it('grants one operation, checks owner and turn, and consumes the approval only once', async () => {
    const f = await bridgeFixture();
    await open(f);
    const args = JSON.stringify({ command: 'printf "hello"' });
    f.history.push({ type: 'tool/call', data: { callId: 'call-1', arguments: args } });
    const pending = f.approval({ toolName: 'bash', callId: 'call-1', reason: 'Exact operation' });
    const frame = f.frames.find((entry) => entry.method === 'isles/permission')!;
    expect(frame.params.text).toBe(`Exact operation\n\n工具：bash\n操作：${args}`);
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

  it('keeps a child approval active after its root turn ends and expires it with the child epoch', async () => {
    const f = await bridgeFixture();
    await open(f);
    const pending = f.childApproval({ toolName: 'write' });
    const frame = f.frames.find((entry) => entry.method === 'isles/permission')!;
    expect(frame.params).toMatchObject({
      rootSessionId: f.session.id,
      sessionId: 'child-session',
      turnId: 'child-epoch',
    });
    f.emit(f.session, {
      type: 'turn/end',
      seq: 2,
      data: { turn: 'turn-1', reason: { kind: 'completed' } },
    });
    expect(
      f.frames.some(
        (entry) => (entry.params.event as { type?: string })?.type === 'question_expired',
      ),
    ).toBe(false);
    f.subagent('end', {
      runId: 'child-epoch',
      id: 'child-session',
      provider: 'spawn',
      local: true,
      stopReason: 'completed',
    });
    await expect(pending).resolves.toBe('cancelled');
    expect(
      f.frames.find(
        (entry) => (entry.params.event as { type?: string })?.type === 'question_expired',
      )?.params,
    ).toMatchObject({ sessionId: 'child-session', event: { turnId: 'child-epoch' } });
    expect(
      await f.request('isles/permission/answer', {
        sessionId: 'child-session',
        expectedTurnId: 'child-epoch',
        requestId: frame.params.requestId,
        allow: true,
      }),
    ).toMatchObject({ rejected: true });
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

describe('DSH bridge native subagent lifecycle', () => {
  async function open(f: Awaited<ReturnType<typeof bridgeFixture>>) {
    await f.request('isles/session/resume', {
      sessionId: f.session.id,
      cwd: f.root,
      dangerFullAccess: false,
      selection: { provider: 'fixture', model: 'model' },
    });
    f.emit(f.session, { type: 'turn/start', seq: 1, data: { turn: 1 } });
  }

  it.each([
    ['completed', 'completed'],
    ['error', 'failed'],
    ['refusal', 'failed'],
    ['max-tokens', 'failed'],
    ['aborted', 'interrupted'],
  ])(
    'maps %s child settlement to %s without completing the root turn',
    async (stopReason, status) => {
      const f = await bridgeFixture();
      await open(f);
      const identity = { runId: 'epoch-1', id: 'child', provider: 'fixture', local: false };
      f.subagent('start', identity);
      f.subagent('start', identity);
      f.subagent('end', {
        ...identity,
        stopReason,
        lastAssistantMessage: [{ type: 'text', text: 'child result' }],
      });
      f.subagent('end', { ...identity, stopReason });
      expect(f.frames.map((frame) => frame.params.event)).toMatchObject([
        { type: 'turn_started', turnId: '1' },
        { type: 'turn_started', turnId: 'epoch-1' },
        {
          type: 'item',
          turnId: 'epoch-1',
          item: {
            id: 'subagent:epoch-1',
            type: 'subagent',
            status: 'running',
            text: 'fixture · child',
          },
        },
        {
          type: 'item',
          turnId: 'epoch-1',
          item: {
            id: 'subagent:epoch-1',
            type: 'subagent',
            status,
            text: 'fixture · child\nchild result',
          },
        },
        { type: 'turn_completed', turnId: 'epoch-1', status },
      ]);
      expect(f.frames.map((frame) => frame.params.rootSessionId)).toEqual(
        Array(5).fill(f.session.id),
      );
      expect(f.frames.map((frame) => frame.params.sessionId)).toEqual([
        f.session.id,
        ...Array(4).fill('child'),
      ]);
      f.emit(f.session, {
        type: 'turn/end',
        seq: 2,
        data: { turn: 1, reason: { kind: 'completed' } },
      });
      expect(f.frames.at(-1)?.params.event).toMatchObject({
        type: 'turn_completed',
        status: 'completed',
      });
    },
  );

  it('routes nested delegations through live ownership and gives a resumed child a new epoch item', async () => {
    const f = await bridgeFixture();
    await open(f);
    const child = f.child('child');
    const grandchild = f.child('grandchild', child);
    const identity = { runId: 'nested-1', id: 'leaf', provider: 'spawn', local: true };
    f.subagent('start', { ...identity, runId: 'stale-parent' }, { ...grandchild });
    f.subagent('start', identity, grandchild);
    f.subagent('end', { ...identity, id: 'unrelated', stopReason: 'error' }, grandchild);
    f.subagent('end', { ...identity, stopReason: 'completed' }, child);
    f.subagent('end', { ...identity, stopReason: 'completed' }, grandchild);
    f.subagent('start', { ...identity, runId: 'nested-2' }, grandchild);
    expect(
      f.frames
        .filter((frame) => (frame.params.event as { type: string }).type === 'item')
        .map((frame) => frame.params.event),
    ).toMatchObject([
      { item: { id: 'subagent:nested-1', status: 'running' } },
      { item: { id: 'subagent:nested-1', status: 'completed', text: 'spawn · leaf\ncompleted' } },
      { item: { id: 'subagent:nested-2', status: 'running' } },
    ]);
  });

  it('keeps child completion and new child starts visible while the root is idle and ignores duplicate epochs', async () => {
    const f = await bridgeFixture();
    await open(f);
    const identity = { runId: 'epoch-1', id: 'child', provider: 'fixture', local: false };
    f.subagent('start', { ...identity, runId: 'unrelated' }, { ...f.agent, id: 'other-root' });
    f.subagent('end', { ...identity, stopReason: 'completed' });
    f.subagent('start', identity);
    f.emit(f.session, {
      type: 'turn/end',
      seq: 2,
      data: { turn: 1, reason: { kind: 'completed' } },
    });
    const count = f.frames.length;
    f.subagent('end', { ...identity, stopReason: 'completed' });
    f.subagent('start', identity);
    expect(f.frames.slice(count).map((frame) => frame.params.event)).toMatchObject([
      { type: 'item', turnId: 'epoch-1', item: { status: 'completed' } },
      { type: 'turn_completed', turnId: 'epoch-1', status: 'completed' },
    ]);
    f.subagent('start', { ...identity, runId: 'epoch-2' });
    expect(f.frames.at(-2)?.params).toMatchObject({
      rootSessionId: f.session.id,
      sessionId: 'child',
      event: { type: 'turn_started', turnId: 'epoch-2' },
    });
  });

  it('drains background descendants on interrupt and shutdown after the root turn ends', async () => {
    const f = await bridgeFixture();
    await open(f);
    f.subagent('start', { runId: 'epoch-1', id: 'child', provider: 'fixture', local: false });
    f.emit(f.session, {
      type: 'turn/end',
      seq: 2,
      data: { turn: 1, reason: { kind: 'completed' } },
    });
    expect(
      await f.request('isles/session/interrupt', {
        sessionId: f.session.id,
        expectedTurnId: 'epoch-1',
      }),
    ).toEqual({});
    expect(f.drainDescendants).toHaveBeenLastCalledWith([f.agent]);
    expect(f.agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true });
    await f.request('shutdown', {});
    expect(f.drainDescendants).toHaveBeenCalledTimes(2);
  });
});

describe('DSH bridge assistant streams', () => {
  it('shows native JSON tool arguments once and preserves result text and MCP identity', async () => {
    const f = await bridgeFixture();
    await f.request('isles/session/resume', {
      sessionId: f.session.id,
      cwd: f.root,
      dangerFullAccess: false,
      selection: { provider: 'fixture', model: 'model' },
    });
    const args = JSON.stringify({ text: 'first\nsecond', cwd: 'C:\\workspace\\项目' });
    f.emit(f.session, {
      type: 'tool/call',
      seq: 1,
      data: {
        turn: 1,
        step: 1,
        callId: 'mcp-1',
        name: 'mcp__isles__send_message',
        arguments: args,
      },
    });
    f.emit(f.session, {
      type: 'tool/result',
      seq: 2,
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { callId: 'mcp-1' },
          isError: true,
          content: [{ type: 'text', text: 'message rejected\n请重试' }],
        },
      },
    });
    expect(f.frames.map((frame) => frame.params.event)).toMatchObject([
      {
        type: 'item',
        turnId: '1',
        append: false,
        item: {
          id: 'mcp-1',
          type: 'mcpToolCall',
          status: 'running',
          text: `mcp__isles__send_message: ${args}`,
        },
      },
      {
        type: 'item',
        turnId: '1',
        append: false,
        item: {
          id: 'mcp-1',
          type: 'mcpToolCall',
          status: 'failed',
          text: 'message rejected\n请重试',
        },
      },
    ]);
  });

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
