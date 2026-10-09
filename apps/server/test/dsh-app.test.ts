import type { Agent } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { DshAdapter } from '../src/harness/dsh/adapter.js';
import { DshEnvironment } from '../src/harness/dsh/environment.js';
import { dshConfig, DshFixture } from './dsh-fixture.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture(injectAdapter = true) {
  const root = await mkdtemp(join(tmpdir(), 'isles-dsh-app-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const { config, binary } = await dshConfig(root);
  const native = new DshFixture();
  const app = await buildApp({
    config,
    ...(injectAdapter
      ? {
          runtimeUrl: 'http://127.0.0.1:4310',
          adapterFactory: (workspace, config) => [
            new DshAdapter(new DshEnvironment(config, workspace), native.factory),
          ],
        }
      : {}),
  });
  cleanups.push(() => app.close());
  const create = async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        harness: 'dsh',
        name: 'DSH',
        model: 'fixture/nested/model',
        reasoningEffort: 'high',
      },
    });
    expect(result.statusCode).toBe(201);
    const agent = result.json() as Agent;
    await vi.waitFor(() => expect(app.isles.store.publicAgent(agent.id).status).toBe('ready'));
    return agent;
  };
  return { root, config, binary, native, app, create };
}

describe('DSH application integration', () => {
  it('registers native SDK capabilities in the default harness directory', async () => {
    const { app } = await fixture(false);
    const response = await app.inject('/api/harnesses');
    expect(response.statusCode).toBe(200);
    expect(response.json().harnesses).toContainEqual(
      expect.objectContaining({
        id: 'dsh',
        configuration: 'cli-path',
        capabilities: expect.objectContaining({
          sessionResume: true,
          interrupt: true,
          steer: true,
          userQuestions: true,
          mcp: true,
          workspaceInstructions: true,
        }),
      }),
    );
  });

  it('exposes the native catalog and persists an explicit CLI path through REST', async () => {
    const { app, config, binary, root } = await fixture();
    expect((await app.inject('/api/harnesses/dsh/status')).json()).toMatchObject({
      available: true,
      authenticated: true,
      version: '0.2.0-rc.2',
      binaryPath: binary,
    });
    expect((await app.inject('/api/harnesses/dsh/models')).json().models).toMatchObject([
      { model: 'fixture/nested/model', supportedReasoningEfforts: ['default', 'high', 'max'] },
    ]);
    const missing = join(root, 'missing-dsh');
    const configured = await app.inject({
      method: 'PUT',
      url: '/api/harnesses/dsh/config',
      payload: { binaryPath: missing },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({ binaryPath: missing });
    expect(parse(await readFile(config.current.configFilePath, 'utf8'))).toMatchObject({
      dsh: { binary_path: missing },
    });
    expect((await app.inject('/api/harnesses/dsh/status')).json()).toMatchObject({
      available: false,
      error: expect.stringContaining(missing),
    });
  });

  it('creates Agents with steer disabled and marks a message accepted only after native consumption', async () => {
    const { app, native, create } = await fixture();
    const agent = await create();
    const stored = app.isles.store.publicAgent(agent.id);
    expect(stored.steerEnabled).toBe(false);
    expect(stored.threadId).toBeTruthy();
    expect(native.calls.some((call) => call.method === 'isles/session/submit')).toBe(false);
    let messageId = '';
    native.onRequest = ({ method, params }) => {
      if (method === 'isles/session/submit') messageId = params.messageId as string;
    };
    const sent = await app.inject({
      method: 'POST',
      url: `/api/channels/${agent.channelId}/messages`,
      payload: { body: 'hello', clientId: randomUUID() },
    });
    expect(sent.statusCode).toBe(201);
    await vi.waitFor(() => expect(messageId).not.toBe(''));
    expect(app.isles.store.listMessages(agent.channelId)[0]!.deliveries[0]!.status).toBe(
      'submitting',
    );
    const turnId = native.start(stored.threadId!);
    native.accept(stored.threadId!, messageId, turnId);
    await vi.waitFor(() =>
      expect(app.isles.store.listMessages(agent.channelId)[0]!.deliveries[0]!.status).toBe(
        'accepted',
      ),
    );
    expect(app.isles.store.agentDetail(agent.id).runs).toMatchObject([{ turnId }]);
    native.complete(stored.threadId!, turnId);
    await vi.waitFor(() =>
      expect(app.isles.store.agentDetail(agent.id).runs).toMatchObject([{ status: 'completed' }]),
    );
    expect(app.isles.store.listMessages(agent.channelId)[0]!.deliveries[0]!.status).toBe(
      'completed',
    );
  });
});
