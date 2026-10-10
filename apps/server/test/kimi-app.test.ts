import { ConfigManager } from '@isles/config';
import type { Agent } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { kimiWebFixture } from './kimi-web-fixture.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-kimi-app-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cli = await kimiWebFixture(root);
  const config = new ConfigManager({
    configFilePath: join(root, 'config.toml'),
    homeDir: root,
    environment: { ISLES_KIMI_HOME: cli.home },
  });
  await config.configureCliBinary('kimi', cli.binary);
  const app = await buildApp({ config, runtimeUrl: 'http://127.0.0.1:4310' });
  cleanups.push(() => app.close());
  const create = async (payload: Record<string, unknown> = {}) => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        harness: 'kimi',
        name: 'Kimi',
        model: 'kimi-code/k3',
        reasoningEffort: 'high',
        ...payload,
      },
    });
    expect(result.statusCode).toBe(201);
    const agent = result.json() as Agent;
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('ready'), {
      timeout: 5_000,
    });
    return agent;
  };
  const send = (agent: Agent, body: string) =>
    app.inject({
      method: 'POST',
      url: `/api/channels/${agent.channelId}/messages`,
      payload: { body, clientId: randomUUID() },
    });
  const frames = async (tail: string, method = 'POST') =>
    (await cli.records()).filter(
      (frame) => frame.type === 'http' && frame.method === method && frame.path?.endsWith(tail),
    );
  return { root, cli, config, app, create, send, frames };
}

