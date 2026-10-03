import { ConfigManager } from '@isles/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../src/codex/adapter.js';
import { NativeEnvironment } from '../src/codex/environment.js';
import { NativeRpcError, type NativeClient, type NativeHandlers } from '../src/codex/protocol.js';
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

async function fixture() {
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
      approvalPolicy: 'never',
      config: { 'mcp_servers.isles': { bearer_token_env_var: 'ISLES_MCP_TOKEN' } },
    });
    setRequest(async () => ({ thread: { id: 'replacement' }, instructionSources: [] }));
    await expect(session.resumeSession('original-session')).rejects.toThrow('不同 thread');
    expect(calls.every((call) => call.method === 'thread/resume')).toBe(true);
    setRequest(async () => ({ thread: { id: 'original-session' }, instructionSources: [] }));
    await expect(session.resumeSession('original-session')).rejects.toThrow('AGENTS.md');
  });

  it('maps semantic submission and control operations, and preserves uncertain errors', async () => {
    const { session, input, calls, native, wire, setRequest } = await fixture();
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
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
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
});
