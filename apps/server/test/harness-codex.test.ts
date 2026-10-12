import { ConfigManager } from '@isles/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../src/harness/codex/adapter.js';
import { StdioClient } from '../src/harness/codex/client.js';
import { NativeEnvironment } from '../src/harness/codex/environment.js';
import {
  NativeRpcError,
  type NativeClient,
  type NativeHandlers,
} from '../src/harness/codex/protocol.js';
import {
  HarnessSubmissionRejected,
  type HarnessCatalog,
  type HarnessHandlers,
  type HarnessTurnInput,
} from '../src/harness/types.js';
import { AgentWorkspace } from '../src/runtime/workspace.js';
import type { AgentRecord } from '../src/storage/store.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(dangerFullAccess = false) {
  const root = await mkdtemp(join(tmpdir(), 'isles-codex-adapter-'));
  roots.push(root);
  const config = new ConfigManager({
    configFilePath: join(root, 'config.toml'),
    homeDir: root,
    environment: { ISLES_DATA_DIR: root, ISLES_CODEX_HOME: join(root, 'native-home') },
  });
  const workspace = new AgentWorkspace(config);
  const environment = new NativeEnvironment(config, workspace);
  const agent: AgentRecord = {
    id: randomUUID(),
    channelId: randomUUID(),
    name: 'Adapter test',
    harness: 'codex',
    model: 'model-one',
    reasoningEffort: 'high',
    workspace: join(root, 'agent'),
    nativeHome: environment.home,
    threadId: null,
    threadCreationAttempted: false,
    canCreateGroups: false,
    dangerFullAccess,
    steerEnabled: false,
    desiredState: 'running',
    status: 'creating',
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let wire!: NativeHandlers;
  let request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'thread/start' || method === 'thread/resume')
      return {
        thread: { id: params.threadId ?? 'session-one' },
        instructionSources: [join(agent.workspace, 'AGENTS.md')],
      };
    if (method === 'turn/start') return { turn: { id: 'turn-one' } };
    return {};
  };
  const native: NativeClient = {
    request: async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return (await request(method, params)) as T;
    },
    respond: vi.fn(),
    reject: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const output: HarnessHandlers = {
    connected: vi.fn(),
    event: vi.fn(),
    question: vi.fn(),
    exit: vi.fn(),
  };
  const catalog: HarnessCatalog = {
    status: async () => ({
      available: true,
      authenticated: true,
      version: 'test',
      binaryPath: null,
      error: null,
    }),
    models: async () => [],
    invalidate: vi.fn(),
  };
  const adapter = new CodexAdapter(environment, catalog, async (_agent, handlers) => {
    wire = handlers;
    return native;
  });
  const session = await adapter.connect(agent, 'http://127.0.0.1:4310', output);
  const input: HarnessTurnInput = {
    sessionId: 'session-one',
    runId: randomUUID(),
    text: '[channel: test] Hello',
    model: 'model-two',
    reasoningEffort: 'max',
    workspace: agent.workspace,
  };
  return {
    root,
    environment,
    agent,
    adapter,
    catalog,
    session,
    native,
    wire,
    output,
    calls,
    input,
    setRequest: (next: typeof request) => {
      request = next;
    },
  };
}

