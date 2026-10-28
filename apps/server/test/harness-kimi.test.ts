import { ConfigManager } from '@isles/config';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpAdapter } from '../src/harness/acp/adapter.js';
import {
  HarnessSubmissionRejected,
  type HarnessEvent,
  type HarnessHandlers,
  type HarnessQuestion,
} from '../src/harness/types.js';
import { findKimiExecutable } from '../src/harness/kimi/executable.js';
import { KimiAcpHarness } from './kimi-acp-harness.js';
import { AgentWorkspace } from '../src/runtime/workspace.js';
import type { AgentRecord } from '../src/storage/store.js';
import { kimiFixture } from './acp-fixture.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture(agentSettings: Partial<AgentRecord> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'isles-kimi-adapter-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cli = await kimiFixture(root);
  const config = new ConfigManager({
    configFilePath: join(root, 'config.toml'),
    homeDir: root,
    environment: { ISLES_KIMI_BIN: cli.binary, ISLES_KIMI_HOME: cli.home },
  });
  const workspace = new AgentWorkspace(config);
  const adapter = new AcpAdapter(new KimiAcpHarness(config, workspace));
  const agent: AgentRecord = {
    id: randomUUID(),
    channelId: randomUUID(),
    name: 'Kimi fixture',
    harness: 'kimi',
    model: 'kimi-code/k3',
    reasoningEffort: 'high',
    workspace: join(root, 'workspace'),
    workspacePaths: [],
    nativeHome: cli.home,
    threadId: null,
    threadCreationAttempted: false,
    canCreateGroups: false,
    dangerFullAccess: false,
    steerEnabled: false,
    desiredState: 'running',
    status: 'creating',
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...agentSettings,
  };
  const events: HarnessEvent[] = [];
  const questions: HarnessQuestion[] = [];
  const output: HarnessHandlers = {
    connected: vi.fn(),
    event: (event) => events.push(event),
    question: (question) => questions.push(question),
    exit: vi.fn(),
  };
  const connect = async () => {
    const session = await adapter.connect(agent, 'http://127.0.0.1:4310', output);
    cleanups.push(() => session.close());
    return session;
  };
  const created = async () => {
    const session = await connect();
    return { session, id: await session.createSession(() => {}) };
  };
  const input = (text: string, sessionId: string) => ({
    sessionId,
    runId: randomUUID(),
    text,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    workspace: agent.workspace,
  });
  const frames = async (method: string) =>
    (await cli.records()).filter((frame) => frame.method === method);
  const completed = (turnId: string) =>
    vi.waitFor(() => {
      const event = events.find(
        (value) => value.type === 'turn_completed' && value.turnId === turnId,
      );
      if (!event) throw new Error('turn still running');
      return event;
    });
  /** Includes buffered deltas before applying the final persistence boundary. */
  const items = () => {
    const result = new Map<string, { type: string; status: string; text: string }>();
    for (const event of events)
      if (event.type === 'item' || event.type === 'item_delta') {
        const previous = result.get(event.item.id);
        result.set(event.item.id, {
          type: event.item.type,
          status: event.item.status,
          text: (event.append ? (previous?.text ?? '') : '') + event.item.text,
        });
      }
    return [...result.values()];
  };
  return {
    root,
    cli,
    workspace,
    adapter,
    agent,
    events,
    questions,
    output,
    connect,
    created,
    input,
    frames,
    completed,
    items,
  };
}

