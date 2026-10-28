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
    workspacePaths: [],
    nativeHome: cli.home,
    threadId: null,
    threadCreationAttempted: false,
    canCreateGroups: false,
    dangerFullAccess: false,
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
  it('expires a native tool approval resolved elsewhere without sending a second reply', async () => {
    const f = await fixture();
    await f.cli.set({ manualOutput: true, holdTurn: true });
    const { session, id } = await f.created();
    const { turnId } = await session.submit(f.input('permission', id));
    await f.cli.emit(id, 'event.approval.requested', {
      turnId: Number(turnId),
      approval_id: 'external-tool',
      tool_name: 'Bash',
      action: 'Run fixture',
      tool_input_display: { kind: 'command', command: 'echo fixture' },
    });
    await vi.waitFor(() => expect(f.questions).toHaveLength(1));
    await f.cli.emit(id, 'event.approval.resolved', {
      turnId: Number(turnId),
      approval_id: 'external-tool',
      decision: 'rejected',
    });
    await vi.waitFor(() =>
      expect(f.events).toContainEqual({
        type: 'question_expired',
        sessionId: id,
        turnId,
        requestId: 'approval:external-tool',
      }),
    );
    expect(() =>
      session.answer('approval:external-tool', {
        answers: { permission: { answers: ['允许本次'] } },
      }),
    ).toThrow('已失效');
    expect(await f.requests('/approvals/external-tool')).toHaveLength(0);
  });
  it('registers all additional context without persistence before cold snapshot and keeps yolo after full access', async () => {
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
    expect((await f.requests('/profile')).at(-1)?.body).toMatchObject({
      agent_config: { permission_mode: 'yolo' },
    });
    await first.session.close();
    f.agent.dangerFullAccess = false;
    const restored = await f.connect();
    await restored.resumeSession(first.id);
    expect((await f.requests('/profile')).at(-1)?.body).toMatchObject({
      agent_config: { permission_mode: 'yolo' },
    });
    const records = await f.cli.records();
    const adds = records.filter((record) => record.path?.endsWith('/add-dir'));
    expect(adds.map((record) => record.body)).toEqual(
      [...workspacePaths, ...workspacePaths].map((path) => ({ path, persist: false })),
    );
    const registrations = records.filter((record) => record.path === '/api/v1/workspaces');
    expect(registrations.map((record) => record.body)).toEqual([
      { root: f.agent.workspace },
      { root: f.agent.workspace },
    ]);
    expect(records.indexOf(adds[0]!)).toBeLessThan(
      records.findIndex((record) => record.path?.endsWith('/snapshot')),
    );
  });

  it.each(['允许本次', '拒绝'])(
    'forwards native tool approval %s without adding session rules',
    async (decision) => {
      const f = await fixture();
      await f.cli.set({ manualOutput: true, holdTurn: true });
      const { session, id } = await f.created();
      const { turnId } = await session.submit(f.input('permission', id));
      await f.cli.emit(id, 'event.approval.requested', {
        turnId: Number(turnId),
        approval_id: 'native-tool',
        tool_name: 'Bash',
        action: 'Run fixture',
        tool_input_display: { kind: 'command', command: 'echo fixture' },
      });
      await vi.waitFor(() => expect(f.questions).toHaveLength(1));
      expect(await f.requests('/approvals/native-tool')).toHaveLength(0);
      session.answer(f.questions[0]!.requestId, {
        answers: { permission: { answers: [decision] } },
      });
      await vi.waitFor(async () =>
        expect((await f.requests('/approvals/native-tool'))[0]?.body).toEqual({
          decision: decision === '允许本次' ? 'approved' : 'rejected',
        }),
      );
      expect(() =>
        session.answer(f.questions[0]!.requestId, {
          answers: { permission: { answers: ['允许本次'] } },
        }),
      ).toThrow('已失效');
    },
  );

  it('reads thinking metadata and auth without creating a native session or changing global settings', async () => {
    const f = await fixture();
    const nativeConfig = 'default_model = "kimi-code/k3"\n';
    const globalMcp = '{"mcpServers":{"personal":{"command":"personal-tool"}}}\n';
    await writeFile(join(f.cli.home, 'config.toml'), nativeConfig);
    await writeFile(join(f.cli.home, 'mcp.json'), globalMcp);
    expect(await f.adapter.catalog.status()).toMatchObject({
      available: true,
      authenticated: true,
      version: '2.3.1',
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
      body: {
        agent_config: { model: 'kimi-code/k3', thinking: 'high', permission_mode: 'yolo' },
      },
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
    await f.cli.emit(id, 'assistant.delta', {
      agentId: 'child',
      turnId: 99,
      delta: ' continued',
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
      { type: 'turn_started', sessionId: `${id}/agents/child`, turnId: '99' },
    ]);
    expect(f.events.filter((event) => event.type === 'turn_completed')).toEqual([
      {
        type: 'turn_completed',
        sessionId: `${id}/agents/child`,
        turnId: '99',
        status: 'completed',
        error: null,
      },
    ]);
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
      f.events.every((event) => {
        if (event.type !== 'item' && event.type !== 'item_delta') return true;
        return (
          (event.turnId === turnId && event.sessionId === id) ||
          (event.turnId === '99' && event.sessionId === `${id}/agents/child`)
        );
      }),
    ).toBe(true);
    const childDeltas = f.events.filter(
      (event) => event.type === 'item_delta' && event.item.id.startsWith('child:99:'),
    );
    expect(childDeltas).toMatchObject([
      { append: false, item: { text: '子代理 Research (child)\nChild result' } },
      { append: true, item: { text: ' continued' } },
    ]);
    await f.cli.finish(id);
    expect(await f.completed(turnId)).toMatchObject({ status: 'completed' });
  });

  it('isolates text chunks and tool progress from discrete items while completing full segments', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ manualOutput: true });
    const { turnId } = await session.submit(f.input('many chunks', id));
    const chunks = Array.from({ length: 200 }, (_, index) => `${index},${'x'.repeat(400)}`);
    await f.cli.emitBatch(
      id,
      chunks.map((delta) => ({
        type: 'assistant.delta',
        fields: { turnId: 1, delta },
      })),
    );
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.type === 'item_delta')).toHaveLength(200),
    );
    expect(f.events.filter((event) => event.type === 'item')).toEqual([]);
    const deltas = f.events.filter(
      (event): event is Extract<HarnessEvent, { type: 'item' | 'item_delta' }> =>
        event.type === 'item_delta',
    );
    expect(deltas.map((event) => event.item.text)).toEqual(chunks);
    expect(deltas.map((event) => event.append)).toEqual([
      false,
      ...chunks.slice(1).map(() => true),
    ]);
    await f.cli.emit(id, 'tool.call.started', {
      turnId: 1,
      toolCallId: 'mcp-1',
      name: 'mcp__isles__read',
      args: { id: 'x' },
    });
    await f.cli.emitBatch(id, [
      ...chunks.map((text) => ({
        type: 'tool.progress',
        fields: {
          turnId: 1,
          toolCallId: 'mcp-1',
          update: { kind: 'stdout', text },
        },
      })),
      {
        type: 'tool.progress',
        fields: {
          turnId: 1,
          toolCallId: 'mcp-1',
          update: { kind: 'status', count: 20 },
        },
      },
      {
        type: 'tool.progress',
        fields: {
          turnId: 1,
          toolCallId: 'mcp-1',
          update: { text: 'replacement', replace: true },
        },
      },
    ]);
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.type === 'item_delta')).toHaveLength(401),
    );
    expect(f.events.filter((event) => event.type === 'item')).toHaveLength(2);
    const progress = f.events.filter(
      (event) => event.type === 'item_delta' && event.item.type === 'mcpToolCall',
    );
    expect(progress[0]).toMatchObject({ append: true, item: { text: `\n${chunks[0]}` } });
    expect(progress[1]).toMatchObject({ append: true, item: { text: chunks[1] } });
    expect(progress.at(-1)).toMatchObject({
      append: false,
      item: { text: 'mcp__isles__read\n{"id":"x"}\nreplacement' },
    });
    await f.cli.emit(id, 'tool.result', {
      turnId: 1,
      toolCallId: 'mcp-1',
      output: 'final result',
      isError: false,
    });
    await f.cli.finish(id);
    await f.completed(turnId);
    expect(f.events.filter((event) => event.type === 'item')).toHaveLength(3);
    expect(f.items()).toEqual([
      { type: 'agentMessage', status: 'completed', text: chunks.join('') },
      {
        type: 'mcpToolCall',
        status: 'completed',
        text: 'mcp__isles__read\n{"id":"x"}\nfinal result',
      },
    ]);
  });

  it('keeps channel switches and tool progress transient until a real lifecycle boundary', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ manualOutput: true });
    const { turnId } = await session.submit(f.input('alternate channels', id));
    const statusCount = (await f.requests('/status', 'GET')).length;
    const snapshotCount = (await f.requests('/snapshot', 'GET')).length;
    await f.cli.emitBatch(id, [
      { type: 'thinking.delta', fields: { turnId: 1, delta: 'Thought' } },
      { type: 'assistant.delta', fields: { turnId: 1, delta: 'Answer' } },
      { type: 'thinking.delta', fields: { turnId: 1, delta: 'Thought again' } },
    ]);
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.type === 'item_delta')).toHaveLength(5),
    );
    await f.cli.emit(id, 'tool.progress', {
      turnId: 1,
      toolCallId: 'progress-1',
      update: { kind: 'status', count: 20 },
    });
    await f.cli.emitBatch(id, [
      { type: 'thinking.delta', fields: { turnId: 1, delta: ' appended' } },
      {
        type: 'tool.progress',
        fields: { turnId: 1, toolCallId: 'progress-1', update: { text: 'progress text' } },
      },
      { type: 'assistant.delta', fields: { turnId: 1, delta: 'Final answer' } },
    ]);
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.type === 'item_delta')).toHaveLength(9),
    );
    expect(f.events.filter((event) => event.type === 'item')).toEqual([]);
    expect(f.items()).toEqual([
      { type: 'reasoning', status: 'completed', text: 'Thought' },
      { type: 'agentMessage', status: 'completed', text: 'Answer' },
      { type: 'reasoning', status: 'completed', text: 'Thought again appended' },
      { type: 'toolCall', status: 'running', text: 'progress-1\n\nprogress text' },
      { type: 'agentMessage', status: 'running', text: 'Final answer' },
    ]);
    expect(await f.requests('/status', 'GET')).toHaveLength(statusCount);
    expect(await f.requests('/snapshot', 'GET')).toHaveLength(snapshotCount);
    await f.cli.emit(id, 'tool.result', {
      turnId: 1,
      toolCallId: 'progress-1',
      output: 'done',
      isError: false,
    });
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.type === 'item')).toHaveLength(2),
    );
    await f.cli.finish(id);
    await f.completed(turnId);
    expect(f.items().every((item) => item.status === 'completed')).toBe(true);
  });

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'interrupted'],
  ] as const)(
    'preserves partial main and child text when a native turn is %s',
    async (reason, status) => {
      const f = await fixture();
      const { session, id } = await f.created();
      await f.cli.set({ manualOutput: true });
      const { turnId } = await session.submit(f.input('partial termination', id));
      await f.cli.emit(id, 'subagent.spawned', {
        subagentId: 'child',
        subagentName: 'Partial',
        parentToolCallId: 'dispatch',
        runInBackground: false,
      });
      await f.cli.emitBatch(id, [
        {
          type: 'turn.started',
          fields: { agentId: 'child', turnId: 99, promptId: 'partial-child' },
        },
        { type: 'thinking.delta', fields: { turnId: 1, delta: 'Completed thought' } },
        { type: 'assistant.delta', fields: { turnId: 1, delta: 'Partial ' } },
        { type: 'assistant.delta', fields: { turnId: 1, delta: 'main text' } },
        {
          type: 'assistant.delta',
          fields: { agentId: 'child', turnId: 99, delta: 'Partial child text' },
        },
        { type: 'turn.ended', fields: { agentId: 'child', turnId: 99, reason } },
      ]);
      await f.cli.finish(id, reason);
      expect(await f.completed(turnId)).toMatchObject({ status });
      expect(f.items()).toEqual(
        expect.arrayContaining([
          { type: 'reasoning', status: 'completed', text: 'Completed thought' },
          { type: 'agentMessage', status, text: 'Partial main text' },
          { type: 'agentMessage', status, text: '子代理 Partial (child)\nPartial child text' },
        ]),
      );
    },
  );

  it('reports main native status while idle without fetching snapshots or status', async () => {
    const f = await fixture({ model: 'default', reasoningEffort: 'default' });
    const { id } = await f.created();
    const statusCount = (await f.requests('/status', 'GET')).length;
    const snapshotCount = (await f.requests('/snapshot', 'GET')).length;
    await f.cli.emitBatch(id, [
      {
        type: 'agent.status.updated',
        fields: { contextTokens: 77, maxContextTokens: 999999, model: 'kimi-code/fast' },
      },
      {
        type: 'agent.status.updated',
        fields: { contextTokens: 77, maxContextTokens: 999999 },
      },
      {
        type: 'agent.status.updated',
        fields: { contextTokens: 77, maxContextTokens: 999999, model: 'kimi-code/fast' },
      },
      {
        type: 'agent.status.updated',
        fields: { agentId: 'child', contextTokens: 88888, maxContextTokens: 99999 },
      },
      {
        type: 'agent.status.updated',
        fields: { contextTokens: 88, maxContextTokens: 123456, model: 'native-other-model' },
      },
    ]);
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.type === 'context_usage').at(-1)).toMatchObject({
        usage: { usedTokens: 88, maxTokens: 123456 },
      }),
    );
    expect(f.events.filter((event) => event.type === 'context_usage')).toHaveLength(3);
    expect(f.events.filter((event) => event.type === 'context_usage')[1]).toMatchObject({
      usage: { usedTokens: 77, maxTokens: 131072, estimated: true },
    });
    expect(await f.requests('/snapshot', 'GET')).toHaveLength(snapshotCount);
    expect(await f.requests('/status', 'GET')).toHaveLength(statusCount);
  });

  it('coalesces context refreshes into status requests and ignores stale responses after native status', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ manualOutput: true, statusDelayMs: 120 });
    const { turnId } = await session.submit(f.input('refresh', id));
    const statusCount = (await f.requests('/status', 'GET')).length;
    await f.cli.emit(id, 'turn.step.completed', { turnId: 1 });
    await vi.waitFor(async () =>
      expect(await f.requests('/status', 'GET')).toHaveLength(statusCount + 1),
    );
    await f.cli.emitBatch(
      id,
      Array.from({ length: 40 }, () => ({
        type: 'turn.step.completed',
        fields: { turnId: 1 },
      })),
    );
    await f.cli.emit(id, 'agent.status.updated', { contextTokens: 4321, maxContextTokens: 262144 });
    await vi.waitFor(async () =>
      expect(await f.requests('/status', 'GET')).toHaveLength(statusCount + 2),
    );
    await new Promise((resolve) => setTimeout(resolve, 170));
    expect(await f.requests('/status', 'GET')).toHaveLength(statusCount + 2);
    expect(await f.requests('/snapshot', 'GET')).toHaveLength(1);
    expect(
      f.events
        .filter((event) => event.type === 'context_usage')
        .map((event) => event.usage?.usedTokens),
    ).toEqual([0, 4321]);
    await f.cli.finish(id);
    await f.completed(turnId);
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

  it('rejects stream offset gaps without accepting the missing chunk', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ manualOutput: true });
    await session.submit(f.input('gap', id));
    await f.cli.emit(id, 'assistant.delta', { turnId: 1, delta: 'first' }, { offset: 0 });
    await f.cli.emit(id, 'assistant.delta', { turnId: 1, delta: 'gap' }, { offset: 9 });
    await vi.waitFor(() => expect(f.handlers.exit).toHaveBeenCalledTimes(1));
    expect(f.handlers.exit).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('流式内容存在缺口'),
      }),
    );
    expect(f.events.filter((event) => event.type === 'item_delta')).toHaveLength(1);
    expect(f.items()).toEqual([{ type: 'agentMessage', status: 'running', text: 'first' }]);
    await session.close();
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

  it('keeps a session occupied by another client retryable after a definite 40931 refusal', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ rejectPrompt: true, rejectPromptCode: 40931 });
    await expect(session.submit(f.input('occupied', id))).rejects.toBeInstanceOf(
      HarnessSubmissionRejected,
    );
    expect(f.handlers.exit).not.toHaveBeenCalled();
    expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([]);
    expect(await f.requests(':takeover')).toEqual([]);
    await f.cli.set({});
    await expect(session.submit(f.input('after owner releases', id))).resolves.toEqual({
      turnId: '1',
    });
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

  it.each([
    { nextTurnBeforeEnd: false, finishOnQueuedPrompt: true, queuedPromptResponseDelayMs: 80 },
    { nextTurnBeforeEnd: true, finishOnQueuedPrompt: true, queuedPromptResponseDelayMs: 80 },
    { nextTurnBeforeEnd: false, boundaryOnSteer: true },
    { nextTurnBeforeEnd: true, boundaryOnSteer: true },
  ])('reports the consuming native turn across a queued input boundary (%j)', async (race) => {
    const f = await fixture();
    await f.cli.set({ manualOutput: true, ...race });
    const { session, id } = await f.created();
    const { turnId } = await session.submit(f.input('active', id));
    const batchId = randomUUID();
    expect(
      await session.steer!({ sessionId: id, expectedTurnId: turnId, batchId, text: 'late batch' }),
    ).toEqual({ turnId: '2' });
    await vi.waitFor(async () =>
      expect(
        (await f.cli.records()).filter(
          (record) => record.type === 'event' && record.frame?.type === 'turn.started',
        ),
      ).toHaveLength(2),
    );
    expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([
      { type: 'turn_started', sessionId: id, turnId },
      { type: 'turn_started', sessionId: id, turnId: '2' },
    ]);
    expect(f.events.filter((event) => event.type === 'turn_completed')).toEqual([
      { type: 'turn_completed', sessionId: id, turnId, status: 'completed', error: null },
    ]);
    expect(await f.requests(`/${f.nativeId(batchId)}:abort`)).toEqual([]);
    expect(f.handlers.exit).not.toHaveBeenCalled();
    expect(
      (await f.requests('/prompts')).filter(
        (record) => record.body?.prompt_id === f.nativeId(batchId),
      ),
    ).toHaveLength(1);
    const wire = (await f.cli.records())
      .filter((record) => record.type === 'event')
      .map((record) => record.frame!);
    const start = wire.findIndex(
      (frame) =>
        frame.type === 'turn.started' && (frame.payload as Record<string, unknown>).turnId === 2,
    );
    const end = wire.findIndex(
      (frame) =>
        frame.type === 'turn.ended' && (frame.payload as Record<string, unknown>).turnId === 1,
    );
    expect(start < end).toBe(race.nextTurnBeforeEnd);
    if ('boundaryOnSteer' in race)
      expect(await f.requests(`/${f.nativeId(batchId)}:steer`)).toHaveLength(1);
    await f.cli.set({ manualOutput: true });
    const nextBatch = randomUUID();
    expect(
      await session.steer!({
        sessionId: id,
        expectedTurnId: '2',
        batchId: nextBatch,
        text: 'append in phase two',
      }),
    ).toEqual({ turnId: '2' });
    const receipt = (await f.cli.records()).find(
      (record) => record.type === 'event' && record.frame?.type === 'prompt.steered',
    );
    expect(receipt?.frame?.payload).toMatchObject({
      activePromptId: f.nativeId(batchId),
      promptIds: [f.nativeId(nextBatch)],
    });
    await f.cli.finish(id);
    expect(await f.completed('2')).toMatchObject({ status: 'completed' });
    expect(f.events.filter((event) => event.type === 'turn_completed')).toHaveLength(2);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('routes native phases and child questions to their own turn identities', async () => {
    const f = await fixture();
    await f.cli.set({
      manualOutput: true,
      boundaryOnSteer: true,
      nextTurnBeforeEnd: true,
      holdTurn: true,
    });
    const { session, id } = await f.created();
    const { turnId } = await session.submit(f.input('phase one', id));
    await f.cli.emitBatch(id, [
      { type: 'thinking.delta', fields: { turnId: 1, delta: 'Thought one' } },
      { type: 'assistant.delta', fields: { turnId: 1, delta: 'Answer one' } },
    ]);
    let currentTurnId = turnId;
    const batch = async (text: string) => {
      const batchId = randomUUID();
      const receipt = await session.steer!({
        sessionId: id,
        expectedTurnId: currentTurnId,
        batchId,
        text,
      });
      expect(receipt.turnId).toBe(String(Number(currentTurnId) + 1));
      currentTurnId = receipt.turnId;
      return batchId;
    };
    await batch('phase two');
    await f.cli.emitBatch(id, [
      { type: 'thinking.delta', fields: { turnId: 2, delta: 'Thought two' } },
      { type: 'assistant.delta', fields: { turnId: 2, delta: 'Answer two' } },
      { type: 'assistant.delta', fields: { turnId: 1, delta: ' old late output' } },
      { type: 'turn.ended', fields: { turnId: 1, reason: 'failed' } },
      { type: 'assistant.delta', fields: { turnId: 2, delta: ' continued' } },
    ]);
    await f.cli.question(id, true);
    await vi.waitFor(() => expect(f.questions).toHaveLength(1));
    expect(f.questions[0]).toMatchObject({
      sessionId: id,
      turnId: '2',
      questions: [{ multiSelect: false }, { multiSelect: true }],
    });
    const nativeMain = (await f.cli.records()).find(
      (record) => record.type === 'event' && record.frame?.type === 'event.question.requested',
    );
    expect(nativeMain?.frame?.payload).toMatchObject({ agent_id: 'main', turn_id: 2 });
    session.answer(f.questions[0]!.requestId, {
      answers: { q0: { answers: ['One'] }, q1: { answers: ['One', 'Two'] } },
    });
    await vi.waitFor(async () =>
      expect(await f.requests(`/questions/${f.questions[0]!.requestId}`)).toHaveLength(1),
    );
    expect((await f.requests(`/questions/${f.questions[0]!.requestId}`))[0]!.body).toEqual({
      method: 'click',
      answers: {
        q0: { kind: 'single', option_id: 'one' },
        q1: { kind: 'multi', option_ids: ['one', 'two'] },
      },
    });
    await batch('phase three');
    await f.cli.emitBatch(id, [
      { type: 'thinking.delta', fields: { turnId: 3, delta: 'Thought three' } },
      { type: 'assistant.delta', fields: { turnId: 3, delta: 'Answer three' } },
      {
        type: 'subagent.spawned',
        fields: {
          turnId: 3,
          subagentId: 'child-three',
          subagentName: 'Research',
          parentToolCallId: 'dispatch-three',
          runInBackground: false,
        },
      },
      {
        type: 'turn.started',
        fields: {
          agentId: 'child-three',
          turnId: 99,
          promptId: 'child-prompt',
          origin: { kind: 'user' },
        },
      },
    ]);
    await f.cli.question(id, false, {
      agentId: 'child-three',
      agent_id: 'child-three',
      turn_id: 99,
    });
    await vi.waitFor(() => expect(f.questions).toHaveLength(2));
    expect(f.questions[1]).toMatchObject({ sessionId: `${id}/agents/child-three`, turnId: '99' });
    const nativeChild = (await f.cli.records())
      .filter(
        (record) => record.type === 'event' && record.frame?.type === 'event.question.requested',
      )
      .at(-1);
    expect(nativeChild?.frame?.payload).toMatchObject({ agent_id: 'child-three', turn_id: 99 });
    session.answer(f.questions[1]!.requestId, { answers: { q0: { answers: ['Two'] } } });
    await vi.waitFor(async () =>
      expect(await f.requests(`/questions/${f.questions[1]!.requestId}`)).toHaveLength(1),
    );
    expect(f.events.filter((event) => event.type === 'turn_completed')).toHaveLength(2);
    await f.cli.emit(id, 'turn.ended', { agentId: 'child-three', turnId: 99, reason: 'completed' });
    await f.cli.finish(id);
    await f.completed('3');
    expect(f.items()).toEqual(
      expect.arrayContaining([
        { type: 'reasoning', status: 'completed', text: 'Thought one' },
        { type: 'agentMessage', status: 'completed', text: 'Answer one' },
        { type: 'reasoning', status: 'completed', text: 'Thought two' },
        { type: 'reasoning', status: 'completed', text: 'Thought three' },
        { type: 'agentMessage', status: 'completed', text: 'Answer three' },
      ]),
    );
    expect(f.items().some((item) => item.text.includes('Answer two continued'))).toBe(true);
    expect(f.items().some((item) => item.text.includes('old late output'))).toBe(false);
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(4);
    expect(f.events.filter((event) => event.type === 'turn_completed')).toHaveLength(4);
    expect(
      f.events.every((event) => {
        if (event.type !== 'item' && event.type !== 'item_delta') return true;
        return event.sessionId === `${id}/agents/child-three`
          ? event.turnId === '99'
          : ['1', '2', '3'].includes(event.turnId!);
      }),
    ).toBe(true);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'finishes a consumed continuation before its delayed HTTP receipt arrives (start before end: %s)',
    async (nextTurnBeforeEnd) => {
      const f = await fixture();
      await f.cli.set({ manualOutput: true });
      const { session, id } = await f.created();
      const { turnId } = await session.submit(f.input('initial', id));
      await f.cli.set({
        finishOnQueuedPrompt: true,
        queuedPromptResponseDelayMs: 100,
        nextTurnBeforeEnd,
      });
      const batchId = randomUUID();
      expect(
        await session.steer!({
          sessionId: id,
          expectedTurnId: turnId,
          batchId,
          text: 'automatic continuation',
        }),
      ).toEqual({ turnId: '2' });
      expect(await f.completed(turnId)).toMatchObject({ status: 'completed' });
      expect(await f.completed('2')).toMatchObject({ status: 'completed' });
      expect(f.items()).toEqual([
        { type: 'agentMessage', status: 'completed', text: 'Reply: automatic continuation' },
      ]);
      expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(2);
      expect(f.events.filter((event) => event.type === 'turn_completed')).toHaveLength(2);
      expect(await f.requests('/prompts')).toHaveLength(2);
      expect(await f.requests(`/${f.nativeId(batchId)}:steer`)).toEqual([]);
      expect(await f.requests(`/${f.nativeId(batchId)}:abort`)).toEqual([]);
      expect(f.handlers.exit).not.toHaveBeenCalled();
    },
  );

  it('cancels a pending batch before the active continuation prompt when stopped', async () => {
    const f = await fixture();
    await f.cli.set({ manualOutput: true, boundaryOnSteer: true });
    const { session, id } = await f.created();
    const { turnId } = await session.submit(f.input('initial', id));
    const activeBatch = randomUUID();
    await session.steer!({
      sessionId: id,
      expectedTurnId: turnId,
      batchId: activeBatch,
      text: 'active continuation',
    });
    await f.cli.set({ manualOutput: true, queuedPromptResponseDelayMs: 200 });
    const pendingBatch = randomUUID();
    const pending = session.steer!({
      sessionId: id,
      expectedTurnId: '2',
      batchId: pendingBatch,
      text: 'pending batch',
    });
    void pending.catch(() => {});
    await vi.waitFor(async () => expect(await f.requests('/prompts')).toHaveLength(3));
    await session.close();
    await expect(pending).rejects.not.toBeInstanceOf(HarnessSubmissionRejected);
    const aborted = (await f.cli.records()).filter(
      (record) => record.type === 'http' && record.path?.endsWith(':abort'),
    );
    expect(aborted.map((record) => record.path)).toEqual([
      `/api/v1/sessions/${id}/prompts/${f.nativeId(pendingBatch)}:abort`,
      `/api/v1/sessions/${id}/prompts/${f.nativeId(activeBatch)}:abort`,
    ]);
    expect(
      (await f.cli.records()).filter(
        (record) => record.type === 'event' && record.frame?.type === 'turn.started',
      ),
    ).toHaveLength(2);
    expect(await f.requests(`/${f.nativeId(pendingBatch)}:steer`)).toEqual([]);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('reports a continuation failure on its own native turn', async () => {
    const f = await fixture();
    await f.cli.set({ manualOutput: true, boundaryOnSteer: true });
    const { session, id } = await f.created();
    const { turnId } = await session.submit(f.input('initial', id));
    const batchId = randomUUID();
    expect(
      await session.steer!({
        sessionId: id,
        expectedTurnId: turnId,
        batchId,
        text: 'continuation',
      }),
    ).toEqual({ turnId: '2' });
    await f.cli.emit(id, 'assistant.delta', { turnId: 2, delta: 'Partial continuation' });
    const error = 'Native model request failed: HTTP 502, request fixture-continuation';
    await f.cli.finish(id, 'failed', error);
    expect(await f.completed('2')).toEqual({
      type: 'turn_completed',
      sessionId: id,
      turnId: '2',
      status: 'failed',
      error,
    });
    expect(f.items()).toEqual([
      { type: 'agentMessage', status: 'failed', text: 'Partial continuation' },
    ]);
    expect(f.events.filter((event) => event.type === 'turn_completed')).toHaveLength(2);
    expect(await f.requests('/prompts')).toHaveLength(2);
    expect(await f.requests(`/${f.nativeId(batchId)}:abort`)).toEqual([]);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('interrupts the active continuation using its native turn ID', async () => {
    const f = await fixture();
    await f.cli.set({ manualOutput: true, boundaryOnSteer: true });
    const { session, id } = await f.created();
    const { turnId } = await session.submit(f.input('initial', id));
    const batchId = randomUUID();
    const steering = session.steer!({
      sessionId: id,
      expectedTurnId: turnId,
      batchId,
      text: 'continuation',
    });
    expect(await steering).toEqual({ turnId: '2' });
    await f.cli.emit(id, 'assistant.delta', { turnId: 2, delta: 'Partial continuation' });
    await session.interrupt(id, '2');
    expect(await f.completed('2')).toMatchObject({ status: 'interrupted', error: null });
    expect(await steering).toEqual({ turnId: '2' });
    expect(f.items()).toEqual([
      { type: 'agentMessage', status: 'interrupted', text: 'Partial continuation' },
    ]);
    expect(f.events.filter((event) => event.type === 'turn_completed')).toHaveLength(2);
    expect(
      (await f.cli.records()).filter(
        (record) => record.type === 'http' && record.path?.endsWith(':abort'),
      ),
    ).toMatchObject([{ path: `/api/v1/sessions/${id}/prompts/${f.nativeId(batchId)}:abort` }]);
    expect(await f.requests('/prompts')).toHaveLength(2);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('expires cached interactions on handoff and keeps fresh questions when an old phase ends late', async () => {
    const f = await fixture();
    await f.cli.set({
      manualOutput: true,
      holdTurn: true,
      boundaryOnSteer: true,
      nextTurnBeforeEnd: true,
      oldTurnEndDelayMs: 200,
    });
    const { session, id } = await f.created();
    const storedPath = join(f.cli.home, 'sessions', `${id}.json`);
    const stored = JSON.parse(await readFile(storedPath, 'utf8')) as { turn: number };
    stored.turn = 6;
    await writeFile(storedPath, JSON.stringify(stored));
    const { turnId } = await session.submit(f.input('phase seven', id));
    expect(turnId).toBe('7');
    await f.cli.question(id);
    const approval = (approvalId: string, phaseId: number, plan: boolean) =>
      f.cli.emit(id, 'event.approval.requested', {
        turnId: phaseId,
        approval_id: approvalId,
        tool_name: plan ? 'ExitPlanMode' : 'Shell',
        action: 'Review fixture action',
        tool_input_display: plan
          ? { kind: 'plan_review', plan: 'Fixture plan', options: [{ label: 'Approve' }] }
          : { command: 'echo fixture' },
      });
    await approval('cached-plan', 7, true);
    await vi.waitFor(() => expect(f.questions).toHaveLength(2));
    const oldQuestion = f.questions[0]!;
    const oldApproval = f.questions[1]!;
    expect(oldApproval.requestId).toBe('approval:cached-plan');
    expect(
      await session.steer!({
        sessionId: id,
        expectedTurnId: turnId,
        batchId: randomUUID(),
        text: 'phase eight',
      }),
    ).toEqual({ turnId: '8' });
    const expired = () => f.events.filter((event) => event.type === 'question_expired');
    await vi.waitFor(() =>
      expect(expired()).toEqual([
        { type: 'question_expired', sessionId: id, turnId, requestId: oldQuestion.requestId },
        { type: 'question_expired', sessionId: id, turnId, requestId: oldApproval.requestId },
      ]),
    );
    expect(() =>
      session.answer(oldQuestion.requestId, { answers: { q0: { answers: ['One'] } } }),
    ).toThrow();
    expect(() =>
      session.answer(oldApproval.requestId, { answers: { approval: { answers: ['Approve'] } } }),
    ).toThrow();
    await f.cli.question(id, false, { turn_id: 7 });
    await approval('stale-plan', 7, true);
    await approval('stale-tool', 7, false);
    await f.cli.question(id);
    await vi.waitFor(() => expect(f.questions).toHaveLength(3));
    const fresh = f.questions[2]!;
    await vi.waitFor(async () =>
      expect(
        (await f.cli.records()).some(
          (record) =>
            record.type === 'event' &&
            record.frame?.type === 'turn.ended' &&
            (record.frame.payload as Record<string, unknown>).turnId === 7,
        ),
      ).toBe(true),
    );
    expect(expired()).toHaveLength(2);
    expect(await f.requests('/approvals/stale-plan')).toEqual([]);
    expect(await f.requests('/approvals/stale-tool')).toEqual([]);
    expect(await f.requests(`/questions/${oldQuestion.requestId}`)).toEqual([]);
    expect(await f.requests('/approvals/cached-plan')).toEqual([]);
    session.answer(fresh.requestId, { answers: { q0: { answers: ['Two'] } } });
    await vi.waitFor(async () =>
      expect(await f.requests(`/questions/${fresh.requestId}`)).toHaveLength(1),
    );
    expect(expired()).toHaveLength(2);
    await f.cli.finish(id);
    expect(await f.completed('8')).toMatchObject({ status: 'completed' });
    expect(f.events.filter((event) => event.type === 'turn_completed')).toHaveLength(2);
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it.each(['event.question.answered', 'event.question.dismissed'])(
    'expires externally resolved forms and suppresses expiry callbacks during close (%s)',
    async (questionEvent) => {
      const f = await fixture();
      await f.cli.set({ manualOutput: true });
      const { session, id } = await f.created();
      const { turnId } = await session.submit(f.input('forms', id));
      const approval = (approvalId: string) =>
        f.cli.emit(id, 'event.approval.requested', {
          turnId: 1,
          approval_id: approvalId,
          tool_name: 'ExitPlanMode',
          action: 'Review fixture plan',
          tool_input_display: { kind: 'plan_review', plan: 'Fixture plan' },
        });
      await f.cli.question(id);
      await approval('external-plan');
      await vi.waitFor(() => expect(f.questions).toHaveLength(2));
      const externalQuestion = f.questions[0]!;
      const externalApproval = f.questions[1]!;
      await f.cli.emitBatch(id, [
        { type: questionEvent, fields: { turnId: 1, question_id: externalQuestion.requestId } },
        {
          type: 'event.approval.resolved',
          fields: { turnId: 1, approval_id: 'external-plan', decision: 'approved' },
        },
      ]);
      const expired = () => f.events.filter((event) => event.type === 'question_expired');
      await vi.waitFor(() =>
        expect(expired()).toEqual([
          {
            type: 'question_expired',
            sessionId: id,
            turnId,
            requestId: externalQuestion.requestId,
          },
          {
            type: 'question_expired',
            sessionId: id,
            turnId,
            requestId: externalApproval.requestId,
          },
        ]),
      );
      expect(() =>
        session.answer(externalQuestion.requestId, { answers: { q0: { answers: ['One'] } } }),
      ).toThrow();
      expect(() =>
        session.answer(externalApproval.requestId, {
          answers: { approval: { answers: ['Approve'] } },
        }),
      ).toThrow();
      await f.cli.question(id);
      await approval('close-plan');
      await vi.waitFor(() => expect(f.questions).toHaveLength(4));
      const closeQuestion = f.questions[2]!;
      const closeApproval = f.questions[3]!;
      await session.close();
      expect(expired()).toHaveLength(2);
      expect(await f.requests(`/questions/${closeQuestion.requestId}:dismiss`)).toHaveLength(1);
      expect((await f.requests('/approvals/close-plan'))[0]).toMatchObject({
        body: { decision: 'cancelled' },
      });
      expect(await f.requests(`/questions/${externalQuestion.requestId}`)).toEqual([]);
      expect(await f.requests('/approvals/external-plan')).toEqual([]);
      expect(() =>
        session.answer(closeQuestion.requestId, { answers: { q0: { answers: ['One'] } } }),
      ).toThrow();
      expect(() =>
        session.answer(closeApproval.requestId, {
          answers: { approval: { answers: ['Approve'] } },
        }),
      ).toThrow();
      expect(f.handlers.exit).not.toHaveBeenCalled();
    },
  );

  it.each(['invalidReceipt', 'loseQueuedReceipt', 'suppressSteerReceipt'] as const)(
    'keeps admitted steering uncertain when confirmation is missing (%s)',
    async (failure) => {
      const f = await fixture();
      await f.cli.set({ manualOutput: true });
      const { session, id } = await f.created();
      const { turnId } = await session.submit(f.input('active', id));
      await f.cli.set({ manualOutput: true, [failure]: true });
      const batchId = randomUUID();
      const pending = session.steer!({
        sessionId: id,
        expectedTurnId: turnId,
        batchId,
        text: 'uncertain',
      });
      void pending.catch(() => {});
      if (failure === 'suppressSteerReceipt') {
        await vi.waitFor(async () =>
          expect(await f.requests(`/${f.nativeId(batchId)}:steer`)).toHaveLength(1),
        );
        await f.cli.drop();
      }
      await expect(pending).rejects.not.toBeInstanceOf(HarnessSubmissionRejected);
      await session.close();
      expect(f.handlers.exit).toHaveBeenCalledTimes(1);
      expect(
        (await f.requests('/prompts')).filter(
          (record) => record.body?.prompt_id === f.nativeId(batchId),
        ),
      ).toHaveLength(1);
      expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
    },
  );

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

  it('observes autonomous native wakeups and steers or interrupts their actual turn', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ manualOutput: true, holdTurn: true });
    await f.cli.wake(id);
    await vi.waitFor(() =>
      expect(f.events).toContainEqual({ type: 'turn_started', sessionId: id, turnId: '1' }),
    );
    expect(await f.requests('/prompts')).toHaveLength(0);
    await f.cli.emit(id, 'assistant.delta', { turnId: 1, delta: 'Autonomous output' });
    const batchId = randomUUID();
    expect(
      await session.steer!({
        sessionId: id,
        expectedTurnId: '1',
        batchId,
        text: 'Steer native wake',
      }),
    ).toEqual({ turnId: '1' });
    await session.interrupt(id, '1');
    expect(await f.completed('1')).toMatchObject({ status: 'interrupted' });
    expect(f.items()).toContainEqual({
      type: 'agentMessage',
      status: 'interrupted',
      text: 'Autonomous output',
    });
    const wake = (await f.cli.records()).find((record) => record.frame?.type === 'turn.started');
    const promptId = (wake!.frame!.payload as { promptId: string }).promptId;
    expect(await f.requests(`/${promptId}:abort`)).toHaveLength(1);
    await f.cli.wake(id, 'Next native wake');
    await f.cli.finish(id);
    expect(await f.completed('2')).toMatchObject({ status: 'completed' });
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('observes and interrupts native turns without a tracked prompt ID', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ manualOutput: true });
    await f.cli.wake(id, 'Untracked native wake', false);
    await vi.waitFor(() =>
      expect(f.events).toContainEqual({ type: 'turn_started', sessionId: id, turnId: '1' }),
    );
    await f.cli.emit(id, 'assistant.delta', { turnId: 1, delta: 'Untracked native output' });
    await expect(
      session.steer!({
        sessionId: id,
        expectedTurnId: '1',
        batchId: randomUUID(),
        text: 'Next user input',
      }),
    ).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    expect(await f.requests('/prompts')).toHaveLength(0);
    await session.interrupt(id, '1');
    expect(await f.completed('1')).toMatchObject({ status: 'interrupted' });
    expect(await f.requests(`${id}:abort`)).toHaveLength(1);
    expect(f.items()).toContainEqual({
      type: 'agentMessage',
      status: 'interrupted',
      text: 'Untracked native output',
    });
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('continues verified background descendants after the parent turn ends and during a new root wake', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ manualOutput: true, holdTurn: true });
    await session.submit(f.input('Spawn background', id));
    await f.cli.emitBatch(id, [
      {
        type: 'subagent.spawned',
        fields: {
          turnId: 1,
          subagentId: 'background',
          subagentName: 'Background',
          runInBackground: true,
        },
      },
      {
        type: 'turn.started',
        fields: { agentId: 'background', turnId: 1, promptId: 'background-prompt' },
      },
      {
        type: 'subagent.spawned',
        fields: {
          agentId: 'background',
          parentAgentId: 'background',
          turnId: 1,
          subagentId: 'nested',
          subagentName: 'Nested',
          runInBackground: true,
        },
      },
      { type: 'turn.started', fields: { agentId: 'nested', turnId: 1, promptId: 'nested-prompt' } },
    ]);
    await f.cli.finish(id);
    expect(await f.completed('1')).toMatchObject({ status: 'completed' });
    await f.cli.question(id, false, { agentId: 'background', agent_id: 'background', turn_id: 1 });
    await vi.waitFor(() => expect(f.questions).toHaveLength(1));
    expect(f.questions[0]).toMatchObject({ sessionId: `${id}/agents/background`, turnId: '1' });
    await f.cli.wake(id);
    await vi.waitFor(() =>
      expect(f.events).toContainEqual({ type: 'turn_started', sessionId: id, turnId: '2' }),
    );
    await f.cli.emitBatch(id, [
      {
        type: 'assistant.delta',
        fields: { agentId: 'background', turnId: 1, delta: 'Background keeps running' },
      },
      {
        type: 'assistant.delta',
        fields: { agentId: 'nested', turnId: 1, delta: 'Nested keeps running' },
      },
      { type: 'turn.ended', fields: { agentId: 'nested', turnId: 1, reason: 'completed' } },
    ]);
    await session.interrupt(id, '2');
    expect(await f.completed('2')).toMatchObject({ status: 'interrupted' });
    expect(await f.requests(`/questions/${f.questions[0]!.requestId}:dismiss`)).toHaveLength(0);
    session.answer(f.questions[0]!.requestId, { answers: { q0: { answers: ['One'] } } });
    await vi.waitFor(async () =>
      expect(await f.requests(`/questions/${f.questions[0]!.requestId}`)).toHaveLength(1),
    );
    await f.cli.emitBatch(id, [
      { type: 'turn.ended', fields: { agentId: 'background', turnId: 1, reason: 'completed' } },
      {
        type: 'subagent.completed',
        fields: { subagentId: 'background', resultSummary: 'Background complete' },
      },
    ]);
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.type === 'turn_completed')).toHaveLength(4),
    );
    expect(f.events).toContainEqual({
      type: 'turn_completed',
      sessionId: `${id}/agents/background`,
      turnId: '1',
      status: 'completed',
      error: null,
    });
    expect(f.events).toContainEqual({
      type: 'turn_completed',
      sessionId: `${id}/agents/nested`,
      turnId: '1',
      status: 'completed',
      error: null,
    });
    expect(
      f.events
        .filter(
          (event) =>
            (event.type === 'item' || event.type === 'item_delta') &&
            event.item.text.includes('Nested keeps running'),
        )
        .every(
          (event) =>
            event.sessionId === `${id}/agents/nested` && 'turnId' in event && event.turnId === '1',
        ),
    ).toBe(true);
    expect(f.items()).toContainEqual({
      type: 'subagent',
      status: 'completed',
      text: '子代理 Background (background)\nBackground complete',
    });
    expect(f.handlers.exit).not.toHaveBeenCalled();
  });

  it('validates root identity and descendant ancestry before publishing native activity', async () => {
    const f = await fixture();
    const { session, id } = await f.created();
    await f.cli.set({ manualOutput: true });
    await session.submit(f.input('Validate descendants', id));
    await f.cli.emitBatch(id, [
      {
        type: 'turn.started',
        fields: { agentId: 'orphan', turnId: 77, promptId: 'orphan-prompt' },
      },
      {
        type: 'assistant.delta',
        fields: { agentId: 'orphan', turnId: 77, delta: 'Orphan output' },
      },
      {
        type: 'turn.started',
        fields: { sessionId: 'foreign-root', turnId: 88, promptId: 'foreign-prompt' },
      },
      {
        type: 'subagent.spawned',
        fields: {
          parentAgentId: 'unknown',
          turnId: 1,
          subagentId: 'forged',
          subagentName: 'Forged',
          runInBackground: true,
        },
      },
      {
        type: 'turn.started',
        fields: { agentId: 'forged', turnId: 66, promptId: 'forged-prompt' },
      },
      {
        type: 'turn.started',
        fields: { agentId: 'late-child', turnId: 99, promptId: 'late-child-prompt' },
      },
      {
        type: 'assistant.delta',
        fields: { agentId: 'late-child', turnId: 99, delta: 'Verified after spawn' },
      },
      {
        type: 'subagent.spawned',
        fields: {
          turnId: 1,
          subagentId: 'late-child',
          subagentName: 'Late child',
          runInBackground: true,
        },
      },
      { type: 'turn.ended', fields: { agentId: 'late-child', turnId: 99, reason: 'completed' } },
    ]);
    await f.cli.finish(id);
    await f.completed('1');
    expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([
      { type: 'turn_started', sessionId: id, turnId: '1' },
      { type: 'turn_started', sessionId: `${id}/agents/late-child`, turnId: '99' },
    ]);
    expect(f.items().some((item) => item.text.includes('Verified after spawn'))).toBe(true);
    expect(f.items().some((item) => /Orphan|Forged/.test(item.text))).toBe(false);
    expect(f.handlers.exit).not.toHaveBeenCalled();
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