describe('Codex adapter protocol boundary', () => {
  it.each([false, true])(
    'applies native permissions for create, resume and every turn (full=%s)',
    async (full) => {
      const f = await fixture(full);
      await f.session.createSession(() => {});
      await f.session.resumeSession('session-one');
      await f.session.submit(f.input);
      for (const call of f.calls.filter((call) =>
        ['thread/start', 'thread/resume'].includes(call.method),
      )) {
        expect(call.params).toMatchObject({
          sandbox: full ? 'danger-full-access' : 'workspace-write',
          approvalPolicy: full ? 'never' : 'on-request',
        });
        if (!full)
          expect(call.params.config).toMatchObject({
            'sandbox_workspace_write.writable_roots': [f.environment.workspace.sharedDir],
          });
      }
      expect(
        f.calls.find((call) => call.method === 'turn/start')?.params.sandboxPolicy,
      ).toMatchObject(
        full
          ? { type: 'dangerFullAccess' }
          : {
              type: 'workspaceWrite',
              writableRoots: [f.agent.workspace, f.environment.workspace.sharedDir],
            },
      );
    },
  );

  it.each([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
  ])(
    'routes %s to native allow and deny responses without extending the session',
    async (method) => {
      const f = await fixture();
      await f.session.createSession(() => {});
      await f.session.submit(f.input);
      const permissions = { network: null, fileSystem: { read: null, write: ['/outside'] } };
      const request = {
        threadId: 'session-one',
        turnId: 'turn-one',
        itemId: 'item',
        command: 'fixture command',
        permissions,
      };
      if (method === 'item/fileChange/requestApproval')
        f.wire.notification('item/started', {
          threadId: 'session-one',
          turnId: 'turn-one',
          item: {
            id: 'item',
            type: 'fileChange',
            changes: [{ path: '/outside/file.txt', kind: { type: 'add' }, diff: '+fixture' }],
          },
        });
      f.wire.request(100, method, request);
      expect(f.native.respond).not.toHaveBeenCalled();
      expect(f.output.question).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 100,
          questions: [expect.objectContaining({ id: 'permission', isOther: false })],
        }),
      );
      if (method === 'item/fileChange/requestApproval')
        expect(vi.mocked(f.output.question).mock.calls[0]![0].questions[0]!.question).toContain(
          '/outside/file.txt',
        );
      f.session.answer(100, { answers: { permission: { answers: ['允许本次'] } } });
      expect(f.native.respond).toHaveBeenLastCalledWith(
        100,
        method.includes('/permissions/')
          ? { permissions: { fileSystem: permissions.fileSystem }, scope: 'turn' }
          : { decision: 'accept' },
      );
      f.wire.request(101, method, request);
      f.session.answer(101, { answers: { permission: { answers: ['拒绝'] } } });
      expect(f.native.respond).toHaveBeenLastCalledWith(
        101,
        method.includes('/permissions/')
          ? { permissions: {}, scope: 'turn' }
          : { decision: 'decline' },
      );
      expect(() =>
        f.session.answer(101, { answers: { permission: { answers: ['允许本次'] } } }),
      ).toThrow('已失效');
    },
  );

  it('rejects unknown threads and expires approvals resolved elsewhere or on stop', async () => {
    const f = await fixture();
    await f.session.createSession(() => {});
    await f.session.submit(f.input);
    const request = { threadId: 'session-one', turnId: 'turn-one', itemId: 'item' };
    f.wire.request('unknown', 'item/fileChange/requestApproval', {
      ...request,
      threadId: 'unknown',
    });
    expect(f.native.respond).toHaveBeenLastCalledWith('unknown', { decision: 'decline' });
    expect(f.output.question).not.toHaveBeenCalled();
    f.wire.notification('thread/started', {
      thread: { id: 'child', parentThreadId: 'session-one' },
    });
    f.wire.request('child-request', 'item/fileChange/requestApproval', {
      ...request,
      threadId: 'child',
      turnId: 'child-turn',
    });
    f.wire.notification('serverRequest/resolved', {
      threadId: 'child',
      requestId: 'child-request',
    });
    expect(f.output.event).toHaveBeenCalledWith({
      type: 'question_expired',
      sessionId: 'session-one',
      turnId: 'turn-one',
      requestId: 'child-request',
    });
    expect(() =>
      f.session.answer('child-request', { answers: { permission: { answers: ['允许本次'] } } }),
    ).toThrow('已失效');
    f.wire.request('stop', 'item/fileChange/requestApproval', request);
    await f.session.interrupt('session-one', 'turn-one');
    expect(f.native.respond).toHaveBeenLastCalledWith('stop', { decision: 'decline' });
    expect(() =>
      f.session.answer('stop', { answers: { permission: { answers: ['允许本次'] } } }),
    ).toThrow('已失效');
  });

  it('isolates message and command deltas while retaining discrete tool and completion boundaries', async () => {
    const { wire, output } = await fixture();
    const identity = { threadId: 'session-one', turnId: 'turn-one' };
    for (const type of ['agentMessage', 'reasoning'])
      wire.notification('item/started', {
        ...identity,
        item: { id: type, type, text: 'partial output' },
      });
    expect(output.event).not.toHaveBeenCalled();
    wire.notification('item/started', {
      ...identity,
      item: { id: 'command', type: 'commandExecution', command: 'echo hello' },
    });
    wire.notification('item/agentMessage/delta', {
      ...identity,
      itemId: 'message',
      delta: 'hello',
    });
    wire.notification('item/commandExecution/outputDelta', {
      ...identity,
      itemId: 'command',
      delta: 'hello\n',
    });
    wire.notification('item/completed', {
      ...identity,
      item: { id: 'message', type: 'agentMessage', text: 'hello' },
    });
    wire.notification('item/completed', {
      ...identity,
      item: { id: 'command', type: 'commandExecution', aggregatedOutput: 'hello\n' },
    });
    expect(vi.mocked(output.event).mock.calls.map(([event]) => event)).toMatchObject([
      { type: 'item', append: false, item: { id: 'command', status: 'running' } },
      { type: 'item_delta', append: true, item: { id: 'message', text: 'hello' } },
      { type: 'item_delta', append: true, item: { id: 'command', text: 'hello\n' } },
      { type: 'item', append: false, item: { id: 'message', status: 'completed' } },
      { type: 'item', append: false, item: { id: 'command', status: 'completed' } },
    ]);
  });

  it('reports last context usage outside turns and filters other native threads', async () => {
    const { session, wire, output } = await fixture();
    await session.createSession(() => {});
    const usage = {
      total: { totalTokens: 900000 },
      last: { totalTokens: 12345 },
      modelContextWindow: 200000,
    };
    wire.notification('thread/tokenUsage/updated', { threadId: 'subagent', tokenUsage: usage });
    expect(output.event).not.toHaveBeenCalled();
    wire.notification('thread/tokenUsage/updated', { threadId: 'session-one', tokenUsage: usage });
    expect(output.event).toHaveBeenLastCalledWith({
      type: 'context_usage',
      sessionId: 'session-one',
      usage: { usedTokens: 12345, maxTokens: 200000, estimated: false },
    });
    await session.resumeSession('restored');
    wire.notification('thread/tokenUsage/updated', { threadId: 'session-one', tokenUsage: usage });
    expect(output.event).toHaveBeenCalledTimes(1);
    wire.notification('thread/tokenUsage/updated', {
      threadId: 'restored',
      tokenUsage: { ...usage, last: { totalTokens: 1000 }, modelContextWindow: null },
    });
    expect(output.event).toHaveBeenLastCalledWith({
      type: 'context_usage',
      sessionId: 'restored',
      usage: { usedTokens: 1000, maxTokens: null, estimated: false },
    });
    for (const invalid of [-1, '1000', 1.5])
      wire.notification('thread/tokenUsage/updated', {
        threadId: 'restored',
        tokenUsage: { ...usage, last: { totalTokens: invalid } },
      });
    expect(output.event).toHaveBeenCalledTimes(2);
  });

  it('does not treat a usage notification as turn acceptance', async () => {
    const { session, wire, setRequest, input, output } = await fixture();
    await session.createSession(() => {});
    setRequest(async () => {
      wire.notification('thread/tokenUsage/updated', {
        threadId: input.sessionId,
        tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 200000 },
      });
      throw new NativeRpcError('input rejected');
    });
    await expect(session.submit(input)).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    expect(output.event).toHaveBeenCalledOnce();
    expect(output.event).toHaveBeenCalledWith(expect.objectContaining({ type: 'context_usage' }));
  });
  it('persists the created ID before injection and guidance verification can fail', async () => {
    const { session, calls, setRequest } = await fixture();
    const saved: string[] = [];
    setRequest(async (method) => {
      if (method === 'thread/start')
        return { thread: { id: 'preserve-this-id' }, instructionSources: [] };
      expect(saved).toEqual(['preserve-this-id']);
      return {};
    });
    await expect(session.createSession((id) => saved.push(id))).rejects.toThrow('AGENTS.md');
    expect(saved).toEqual(['preserve-this-id']);
    expect(calls.map((call) => call.method)).toEqual(['thread/start', 'thread/inject_items']);
    expect(calls[1]!.params).toMatchObject({ threadId: 'preserve-this-id' });

    calls.length = 0;
    saved.length = 0;
    setRequest(async (method) => {
      if (method === 'thread/start') return { thread: { id: 'preserve-this-id' } };
      expect(saved).toEqual(['preserve-this-id']);
      throw new Error('injection lost');
    });
    await expect(session.createSession((id) => saved.push(id))).rejects.toThrow('injection lost');
    expect(saved).toEqual(['preserve-this-id']);
  });

  it('resumes only the requested native session and never creates replacement context', async () => {
    const { session, calls, setRequest, agent } = await fixture();
    await expect(session.resumeSession('original-session')).resolves.toBe('original-session');
    expect(calls.map((call) => call.method)).toEqual(['thread/resume']);
    expect(calls[0]!.params).toMatchObject({
      threadId: 'original-session',
      cwd: agent.workspace,
      approvalPolicy: 'on-request',
      config: { 'mcp_servers.isles': { bearer_token_env_var: 'ISLES_MCP_TOKEN' } },
    });
    setRequest(async () => ({ thread: { id: 'replacement' }, instructionSources: [] }));
    await expect(session.resumeSession('original-session')).rejects.toThrow('不同 thread');
    expect(calls.every((call) => call.method === 'thread/resume')).toBe(true);
    setRequest(async () => ({ thread: { id: 'original-session' }, instructionSources: [] }));
    await expect(session.resumeSession('original-session')).rejects.toThrow('AGENTS.md');
  });

  it('maps semantic submission and control operations, and preserves uncertain errors', async () => {
    const { session, input, calls, native, wire, setRequest, environment } = await fixture();
    await expect(session.submit(input)).resolves.toEqual({ turnId: 'turn-one' });
    expect(calls[0]).toEqual({
      method: 'turn/start',
      params: {
        threadId: input.sessionId,
        clientUserMessageId: input.runId,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
        model: input.model,
        effort: input.reasoningEffort,
        cwd: input.workspace,
        approvalPolicy: 'on-request',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [input.workspace, environment.workspace.sharedDir],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    });
    const refusal = new NativeRpcError('input rejected');
    setRequest(async () => {
      throw refusal;
    });
    await expect(session.submit(input)).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    const lost = new Error('connection lost after write');
    setRequest(async () => {
      throw lost;
    });
    await expect(session.submit(input)).rejects.toBe(lost);
    setRequest(async () => {
      wire.notification('turn/started', {
        threadId: input.sessionId,
        turn: { id: 'accepted-turn', status: 'inProgress' },
      });
      throw refusal;
    });
    await expect(session.submit(input)).rejects.toBe(refusal);
    setRequest(async () => ({}));
    await session.interrupt(input.sessionId, 'accepted-turn');
    expect(calls.at(-1)).toEqual({
      method: 'turn/interrupt',
      params: { threadId: input.sessionId, turnId: 'accepted-turn' },
    });
    const answer = { answers: { q: { answers: ['Yes'] } } };
    session.answer(7, answer);
    session.rejectQuestion('other', 'expired');
    await session.close();
    await session.close();
    expect(native.respond).toHaveBeenCalledWith(7, answer);
    expect(native.reject).toHaveBeenCalledWith('other', 'expired');
    expect(native.close).toHaveBeenCalledOnce();
  });

  it('projects safe items and scrubs credentials across events, questions and exits', async () => {
    const { environment, wire, output, native } = await fixture();
    const secret = 'private-token-123456';
    environment.redactor.add(secret);
    wire.notification('item/completed', {
      threadId: 'session-one',
      turnId: 'turn-one',
      item: {
        id: 'safe-item',
        type: 'mcpToolCall',
        text: `ok ${secret}`,
        command: 'echo ok',
        aggregatedOutput: 'safe output',
        server: 'isles',
        tool: 'send_message',
        status: 'nativeCompleted',
        exitCode: 0,
        arguments: { body: 'hidden-arguments' },
        config: { authorization: 'hidden-config' },
        result: { text: 'hidden-result' },
        reasoning: 'hidden-reasoning',
      },
    });
    wire.notification('item/agentMessage/delta', {
      threadId: 'session-one',
      itemId: 'safe-item',
      delta: secret,
    });
    wire.notification('turn/completed', {
      threadId: 'session-one',
      turn: { id: 'turn-one', status: 'failed', error: { message: secret } },
    });
    const request = {
      threadId: 'child-session',
      turnId: 'child-turn',
      itemId: 'question-item',
      isBlocking: true,
      questions: [
        {
          id: 'q',
          header: secret,
          question: `Pick ${secret}`,
          isOther: false,
          isSecret: false,
          options: [{ label: secret, description: secret }],
        },
      ],
    };
    wire.request(10, 'item/tool/requestUserInput', request);
    wire.request(11, 'unknown/request', request);
    wire.request(12, 'item/tool/requestUserInput', { ...request, questions: [] });
    wire.exit(new Error(secret));
    expect(output.question).toHaveBeenCalledOnce();
    expect(output.question).toHaveBeenCalledWith({
      requestId: 10,
      sessionId: 'child-session',
      turnId: 'child-turn',
      questions: [
        {
          ...request.questions[0],
          multiSelect: false,
          header: '[redacted]',
          question: 'Pick [redacted]',
          options: [{ label: '[redacted]', description: '[redacted]' }],
        },
      ],
    });
    expect(native.reject).toHaveBeenCalledWith(11, expect.any(String));
    expect(native.reject).toHaveBeenCalledWith(12, expect.any(String));
    const emitted = JSON.stringify([
      vi.mocked(output.event).mock.calls,
      vi.mocked(output.question).mock.calls,
    ]);
    for (const hidden of [
      secret,
      'hidden-arguments',
      'hidden-config',
      'hidden-result',
      'hidden-reasoning',
    ])
      expect(emitted).not.toContain(hidden);
    expect(output.event).toHaveBeenCalledWith({
      type: 'item',
      sessionId: 'session-one',
      turnId: 'turn-one',
      append: false,
      item: {
        id: 'safe-item',
        type: 'mcpToolCall',
        status: 'completed',
        text: 'ok [redacted]\ncommand: echo ok\naggregatedOutput: safe output\nserver: isles\ntool: send_message\nstatus: nativeCompleted\nexitCode: 0',
      },
    });
    expect(output.exit).toHaveBeenCalledWith(expect.objectContaining({ message: '[redacted]' }));
  });

  it('publishes the default connection so a silent initialization process can be closed', async () => {
    const { root, environment, agent, catalog, output } = await fixture();
    const script = join(root, 'silent-server.cjs');
    await writeFile(script, 'process.stdin.resume(); setInterval(() => {}, 1000);\n');
    vi.spyOn(environment, 'executable').mockResolvedValue({
      file: process.execPath,
      args: [script],
      path: script,
      version: 'test-node-server',
    });
    const adapter = new CodexAdapter(environment, catalog);
    const connection = adapter
      .connect(agent, 'http://127.0.0.1:4310', output)
      .catch((error: unknown) => error);
    await expect.poll(() => vi.mocked(output.connected).mock.calls.length).toBe(2);
    const published = vi.mocked(output.connected).mock.calls[1]![0];
    await published.close();
    expect(await connection).toBeInstanceOf(Error);
  });

  it('invalidates both native discovery and the catalog on configuration refresh', async () => {
    const { adapter, environment, catalog } = await fixture();
    const invalidate = vi.spyOn(environment, 'invalidate');
    adapter.invalidate();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(catalog.invalidate).toHaveBeenCalledOnce();
  });

  it('steers only the expected turn with a separately identified text batch', async () => {
    const { session, calls, input, setRequest, adapter } = await fixture();
    const batch = {
      sessionId: input.sessionId,
      expectedTurnId: 'active-turn',
      batchId: randomUUID(),
      text: '[channel: test] Change direction',
    };
    setRequest(async () => ({ turnId: batch.expectedTurnId }));
    expect(adapter.descriptor.capabilities.steer).toBe(true);
    await expect(session.steer(batch)).resolves.toEqual({ turnId: 'active-turn' });
    expect(calls).toEqual([
      {
        method: 'turn/steer',
        params: {
          threadId: batch.sessionId,
          expectedTurnId: batch.expectedTurnId,
          clientUserMessageId: batch.batchId,
          input: [{ type: 'text', text: batch.text, text_elements: [] }],
        },
      },
    ]);
    for (const invalid of [{ turnId: 'replacement-turn' }, { turnId: '' }, {}, null]) {
      setRequest(async () => invalid);
      try {
        await session.steer(batch);
        expect.fail('Invalid steer acknowledgement must fail');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(HarnessSubmissionRejected);
      }
    }
  });

  it('permits queue fallback only for definite steer refusals and scrubs every failure', async () => {
    const { session, input, environment, setRequest } = await fixture();
    const batch = {
      sessionId: input.sessionId,
      expectedTurnId: 'active-turn',
      batchId: randomUUID(),
      text: 'Follow-up',
    };
    const secret = 'steer-private-secret-123456';
    environment.redactor.add(secret);
    for (const code of [-32600, -32601, -32602, -32603, -32000, undefined]) {
      setRequest(async () => {
        throw new NativeRpcError(`steer failed: ${secret}`, code);
      });
      try {
        await session.steer(batch);
        expect.fail('Native error must fail');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('steer failed: [redacted]');
        if (code !== undefined && [-32600, -32601, -32602].includes(code))
          expect(error).toBeInstanceOf(HarnessSubmissionRejected);
        else {
          expect(error).not.toBeInstanceOf(HarnessSubmissionRejected);
          expect(error).toBeInstanceOf(NativeRpcError);
          expect((error as NativeRpcError).code).toBe(code);
        }
      }
    }
    setRequest(async () => {
      throw new Error(`timeout after write ${secret}`);
    });
    await expect(session.steer(batch)).rejects.toThrow('timeout after write [redacted]');
  });

  it('retains RPC error codes from native frames and closes pending steer safely', async () => {
    const { root, environment } = await fixture();
    const script = join(root, 'steer-server.cjs');
    await writeFile(
      script,
      `const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize')
    process.stdout.write(JSON.stringify({id:frame.id,result:{}}) + '\\n');
  if (frame.method === 'turn/steer' && frame.params.input.length)
    process.stdout.write(JSON.stringify({id:frame.id,error:{code:-32602,message:'Bearer frame-private-secret'}}) + '\\n');
});
`,
    );
    const client = new StdioClient(
      { file: process.execPath, args: [script] },
      root,
      {},
      { notification: () => {}, request: () => {}, exit: () => {} },
      environment.redactor,
      environment.log,
    );
    try {
      await client.initialize();
      await expect(client.request('turn/steer', { input: [{}] })).rejects.toMatchObject({
        code: -32602,
        message: 'Bearer [redacted]',
      });
      const pending = client.request('turn/steer', { input: [] });
      const rejected = expect(pending).rejects.toThrow('连接已关闭');
      await client.close();
      await rejected;
      await client.close();
    } finally {
      await client.close();
    }
  });
});