describe('Kimi Code discovery', () => {
  it('projects usage updates after completion and during resume, filtering invalid and unrelated sessions', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({
      contextUsage: { used: 12345, size: 262144 },
      otherSessionUsage: true,
      invalidUsage: true,
    });
    const input = f.input('hello', id);
    await session.submit(input);
    await f.completed(input.runId);
    const usage = () => f.events.filter((event) => event.type === 'context_usage');
    await vi.waitFor(() =>
      expect(usage()).toEqual([
        {
          type: 'context_usage',
          sessionId: id,
          usage: { usedTokens: 12345, maxTokens: 262144, estimated: false },
        },
      ]),
    );
    await session.close();
    await f.cli.set({ contextUsage: { used: 1024, size: 262144 }, usageOnResume: true });
    await (await f.connect()).resumeSession(id);
    expect(usage().at(-1)).toMatchObject({ sessionId: id, usage: { usedTokens: 1024 } });
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
  });

  it('does not accept a rejected or pending prompt from a usage update', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ contextUsage: { used: 10, size: 262144 }, usageBeforeReject: true });
    await expect(session.submit(f.input('hello', id))).rejects.toBeInstanceOf(
      HarnessSubmissionRejected,
    );
    expect(f.events.map((event) => event.type)).toEqual(['context_usage']);
    await f.cli.set({ contextUsage: { used: 20, size: 262144 }, usageBeforeHold: true });
    const input = f.input('hold', id);
    let accepted = false;
    const submission = session.submit(input).then((result) => {
      accepted = true;
      return result;
    });
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.type === 'context_usage')).toHaveLength(2),
    );
    expect(accepted).toBe(false);
    expect(f.events.some((event) => event.type === 'turn_started')).toBe(false);
    await session.interrupt(id, input.runId);
    await submission;
    expect(await f.completed(input.runId)).toMatchObject({ status: 'interrupted' });
  });
  it('accepts the bare version Kimi prints and rejects other programs', async () => {
    const version = (output: string) => () => Promise.resolve(output);
    const root = await mkdtemp(join(tmpdir(), 'isles-kimi-executable-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const { binary } = await kimiFixture(root);
    expect(await findKimiExecutable({ binary }, version('2.1.1\n'))).toMatchObject({
      path: binary,
      version: '2.1.1',
      file: process.execPath,
      args: [await realpath(binary)],
    });
    await expect(findKimiExecutable({ binary }, version('kimi 2.1.1'))).rejects.toThrow(
      '配置的 Kimi Code 无法运行',
    );
    await expect(
      findKimiExecutable({ binary: join(root, 'missing') }, version('2.1.1')),
    ).rejects.toThrow('找不到配置的 Kimi Code');
  });
});

