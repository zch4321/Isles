import type { Agent } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { OpenCodeAdapter } from '../src/harness/opencode/adapter.js';
import { OpenCodeEnvironment } from '../src/harness/opencode/environment.js';
import { inboxReceipt, opencodeConfig, OpenCodeFixture } from './opencode-fixture.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture(injectAdapter = true) {
  const root = await mkdtemp(join(tmpdir(), 'isles-opencode-app-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const { config, binary } = await opencodeConfig(root);
  const native = new OpenCodeFixture();
  const app = await buildApp({
    config,
    ...(injectAdapter
      ? {
          runtimeUrl: 'http://127.0.0.1:4310',
          adapterFactory: (workspace, config) => [
            new OpenCodeAdapter(new OpenCodeEnvironment(config, workspace), native.factory),
          ],
        }
      : {}),
  });
  cleanups.push(() => app.close());
  const create = async (payload: Record<string, unknown> = {}) => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        harness: 'opencode',
        name: 'OpenCode',
        model: 'fixture/fixture-model',
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
  return { root, config, binary, native, app, create, send };
}

describe('OpenCode application integration', () => {
  it('answers native permissions through Isles REST and expires replies made by another client', async () => {
    const { app, native, create, send } = await fixture();
    const agent = await create();
    const sessionID = app.isles.store.publicAgent(agent.id).threadId!;
    let inboxID = '';
    native.onRequest = ({ path, body }) => {
      if (!path.endsWith('/prompt')) return;
      const receipt = inboxReceipt(sessionID, 'permissions', (body as { id: string }).id);
      inboxID = receipt.data.id;
      return receipt;
    };
    await send(agent, 'edit a reference file');
    await vi.waitFor(() => expect(inboxID).not.toBe(''));
    native.execution(sessionID);
    native.deliver(sessionID, inboxID);
    native.emit(
      native.frame(sessionID, 'permission.asked', {
        id: 'per_rest',
        action: 'edit',
        resources: ['/reference/document.txt'],
      }),
    );
    await vi.waitFor(() => expect(app.isles.store.agentDetail(agent.id).questions).toHaveLength(1));
    const question = app.isles.store.agentDetail(agent.id).questions[0]!;
    const answer = { answers: { permission: { answers: ['允许本次'] } } };
    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/questions/${question.id}/answer`,
      payload: answer,
    });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(native.calls).toContainEqual({
        method: 'POST',
        path: `/api/session/${sessionID}/permission/per_rest/reply`,
        body: { decision: 'once' },
      }),
    );
    expect(app.isles.store.getQuestion(question.id).status).toBe('answered');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/agents/${agent.id}/questions/${question.id}/answer`,
          payload: answer,
        })
      ).statusCode,
    ).toBe(409);
    native.emit(
      native.frame(sessionID, 'permission.asked', {
        id: 'per_other_client',
        action: 'shell',
        resources: ['git push'],
      }),
    );
    const external = app.isles.store
      .agentDetail(agent.id)
      .questions.find((value) => value.status === 'pending')!;
    native.emit(
      native.frame(sessionID, 'permission.replied', {
        requestID: 'per_other_client',
        reply: 'once',
      }),
    );
    expect(app.isles.store.getQuestion(external.id).status).toBe('expired');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/agents/${agent.id}/questions/${external.id}/answer`,
          payload: answer,
        })
      ).statusCode,
    ).toBe(409);
    native.emit(native.frame(sessionID, 'session.execution.succeeded'));
  });

  it('registers OpenCode in the default harness directory with native capabilities', async () => {
    const { app } = await fixture(false);
    const response = await app.inject('/api/harnesses');
    expect(response.statusCode).toBe(200);
    expect(response.json().harnesses).toContainEqual(
      expect.objectContaining({
        id: 'opencode',
        configuration: 'cli-path',
        capabilities: expect.objectContaining({
          sessionResume: true,
          mcp: true,
          workspaceInstructions: true,
          steer: true,
          userQuestions: true,
          nativeSubagents: true,
        }),
      }),
    );
  });

  it('exposes the native catalog and persists CLI path changes through REST', async () => {
    const { app, config, binary, root } = await fixture();
    expect((await app.inject('/api/harnesses/opencode/status')).json()).toMatchObject({
      available: true,
      authenticated: true,
      version: 'opencode v2.0.25',
      binaryPath: binary,
    });
    expect((await app.inject('/api/harnesses/opencode/models')).json().models).toMatchObject([
      { model: 'fixture/fixture-model', supportedReasoningEfforts: ['default', 'high', 'max'] },
    ]);
    const missing = join(root, 'missing-opencode');
    const configured = await app.inject({
      method: 'PUT',
      url: '/api/harnesses/opencode/config',
      payload: { binaryPath: missing },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({ binaryPath: missing });
    expect(parse(await readFile(config.current.configFilePath, 'utf8'))).toMatchObject({
      opencode: { binary_path: missing },
    });
    expect((await app.inject('/api/harnesses/opencode/status')).json()).toMatchObject({
      available: false,
      error: expect.stringContaining(missing),
    });
  });

  it('creates an Agent with steer disabled and waits for durable delivery before marking input received', async () => {
    const { app, native, create, send } = await fixture();
    const agent = await create();
    const stored = app.isles.store.publicAgent(agent.id);
    expect(stored.steerEnabled).toBe(false);
    expect(stored.threadId).toMatch(/^ses_/);
    let inboxID = '';
    native.onRequest = ({ path, body }) => {
      if (path.endsWith('/prompt')) {
        const receipt = inboxReceipt(
          stored.threadId!,
          (body as { text: string }).text,
          (body as { id: string }).id,
        );
        inboxID = receipt.data.id;
        return receipt;
      }
    };
    await send(agent, 'hello');
    await vi.waitFor(() => expect(inboxID).not.toBe(''));
    expect(app.isles.store.listMessages(agent.channelId)[0]!.deliveries[0]!.status).toBe(
      'submitting',
    );
    const turnID = native.execution(stored.threadId!);
    native.deliver(stored.threadId!, inboxID);
    await vi.waitFor(() =>
      expect(app.isles.store.agentDetail(agent.id).runs).toMatchObject([{ turnId: turnID }]),
    );
    await vi.waitFor(() =>
      expect(app.isles.store.listMessages(agent.channelId)[0]!.deliveries[0]!.status).toBe(
        'accepted',
      ),
    );
    native.emit(native.frame(stored.threadId!, 'session.execution.succeeded'));
    await vi.waitFor(() =>
      expect(app.isles.store.agentDetail(agent.id).runs).toMatchObject([{ status: 'completed' }]),
    );
    expect(app.isles.store.listMessages(agent.channelId)[0]!.deliveries[0]!.status).toBe(
      'completed',
    );
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  });
  it('keeps an Agent out of ready when its Isles MCP connection fails', async () => {
    const { app, native } = await fixture();
    native.onRequest = ({ path }) => {
      if (path.split('?')[0] === '/api/mcp')
        return {
          data: [{ name: 'isles', status: { status: 'failed', error: 'Fixture MCP unavailable' } }],
        };
    };
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        harness: 'opencode',
        name: 'Failed MCP',
        model: 'fixture/fixture-model',
        reasoningEffort: 'high',
      },
    });
    expect(created.statusCode).toBe(201);
    const agent = created.json() as Agent;
    await vi.waitFor(() =>
      expect(app.isles.store.publicAgent(agent.id)).toMatchObject({
        status: 'error',
        error: expect.stringContaining('Fixture MCP unavailable'),
      }),
    );
    expect(native.sessions.size).toBe(0);
    expect(native.calls.filter((call) => call.path.endsWith('/prompt'))).toEqual([]);
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  });
});
