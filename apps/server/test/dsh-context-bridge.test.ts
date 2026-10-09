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
  }
  // Replace the carrier package loader; execute the unchanged native plugin body.
  // The meter is the native service boundary, not Isles' reconstruction of usage.
  const dependencyKey = `__islesBridge_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const dependencies = {
    '@deepseek-ai/dsh-sdk-protocol': { JsonRpcLineTransport: Transport },
    '@deepseek-ai/dsh-llm': { createUserMessage: vi.fn(), BlockAssembler: class {} },
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
  const agent = { id: 'root-agent', session, inbox: { nextStep: [], nextTurn: [] } };
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
    tools: { get: () => ({}) },
    llm: {
      resolveCallConfig: vi.fn(async (selection: unknown) => selection),
      resolveModelInfo: vi.fn(async () => ({ context: { contextWindow: 4000 } })),
    },
    agents: {
      get: () => agent,
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
  module.apply(ctx);
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