describe('Kimi Code application integration', () => {
  it('registers Kimi with steer and keeps its path and catalog independent', async () => {
    const { app, config, cli, root } = await fixture();
    const harnesses = (await app.inject('/api/harnesses')).json().harnesses as {
      id: string;
      configuration: string | null;
      capabilities: Record<string, boolean>;
    }[];
    expect(harnesses.map((harness) => harness.id)).toEqual([
      'codex',
      'claude',
      'kimi',
      'opencode',
      'dsh',
    ]);
    expect(harnesses[2]).toMatchObject({
      configuration: 'cli-path',
      capabilities: { steer: true, sessionResume: true, mcp: true, userQuestions: true },
    });
    expect((await app.inject('/api/harnesses/kimi/status')).json()).toMatchObject({
      available: true,
      authenticated: true,
      version: '2.1.1',
      binaryPath: cli.binary,
    });
    expect(
      (await app.inject('/api/harnesses/kimi/models'))
        .json()
        .models.map((model: { model: string }) => model.model),
    ).toEqual(['kimi-code/k3', 'kimi-code/fast']);
    const missing = join(root, 'missing-kimi');
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/harnesses/kimi/config',
          payload: { binaryPath: missing },
        })
      ).json(),
    ).toMatchObject({ binaryPath: missing, configFilePath: config.current.configFilePath });
    expect((await app.inject('/api/harnesses/kimi/status')).json()).toMatchObject({
      available: false,
      error: expect.stringContaining(missing),
    });
    expect(parse(await readFile(config.current.configFilePath, 'utf8'))).toMatchObject({
      kimi: { binary_path: missing },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/harnesses/kimi/config',
      payload: { binaryPath: cli.binary },
    });
    const steered = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        harness: 'kimi',
        name: 'Steer',
        model: 'kimi-code/k3',
        reasoningEffort: 'high',
        steerEnabled: true,
      },
    });
    expect(steered.statusCode).toBe(201);
    const enabled = steered.json() as Agent;
    await vi.waitFor(() => expect(app.isles.store.publicAgent(enabled.id).status).toBe('ready'));
    expect(enabled.steerEnabled).toBe(true);
  });

  it('creates a Kimi Agent, completes a private run and resumes the same session after stop', async () => {
    const { app, create, send, frames } = await fixture();
    const agent = await create();
    const binding = app.isles.store.publicAgent(agent.id).threadId;
    expect(binding).toMatch(/^session_/);
    expect(app.isles.store.agentDetail(agent.id).runs).toEqual([]);
    expect(await frames('/prompts')).toEqual([]);
    await send(agent, 'hello');
    await vi.waitFor(() =>
      expect(app.isles.store.agentDetail(agent.id).runs).toMatchObject([{ status: 'completed' }]),
    );
    const [run] = app.isles.store.agentDetail(agent.id).runs;
    expect(run).toMatchObject({ threadId: binding, turnId: '1' });
    expect(run!.items).toMatchObject([
      { type: 'agentMessage', status: 'completed', text: expect.stringContaining('Reply: ') },
    ]);
    expect(app.isles.store.listMessages(agent.channelId)[0]!.deliveries[0]!.status).toBe(
      'completed',
    );
    await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/stop`, payload: {} });
    await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/resume`, payload: {} });
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('ready'));
    expect(app.isles.store.publicAgent(agent.id).threadId).toBe(binding);
    expect(await frames(`/sessions/${binding}`, 'GET')).toHaveLength(1);
    expect(await frames('/sessions')).toHaveLength(1);
  });

  it('queues busy input for the next Kimi turn in the same session', async () => {
    const { app, cli, create, send, frames } = await fixture();
    const agent = await create();
    await cli.set({ holdTurn: true });
    await send(agent, 'initial');
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('running'));
    await send(agent, 'queued');
    expect(app.isles.store.listMessages(agent.channelId).at(-1)!.deliveries[0]!.status).toBe(
      'queued',
    );
    await vi.waitFor(async () => expect(await frames('/prompts')).toHaveLength(1));
    await cli.set({ holdTurn: true, releaseHeld: true });
    await vi.waitFor(() =>
      expect(
        app.isles.store.agentDetail(agent.id).runs.filter((run) => run.status === 'completed'),
      ).toHaveLength(2),
    );
    expect(
      new Set(app.isles.store.agentDetail(agent.id).runs.map((run) => run.threadId)).size,
    ).toBe(1);
  });

  it('keeps the service alive and the delivery uncertain when native acceptance is lost', async () => {
    const { app, cli, create, send } = await fixture();
    const agent = await create();
    await cli.set({ loseBeforeAcceptance: true });
    await send(agent, 'invalid response');
    await vi.waitFor(() =>
      expect(app.isles.store.agentDetail(agent.id).runs).toMatchObject([{ status: 'uncertain' }]),
    );
    expect(app.isles.store.publicAgent(agent.id).status).toBe('error');
    expect(app.isles.store.listMessages(agent.channelId)[0]!.deliveries[0]!.status).toBe(
      'uncertain',
    );
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  });

  it('appends new messages to the active turn when steer is enabled', async () => {
    const { app, cli, create, send, frames } = await fixture();
    const agent = await create({ steerEnabled: true });
    await cli.set({ holdTurn: true });
    await send(agent, 'initial');
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('running'));
    await send(agent, 'append');
    await vi.waitFor(async () => expect(await frames(':steer')).toHaveLength(1));
    await cli.finish(app.isles.store.publicAgent(agent.id).threadId!);
    await vi.waitFor(() =>
      expect(app.isles.store.agentDetail(agent.id).runs).toMatchObject([{ status: 'completed' }]),
    );
    expect(app.isles.store.agentDetail(agent.id).runs).toHaveLength(1);
    expect(
      app.isles.store.listMessages(agent.channelId).map((message) => message.deliveries[0]!.status),
    ).toEqual(['completed', 'completed']);
    expect(await frames('/prompts')).toHaveLength(2);
  });

  it.each([
    { finishOnQueuedPrompt: true, queuedPromptResponseDelayMs: 50, nextTurnBeforeEnd: false },
    { finishOnQueuedPrompt: true, queuedPromptResponseDelayMs: 50, nextTurnBeforeEnd: true },
    { boundaryOnSteer: true, nextTurnBeforeEnd: false },
    { boundaryOnSteer: true, nextTurnBeforeEnd: true },
  ])(
    'tracks a consumed continuation in one run, including later steer and questions: %j',
    async (race) => {
      const { app, cli, create, send, frames } = await fixture();
      const agent = await create({ steerEnabled: true });
      await cli.set({ manualOutput: true, holdTurn: true, ...race });
      await send(agent, 'initial');
      await vi.waitFor(() =>
        expect(app.isles.store.agentDetail(agent.id).runs[0]?.turnId).toBe('1'),
      );
      const runId = app.isles.store.agentDetail(agent.id).runs[0]!.id;
      await send(agent, 'late append');
      await vi.waitFor(() =>
        expect(
          app.isles.store
            .listMessages(agent.channelId)
            .map((message) => message.deliveries[0]!.status),
        ).toEqual(['accepted', 'accepted']),
      );
      expect(app.isles.store.publicAgent(agent.id).status).toBe('running');
      expect(app.isles.store.agentDetail(agent.id).runs).toMatchObject([
        { id: runId, turnId: '1', status: 'running' },
      ]);
      const nativeId = app.isles.store.publicAgent(agent.id).threadId!;
      const posts = await frames('/prompts');
      expect(posts).toHaveLength(2);
      const activePromptId = posts[1]!.body!.prompt_id;
      await cli.set({ manualOutput: true, holdTurn: true });
      await cli.emit(nativeId, 'assistant.delta', { turnId: 1, delta: 'Old late output' });
      await cli.emit(nativeId, 'assistant.delta', { turnId: 2, delta: 'Continuation reply' });
      await send(agent, 'append to continuation');
      await vi.waitFor(() =>
        expect(
          app.isles.store
            .listMessages(agent.channelId)
            .map((message) => message.deliveries[0]!.status),
        ).toEqual(['accepted', 'accepted', 'accepted']),
      );
      const receipts = (await cli.records()).filter(
        (record) => record.type === 'event' && record.frame?.type === 'prompt.steered',
      );
      expect(receipts.at(-1)?.frame?.payload).toMatchObject({ activePromptId });
      await cli.question(nativeId);
      await vi.waitFor(() =>
        expect(app.isles.store.agentDetail(agent.id).questions).toHaveLength(1),
      );
      const question = app.isles.store.agentDetail(agent.id).questions[0]!;
      expect(question).toMatchObject({ runId, status: 'pending' });
      const nativeQuestion = app.isles.store.getQuestion(question.id);
      expect(nativeQuestion.turnId).toBe('1');
      const answer = await app.inject({
        method: 'POST',
        url: `/api/agents/${agent.id}/questions/${question.id}/answer`,
        payload: { answers: { q0: { answers: ['Two'] } } },
      });
      expect(answer.statusCode).toBe(200);
      await vi.waitFor(async () =>
        expect(
          await frames('/questions/' + JSON.parse(nativeQuestion.nativeRequestId)),
        ).toHaveLength(1),
      );
      await cli.finish(nativeId);
      await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('ready'));
      const detail = app.isles.store.agentDetail(agent.id);
      expect(detail.runs).toHaveLength(1);
      expect(detail.runs[0]).toMatchObject({
        id: runId,
        turnId: '1',
        status: 'completed',
        inputs: [{ channelId: agent.channelId, messageSeqs: [1, 2, 3] }],
      });
      expect(detail.runs[0]!.items.map((item) => item.text).join('\n')).toContain(
        'Continuation reply',
      );
      expect(detail.runs[0]!.items.map((item) => item.text).join('\n')).not.toContain(
        'Old late output',
      );
      expect(
        app.isles.store
          .listMessages(agent.channelId)
          .map((message) => message.deliveries[0]!.status),
      ).toEqual(['completed', 'completed', 'completed']);
      expect(await frames('/prompts')).toHaveLength(3);
      expect(await frames(':abort')).toHaveLength(0);
      expect((await app.inject('/api/health')).statusCode).toBe(200);
    },
  );

  it('cancels pending input before the active continuation without starting another native turn', async () => {
    const { app, cli, create, send, frames } = await fixture();
    const agent = await create({ steerEnabled: true });
    await cli.set({
      manualOutput: true,
      holdTurn: true,
      boundaryOnSteer: true,
      nextTurnBeforeEnd: true,
    });
    await send(agent, 'initial');
    await vi.waitFor(() => expect(app.isles.store.agentDetail(agent.id).runs[0]?.turnId).toBe('1'));
    await send(agent, 'native continuation');
    await vi.waitFor(() =>
      expect(
        app.isles.store
          .listMessages(agent.channelId)
          .map((message) => message.deliveries[0]!.status),
      ).toEqual(['accepted', 'accepted']),
    );
    await cli.set({ manualOutput: true, holdTurn: true, queuedPromptResponseDelayMs: 150 });
    await send(agent, 'cancel pending batch');
    await vi.waitFor(async () => expect(await frames('/prompts')).toHaveLength(3));
    const posts = await frames('/prompts');
    await app.isles.runtime.stop(agent.id);
    const aborts = await frames(':abort');
    expect(aborts.map((record) => record.path)).toEqual([
      expect.stringContaining(String(posts[2]!.body!.prompt_id)),
      expect.stringContaining(String(posts[1]!.body!.prompt_id)),
    ]);
    const starts = (await cli.records()).filter(
      (record) => record.type === 'event' && record.frame?.type === 'turn.started',
    );
    expect(starts).toHaveLength(2);
    expect(app.isles.store.publicAgent(agent.id).status).toBe('stopped');
    expect(app.isles.store.agentDetail(agent.id).runs).toMatchObject([{ status: 'interrupted' }]);
    expect(
      app.isles.store.listMessages(agent.channelId).map((message) => message.deliveries[0]!.status),
    ).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(await frames('/prompts')).toHaveLength(3);
  });

  it('expires a previous phase form while the continuation remains active and its new question stays answerable', async () => {
    const { app, cli, create, send, frames } = await fixture();
    const agent = await create({ steerEnabled: true });
    await cli.set({
      manualOutput: true,
      holdTurn: true,
      boundaryOnSteer: true,
      nextTurnBeforeEnd: true,
    });
    await send(agent, 'initial');
    await vi.waitFor(() => expect(app.isles.store.agentDetail(agent.id).runs[0]?.turnId).toBe('1'));
    const nativeId = app.isles.store.publicAgent(agent.id).threadId!;
    await cli.question(nativeId);
    await vi.waitFor(() => expect(app.isles.store.agentDetail(agent.id).questions).toHaveLength(1));
    const old = app.isles.store.agentDetail(agent.id).questions[0]!;
    const oldRequestId = JSON.parse(app.isles.store.getQuestion(old.id).nativeRequestId);
    await send(agent, 'continuation');
    await vi.waitFor(() =>
      expect(
        app.isles.store
          .listMessages(agent.channelId)
          .map((message) => message.deliveries[0]!.status),
      ).toEqual(['accepted', 'accepted']),
    );
    expect(app.isles.store.getQuestion(old.id).status).toBe('expired');
    expect(app.isles.store.agentDetail(agent.id).questions).toEqual([]);
    expect(app.isles.store.agentDetail(agent.id).runs[0]!.status).toBe('running');
    const stale = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/questions/${old.id}/answer`,
      payload: { answers: { q0: { answers: ['One'] } } },
    });
    expect(stale.statusCode).toBe(409);
    expect(await frames('/questions/' + oldRequestId)).toHaveLength(0);
    await cli.set({ manualOutput: true, holdTurn: true });
    await cli.question(nativeId);
    await vi.waitFor(() => expect(app.isles.store.agentDetail(agent.id).questions).toHaveLength(1));
    const current = app.isles.store.agentDetail(agent.id).questions[0]!;
    expect(current.runId).toBe(old.runId);
    const result = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/questions/${current.id}/answer`,
      payload: { answers: { q0: { answers: ['Two'] } } },
    });
    expect(result.statusCode).toBe(200);
    await cli.finish(nativeId);
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('ready'));
    expect(app.isles.store.getQuestion(old.id).status).toBe('expired');
    expect(app.isles.store.getQuestion(current.id).status).toBe('answered');
  });

  it('preserves a continuation native failure without closing the service or resending its input', async () => {
    const { app, cli, create, send, frames } = await fixture();
    const agent = await create({ steerEnabled: true });
    await cli.set({ manualOutput: true, boundaryOnSteer: true, nextTurnBeforeEnd: true });
    await send(agent, 'initial');
    await vi.waitFor(() => expect(app.isles.store.agentDetail(agent.id).runs[0]?.turnId).toBe('1'));
    await send(agent, 'failing continuation');
    await vi.waitFor(() =>
      expect(
        app.isles.store
          .listMessages(agent.channelId)
          .map((message) => message.deliveries[0]!.status),
      ).toEqual(['accepted', 'accepted']),
    );
    const nativeId = app.isles.store.publicAgent(agent.id).threadId!;
    await cli.emit(nativeId, 'assistant.delta', { turnId: 2, delta: 'Partial continuation' });
    await cli.finish(nativeId, 'failed', 'Fixture native failure');
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('error'));
    const run = app.isles.store.agentDetail(agent.id).runs[0]!;
    expect(run).toMatchObject({ turnId: '1', status: 'failed', error: 'Fixture native failure' });
    expect(run.items).toContainEqual(
      expect.objectContaining({
        type: 'agentMessage',
        status: 'failed',
        text: 'Partial continuation',
      }),
    );
    expect(
      app.isles.store.listMessages(agent.channelId).map((message) => message.deliveries[0]!.status),
    ).toEqual(['failed', 'failed']);
    expect(await frames('/prompts')).toHaveLength(2);
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  });

  it('publishes context usage for the current session and resets it when creating a new session', async () => {
    const { app, cli, create, frames } = await fixture();
    const agent = await create();
    const firstId = app.isles.store.publicAgent(agent.id).threadId!;
    await cli.emit(firstId, 'agent.status.updated', {
      contextTokens: 12345,
      maxContextTokens: 262144,
    });
    await vi.waitFor(() =>
      expect(app.isles.store.agentDetail(agent.id).contextUsage).toMatchObject({
        sessionId: firstId,
        usedTokens: 12345,
        maxTokens: 262144,
        estimated: true,
      }),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/new-session`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('ready'));
    const newId = app.isles.store.publicAgent(agent.id).threadId!;
    expect(newId).not.toBe(firstId);
    expect(app.isles.store.agentDetail(agent.id).contextUsage).toMatchObject({
      sessionId: newId,
      usedTokens: 0,
    });
    expect(await frames('/sessions')).toHaveLength(2);
    expect(app.isles.store.agentDetail(agent.id).runs).toEqual([]);
  });
});
