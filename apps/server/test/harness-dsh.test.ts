import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DshAdapter } from '../src/harness/dsh/adapter.js';
import { DshClient, DshRpcError } from '../src/harness/dsh/client.js';
import { DshEnvironment } from '../src/harness/dsh/environment.js';
import {
  HarnessSubmissionRejected,
  type HarnessEvent,
  type HarnessHandlers,
  type HarnessQuestion,
  type HarnessSession,
} from '../src/harness/types.js';
import { AgentWorkspace } from '../src/runtime/workspace.js';
import { silentLogger } from '../src/logging.js';
import type { AgentRecord } from '../src/storage/store.js';
import { dshConfig, DshFixture, dshTransport } from './dsh-fixture.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-dsh-adapter-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const { config, binary, home } = await dshConfig(root);
  const native = new DshFixture();
  const environment = new DshEnvironment(config, new AgentWorkspace(config));
  const adapter = new DshAdapter(environment, native.factory);
  const agent: AgentRecord = {
    id: randomUUID(),
    channelId: randomUUID(),
    name: 'DSH fixture',
    harness: 'dsh',
    model: 'fixture/nested/model',
    reasoningEffort: 'high',
    workspace: join(root, 'workspace'),
    workspacePaths: [],
    nativeHome: home,
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
    connected: vi.fn((session: HarnessSession) => cleanups.push(() => session.close())),
    event: (event) => events.push(event),
    question: (question) => questions.push(question),
    exit: vi.fn(),
  };
  const connect = () => adapter.connect(agent, 'http://127.0.0.1:4310', handlers);
  const input = (sessionId: string, text = 'hello') => ({
    sessionId,
    runId: randomUUID(),
    text,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    workspace: agent.workspace,
  });
  const startInput = (sessionId: string) => {
    native.onRequest = ({ method, params }) => {
      if (method !== 'isles/session/submit') return;
      const turnId = native.start(sessionId);
      native.accept(sessionId, params.messageId as string, turnId);
    };
  };
  return {
    root,
    config,
    binary,
    home,
    native,
    environment,
    adapter,
    agent,
    events,
    questions,
    handlers,
    connect,
    input,
    startInput,
  };
}

