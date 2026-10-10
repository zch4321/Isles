import { ConfigManager } from '@isles/config';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KimiWebAdapter } from '../src/harness/kimi/web-adapter.js';
import { KimiWebEnvironment } from '../src/harness/kimi/web-environment.js';
import {
  HarnessSubmissionRejected,
  type HarnessEvent,
  type HarnessHandlers,
  type HarnessQuestion,
} from '../src/harness/types.js';
import { AgentWorkspace } from '../src/runtime/workspace.js';
import type { AgentRecord } from '../src/storage/store.js';
import { kimiWebFixture } from './kimi-web-fixture.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture(agentSettings: Partial<AgentRecord> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'isles-kimi-web-adapter-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cli = await kimiWebFixture(root);
  const config = new ConfigManager({
    configFilePath: join(root, 'config.toml'),
    homeDir: root,
    environment: { ISLES_KIMI_BIN: cli.binary, ISLES_KIMI_HOME: cli.home },
  });
  const workspace = new AgentWorkspace(config);
  const adapter = new KimiWebAdapter(new KimiWebEnvironment(config, workspace));
  const agent: AgentRecord = {
    id: randomUUID(),
    channelId: randomUUID(),
    name: 'Kimi Web fixture',
    harness: 'kimi',
    model: 'kimi-code/k3',
    reasoningEffort: 'high',
    workspace: join(root, 'workspace'),
    nativeHome: cli.home,
    threadId: null,
    threadCreationAttempted: false,
    canCreateGroups: false,
    steerEnabled: true,
    desiredState: 'running',
    status: 'creating',
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...agentSettings,
  };
  const events: HarnessEvent[] = [];
  const questions: HarnessQuestion[] = [];
  const handlers: HarnessHandlers = {
    connected: vi.fn(),
    event: (event) => events.push(event),
    question: (question) => questions.push(question),
    exit: vi.fn(),
  };
  const connect = async () => {
    const session = await adapter.connect(agent, 'http://127.0.0.1:4310', handlers);
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
  const nativeId = (id: string) => `isles-${agent.id}-${id}`;
  const requests = async (tail: string, method = 'POST') =>
    (await cli.records()).filter(
      (record) => record.type === 'http' && record.method === method && record.path?.endsWith(tail),
    );
  const completed = (turnId: string) =>
    vi.waitFor(() => {
      const event = events.find(
        (event) => event.type === 'turn_completed' && event.turnId === turnId,
      );
      if (!event) throw new Error('Turn still running');
      return event;
    });
  const items = () => {
    const result = new Map<string, { type: string; status: string; text: string }>();
    for (const event of events)
      if (event.type === 'item') {
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
    nativeId,
    root,
    cli,
    config,
    workspace,
    adapter,
    agent,
    events,
    questions,
    handlers,
    connect,
    created,
    input,
    requests,
    completed,
    items,
  };
}

describe('Kimi Code local Web adapter', () => {
  it('reads thinking metadata and auth without creating a native session or changing global settings', async () => {
    const f = await fixture();
    const nativeConfig = 'default_model = "kimi-code/k3"\n';
    const globalMcp = '{"mcpServers":{"personal":{"command":"personal-tool"}}}\n';
    await writeFile(join(f.cli.home, 'config.toml'), nativeConfig);
    await writeFile(join(f.cli.home, 'mcp.json'), globalMcp);
    expect(await f.adapter.catalog.status()).toMatchObject({
      available: true,
      authenticated: true,
      version: '2.1.1',
      binaryPath: f.cli.binary,
    });
    expect(await f.adapter.catalog.models()).toMatchObject([
      {
        model: 'kimi-code/k3',
        supportedReasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'max',
        isDefault: true,
      },
      {
        model: 'kimi-code/fast',
        supportedReasoningEfforts: ['default'],
        defaultReasoningEffort: 'default',
        isDefault: false,
      },
    ]);
    expect(await f.requests('/sessions')).toEqual([]);
    expect(await f.requests('/prompts')).toEqual([]);
    expect(
      (await f.cli.records()).filter((record) => record.method && record.method !== 'GET'),
    ).toEqual([]);
    expect(await readFile(join(f.cli.home, 'config.toml'), 'utf8')).toBe(nativeConfig);
    expect(await readFile(join(f.cli.home, 'mcp.json'), 'utf8')).toBe(globalMcp);
    await f.cli.set({ unauthenticated: true });
    f.adapter.invalidate();
    expect(await f.adapter.catalog.status()).toMatchObject({
      available: true,
      authenticated: false,
      error: expect.stringContaining('尚未登录'),
    });
    expect(await f.adapter.catalog.models()).toEqual([]);
  });

  it('persists a new ID before settings, binds cwd and preserves other workspace MCP entries', async () => {
    const f = await fixture();
    const dir = join(f.agent.workspace, '.kimi-code');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'mcp.json'),
      JSON.stringify({
        label: 'personal',
        mcpServers: { personal: { command: 'own-tool' }, isles: { url: 'old-url' } },
      }),
    );
    const session = await f.connect();
    const saved: string[] = [];
    const id = await session.createSession((value) => saved.push(value));
    expect(saved).toEqual([id]);
    expect(id).toMatch(/^session_/);
    expect((await f.cli.records()).find((record) => record.type === 'launch')).toMatchObject({
      args: ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
      cwd: await realpath(f.agent.workspace),
      home: f.cli.home,
      hasToken: true,
    });
    expect((await f.requests('/sessions'))[0]).toMatchObject({
      body: { metadata: { cwd: f.agent.workspace } },
    });
    expect((await f.requests('/profile'))[0]).toMatchObject({
      body: { agent_config: { model: 'kimi-code/k3', thinking: 'high', permission_mode: 'yolo' } },
    });
    expect(JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))).toEqual({
      label: 'personal',
      mcpServers: {
        personal: { command: 'own-tool' },
        isles: {
          url: `http://127.0.0.1:4310/mcp/${f.agent.id}`,
          bearerTokenEnvVar: 'ISLES_KIMI_MCP_TOKEN',
        },
      },
    });
    expect((await f.cli.records()).filter((record) => record.type === 'ws')).toMatchObject([
      { frame: { type: 'subscribe', payload: { session_ids: [id] } } },
    ]);
    expect(await f.requests('/prompts')).toEqual([]);
    expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([]);
  });

  it('keeps the created ID when native thinking is unsupported and omits only default selections', async () => {
    const f = await fixture({ model: 'kimi-code/fast', reasoningEffort: 'high' });
    const session = await f.connect();
    const saved: string[] = [];
    await expect(session.createSession((id) => saved.push(id))).rejects.toThrow(
      'Unsupported model or thinking',
    );
    expect(saved).toEqual([expect.stringMatching(/^session_/)]);
    expect(await f.requests('/sessions')).toHaveLength(1);
    expect(await f.requests('/prompts')).toEqual([]);
    await session.close();
    const defaults = await fixture({ model: 'default', reasoningEffort: 'default' });
    await defaults.created();
    expect((await defaults.requests('/profile'))[0]!.body).toEqual({
      agent_config: { permission_mode: 'yolo' },
    });
  });

  it('rejects input for a different session or configuration before native submission', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    const input = f.input('invalid binding', id);
    for (const invalid of [
      { sessionId: 'other-session' },
      { model: 'other-model' },
      { reasoningEffort: 'low' },
      { workspace: f.root },
    ]) {
      await expect(session.submit({ ...input, ...invalid })).rejects.toBeInstanceOf(
        HarnessSubmissionRejected,
      );
    }
    expect(await f.requests('/prompts')).toEqual([]);
    expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([]);
  });

  it('answers native heartbeat pings while keeping control frames out of run events', async () => {
    const f = await fixture();
    await f.cli.set({ heartbeatMs: 40, manualOutput: true });
    const { session, id } = await f.created();
    await vi.waitFor(async () =>
      expect(
        (await f.cli.records()).filter(
          (record) => record.type === 'ws' && record.frame?.type === 'pong',
        ).length,
      ).toBeGreaterThanOrEqual(3),
    );
    expect(f.handlers.exit).not.toHaveBeenCalled();
    expect(f.events.filter((event) => event.type !== 'context_usage')).toEqual([]);
    const result = await session.submit(f.input('after heartbeat', id));
    await f.cli.finish(id);
    expect(await f.completed(result.turnId)).toMatchObject({ status: 'completed' });
    expect(f.handlers.exit).not.toHaveBeenCalled();
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
  });

  it('does not construct or launch a native client after stop during executable discovery', async () => {
    const f = await fixture();
    const command = await f.adapter.environment.executable();
    let release: (value: typeof command) => void = () => {};
    const discovery = new Promise<typeof command>((resolve) => {
      release = resolve;
    });
    const executable = vi.spyOn(f.adapter.environment, 'executable').mockReturnValue(discovery);
    const factory = vi.fn(() => {
      throw new Error('Native client must not be constructed after stop');
    });
    const adapter = new KimiWebAdapter(f.adapter.environment, undefined, factory);
    const pending = adapter.connect(f.agent, 'http://127.0.0.1:4310', f.handlers);
    void pending.catch(() => {});
    await vi.waitFor(() => expect(executable).toHaveBeenCalled());
    const published = vi.mocked(f.handlers.connected).mock.calls[0]![0];
    await published.close();
    release(command);
    await expect(pending).rejects.toThrow('停止');
    expect(factory).not.toHaveBeenCalled();
    expect((await f.cli.records()).filter((record) => record.type === 'launch')).toEqual([]);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('resumes the same session after restart, reapplies profile and keeps history out of a new run', async () => {
    const f = await fixture();
    const first = await f.created();
    const input = f.input('hello', first.id);
    const turn = await first.session.submit(input);
    await f.completed(turn.turnId);
    await first.session.close();
    const before = f.events.filter((event) => event.type === 'turn_started').length;
    const session = await f.connect();
    expect(await session.resumeSession(first.id)).toBe(first.id);
    expect(await f.requests('/sessions')).toHaveLength(1);
    expect(await f.requests('/profile')).toHaveLength(2);
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(before);
    const next = await session.submit(f.input('after restart', first.id));
    await f.completed(next.turnId);
    expect((await f.requests('/prompts')).map((record) => record.path)).toEqual([
      `/api/v1/sessions/${first.id}/prompts`,
      `/api/v1/sessions/${first.id}/prompts`,
    ]);
  });

  it('reports an unknown session without creating a replacement', async () => {
    const f = await fixture();
    const session = await f.connect();
    await expect(session.resumeSession('session_missing')).rejects.toThrow();
    expect(await f.requests('/sessions')).toEqual([]);
    expect(await f.requests('/prompts')).toEqual([]);
  });

  it('uses runId as a stable prompt ID and waits for consumption rather than a queued receipt', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ holdAdmission: true, manualOutput: true });
    const input = f.input('waiting', id);
    let accepted = false;
    const submission = session.submit(input).then((result) => {
      accepted = true;
      return result;
    });
    void submission.catch(() => {});
    await vi.waitFor(async () => expect(await f.requests('/prompts')).toHaveLength(1));
    expect((await f.requests('/prompts'))[0]).toMatchObject({
      body: {
        prompt_id: f.nativeId(input.runId),
        content: [{ type: 'text', text: 'waiting' }],
        model: input.model,
        thinking: input.reasoningEffort,
        permission_mode: 'yolo',
      },
    });
    expect(accepted).toBe(false);
    expect(f.events.some((event) => event.type === 'turn_started')).toBe(false);
    await f.cli.begin(id, f.nativeId(input.runId));
    expect(await submission).toEqual({ turnId: '1' });
    await f.cli.finish(id);
    await f.completed('1');
  });

  it('projects text, reasoning, tools and usage while isolating native child turns', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ manualOutput: true });
    const { turnId } = await session.submit(f.input('details', id));
    await f.cli.emit(id, 'thinking.delta', { turnId: 1, delta: 'Think ' });
    await f.cli.emit(id, 'thinking.delta', { turnId: 1, delta: 'carefully' });
    await f.cli.emit(id, 'assistant.delta', { turnId: 1, delta: 'Hello ' });
    await f.cli.emit(id, 'assistant.delta', { turnId: 1, delta: 'world' });
    await f.cli.emit(id, 'tool.call.started', {
      turnId: 1,
      toolCallId: 'shell-1',
      name: 'Shell',
      args: { command: 'echo hi' },
      display: { kind: 'command', command: 'echo hi' },
    });
    await f.cli.emit(id, 'tool.progress', {
      turnId: 1,
      toolCallId: 'shell-1',
      update: { kind: 'stdout', text: 'hi' },
    });
    await f.cli.emit(id, 'tool.result', {
      turnId: 1,
      toolCallId: 'shell-1',
      output: 'hi',
      isError: false,
    });
    await f.cli.emit(id, 'subagent.spawned', {
      subagentId: 'child',
      subagentName: 'Research',
      parentToolCallId: 'dispatch',
      runInBackground: false,
    });
    await f.cli.emit(id, 'turn.started', {
      agentId: 'child',
      turnId: 99,
      promptId: 'child-prompt',
      origin: { kind: 'user' },
    });
    await f.cli.emit(id, 'assistant.delta', {
      agentId: 'child',
      turnId: 99,
      delta: 'Child result',
    });
    await f.cli.emit(id, 'turn.ended', { agentId: 'child', turnId: 99, reason: 'completed' });
    await f.cli.emit(id, 'agent.status.updated', {
      agentId: 'child',
      contextTokens: 99999,
      maxContextTokens: 100000,
    });
    await f.cli.emit(id, 'agent.status.updated', {
      contextTokens: 12345,
      maxContextTokens: 262144,
    });
    await vi.waitFor(() =>
      expect(f.items()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'reasoning', text: 'Think carefully' }),
          expect.objectContaining({ type: 'agentMessage', text: 'Hello world' }),
          expect.objectContaining({
            type: 'toolCall',
            status: 'completed',
            text: expect.stringContaining('hi'),
          }),
          expect.objectContaining({ text: expect.stringContaining('Child result') }),
        ]),
      ),
    );
    expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([
      { type: 'turn_started', sessionId: id, turnId },
    ]);
    expect(f.events.filter((event) => event.type === 'turn_completed')).toEqual([]);
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.type === 'context_usage').at(-1)).toEqual({
        type: 'context_usage',
        sessionId: id,
        usage: { usedTokens: 12345, maxTokens: 262144, estimated: true },
      }),
    );
    expect(
      f.events
        .filter((event) => event.type === 'context_usage')
        .some((event) => event.usage?.usedTokens === 99999),
    ).toBe(false);
    expect(
      f.events
        .filter((event) => event.type === 'item')
        .every((event) => event.turnId === turnId && event.sessionId === id),
    ).toBe(true);
    await f.cli.finish(id);
    expect(await f.completed(turnId)).toMatchObject({ status: 'completed' });
  });

  it('deduplicates volatile offsets before switching channels and resets both channels for each step', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ manualOutput: true });
    const { turnId } = await session.submit(f.input('offsets', id));
    await f.cli.emit(id, 'turn.step.started', { turnId: 1, step: 1 });
    await f.cli.emit(
      id,
      'thinking.delta',
      { turnId: 1, delta: 'Think' },
      { volatile: true, offset: 0 },
    );
    await f.cli.emit(
      id,
      'assistant.delta',
      { turnId: 1, delta: 'Hello' },
      { volatile: true, offset: 0 },
    );
    await f.cli.emit(
      id,
      'thinking.delta',
      { turnId: 1, delta: 'Think' },
      { volatile: true, offset: 0 },
    );
    await f.cli.emit(
      id,
      'assistant.delta',
      { turnId: 1, delta: ' world' },
      { volatile: true, offset: 5 },
    );
    await f.cli.emit(id, 'turn.step.started', { turnId: 1, step: 2 });
    await f.cli.emit(
      id,
      'thinking.delta',
      { turnId: 1, delta: 'Again' },
      { volatile: true, offset: 0 },
    );
    await f.cli.emit(
      id,
      'assistant.delta',
      { turnId: 1, delta: 'Final' },
      { volatile: true, offset: 0 },
    );
    await f.cli.finish(id);
    await f.completed(turnId);
    expect(f.items()).toEqual([
      { type: 'reasoning', status: 'completed', text: 'Think' },
      { type: 'agentMessage', status: 'completed', text: 'Hello world' },
      { type: 'reasoning', status: 'completed', text: 'Again' },
      { type: 'agentMessage', status: 'completed', text: 'Final' },
    ]);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('distinguishes definite refusal from transport loss before native acceptance', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ rejectPrompt: true });
    await expect(session.submit(f.input('refused', id))).rejects.toBeInstanceOf(
      HarnessSubmissionRejected,
    );
    expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([]);
    await f.cli.set({ loseBeforeAcceptance: true });
    await expect(session.submit(f.input('lost', id))).rejects.not.toBeInstanceOf(
      HarnessSubmissionRejected,
    );
    expect(f.handlers.exit).toHaveBeenCalledTimes(1);
    expect(f.events.filter((event) => event.type === 'turn_completed')).toEqual([]);
  });

  it('keeps a proven start accepted if the HTTP response fails later and reports stream loss once', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ loseAfterAcceptance: true });
    await expect(session.submit(f.input('accepted', id))).resolves.toEqual({ turnId: '1' });
    await vi.waitFor(() => expect(f.handlers.exit).toHaveBeenCalledTimes(1));
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
    expect(f.events.filter((event) => event.type === 'turn_completed')).toEqual([]);
  });

  it('treats an unconsumed receipt with a different prompt ID as uncertain', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ holdAdmission: true, invalidReceipt: true });
    const input = f.input('invalid identity', id);
    await expect(session.submit(input)).rejects.not.toBeInstanceOf(HarnessSubmissionRejected);
    await session.close();
    expect(f.handlers.exit).toHaveBeenCalledTimes(1);
    expect(await f.requests(`/${f.nativeId(input.runId)}:abort`)).toHaveLength(1);
    expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([]);
  });

  it('steers one batch into the same turn and refuses stale or idle targets without another post', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ holdTurn: true, manualOutput: true });
    const { turnId } = await session.submit(f.input('active', id));
    const steering = {
      sessionId: id,
      expectedTurnId: turnId,
      batchId: randomUUID(),
      text: 'append',
    };
    expect(await session.steer!(steering)).toEqual({ turnId });
    expect(await f.requests('/prompts')).toHaveLength(2);
    expect((await f.requests('/prompts'))[1]).toMatchObject({
      body: {
        prompt_id: f.nativeId(steering.batchId),
        content: [{ type: 'text', text: steering.text }],
      },
    });
    expect(await f.requests(`/${f.nativeId(steering.batchId)}:steer`)).toHaveLength(1);
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
    await expect(
      session.steer!({ ...steering, batchId: randomUUID(), expectedTurnId: 'other' }),
    ).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    await f.cli.finish(id);
    await f.completed(turnId);
    await expect(session.steer!({ ...steering, batchId: randomUUID() })).rejects.toBeInstanceOf(
      HarnessSubmissionRejected,
    );
    expect(await f.requests('/prompts')).toHaveLength(2);
  });

  it('withdraws an admitted batch on boundary uncertainty and never redelivers it', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ manualOutput: true, boundaryOnSteer: true });
    const { turnId } = await session.submit(f.input('active', id));
    const batchId = randomUUID();
    await expect(
      session.steer!({ sessionId: id, expectedTurnId: turnId, batchId, text: 'late batch' }),
    ).rejects.not.toBeInstanceOf(HarnessSubmissionRejected);
    await session.close();
    expect(f.handlers.exit).toHaveBeenCalledTimes(1);
    expect(await f.requests(`/${f.nativeId(batchId)}:abort`)).toHaveLength(1);
    expect(
      (await f.requests('/prompts')).filter(
        (record) => record.body?.prompt_id === f.nativeId(batchId),
      ),
    ).toHaveLength(1);
    await f.cli.set({ manualOutput: true });
    const resumed = await f.connect();
    expect(await resumed.resumeSession(id)).toBe(id);
    const after = await resumed.submit(f.input('next run', id));
    await f.cli.finish(id);
    await f.completed(after.turnId);
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(2);
  });

  it('maps native single and multiple choices to option IDs, with dismiss and interrupt cancellation', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    const first = await session.submit(f.input('ask', id));
    await vi.waitFor(() => expect(f.questions).toHaveLength(1));
    expect(f.questions[0]).toMatchObject({
      sessionId: id,
      turnId: first.turnId,
      questions: [
        {
          id: 'q0',
          question: 'Which result?',
          isOther: true,
          options: [{ label: 'One' }, { label: 'Two' }],
        },
      ],
    });
    session.answer(f.questions[0]!.requestId, { answers: { q0: { answers: ['Two'] } } });
    await f.completed(first.turnId);
    expect((await f.requests(`/questions/${f.questions[0]!.requestId}`))[0]).toMatchObject({
      body: { answers: { q0: { kind: 'single', option_id: 'two' } } },
    });
    const many = await session.submit(f.input('ask-many', id));
    await vi.waitFor(() => expect(f.questions).toHaveLength(2));
    expect(f.questions[1]!.questions.map((question) => question.multiSelect)).toEqual([
      false,
      true,
    ]);
    session.answer(f.questions[1]!.requestId, {
      answers: { q0: { answers: ['One'] }, q1: { answers: ['One', 'Two'] } },
    });
    await f.completed(many.turnId);
    expect((await f.requests(`/questions/${f.questions[1]!.requestId}`))[0]).toMatchObject({
      body: {
        answers: {
          q0: { kind: 'single', option_id: 'one' },
          q1: { kind: 'multi', option_ids: ['one', 'two'] },
        },
      },
    });
    const cancelled = await session.submit(f.input('ask', id));
    await vi.waitFor(() => expect(f.questions).toHaveLength(3));
    await session.interrupt(id, cancelled.turnId);
    expect(await f.completed(cancelled.turnId)).toMatchObject({ status: 'interrupted' });
    expect(await f.requests(`/questions/${f.questions[2]!.requestId}:dismiss`)).toHaveLength(1);
    expect(() =>
      session.answer(f.questions[2]!.requestId, { answers: { q0: { answers: ['One'] } } }),
    ).toThrow();
  });

  it('withdraws its unconsumed prompt on stop and resumes without consuming it', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ holdAdmission: true });
    const input = f.input('unconsumed', id);
    const pending = session.submit(input);
    void pending.catch(() => {});
    await vi.waitFor(async () => expect(await f.requests('/prompts')).toHaveLength(1));
    await session.close();
    await expect(pending).rejects.not.toBeInstanceOf(HarnessSubmissionRejected);
    expect(await f.requests(`/${f.nativeId(input.runId)}:abort`)).toHaveLength(1);
    expect(f.handlers.exit).not.toHaveBeenCalled();
    await f.cli.set({});
    const resumed = await f.connect();
    expect(await resumed.resumeSession(id)).toBe(id);
    const result = await resumed.submit(f.input('new input', id));
    await f.completed(result.turnId);
    expect(
      (await f.requests('/prompts')).filter(
        (record) => record.body?.prompt_id === f.nativeId(input.runId),
      ),
    ).toHaveLength(1);
  });

  it('cancels leftover owned prompts on restart and binds the original session', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await session.close();
    const storedPath = join(f.cli.home, 'sessions', `${id}.json`);
    const stored = JSON.parse(await readFile(storedPath, 'utf8')) as { queue: unknown[] };
    const leftoverId = f.nativeId(randomUUID());
    stored.queue = [
      {
        prompt_id: leftoverId,
        user_message_id: 'message-leftover',
        status: 'queued',
        content: [{ type: 'text', text: 'leftover' }],
        created_at: new Date().toISOString(),
      },
    ];
    await writeFile(storedPath, JSON.stringify(stored));
    const resumed = await f.connect();
    expect(await resumed.resumeSession(id)).toBe(id);
    expect(await f.requests(`/${leftoverId}:abort`)).toHaveLength(1);
    expect(await f.requests('/sessions')).toHaveLength(1);
    expect(await f.requests('/prompts')).toEqual([]);
    expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([]);
    const turn = await resumed.submit(f.input('fresh', id));
    await f.completed(turn.turnId);
    expect(await f.requests('/prompts')).toHaveLength(1);
  });

  it('recovers owned queued inputs after a restart while preserving foreign pending prompts', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await session.close();
    const storedPath = join(f.cli.home, 'sessions', `${id}.json`);
    const stored = JSON.parse(await readFile(storedPath, 'utf8')) as { queue: unknown[] };
    const ownedId = f.nativeId(randomUUID());
    const foreignId = 'human-prompt';
    const prompt = (prompt_id: string, metadata: Record<string, unknown>) => ({
      prompt_id,
      user_message_id: `message-${prompt_id}`,
      status: 'queued',
      content: [{ type: 'text', text: prompt_id }],
      created_at: new Date().toISOString(),
      metadata,
    });
    stored.queue = [prompt(ownedId, { isles_agent_id: f.agent.id }), prompt(foreignId, {})];
    await writeFile(storedPath, JSON.stringify(stored));
    const restarted = await f.connect();
    await expect(restarted.resumeSession(id)).rejects.toThrow();
    expect(await f.requests(`/${ownedId}:abort`)).toHaveLength(1);
    expect(await f.requests(`/${foreignId}:abort`)).toEqual([]);
    expect(await f.requests('/sessions')).toHaveLength(1);
    expect(await f.requests('/prompts')).toEqual([]);
  });
});
