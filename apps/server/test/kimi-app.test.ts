import { ConfigManager } from '@isles/config';
import type { Agent } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { kimiFixture } from './acp-fixture.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-kimi-app-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cli = await kimiFixture(root);
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
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('ready'));
    return agent;
  };
  const send = (agent: Agent, body: string) =>
    app.inject({
      method: 'POST',
      url: `/api/channels/${agent.channelId}/messages`,
      payload: { body, clientId: randomUUID() },
    });
  const frames = async (method: string) =>
    (await cli.records()).filter((frame) => frame.method === method);
  return { root, cli, config, app, create, send, frames };
}

describe('Kimi Code application integration', () => {
  it('registers Kimi without steer and keeps its path and catalog independent', async () => {
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
      capabilities: { steer: false, sessionResume: true, mcp: true, userQuestions: true },
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
    const refused = await app.inject({
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
    expect(refused.statusCode).toBe(400);
  });

  it('creates a Kimi Agent, completes a private run and resumes the same session after stop', async () => {
    const { app, create, send, frames } = await fixture();
    const agent = await create();
    const binding = app.isles.store.publicAgent(agent.id).threadId;
    expect(binding).toMatch(/^session_/);
    expect(app.isles.store.agentDetail(agent.id).runs).toEqual([]);
    expect(await frames('session/prompt')).toEqual([]);
    await send(agent, 'hello');
    await vi.waitFor(() =>
      expect(app.isles.store.agentDetail(agent.id).runs).toMatchObject([{ status: 'completed' }]),
    );
    const [run] = app.isles.store.agentDetail(agent.id).runs;
    expect(run).toMatchObject({ threadId: binding, turnId: run!.id });
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
    expect(await frames('session/resume')).toMatchObject([{ params: { sessionId: binding } }]);
    expect(await frames('session/new')).toHaveLength(2);
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
    expect(await frames('session/prompt')).toHaveLength(1);
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

  it('keeps the service alive and the delivery uncertain on an invalid native result', async () => {
    const { app, cli, create, send } = await fixture();
    const agent = await create();
    await cli.set({ invalidPromptResult: true });
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
});