describe('DSH SDK stdio transport', () => {
  it('keeps Unicode notifications separate from RPC results, scrubs stderr and shuts down once', async () => {
    const f = await fixture();
    const { command, audit } = await dshTransport(f.root);
    const secret = 'fixture-native-transport-secret';
    f.environment.redactor.add({ token: secret });
    const debug = vi.fn();
    const handlers = { notification: vi.fn(), exit: vi.fn() };
    const client = new DshClient(
      { ...command, env: { DSH_HOME: f.home } },
      f.root,
      {
        args: ['fixture-runtime-arg'],
        env: { DSH_FIXTURE_AUDIT: audit, DSH_FIXTURE_TOKEN: secret },
      },
      handlers,
      f.environment.redactor,
      { ...silentLogger, debug },
    );
    cleanups.push(() => client.close());
    await expect(client.request('echo', { text: '中文' })).resolves.toEqual({
      params: { text: '中文' },
      cwd: await realpath(f.root),
      home: f.home,
      args: ['fixture-runtime-arg'],
    });
    expect(handlers.notification).toHaveBeenCalledWith('fixture/notice', { text: '中文' });
    await vi.waitFor(() =>
      expect(
        debug.mock.calls.some((call) => JSON.stringify(call).includes('Diagnostic [redacted]')),
      ).toBe(true),
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain(secret);
    await expect(client.request('refuse', {})).rejects.toMatchObject({
      code: -32603,
      message: 'Failure [redacted]',
    });
    await Promise.all([client.close(), client.close()]);
    const calls = (await readFile(audit, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string });
    expect(calls.filter((call) => call.method === 'shutdown')).toHaveLength(1);
    expect(handlers.exit).not.toHaveBeenCalled();
  });

  it('rejects a pending RPC and reports one exit for a malformed native stream', async () => {
    const f = await fixture();
    const { command, audit } = await dshTransport(f.root);
    const handlers = { notification: vi.fn(), exit: vi.fn() };
    const client = new DshClient(
      command,
      f.root,
      { args: [], env: { DSH_FIXTURE_AUDIT: audit } },
      handlers,
      f.environment.redactor,
      silentLogger,
    );
    cleanups.push(() => client.close());
    await expect(client.request('malformed', {})).rejects.toThrow('协议消息无效');
    await client.close();
    expect(handlers.exit).toHaveBeenCalledTimes(1);
    expect(handlers.notification).not.toHaveBeenCalled();
  });
});

describe('DSH native SDK adapter', () => {
  it('requires MCP readiness before creating a native session while catalog reads remain available', async () => {
    const f = await fixture();
    f.native.onRequest = ({ method, params }) => {
      if (method === 'isles/catalog' && params.requireMcp === true)
        return { rejected: true, reason: 'Isles MCP 尚未就绪' };
    };
    await expect(f.connect()).rejects.toThrow('Isles MCP 尚未就绪');
    expect(f.native.closed).toBe(true);
    expect(f.native.calls.some(({ method }) => method.startsWith('isles/session/'))).toBe(false);
    expect(await f.adapter.catalog.status()).toMatchObject({ available: true });
  });
  it('reads native model identity, efforts and defaults without creating a session or a model turn', async () => {
    const f = await fixture();
    expect(await f.adapter.catalog.status()).toMatchObject({
      available: true,
      authenticated: true,
      version: '0.2.0-rc.2',
      binaryPath: f.binary,
    });
    expect(await f.adapter.catalog.models()).toMatchObject([
      {
        model: 'fixture/nested/model',
        supportedReasoningEfforts: ['default', 'high', 'max'],
        defaultReasoningEffort: 'high',
        isDefault: true,
      },
    ]);
    expect(f.native.calls.every((call) => call.method === 'isles/catalog')).toBe(true);
    expect(f.native.closed).toBe(true);
  });

  it('reports an enabled SDK with no usable native models as unauthenticated', async () => {
    const f = await fixture();
    f.native.onRequest = ({ method }) => (method === 'isles/catalog' ? { models: [] } : undefined);
    expect(await f.adapter.catalog.status()).toMatchObject({
      available: true,
      authenticated: false,
    });
    expect(await f.adapter.catalog.models()).toEqual([]);
  });

  it('uses the Desktop saved picker default independently of the SDK default', async () => {
    const f = await fixture();
    const desktop = join(f.home, 'profiles/desktop');
    await mkdir(desktop, { recursive: true });
    await writeFile(
      join(desktop, 'cordis.patch.yml'),
      '- id: agent-default-model\n  config:\n    provider: fixture\n    model: nested/model\n    reasoningEffort: max\n',
    );
    expect(await f.adapter.catalog.models()).toMatchObject([
      { isDefault: true, defaultReasoningEffort: 'max' },
    ]);
  });

  it('creates and persists a fixed native ID, then resumes it without a replacement or model call', async () => {
    const f = await fixture();
    const session = await f.connect();
    const saved: string[] = [];
    const id = await session.createSession((value) => saved.push(value));
    expect(saved).toEqual([id]);
    expect(f.native.calls.find((call) => call.method === 'isles/session/create')).toMatchObject({
      params: {
        sessionId: id,
        cwd: f.agent.workspace,
        dangerFullAccess: false,
        selection: { provider: 'fixture', model: 'nested/model', reasoningEffort: 'high' },
      },
    });
    await session.close();
    const resumed = await f.connect();
    await expect(resumed.resumeSession(id)).resolves.toBe(id);
    expect(f.native.calls.filter((call) => call.method === 'isles/session/create')).toHaveLength(1);
    expect(f.native.calls.filter((call) => call.method === 'isles/session/submit')).toEqual([]);
    expect(f.events).toEqual([]);
  });

  it('overlays native defaults and explicitly passes each Agent full-access choice when opening a session', async () => {
    const f = await fixture();
    f.agent.dangerFullAccess = true;
    const session = await f.connect();
    await session.createSession(() => {});
    expect(
      f.native.calls.find((call) => call.method === 'isles/session/create')?.params
        .dangerFullAccess,
    ).toBe(true);
    const patch = JSON.parse(await readFile(f.native.runtimes.at(-1)!.runtime.args[3]!, 'utf8'));
    expect(patch).toContainEqual({
      id: 'sandbox-policy',
      config: { mode: 'danger-full-access', workspaceRoot: f.agent.workspace },
    });
    expect(patch).toContainEqual({ id: 'approval', config: { policy: 'never' } });
    expect(patch).toContainEqual({
      id: 'permission',
      config: expect.objectContaining({ defaultPreset: 'danger-full-access' }),
    });
    expect(patch).toContainEqual({ id: 'fs-sandbox', disabled: true });
    expect(patch).toContainEqual({ id: 'sandbox', disabled: true });
    expect(patch).toContainEqual({
      insert: expect.arrayContaining([
        expect.objectContaining({
          id: 'isles-fs-shared',
          config: { cwd: f.agent.workspace, additionalDirs: [f.environment.workspace.sharedDir] },
        }),
        expect.objectContaining({
          id: 'isles-sandbox-shared',
          config: { additionalDirs: [f.environment.workspace.sharedDir] },
        }),
      ]),
    });
  });

  it('passes every additional workspace to file, command and prompt plugins while retaining the primary cwd', async () => {
    const f = await fixture();
    const external = join(f.root, 'external worktree');
    const second = join(f.root, 'second worktree');
    await Promise.all(
      [external, second, f.environment.workspace.sharedDir].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    f.agent.workspacePaths = [external, second, external, f.environment.workspace.sharedDir];
    const session = await f.connect();
    await session.createSession(() => {});
    const runtime = f.native.runtimes.at(-1)!;
    expect(runtime.cwd).toBe(f.agent.workspace);
    const patch = JSON.parse(await readFile(runtime.runtime.args[3]!, 'utf8'));
    const inserted = patch.find((row: { insert?: unknown }) => row.insert)?.insert;
    for (const id of ['isles-fs-shared', 'isles-sandbox-shared', 'isles-dsh-bridge'])
      expect(inserted).toContainEqual(
        expect.objectContaining({
          id,
          config: expect.objectContaining({
            additionalDirs: [f.environment.workspace.sharedDir, external, second],
          }),
        }),
      );
    expect(f.native.calls.find((call) => call.method === 'isles/session/create')?.params.cwd).toBe(
      f.agent.workspace,
    );
  });

  it('presents a one-shot permission form, validates fixed decisions and ignores expired answers', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.startInput(id);
    const { turnId } = await session.submit(f.input(id));
    const notify = (requestId: string, sessionId = id) =>
      f.native.notify('isles/permission', {
        sessionId,
        turnId,
        requestId,
        text: 'Write outside workspace',
      });
    notify('foreign', 'other-session');
    notify('permit');
    expect(f.questions).toHaveLength(1);
    expect(f.questions[0]!.questions[0]).toMatchObject({
      id: 'permission',
      isOther: false,
      options: [{ label: '允许本次' }, { label: '拒绝' }],
    });
    expect(() =>
      session.answer('permit', { answers: { permission: { answers: ['custom'] } } }),
    ).toThrow('请选择');
    session.answer('permit', { answers: { permission: { answers: ['允许本次'] } } });
    session.answer('permit', { answers: { permission: { answers: ['允许本次'] } } });
    await vi.waitFor(() =>
      expect(
        f.native.calls.filter((call) => call.method === 'isles/permission/answer'),
      ).toHaveLength(1),
    );
    expect(
      f.native.calls.find((call) => call.method === 'isles/permission/answer')?.params,
    ).toEqual({ sessionId: id, expectedTurnId: turnId, requestId: 'permit', allow: true });
    expect(f.events.some((event) => event.type === 'question_expired')).toBe(false);
    notify('expired');
    f.native.event(id, { type: 'question_expired', turnId, requestId: 'expired' });
    session.answer('expired', { answers: { permission: { answers: ['允许本次'] } } });
    expect(f.native.calls.filter((call) => call.method === 'isles/permission/answer')).toHaveLength(
      1,
    );
    expect(f.events).toContainEqual({
      type: 'question_expired',
      sessionId: id,
      turnId,
      requestId: 'expired',
    });
    notify('close');
    await session.close();
    expect(f.events).toContainEqual({
      type: 'question_expired',
      sessionId: id,
      turnId,
      requestId: 'close',
    });
  });

  it('refuses a missing persisted session without creating another one', async () => {
    const f = await fixture();
    const session = await f.connect();
    await expect(session.resumeSession('missing-native-session')).rejects.toThrow(
      'Native session missing',
    );
    expect(f.native.calls.some((call) => call.method === 'isles/session/create')).toBe(false);
  });

  it('shares native login and settings while keeping Isles overlay and MCP token in its own agent directory', async () => {
    const f = await fixture();
    const credentials = 'oauth:\n  access: native-fixture-access-secret\n';
    const settings = '- id: user-setting\n  config:\n    keep: true\n';
    await writeFile(join(f.home, '.credentials.yaml'), credentials);
    await writeFile(join(f.home, 'cordis.patch.yml'), settings);
    await f.connect();
    const runtime = f.native.runtimes.at(-1)!;
    expect(runtime).toMatchObject({
      cwd: f.agent.workspace,
      runtime: { env: { DSH_HOME: f.home } },
    });
    expect(runtime.runtime.args.slice(0, 3)).toEqual(['--profile', 'sdk', '--patch']);
    const overlayPath = runtime.runtime.args[3]!;
    expect(overlayPath.startsWith(f.home)).toBe(false);
    expect(JSON.parse(await readFile(overlayPath, 'utf8'))).toContainEqual({
      insert: expect.arrayContaining([
        expect.objectContaining({
          id: 'isles-mcp',
          config: expect.objectContaining({ url: `http://127.0.0.1:4310/mcp/${f.agent.id}` }),
        }),
      ]),
    });
    expect(await readFile(join(f.home, '.credentials.yaml'), 'utf8')).toBe(credentials);
    expect(await readFile(join(f.home, 'cordis.patch.yml'), 'utf8')).toBe(settings);
    expect(f.environment.redactor.text('native-fixture-access-secret')).not.toContain(
      'native-fixture-access-secret',
    );
  });

  it.each([true, false])(
    'waits for input consumption when the notification comes before the RPC response (%s)',
    async (eventFirst) => {
      const f = await fixture();
      const session = await f.connect();
      const id = await session.createSession(() => {});
      let messageId = '';
      let turnId = '';
      f.native.onRequest = ({ method, params }) => {
        if (method !== 'isles/session/submit') return;
        messageId = params.messageId as string;
        if (eventFirst) {
          turnId = f.native.start(id);
          f.native.accept(id, messageId, turnId);
        }
      };
      const pending = session.submit(f.input(id));
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.waitFor(() => expect(messageId).not.toBe(''));
      if (!eventFirst) {
        expect(settled).toBe(false);
        turnId = f.native.start(id);
        f.native.accept(id, 'unrelated-message', turnId);
        await Promise.resolve();
        expect(settled).toBe(false);
        f.native.accept(id, messageId, turnId);
      }
      await expect(pending).resolves.toEqual({ turnId });
      expect(f.events).toEqual([{ type: 'turn_started', sessionId: id, turnId }]);
      f.native.complete(id, turnId);
      expect(f.events).toContainEqual({
        type: 'turn_completed',
        sessionId: id,
        turnId,
        status: 'completed',
        error: null,
      });
    },
  );

  it('restores context usage and accepts idle main-session updates independently of a turn', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.native.onRequest = ({ method }) =>
      method === 'isles/session/resume'
        ? {
            sessionId: id,
            cwd: f.agent.workspace,
            contextUsage: { usedTokens: 800, maxTokens: 4000, estimated: false },
          }
        : undefined;
    await session.resumeSession(id);
    const update = {
      type: 'context_usage',
      usage: { usedTokens: 120, maxTokens: 4000, estimated: true },
    };
    f.native.event('other-session', update);
    f.native.notify('isles/event', { sessionId: id, event: update, eventId: 'compacted' });
    f.native.notify('isles/event', { sessionId: id, event: update, eventId: 'compacted' });
    expect(f.events).toEqual([
      {
        type: 'context_usage',
        sessionId: id,
        usage: { usedTokens: 800, maxTokens: 4000, estimated: false },
      },
      { type: 'context_usage', sessionId: id, usage: update.usage },
    ]);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('changes selection only for a new submit and preserves provider and nested model identity', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.startInput(id);
    const { turnId } = await session.submit({ ...f.input(id), reasoningEffort: 'max' });
    f.native.onRequest = ({ method, params }) => {
      if (method === 'isles/session/steer') f.native.accept(id, params.messageId as string, turnId);
    };
    await session.steer!({
      sessionId: id,
      expectedTurnId: turnId,
      batchId: randomUUID(),
      text: 'more',
    });
    expect(
      f.native.calls.find((call) => call.method === 'isles/session/submit')!.params.selection,
    ).toEqual({ provider: 'fixture', model: 'nested/model', reasoningEffort: 'max' });
    expect(
      f.native.calls.find((call) => call.method === 'isles/session/steer')!.params.selection,
    ).toBeUndefined();
  });

  it('keeps steer pending for exact-turn consumption, refuses a stale turn and deduplicates batch IDs', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.startInput(id);
    const { turnId } = await session.submit(f.input(id));
    let messageId = '';
    f.native.onRequest = ({ method, params }) => {
      if (method === 'isles/session/steer') messageId = params.messageId as string;
    };
    const steering = {
      sessionId: id,
      expectedTurnId: turnId,
      batchId: randomUUID(),
      text: 'update',
    };
    const pending = session.steer!(steering);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(messageId).not.toBe(''));
    f.native.accept('native-other-session', messageId, turnId);
    await Promise.resolve();
    expect(settled).toBe(false);
    f.native.accept(id, messageId, turnId);
    await expect(pending).resolves.toEqual({ turnId });
    await expect(session.steer!(steering)).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    await expect(
      session.steer!({ ...steering, batchId: randomUUID(), expectedTurnId: 'stale-turn' }),
    ).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    expect(f.native.calls.filter((call) => call.method === 'isles/session/steer')).toHaveLength(1);
  });

  it('retains proven consumption if the RPC refusal arrives later', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    let turnId = '';
    f.native.onRequest = ({ method, params }) => {
      if (method !== 'isles/session/submit') return;
      turnId = f.native.start(id);
      f.native.accept(id, params.messageId as string, turnId);
      throw new DshRpcError('Late native refusal', -32602);
    };
    await expect(session.submit(f.input(id))).resolves.toEqual({ turnId: expect.any(String) });
    expect(f.handlers.exit).not.toHaveBeenCalled();
    expect(f.native.closed).toBe(false);
  });

  it('passes the exact turn to native steer and surfaces native CAS refusal as a definite rejection', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.startInput(id);
    const { turnId } = await session.submit(f.input(id));
    f.native.onRequest = ({ method }) => {
      if (method === 'isles/session/steer')
        return { rejected: true, reason: 'Expected native turn already ended' };
    };
    await expect(
      session.steer!({
        sessionId: id,
        expectedTurnId: turnId,
        batchId: randomUUID(),
        text: 'racing input',
      }),
    ).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    expect(f.native.calls.find((call) => call.method === 'isles/session/steer')).toMatchObject({
      params: { sessionId: id, expectedTurnId: turnId },
    });
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('does not confirm steer when its consumption receipt belongs to a different turn', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.startInput(id);
    const { turnId } = await session.submit(f.input(id));
    f.native.onRequest = ({ method, params }) => {
      if (method === 'isles/session/steer')
        f.native.accept(id, params.messageId as string, 'different-native-turn');
    };
    await expect(
      session.steer!({
        sessionId: id,
        expectedTurnId: turnId,
        batchId: randomUUID(),
        text: 'late input',
      }),
    ).rejects.not.toBeInstanceOf(HarnessSubmissionRejected);
    await vi.waitFor(() => expect(f.native.closed).toBe(true));
    expect(f.handlers.exit).toHaveBeenCalledTimes(1);
  });

  it('treats disconnect before consumption as unknown and closes the owned SDK connection once', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const pending = session.submit(f.input(id));
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(f.native.calls.some((call) => call.method === 'isles/session/submit')).toBe(true),
    );
    f.native.loseConnection();
    f.native.loseConnection();
    await expect(pending).rejects.not.toBeInstanceOf(HarnessSubmissionRejected);
    await vi.waitFor(() => expect(f.native.closed).toBe(true));
    expect(f.handlers.exit).toHaveBeenCalledTimes(1);
  });

  it('refuses explicitly rejected native input without accepting its admission receipt', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.native.onRequest = ({ method, params }) => {
      if (method === 'isles/session/submit')
        f.native.event(id, {
          type: 'input_rejected',
          messageId: params.messageId,
          reason: 'Native input refused',
        });
    };
    await expect(session.submit(f.input(id))).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    expect(f.events).toEqual([]);
  });

  it('distinguishes a definite native admission refusal from an uncertain RPC failure', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.native.onRequest = ({ method }) => {
      if (method === 'isles/session/submit')
        return { rejected: true, reason: 'Native input refused before queueing' };
    };
    await expect(session.submit(f.input(id))).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    expect(f.handlers.exit).not.toHaveBeenCalled();
    f.native.onRequest = ({ method }) => {
      if (method === 'isles/session/submit')
        throw new DshRpcError('Native RPC failed after possible queueing', -32603);
    };
    await expect(session.submit(f.input(id))).rejects.not.toBeInstanceOf(HarnessSubmissionRejected);
    await vi.waitFor(() => expect(f.native.closed).toBe(true));
    expect(f.handlers.exit).toHaveBeenCalledTimes(1);
  });

  it('deduplicates native event IDs and keeps items attached to their original turn', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.startInput(id);
    const { turnId } = await session.submit(f.input(id));
    const frame = {
      sessionId: id,
      eventId: 'native-committed-item-1',
      event: {
        type: 'item',
        turnId,
        append: false,
        item: {
          id: 'assistant-message',
          type: 'agentMessage',
          status: 'completed',
          text: 'One response',
        },
      },
    };
    f.native.notify('isles/event', frame);
    f.native.notify('isles/event', frame);
    expect(f.events.filter((event) => event.type === 'item')).toEqual([
      { type: 'item', sessionId: id, turnId, append: false, item: frame.event.item },
    ]);
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('keeps streamed fragments distinct from final items without native context refresh', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.startInput(id);
    const { turnId } = await session.submit(f.input(id));
    const callsBeforeStream = f.native.calls.length;
    f.events.length = 0;
    const item = { id: 'assistant:1:1', type: 'agentMessage', status: 'running', text: '中文' };
    f.native.event(id, { type: 'item_delta', turnId, append: true, item });
    f.native.event(id, {
      type: 'item_delta',
      turnId,
      append: true,
      item: { ...item, text: '输出' },
    });
    f.native.event(id, {
      type: 'item',
      turnId,
      append: false,
      item: { ...item, text: '中文输出', status: 'completed' },
    });
    expect(f.events).toEqual([
      { type: 'item_delta', sessionId: id, turnId, append: true, item },
      { type: 'item_delta', sessionId: id, turnId, append: true, item: { ...item, text: '输出' } },
      {
        type: 'item',
        sessionId: id,
        turnId,
        append: false,
        item: { ...item, text: '中文输出', status: 'completed' },
      },
    ]);
    expect(f.native.calls).toHaveLength(callsBeforeStream);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('interrupts the exact turn and refuses further steering', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.startInput(id);
    const { turnId } = await session.submit(f.input(id));
    f.native.onRequest = ({ method }) => {
      if (method === 'isles/session/interrupt') f.native.complete(id, turnId, 'interrupted');
    };
    await session.interrupt(id, turnId);
    expect(f.native.calls.find((call) => call.method === 'isles/session/interrupt')).toMatchObject({
      params: { sessionId: id, expectedTurnId: turnId },
    });
    await expect(
      session.steer!({
        sessionId: id,
        expectedTurnId: turnId,
        batchId: randomUUID(),
        text: 'late',
      }),
    ).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    expect(f.events).toContainEqual({
      type: 'turn_completed',
      sessionId: id,
      turnId,
      status: 'interrupted',
      error: null,
    });
  });

  it('observes autonomous root turns and background child lifecycles independently of owned inputs', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const child = 'native-child';
    const epoch = 'native-epoch';
    const rootTurn = f.native.start(id, 'native-root-1');
    f.native.event(child, { type: 'turn_started', turnId: epoch }, id);
    f.native.complete(id, rootTurn);
    f.native.event(
      child,
      {
        type: 'item',
        turnId: epoch,
        append: false,
        item: { id: 'child-result', type: 'subagent', status: 'completed', text: 'child answer' },
      },
      id,
    );
    f.native.event(
      child,
      { type: 'turn_completed', turnId: epoch, status: 'completed', error: null },
      id,
    );
    f.native.start(id, 'native-root-2');
    f.native.event(id, {
      type: 'item',
      turnId: 'native-root-2',
      append: false,
      item: {
        id: 'root-answer',
        type: 'agentMessage',
        status: 'completed',
        text: 'follow-up answer',
      },
    });
    f.native.complete(id, 'native-root-2');
    f.native.start(id, 'native-root-1');
    expect(f.events).toMatchObject([
      { type: 'turn_started', sessionId: id, turnId: rootTurn },
      { type: 'turn_started', sessionId: child, turnId: epoch },
      { type: 'turn_completed', sessionId: id, turnId: rootTurn },
      { type: 'item', sessionId: child, turnId: epoch, item: { text: 'child answer' } },
      { type: 'turn_completed', sessionId: child, turnId: epoch },
      { type: 'turn_started', sessionId: id, turnId: 'native-root-2' },
      { type: 'item', sessionId: id, turnId: 'native-root-2', item: { text: 'follow-up answer' } },
      { type: 'turn_completed', sessionId: id, turnId: 'native-root-2' },
    ]);
    expect(f.native.calls.some((call) => call.method === 'isles/session/submit')).toBe(false);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('authenticates the root envelope and answers child approvals after the root turn ends', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const rootTurn = f.native.start(id);
    const child = 'native-child';
    const epoch = 'child-epoch';
    f.native.event(child, { type: 'turn_started', turnId: epoch }, 'unrelated-root');
    f.native.notify('isles/permission', {
      rootSessionId: id,
      sessionId: child,
      turnId: epoch,
      requestId: 'unowned',
      text: 'Write file',
    });
    expect(f.questions).toHaveLength(0);
    f.native.event(child, { type: 'turn_started', turnId: epoch }, id);
    f.native.notify('isles/permission', {
      rootSessionId: id,
      sessionId: child,
      turnId: epoch,
      requestId: 'owned',
      text: 'Write file',
    });
    f.native.complete(id, rootTurn);
    session.answer('owned', { answers: { permission: { answers: ['允许本次'] } } });
    await vi.waitFor(() =>
      expect(
        f.native.calls.find((call) => call.method === 'isles/permission/answer'),
      ).toMatchObject({ params: { sessionId: child, expectedTurnId: epoch, requestId: 'owned' } }),
    );
    expect(f.questions).toMatchObject([{ sessionId: child, turnId: epoch, requestId: 'owned' }]);
    await session.interrupt!(child, epoch);
    expect(f.native.calls.find((call) => call.method === 'isles/session/interrupt')).toMatchObject({
      params: { sessionId: id, expectedTurnId: epoch },
    });
    expect(f.events.some((event) => event.type === 'turn_started' && event.turnId === epoch)).toBe(
      true,
    );
  });

  it('steers a native autonomous root turn and keeps consumption tied to that exact turn', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const turnId = f.native.start(id, 'autonomous-root');
    f.native.onRequest = ({ method, params }) => {
      if (method === 'isles/session/steer') f.native.accept(id, params.messageId as string, turnId);
    };
    await expect(
      session.steer!({
        sessionId: id,
        expectedTurnId: turnId,
        batchId: randomUUID(),
        text: 'additional input',
      }),
    ).resolves.toEqual({ turnId });
    f.native.complete(id, turnId);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('forwards native user questions and sends answer or rejection once', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    f.startInput(id);
    const { turnId } = await session.submit(f.input(id));
    const questions = [
      {
        id: 'choice',
        header: 'Next',
        question: 'Choose next step',
        multiSelect: false,
        isOther: true,
        isSecret: false,
        options: [{ label: 'Continue', description: 'Proceed' }],
      },
    ];
    f.native.notify('isles/question', {
      sessionId: id,
      turnId,
      requestId: 'native-question',
      questions,
    });
    f.native.notify('isles/question', {
      sessionId: id,
      turnId,
      requestId: 'native-question',
      questions,
    });
    expect(f.questions).toEqual([
      { sessionId: id, turnId, requestId: 'native-question', questions },
    ]);
    session.answer('native-question', { answers: { choice: { answers: ['Continue'] } } });
    session.answer('native-question', { answers: { choice: { answers: ['duplicate'] } } });
    await vi.waitFor(() =>
      expect(f.native.calls.filter((call) => call.method === 'isles/question/answer')).toHaveLength(
        1,
      ),
    );
    expect(f.native.calls.find((call) => call.method === 'isles/question/answer')).toMatchObject({
      params: { requestId: 'native-question', answers: { choice: { answers: ['Continue'] } } },
    });
    f.native.notify('isles/question', {
      sessionId: id,
      turnId,
      requestId: 'cancel-question',
      questions,
    });
    session.rejectQuestion('cancel-question', 'User declined');
    await vi.waitFor(() =>
      expect(f.native.calls.find((call) => call.method === 'isles/question/reject')).toMatchObject({
        params: { requestId: 'cancel-question', reason: 'User declined' },
      }),
    );
  });

  it('does not construct a process when closed during executable discovery', async () => {
    const f = await fixture();
    const command = await f.environment.executable();
    let release!: (value: typeof command) => void;
    const discovery = new Promise<typeof command>((resolve) => {
      release = resolve;
    });
    const executable = vi.spyOn(f.environment, 'executable').mockReturnValue(discovery);
    const factory = vi.fn(f.native.factory);
    const adapter = new DshAdapter(f.environment, factory);
    const pending = adapter.connect(f.agent, 'http://127.0.0.1:4310', f.handlers);
    void pending.catch(() => {});
    await vi.waitFor(() => expect(executable).toHaveBeenCalled());
    const published = vi.mocked(f.handlers.connected).mock.calls[0]![0];
    await published.close();
    release(command);
    await expect(pending).rejects.toThrow('连接已关闭');
    expect(factory).not.toHaveBeenCalled();
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('keeps the fixed ID persisted and releases its process when closed during native session creation', async () => {
    const f = await fixture();
    const session = await f.connect();
    let release!: (value: unknown) => void;
    let params: Record<string, unknown> | undefined;
    f.native.onRequest = (call) => {
      if (call.method !== 'isles/session/create') return;
      params = call.params;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const saved: string[] = [];
    const creating = session.createSession((id) => saved.push(id));
    void creating.catch(() => {});
    await vi.waitFor(() => expect(params).toBeDefined());
    expect(saved).toEqual([params!.sessionId]);
    await session.close();
    release({ sessionId: params!.sessionId, cwd: f.agent.workspace });
    await expect(creating).rejects.toThrow('连接已关闭');
    expect(f.native.closed).toBe(true);
    expect(f.handlers.exit).not.toHaveBeenCalled();
    expect(f.native.calls.filter((call) => call.method === 'isles/session/create')).toHaveLength(1);
  });

  it('closes a pending submit without leaking a connection or reporting an intentional exit', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const pending = session.submit(f.input(id));
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(f.native.calls.some((call) => call.method === 'isles/session/submit')).toBe(true),
    );
    await session.close();
    await expect(pending).rejects.toThrow();
    expect(f.native.closed).toBe(true);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });
});
