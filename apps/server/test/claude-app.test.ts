import { ConfigManager } from '@isles/config';
import type { Agent } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { claudeFixture } from './claude-fixture.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-claude-app-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cli = await claudeFixture(root);
  const config = new ConfigManager({
    configFilePath: join(root, 'config.toml'),
    homeDir: root,
    environment: { ISLES_CLAUDE_HOME: cli.home },
  });
  await config.configureCliBinary('claude', cli.binary);
  const app = await buildApp({ config, runtimeUrl: 'http://127.0.0.1:4310' });
  cleanups.push(() => app.close());
  return { root, cli, config, app };
}
describe('Claude application integration', () => {
  it('registers Codex and Claude, persists independent paths, and invalidates failed discovery immediately', async () => {
    const { app, config, root, cli } = await fixture();
    expect(
      (await app.inject('/api/harnesses')).json().harnesses.map((h: { id: string }) => h.id),
    ).toEqual(['codex', 'claude', 'kimi', 'opencode', 'dsh']);
    expect((await app.inject('/api/harnesses/claude/status')).json()).toMatchObject({
      available: true,
      authenticated: true,
    });
    await app.inject({
      method: 'PUT',
      url: '/api/harnesses/codex/config',
      payload: { binaryPath: 'codex-independent' },
    });
    const missing = join(root, 'missing-claude');
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/harnesses/claude/config',
      payload: { binaryPath: missing },
    });
    expect(saved.json()).toMatchObject({
      binaryPath: missing,
      configFilePath: config.current.configFilePath,
    });
    expect((await app.inject('/api/harnesses/claude/status')).json()).toMatchObject({
      available: false,
      error: expect.stringContaining(missing),
    });
    expect(parse(await readFile(config.current.configFilePath, 'utf8'))).toMatchObject({
      codex: { binary_path: 'codex-independent' },
      claude: { binary_path: missing },
    });
    await app.close();
    const restored = await buildApp({
      config: new ConfigManager({
        configFilePath: config.current.configFilePath,
        homeDir: root,
        environment: { ISLES_CLAUDE_HOME: cli.home },
      }),
    });
    cleanups.push(() => restored.close());
    expect((await restored.inject('/api/harnesses/claude/config')).json().binaryPath).toBe(missing);
    expect(
      (
        await restored.inject({
          method: 'PUT',
          url: '/api/harnesses/claude/config',
          payload: { binaryPath: '' },
        })
      ).statusCode,
    ).toBe(400);
    await restored.inject({
      method: 'PUT',
      url: '/api/harnesses/claude/config',
      payload: { binaryPath: null },
    });
    expect((await restored.inject('/api/harnesses/claude/config')).json().binaryPath).toBeNull();
    expect((await restored.inject('/api/harnesses/codex/config')).json().binaryPath).toBe(
      'codex-independent',
    );
    expect((await restored.inject('/api/harnesses/missing/config')).statusCode).toBe(404);
  });
  it('creates a ready Claude Agent without publishing bootstrap input or an Isles run and resumes the same binding', async () => {
    const { app } = await fixture();
    const result = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { harness: 'claude', name: 'Claude API', model: 'default', reasoningEffort: 'high' },
    });
    expect(result.statusCode).toBe(201);
    const agent = result.json() as Agent;
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('ready'));
    const binding = app.isles.store.publicAgent(agent.id).threadId;
    expect(binding).toBeTruthy();
    expect(app.isles.store.agentDetail(agent.id).runs).toEqual([]);
    expect(app.isles.store.channelDetail(agent.channelId).messages).toEqual([]);
    await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/stop`, payload: {} });
    await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/resume`, payload: {} });
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('ready'));
    expect(app.isles.store.publicAgent(agent.id).threadId).toBe(binding);
  });
  it('records native consumption of busy input and preserves the native session', async () => {
    const { app, cli } = await fixture();
    const result = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        harness: 'claude',
        name: 'Claude steer',
        model: 'default',
        reasoningEffort: 'high',
        steerEnabled: true,
      },
    });
    expect(result.statusCode).toBe(201);
    const agent = result.json() as Agent;
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('ready'));
    const binding = app.isles.store.publicAgent(agent.id).threadId;
    await cli.set({ holdTurn: true });
    await app.inject({
      method: 'POST',
      url: `/api/channels/${agent.channelId}/messages`,
      payload: { body: 'initial', clientId: randomUUID() },
    });
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('running'));
    const runId = app.isles.store.agentDetail(agent.id).runs[0]!.id;
    await app.inject({
      method: 'POST',
      url: `/api/channels/${agent.channelId}/messages`,
      payload: { body: 'appended', clientId: randomUUID() },
    });
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('ready'));
    expect(app.isles.store.agentDetail(agent.id).runs).toMatchObject([
      {
        id: runId,
        threadId: binding,
        turnId: runId,
        status: 'completed',
        inputs: [{ messageSeqs: [1, 2] }],
      },
    ]);
    expect(app.isles.store.agentDetail(agent.id).runs).toHaveLength(1);
    expect(
      app.isles.store.listMessages(agent.channelId).map((message) => message.deliveries[0]!.status),
    ).toEqual(['accepted', 'accepted']);
    const frames = await cli.records();
    const batchId = frames.filter((frame) => frame.type === 'user').at(-1)!.uuid as string;
    expect(app.isles.store.getSteer(batchId)).toMatchObject({
      runId,
      turnId: runId,
      status: 'accepted',
    });
    const launches = frames.filter((frame) => frame.type === 'launch').length;
    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      payload: { steerEnabled: false },
    });
    expect(edited.json()).toMatchObject({ steerEnabled: false, threadId: binding });
    expect((await cli.records()).filter((frame) => frame.type === 'launch')).toHaveLength(launches);
  });
  it('links queued steer to the native turn that consumes it after the first result', async () => {
    const { app, cli } = await fixture();
    const agent = (
      await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: {
          harness: 'claude',
          name: 'Native queue',
          model: 'default',
          reasoningEffort: 'high',
          steerEnabled: true,
        },
      })
    ).json() as Agent;
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('ready'));
    await cli.set({ holdTurn: true });
    await app.inject({
      method: 'POST',
      url: `/api/channels/${agent.channelId}/messages`,
      payload: { body: 'initial', clientId: randomUUID() },
    });
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('running'));
    const first = app.isles.store.agentDetail(agent.id).runs[0]!;
    await cli.set({ finishBeforeSteer: true });
    await app.inject({
      method: 'POST',
      url: `/api/channels/${agent.channelId}/messages`,
      payload: { body: 'next native turn', clientId: randomUUID() },
    });
    await vi.waitFor(() =>
      expect(
        app.isles.store.agentDetail(agent.id).runs.filter((run) => run.status === 'completed'),
      ).toHaveLength(2),
    );
    const frames = await cli.records();
    const batchId = frames.filter((frame) => frame.type === 'user').at(-1)!.uuid as string;
    const runs = app.isles.store.agentDetail(agent.id).runs;
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.id === first.id)).toMatchObject({
      inputs: [{ messageSeqs: [1] }],
    });
    expect(runs.find((run) => run.turnId === batchId)).toMatchObject({
      inputs: [{ messageSeqs: [2] }],
      threadId: first.threadId,
    });
    const messages = app.isles.store.listMessages(agent.channelId);
    expect(messages.map((message) => message.deliveries[0]!.status)).toEqual([
      'accepted',
      'accepted',
    ]);
    expect(app.isles.store.getSteer(batchId)).toMatchObject({
      status: 'accepted',
    });
  });

  it('keeps Claude busy input queued when steer is off', async () => {
    const { app, cli } = await fixture();
    const agent = (
      await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { harness: 'claude', name: 'Queue', model: 'default', reasoningEffort: 'high' },
      })
    ).json() as Agent;
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('ready'));
    await cli.set({ holdTurn: true });
    await app.inject({
      method: 'POST',
      url: `/api/channels/${agent.channelId}/messages`,
      payload: { body: 'initial', clientId: randomUUID() },
    });
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('running'));
    await app.inject({
      method: 'POST',
      url: `/api/channels/${agent.channelId}/messages`,
      payload: { body: 'queued', clientId: randomUUID() },
    });
    expect(app.isles.store.listMessages(agent.channelId).at(-1)!.deliveries[0]!.status).toBe(
      'queued',
    );
    expect((await cli.records()).filter((frame) => frame.type === 'user')).toHaveLength(2);
    await cli.set({ releaseHeld: true });
    await vi.waitFor(() =>
      expect(
        app.isles.store.agentDetail(agent.id).runs.filter((run) => run.status === 'completed'),
      ).toHaveLength(2),
    );
    expect(
      new Set(app.isles.store.agentDetail(agent.id).runs.map((run) => run.threadId)).size,
    ).toBe(1);
  });
});