describe('Kimi Code ACP adapter', () => {
  it('uses declared ordinary/full modes and resets full access on resume', async () => {
    const f = await fixture({ dangerFullAccess: true });
    f.agent.workspacePaths = await Promise.all(
      ['external one', 'external-two'].map(async (name) => {
        const path = join(f.root, name);
        await mkdir(path);
        return realpath(path);
      }),
    );
    const workspacePaths = [f.workspace.sharedDir, ...f.agent.workspacePaths];
    const first = await f.created();
    expect(
      (await f.frames('session/set_config_option')).map((frame) => frame.params),
    ).toContainEqual({ sessionId: first.id, configId: 'mode', value: 'yolo' });
    expect((await f.frames('session/new'))[0]?.params).toMatchObject({
      cwd: f.agent.workspace,
      additionalDirectories: workspacePaths,
    });
    await first.session.close();
    await f.cli.set({ initialMode: 'yolo' });
    f.agent.dangerFullAccess = false;
    const restored = await f.connect();
    await restored.resumeSession(first.id);
    expect(
      (await f.frames('session/set_config_option')).map((frame) => frame.params).at(-2),
    ).toMatchObject({ configId: 'mode', value: 'default' });
    expect((await f.frames('session/resume'))[0]?.params).toMatchObject({
      cwd: f.agent.workspace,
      additionalDirectories: workspacePaths,
    });
  });

  it('cancels native requests offering only a persistent grant', async () => {
    const f = await fixture();
    await f.cli.set({ permissionAlwaysOnly: true });
    const { session, id } = await f.created();
    const input = f.input('permission', id);
    await session.submit(input);
    await f.completed(input.runId);
    expect(f.questions).toHaveLength(0);
    expect(f.items().at(-1)?.text).toContain('"outcome":"cancelled"');
  });

  it('omits additional directories when native capability is absent', async () => {
    const f = await fixture();
    await f.cli.set({ noAdditionalDirectories: true });
    await f.created();
    expect((await f.frames('session/new'))[0]?.params).not.toHaveProperty('additionalDirectories');
  });

  it.each(['create', 'resume'])(
    'reports missing additional-directory capability on %s',
    async (method) => {
      const f = await fixture();
      f.agent.workspacePaths = [await realpath(f.root)];
      await f.cli.set({ noAdditionalDirectories: true });
      const session = await f.connect();
      await expect(
        method === 'create' ? session.createSession(() => {}) : session.resumeSession('existing'),
      ).rejects.toThrow('additionalDirectories');
      expect(await f.frames('session/new')).toEqual([]);
      expect(await f.frames('session/resume')).toEqual([]);
    },
  );

  it('declines native permissions and expires pending requests on interruption', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    const first = f.input('permission', id);
    await session.submit(first);
    await vi.waitFor(() => expect(f.questions).toHaveLength(1));
    session.answer(f.questions[0]!.requestId, { answers: { permission: { answers: ['拒绝'] } } });
    await f.completed(first.runId);
    expect(f.items().at(-1)?.text).toContain('"optionId":"reject"');
    const second = f.input('permission', id);
    await session.submit(second);
    await vi.waitFor(() => expect(f.questions).toHaveLength(2));
    await session.interrupt(id, second.runId);
    expect(f.events).toContainEqual({
      type: 'question_expired',
      sessionId: id,
      turnId: second.runId,
      requestId: f.questions[1]!.requestId,
    });
    expect(() =>
      session.answer(f.questions[1]!.requestId, {
        answers: { permission: { answers: ['允许本次'] } },
      }),
    ).toThrow('已失效');
  });

  it('reads per-model thinking levels from a deleted probe session without a prompt', async () => {
    const f = await fixture();
    expect(await f.adapter.catalog.status()).toMatchObject({
      available: true,
      authenticated: true,
      version: '2.1.1',
      error: null,
    });
    expect(await f.adapter.catalog.models()).toEqual([
      {
        id: 'kimi-code/k3',
        model: 'kimi-code/k3',
        displayName: 'K3',
        description: '',
        supportedReasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'max',
        isDefault: true,
      },
      {
        id: 'kimi-code/fast',
        model: 'kimi-code/fast',
        displayName: 'Fast',
        description: '',
        supportedReasoningEfforts: ['default'],
        defaultReasoningEffort: 'default',
        isDefault: false,
      },
    ]);
    expect(await f.frames('session/prompt')).toEqual([]);
    const [created] = await f.frames('session/new');
    expect(created).toMatchObject({
      params: { cwd: join(f.workspace.dataDir, 'acp-catalog', 'kimi'), mcpServers: [] },
    });
    expect(await f.frames('session/delete')).toHaveLength(1);
    expect(await readdir(join(f.cli.home, 'sessions'))).toEqual([]);
    await f.cli.set({ unauthenticated: true });
    f.adapter.invalidate();
    expect(await f.adapter.catalog.status()).toMatchObject({
      available: true,
      authenticated: false,
      error: expect.stringContaining('尚未登录'),
    });
    expect(await f.adapter.catalog.models()).toEqual([]);
  });

  it('saves the session ID, passes Isles MCP with a bearer header, then applies mode, model and thinking', async () => {
    const f = await fixture();
    const session = await f.connect();
    const saved: string[] = [];
    const id = await session.createSession((value) => saved.push(value));
    expect(id).toMatch(/^session_/);
    expect(saved).toEqual([id]);
    const records = await f.cli.records();
    expect(records.find((frame) => frame.type === 'launch')).toMatchObject({
      args: ['acp'],
      cwd: await realpath(f.agent.workspace),
      home: f.cli.home,
      hasToken: false,
    });
    const token = await f.workspace.token(join(f.workspace.dataDir, 'agents', f.agent.id));
    expect((await f.frames('session/new'))[0]).toMatchObject({
      params: {
        cwd: f.agent.workspace,
        mcpServers: [
          {
            type: 'http',
            name: 'isles',
            url: `http://127.0.0.1:4310/mcp/${f.agent.id}`,
            headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
          },
        ],
      },
    });
    expect((await f.frames('session/set_config_option')).map((frame) => frame.params)).toEqual([
      { sessionId: id, configId: 'thinking', value: 'high' },
    ]);
    expect(await f.frames('initialize')).toMatchObject([
      { params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } } },
    ]);
    expect(await f.frames('session/prompt')).toEqual([]);
    expect(f.events).toEqual([]);
  });

  it('filters a retained thinking value that the selected model cannot set', async () => {
    const f = await fixture({ model: 'kimi-code/fast', reasoningEffort: 'high' });
    await f.cli.set({ initialThinking: 'high', restrictedThinking: true });
    expect(await f.adapter.catalog.models()).toMatchObject([
      { model: 'kimi-code/k3', defaultReasoningEffort: 'high' },
      {
        model: 'kimi-code/fast',
        supportedReasoningEfforts: ['on', 'max'],
        defaultReasoningEffort: 'max',
      },
    ]);
    expect(await f.frames('session/prompt')).toEqual([]);
    const session = await f.connect();
    await expect(session.createSession(() => {})).rejects.toThrow('Unsupported thinking');
  });

  it('resumes the exact session after a restart and reapplies settings that Kimi resets', async () => {
    const f = await fixture({ model: 'kimi-code/fast', reasoningEffort: 'default' });
    const first = await f.created();
    await first.session.close();
    const session = await f.connect();
    expect(await session.resumeSession(first.id)).toBe(first.id);
    expect(await f.frames('session/resume')).toMatchObject([
      { params: { sessionId: first.id, cwd: f.agent.workspace, mcpServers: [{ name: 'isles' }] } },
    ]);
    expect((await f.frames('session/set_config_option')).map((frame) => frame.params)).toEqual([
      { sessionId: first.id, configId: 'model', value: 'kimi-code/fast' },
      { sessionId: first.id, configId: 'model', value: 'kimi-code/fast' },
    ]);
    const input = f.input('hello', first.id);
    expect(await session.submit(input)).toEqual({ turnId: input.runId });
    await f.completed(input.runId);
    expect(await f.frames('session/new')).toHaveLength(1);
  });

  it('reports an unknown session instead of creating a replacement', async () => {
    const f = await fixture();
    const session = await f.connect();
    await expect(session.resumeSession('session_missing')).rejects.toThrow(
      'ACP fixture 无法恢复原 session',
    );
    expect(f.output.exit).toHaveBeenCalledTimes(1);
    expect(await f.frames('session/new')).toEqual([]);
  });

  it('rejects settings the selected model does not offer', async () => {
    const f = await fixture({ model: 'kimi-code/fast', reasoningEffort: 'high' });
    const session = await f.connect();
    await expect(session.createSession(() => {})).rejects.toThrow('当前不支持推理等级 high');
  });

  it('streams merged message, reasoning, tool and plan items and completes the run', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    const input = f.input('tools', id);
    expect(await session.submit(input)).toEqual({ turnId: input.runId });
    expect(await f.completed(input.runId)).toMatchObject({ status: 'completed', error: null });
    expect(f.events[0]).toEqual({ type: 'turn_started', sessionId: id, turnId: input.runId });
    expect(f.events.filter((event) => event.type === 'item_delta')).toMatchObject([
      { append: true, item: { type: 'reasoning', text: 'Thinking about it' } },
      { append: true, item: { type: 'reasoning', status: 'completed', text: '' } },
      { append: true, item: { type: 'agentMessage', text: 'Let me ' } },
      { append: true, item: { type: 'agentMessage', text: 'check.' } },
      { append: true, item: { type: 'agentMessage', text: 'Done' } },
    ]);
    expect(f.events.filter((event) => event.type === 'item' && event.append)).toMatchObject([
      { item: { type: 'agentMessage', status: 'completed', text: '' } },
      { item: { type: 'agentMessage', status: 'completed', text: '' } },
    ]);
    expect(f.items()).toEqual([
      { type: 'reasoning', status: 'completed', text: 'Thinking about it' },
      { type: 'agentMessage', status: 'completed', text: 'Let me check.' },
      {
        type: 'commandExecution',
        status: 'completed',
        text: 'Shell\n\n{\n  "command": "echo hi"\n}\n\nhi',
      },
      {
        type: 'fileChange',
        status: 'failed',
        text: 'Edit notes.md\n\n{\n  "path": "notes.md"\n}\n\n/tmp/notes.md',
      },
      { type: 'plan', status: 'running', text: '[x] Check\n[ ] Report' },
      { type: 'agentMessage', status: 'completed', text: 'Done' },
    ]);
    expect((await f.frames('session/prompt'))[0]).toMatchObject({
      params: { sessionId: id, prompt: [{ type: 'text', text: 'tools' }] },
    });
  });

  it('buffers repeated running tool progress while publishing starts and state changes', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    const input = f.input('tool-progress', id);
    await session.submit(input);
    await f.completed(input.runId);
    const tools = f.events.filter(
      (event) =>
        (event.type === 'item' || event.type === 'item_delta') && event.item.id === 'progress',
    );
    expect(tools).toMatchObject([
      { type: 'item', append: false, item: { status: 'running', text: 'Shell' } },
      { type: 'item_delta', append: false, item: { status: 'running', text: 'Shell\n\nworking' } },
      { type: 'item_delta', append: false, item: { status: 'running' } },
      { type: 'item_delta', append: false, item: { status: 'running' } },
      { type: 'item', append: false, item: { status: 'completed' } },
    ]);
  });

  it('keeps chunk-kind switches and same-state tool updates entirely in the delta path', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    const input = f.input('interleaved-progress', id);
    await session.submit(input);
    await f.completed(input.runId);
    const items = f.events.filter((event) => event.type === 'item' || event.type === 'item_delta');
    expect(items).toMatchObject([
      { type: 'item_delta', item: { text: 'First thought' } },
      { type: 'item_delta', append: true, item: { status: 'completed', text: '' } },
      { type: 'item_delta', item: { text: 'First answer' } },
      { type: 'item_delta', append: true, item: { status: 'completed', text: '' } },
      { type: 'item_delta', item: { text: 'Second thought' } },
      { type: 'item', append: true, item: { status: 'completed', text: '' } },
      { type: 'item', item: { id: 'progress', status: 'running' } },
      { type: 'item_delta', item: { text: 'Thinking while tool runs' } },
      { type: 'item_delta', append: true, item: { status: 'completed', text: '' } },
      { type: 'item_delta', item: { text: 'Output while tool runs' } },
      { type: 'item_delta', append: true, item: { status: 'completed', text: '' } },
      { type: 'item_delta', item: { id: 'progress', status: 'running' } },
      { type: 'item_delta', item: { text: 'Waiting for completion' } },
      { type: 'item', append: true, item: { status: 'completed', text: '' } },
      { type: 'item', item: { id: 'progress', status: 'completed' } },
      { type: 'item_delta', item: { text: 'Final answer' } },
      { type: 'item', append: true, item: { status: 'completed', text: '' } },
    ]);
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
    expect(
      f.items().filter((item) => item.type === 'agentMessage' || item.type === 'reasoning'),
    ).toEqual([
      { type: 'reasoning', status: 'completed', text: 'First thought' },
      { type: 'agentMessage', status: 'completed', text: 'First answer' },
      { type: 'reasoning', status: 'completed', text: 'Second thought' },
      { type: 'reasoning', status: 'completed', text: 'Thinking while tool runs' },
      { type: 'agentMessage', status: 'completed', text: 'Output while tool runs' },
      { type: 'reasoning', status: 'completed', text: 'Waiting for completion' },
      { type: 'agentMessage', status: 'completed', text: 'Final answer' },
    ]);
  });

  it.each([
    { status: 'failed', text: 'partial-refusal' },
    { status: 'interrupted', text: 'hold' },
  ] as const)('preserves $status for an unfinished streamed segment', async ({ status, text }) => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ chunkBeforeHold: true });
    const input = f.input(text, id);
    await session.submit(input);
    if (status === 'interrupted') await session.interrupt(id, input.runId);
    expect(await f.completed(input.runId)).toMatchObject({ status });
    expect(
      f.events.filter((event) => event.type === 'item' || event.type === 'item_delta'),
    ).toMatchObject([
      { type: 'item_delta', append: true, item: { status: 'running', text: 'Working' } },
      { type: 'item', append: true, item: { status, text: '' } },
    ]);
    expect(f.items()).toEqual([{ type: 'agentMessage', status, text: 'Working' }]);
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
  });

  it('retries a prompt Kimi refuses as busy and keeps one run', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ busy: 1 });
    const input = f.input('after busy', id);
    expect(await session.submit(input)).toEqual({ turnId: input.runId });
    await f.completed(input.runId);
    expect(await f.frames('session/prompt')).toHaveLength(2);
    expect(f.events.filter((event) => event.type === 'turn_completed')).toHaveLength(1);
  });

  it('separates definite refusals from uncertain outcomes', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await expect(session.submit({ ...f.input('hello', id), sessionId: 'other' })).rejects.toThrow(
      HarnessSubmissionRejected,
    );
    await expect(session.submit(f.input('rpc-error', id))).rejects.toThrow(
      HarnessSubmissionRejected,
    );
    const refused = f.input('refuse', id);
    await session.submit(refused);
    expect(await f.completed(refused.runId)).toMatchObject({
      status: 'failed',
      error: 'ACP fixture 拒绝继续执行',
    });
    const limited = f.input('limit', id);
    await session.submit(limited);
    expect(await f.completed(limited.runId)).toMatchObject({
      status: 'completed',
      error: 'ACP fixture 已达到单轮上限（max_turn_requests）',
    });
    await f.cli.set({ exitOnPrompt: true });
    const lost = await session.submit(f.input('hello', id)).catch((error: unknown) => error);
    expect(lost).not.toBeInstanceOf(HarnessSubmissionRejected);
    expect((lost as Error).message).toContain('ACP fixture 已退出');
    expect(f.output.exit).toHaveBeenCalledTimes(1);
  });

  it('reports an exit after acceptance once through the exit handler', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    const input = f.input('exit', id);
    expect(await session.submit(input)).toEqual({ turnId: input.runId });
    await vi.waitFor(() => expect(f.output.exit).toHaveBeenCalledTimes(1));
    expect(f.events.some((event) => event.type === 'turn_completed')).toBe(false);
  });

  it('settles an invalid prompt result as uncertain before any update', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ invalidPromptResult: true });
    const error = await session.submit(f.input('silent', id)).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HarnessSubmissionRejected);
    expect(f.output.exit).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual([]);
  });

  it('reports an invalid result after acceptance once instead of completing the turn', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ invalidPromptResult: true });
    await session.submit(f.input('hello', id));
    await vi.waitFor(() => expect(f.output.exit).toHaveBeenCalledTimes(1));
    expect(f.events.some((event) => event.type === 'turn_started')).toBe(true);
    expect(f.events.some((event) => event.type === 'turn_completed')).toBe(false);
  });

  it('leaves an unaccepted prompt uncertain when Isles closes the session', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ holdTurn: true });
    const pending = session.submit(f.input('waiting', id)).catch((error: unknown) => error);
    await vi.waitFor(async () => expect(await f.frames('session/prompt')).toHaveLength(1));
    await session.close();
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HarnessSubmissionRejected);
    expect((error as Error).message).toContain('连接已关闭，输入结果待核对');
    expect(f.output.exit).not.toHaveBeenCalled();
  });

  it('turns form elicitations into Isles questions and returns the selected labels', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    const single = f.input('ask', id);
    await session.submit(single);
    await vi.waitFor(() => expect(f.questions).toHaveLength(1));
    expect(f.questions[0]).toMatchObject({
      sessionId: id,
      turnId: single.runId,
      questions: [
        {
          id: 'q0',
          header: 'Result',
          question: 'Which result?\nPick one',
          isOther: false,
          options: [
            { label: 'One', description: 'First result' },
            { label: 'Two', description: 'Second result' },
          ],
        },
      ],
    });
    session.answer(f.questions[0]!.requestId, { answers: { q0: { answers: ['Two'] } } });
    await f.completed(single.runId);
    expect(f.items().at(-1)?.text).toBe('Answer: {"action":"accept","content":{"q0":"Two"}}');
    const many = f.input('ask-many', id);
    await session.submit(many);
    await vi.waitFor(() => expect(f.questions).toHaveLength(2));
    expect(f.questions[1]!.questions.map((q) => [q.id, q.question, q.multiSelect])).toEqual([
      ['q0', 'Which result?', false],
      ['q1', 'Which extras?', true],
    ]);
    session.answer(f.questions[1]!.requestId, {
      answers: { q0: { answers: ['One'] }, q1: { answers: ['One', 'Two'] } },
    });
    await f.completed(many.runId);
    expect(f.items().at(-1)?.text).toBe(
      'Answer: {"action":"accept","content":{"q0":"One","q1":["One","Two"]}}',
    );
    const declined = f.input('ask', id);
    await session.submit(declined);
    await vi.waitFor(() => expect(f.questions).toHaveLength(3));
    session.rejectQuestion(f.questions[2]!.requestId, 'stale');
    await f.completed(declined.runId);
    expect(f.items().at(-1)?.text).toBe('Answer: {"action":"decline"}');
    expect(() =>
      session.answer(f.questions[2]!.requestId, { answers: { q0: { answers: ['One'] } } }),
    ).toThrow('原生问题已失效');
  });

  it('asks before native tool approval and leaves question fallbacks to the user', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    const tool = f.input('permission', id);
    await session.submit(tool);
    await vi.waitFor(() => expect(f.questions).toHaveLength(1));
    session.answer(f.questions[0]!.requestId, {
      answers: { permission: { answers: ['允许本次'] } },
    });
    await f.completed(tool.runId);
    expect(f.items().at(-1)?.text).toBe(
      'Permission: {"outcome":"selected","optionId":"approve_once"}',
    );
    const question = f.input('ask-permission', id);
    await session.submit(question);
    await f.completed(question.runId);
    expect(f.items().at(-1)?.text).toBe('Permission: {"outcome":"cancelled"}');
  });

  it('cancels the active turn, closes its open question and ignores output after the turn', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ lateAfterCancel: true });
    const asked = f.input('ask', id);
    await session.submit(asked);
    await vi.waitFor(() => expect(f.questions).toHaveLength(1));
    await session.interrupt(id, asked.runId);
    expect(await f.completed(asked.runId)).toMatchObject({ status: 'interrupted' });
    const responses = (await f.cli.records()).filter((frame) => frame.result !== undefined);
    expect(responses.at(-1)).toMatchObject({ result: { action: 'cancel' } });
    expect(await f.frames('session/cancel')).toMatchObject([{ params: { sessionId: id } }]);
    await f.cli.set({ chunkBeforeHold: true });
    const held = f.input('hold', id);
    await session.submit(held);
    await session.interrupt(id, held.runId);
    await f.completed(held.runId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.items().map((item) => item.text)).not.toContain('late after cancel');
  });

  it('falls back to session/load and does not record replayed history', async () => {
    const f = await fixture();
    const first = await f.created();
    await first.session.close();
    await f.cli.set({ noResume: true });
    const session = await f.connect();
    await session.resumeSession(first.id);
    expect(await f.frames('session/load')).toHaveLength(1);
    expect(f.events).toEqual([]);
  });

  it('requires HTTP MCP support before creating a session', async () => {
    const f = await fixture();
    await f.cli.set({ noHttpMcp: true });
    const session = await f.connect();
    await expect(session.createSession(() => {})).rejects.toThrow('未声明 HTTP MCP 支持');
    expect(await f.frames('session/new')).toEqual([]);
  });
});
