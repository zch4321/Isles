import { ConfigManager } from '@isles/config';
import type { Agent } from '@isles/contracts';
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
  await config.configureClaudeBinary(cli.binary);
  const app = await buildApp({ config, runtimeUrl: 'http://127.0.0.1:4310' });
  cleanups.push(() => app.close());
  return { root, cli, config, app };
}
describe('Claude application integration', () => {
  it('registers Codex and Claude, persists independent paths, and invalidates failed discovery immediately', async () => {
    const { app, config, root, cli } = await fixture();
    expect(
      (await app.inject('/api/harnesses')).json().harnesses.map((h: { id: string }) => h.id),
    ).toEqual(['codex', 'claude']);
    expect((await app.inject('/api/harnesses/claude/status')).json()).toMatchObject({
      available: true,
      authenticated: true,
    });
    await app.inject({
      method: 'PUT',
      url: '/api/codex/config',
      payload: { binaryPath: 'codex-independent' },
    });
    const missing = join(root, 'missing-claude');
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/claude/config',
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
    expect((await restored.inject('/api/claude/config')).json().binaryPath).toBe(missing);
    expect(
      (
        await restored.inject({
          method: 'PUT',
          url: '/api/claude/config',
          payload: { binaryPath: '' },
        })
      ).statusCode,
    ).toBe(400);
    await restored.inject({
      method: 'PUT',
      url: '/api/claude/config',
      payload: { binaryPath: null },
    });
    expect((await restored.inject('/api/claude/config')).json().binaryPath).toBeNull();
    expect((await restored.inject('/api/codex/config')).json().binaryPath).toBe(
      'codex-independent',
    );
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
  it('rejects unsupported Claude steer before creating an Agent or native conversation', async () => {
    const { app, cli } = await fixture();
    const result = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        harness: 'claude',
        name: 'Unsupported steer',
        model: 'default',
        reasoningEffort: 'high',
        steerEnabled: true,
      },
    });
    expect(result.statusCode).toBe(400);
    expect(app.isles.store.listAgents()).toEqual([]);
    expect((await cli.records()).filter((record) => record.type === 'user')).toEqual([]);
  });
});
