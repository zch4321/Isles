import { ConfigManager } from '@isles/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter, CLAUDE_INITIALIZATION_MESSAGE } from '../src/harness/claude/adapter.js';
import { ClaudeEnvironment } from '../src/harness/claude/environment.js';
import { ClaudeClient, type ClaudeFrame } from '../src/harness/claude/client.js';
import {
  HarnessSubmissionRejected,
  type HarnessEvent,
  type HarnessHandlers,
  type HarnessQuestion,
} from '../src/harness/types.js';
import { AgentWorkspace } from '../src/runtime/workspace.js';
import type { AgentRecord } from '../src/storage/store.js';
import { claudeFixture } from './claude-fixture.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-claude-adapter-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cli = await claudeFixture(root);
  const config = new ConfigManager({
    configFilePath: join(root, 'config.toml'),
    homeDir: root,
    environment: { ISLES_CLAUDE_BIN: cli.binary, ISLES_CLAUDE_HOME: cli.home },
  });
  const workspace = new AgentWorkspace(config);
  const environment = new ClaudeEnvironment(config, workspace);
  const received: ClaudeFrame[] = [];
  let emit!: (frame: ClaudeFrame) => void;
  let requestNative!: (id: string, request: ClaudeFrame) => void;
  let cancelNative!: (id: string) => void;
  const adapter = new ClaudeAdapter(
    environment,
    undefined,
    (command, args, cwd, env, handlers, log) => {
      emit = handlers.event;
      requestNative = handlers.request;
      cancelNative = handlers.cancel;
      return new ClaudeClient(
        command,
        args,
        cwd,
        env,
        {
          ...handlers,
          event: (frame) => {
            received.push(frame);
            handlers.event(frame);
          },
        },
        environment.redactor,
        log,
      );
    },
  );
  const agent: AgentRecord = {
    id: randomUUID(),
    channelId: randomUUID(),
    name: 'Claude fixture',
    harness: 'claude',
    model: 'default',
    reasoningEffort: 'high',
    workspace: join(root, 'workspace'),
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
  const input = (text: string, sessionId: string) => ({
    sessionId,
    runId: randomUUID(),
    text,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    workspace: agent.workspace,
  });
  return {
    root,
    cli,
    config,
    adapter,
    agent,
    events,
    received,
    questions,
    output,
    connect,
    input,
    emit: (frame: ClaudeFrame) => emit(frame),
    requestNative: (id: string, request: ClaudeFrame) => requestNative(id, request),
    cancelNative: (id: string) => cancelNative(id),
  };
}

describe('Claude CLI adapter', () => {
  it('records native turns and autonomous wakeups without an Isles input receipt', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const nativeId = randomUUID();
    const wakeupId = randomUUID();
    f.emit({ type: 'user', session_id: id, isReplay: true, uuid: randomUUID() });
    f.emit({
      type: 'assistant',
      session_id: id,
      isReplay: true,
      uuid: randomUUID(),
      message: { content: [] },
    });
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(0);
    f.emit({ type: 'command_lifecycle', state: 'started', session_id: id, command_uuid: nativeId });
    f.emit({
      type: 'result',
      subtype: 'success',
      session_id: id,
      user_message_uuid: nativeId,
      is_error: false,
    });
    f.emit({
      type: 'assistant',
      session_id: id,
      uuid: wakeupId,
      message: { content: [{ type: 'text', text: 'Automatic follow-up' }] },
    });
    f.emit({
      type: 'result',
      subtype: 'success',
      session_id: id,
      is_error: false,
      origin: { kind: 'task-notification' },
    });
    expect(f.events.filter((event) => event.type === 'turn_started')).toEqual([
      { type: 'turn_started', sessionId: id, turnId: nativeId },
      { type: 'turn_started', sessionId: id, turnId: wakeupId },
    ]);
    expect(
      f.events.filter((event) => event.type === 'turn_completed').map((event) => event.turnId),
    ).toEqual([nativeId, wakeupId]);
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: 'item',
        turnId: wakeupId,
        item: expect.objectContaining({ text: 'Automatic follow-up' }),
      }),
    );
  });

  it('keeps background output and questions attached to their native child after the root finishes', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('hold', id);
    await session.submit(input);
    f.emit({
      type: 'system',
      subtype: 'task_started',
      session_id: id,
      task_id: 'native-child',
      run_id: 'child-run',
      tool_use_id: 'spawn-tool',
    });
    const childId = `${id}/agents/native-child`;
    const child = { session_id: id, parent_tool_use_id: 'spawn-tool', agent_id: 'native-child' };
    const questionInput = {
      questions: [
        {
          question: 'Child choice?',
          header: 'Child',
          options: [
            { label: 'One', description: 'First' },
            { label: 'Two', description: 'Second' },
          ],
        },
      ],
    };
    f.emit({
      ...child,
      type: 'assistant',
      uuid: randomUUID(),
      message: {
        content: [
          { type: 'tool_use', id: 'child-tool', name: 'AskUserQuestion', input: questionInput },
        ],
      },
    });
    f.requestNative('child-question', {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'child-tool',
      input: questionInput,
    });
    expect(f.questions[0]).toMatchObject({ sessionId: childId, turnId: 'child-run' });
    f.emit({
      type: 'result',
      subtype: 'success',
      session_id: id,
      user_message_uuid: input.runId,
      is_error: false,
    });
    expect(f.events.filter((event) => event.type === 'question_expired')).toHaveLength(0);
    expect(() =>
      session.answer('child-question', { answers: { 'question-0': { answers: ['One'] } } }),
    ).not.toThrow();
    const contexts = f.events.filter((event) => event.type === 'context_usage').length;
    f.emit({
      ...child,
      type: 'assistant',
      uuid: randomUUID(),
      message: { content: [{ type: 'text', text: 'Background complete' }] },
    });
    f.emit({
      type: 'system',
      subtype: 'task_notification',
      session_id: id,
      task_id: 'native-child',
      run_id: 'child-run',
      status: 'completed',
      summary: 'Child done',
    });
    expect(f.events.filter((event) => event.type === 'turn_completed')).toEqual([
      expect.objectContaining({ sessionId: id, turnId: input.runId, status: 'completed' }),
      expect.objectContaining({ sessionId: childId, turnId: 'child-run', status: 'completed' }),
    ]);
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: 'item',
        sessionId: childId,
        turnId: 'child-run',
        item: expect.objectContaining({ text: 'Background complete' }),
      }),
    );
    expect(f.events.filter((event) => event.type === 'context_usage')).toHaveLength(contexts);
  });

  it('keeps nested children separate and stops background work after the root result', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('hold', id);
    await session.submit(input);
    f.emit({
      type: 'system',
      subtype: 'task_started',
      session_id: id,
      task_id: 'child',
      run_id: 'child-run',
      tool_use_id: 'spawn-child',
    });
    f.emit({
      type: 'system',
      subtype: 'task_started',
      session_id: id,
      parent_tool_use_id: 'spawn-child',
      task_id: 'nested',
      run_id: 'nested-run',
      tool_use_id: 'spawn-nested',
    });
    f.emit({
      type: 'result',
      subtype: 'success',
      session_id: id,
      user_message_uuid: input.runId,
      is_error: false,
    });
    f.emit({
      type: 'assistant',
      session_id: id,
      parent_tool_use_id: 'unknown-child',
      uuid: randomUUID(),
      message: { content: [{ type: 'text', text: 'Unverified' }] },
    });
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(3);
    await session.interrupt(id, input.runId);
    f.emit({
      type: 'system',
      subtype: 'task_notification',
      session_id: id,
      task_id: 'child',
      status: 'stopped',
    });
    f.emit({
      type: 'system',
      subtype: 'task_notification',
      session_id: id,
      parent_tool_use_id: 'spawn-child',
      task_id: 'nested',
      status: 'stopped',
    });
    expect(f.events.filter((event) => event.type === 'turn_completed')).toEqual([
      expect.objectContaining({ sessionId: id, status: 'completed' }),
      expect.objectContaining({ sessionId: `${id}/agents/child`, status: 'interrupted' }),
      expect.objectContaining({ sessionId: `${id}/agents/nested`, status: 'interrupted' }),
    ]);
    await session.close();
    const before = f.events.length;
    f.emit({
      type: 'command_lifecycle',
      state: 'started',
      session_id: id,
      command_uuid: randomUUID(),
    });
    expect(f.events).toHaveLength(before);
  });

  it('keeps native dedicated interactions distinct from one-time tool approvals', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('hold', id);
    await session.submit(input);
    f.emit({
      type: 'assistant',
      session_id: id,
      user_message_uuid: input.runId,
      message: {
        content: [
          { type: 'tool_use', id: 'interactive-tool', name: 'NativeInteraction', input: {} },
        ],
      },
    });
    f.requestNative('interactive', {
      subtype: 'can_use_tool',
      tool_name: 'NativeInteraction',
      tool_use_id: 'interactive-tool',
      input: {},
      requires_user_interaction: true,
    });
    expect(f.questions).toHaveLength(0);
    await vi.waitFor(async () => {
      const response = (await f.cli.records()).find(
        (frame) =>
          frame.type === 'control_response' &&
          (frame.response as ClaudeFrame)?.request_id === 'interactive',
      );
      expect((response?.response as ClaudeFrame)?.response).toEqual({
        behavior: 'deny',
        message: '该原生请求需要专用交互，请在 Claude Code 会话中处理。',
      });
    });
  });
  it('expires externally cancelled approvals and denies tool requests without a matching active tool', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('hold', id);
    await session.submit(input);
    const request = {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      tool_use_id: 'native-tool',
      input: { command: 'echo fixture' },
    };
    f.requestNative('unassociated', request);
    expect(f.questions).toHaveLength(0);
    f.emit({
      type: 'assistant',
      session_id: id,
      user_message_uuid: input.runId,
      message: {
        content: [{ type: 'tool_use', id: 'native-tool', name: 'Bash', input: request.input }],
      },
    });
    f.requestNative('approval', request);
    expect(f.questions).toHaveLength(1);
    f.cancelNative('approval');
    expect(f.events).toContainEqual({
      type: 'question_expired',
      sessionId: id,
      turnId: input.runId,
      requestId: 'approval',
    });
    expect(() =>
      session.answer('approval', { answers: { permission: { answers: ['允许本次'] } } }),
    ).toThrow('已失效');
    expect(f.output.exit).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'uses native mode and shared directory when creating and restoring (full=%s)',
    async (full) => {
      const f = await fixture();
      f.agent.dangerFullAccess = full;
      const session = await f.connect();
      const id = await session.createSession(() => {});
      await session.close();
      const restored = await f.connect();
      await restored.resumeSession(id);
      const launches = (await f.cli.records()).filter((frame) => frame.type === 'launch');
      expect(launches).toHaveLength(2);
      for (const launch of launches) {
        const args = launch.args as string[];
        expect(args.includes('--dangerously-skip-permissions')).toBe(full);
        expect(args).toContain('--add-dir');
        if (!full) expect(args).toContain('acceptEdits');
      }
    },
  );

  it.each(['允许本次', '拒绝'])(
    'answers native tool permission with %s and no persistent grant',
    async (decision) => {
      const f = await fixture();
      const session = await f.connect();
      const id = await session.createSession(() => {});
      await session.submit(f.input('permission', id));
      await vi.waitFor(() => expect(f.questions).toHaveLength(1));
      const question = f.questions[0]!;
      expect(question.questions[0]).toMatchObject({ id: 'permission', isOther: false });
      session.answer(question.requestId, { answers: { permission: { answers: [decision] } } });
      await vi.waitFor(async () => {
        const response = (await f.cli.records()).find(
          (frame) =>
            frame.type === 'control_response' &&
            (frame.response as ClaudeFrame)?.request_id === question.requestId,
        );
        expect((response?.response as ClaudeFrame)?.response).toEqual(
          decision === '允许本次'
            ? { behavior: 'allow', updatedInput: { command: 'echo fixture' } }
            : { behavior: 'deny', message: '用户拒绝本次执行' },
        );
      });
      expect(() =>
        session.answer(question.requestId, { answers: { permission: { answers: ['允许本次'] } } }),
      ).toThrow('已失效');
    },
  );

  it('ignores partial stream frames and publishes complete assistant and tool snapshots', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('hold', id);
    await session.submit(input);
    const before = f.events.length;
    const identity = { session_id: id, user_message_uuid: input.runId };
    f.emit({
      ...identity,
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    });
    f.emit({ ...identity, type: 'tool_progress', tool_use_id: 'tool', elapsed_time_seconds: 1 });
    expect(f.events).toHaveLength(before);
    f.emit({
      ...identity,
      type: 'assistant',
      message: {
        id: 'complete-message',
        content: [
          { type: 'text', text: 'Complete answer' },
          { type: 'thinking', thinking: 'Complete reasoning' },
          { type: 'tool_use', id: 'tool', name: 'isles.send_message', input: { body: 'Sent' } },
        ],
      },
    });
    f.emit({
      ...identity,
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Done' }] },
    });
    expect(f.events.slice(before)).toMatchObject([
      { type: 'item', append: false, item: { type: 'agentMessage', status: 'completed' } },
      { type: 'item', append: false, item: { type: 'reasoning', status: 'completed' } },
      { type: 'item', append: false, item: { id: 'tool', status: 'running' } },
      { type: 'item', append: false, item: { id: 'tool', status: 'completed' } },
    ]);
  });

  it('keeps the latest context snapshot when two result controls respond in reverse order', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    await f.cli.set({ reverseContextResponses: [4096, 2048] });
    const first = f.input('first', id);
    await session.submit(first);
    await vi.waitFor(() =>
      expect(f.events).toContainEqual(
        expect.objectContaining({ type: 'turn_completed', turnId: first.runId }),
      ),
    );
    // The fixture withholds this query until another completed input requests a newer snapshot.
    await vi.waitFor(async () => {
      const reads = (await f.cli.records()).filter(
        (frame) =>
          frame.type === 'control_request' &&
          (frame.request as Record<string, unknown>).subtype === 'get_context_usage',
      );
      expect(reads).toHaveLength(3);
    });
    const second = f.input('second', id);
    await session.submit(second);
    await vi.waitFor(() =>
      expect(f.received).toContainEqual({
        type: 'system',
        subtype: 'context_responses_replayed',
        session_id: id,
      }),
    );
    const usages = f.events.filter((event) => event.type === 'context_usage');
    expect(usages.map((event) => event.usage?.usedTokens)).toEqual([1024, 1024, 2048]);
    expect(f.events.filter((event) => event.type === 'turn_completed')).toHaveLength(2);
    expect((await f.cli.records()).filter((frame) => frame.type === 'user')).toHaveLength(3);
  });
  it('warns with redacted diagnostics when a post-result usage control fails and still completes the run', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const secret = 'fixture-context-secret';
    f.adapter.environment.redactor.add(secret);
    const warn = vi.spyOn(f.adapter.environment.log, 'warn').mockImplementation(() => {});
    await f.cli.set({ contextError: `Unavailable ${secret}` });
    const input = f.input('hello', id);
    await session.submit(input);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    const detail = warn.mock.calls[0]![0] as { err: Error };
    expect(detail.err.message).not.toContain(secret);
    expect(f.events).toContainEqual({
      type: 'turn_completed',
      sessionId: id,
      turnId: input.runId,
      status: 'completed',
      error: null,
    });
    expect(f.events.filter((event) => event.type === 'context_usage')).toHaveLength(2);
    expect(f.output.exit).not.toHaveBeenCalled();
    await f.cli.set({});
    await session.submit(f.input('next', id));
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.type === 'context_usage')).toHaveLength(3),
    );
  });
  it('reads current context with summary controls at initialization, results and resume without extra prompts', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const usage = () => f.events.filter((event) => event.type === 'context_usage');
    expect(usage()).toEqual([
      {
        type: 'context_usage',
        sessionId: id,
        usage: { usedTokens: 1024, maxTokens: 200000, estimated: true },
      },
      {
        type: 'context_usage',
        sessionId: id,
        usage: { usedTokens: 1024, maxTokens: 200000, estimated: true },
      },
    ]);
    await f.cli.set({ contextTokens: 4096, staleResult: true, subagentResult: true });
    const input = f.input('hello', id);
    await session.submit(input);
    await vi.waitFor(() => expect(usage()).toHaveLength(3));
    expect(usage().at(-1)).toMatchObject({ usage: { usedTokens: 4096 } });
    await session.close();
    await f.cli.set({ contextTokens: 2048 });
    await (await f.connect()).resumeSession(id);
    expect(usage().at(-1)).toMatchObject({ sessionId: id, usage: { usedTokens: 2048 } });
    const records = await f.cli.records();
    const reads = records.filter(
      (frame) =>
        frame.type === 'control_request' &&
        (frame.request as Record<string, unknown>).subtype === 'get_context_usage',
    );
    expect(reads).toHaveLength(4);
    expect(
      reads.every((frame) => (frame.request as Record<string, unknown>).detail === 'summary'),
    ).toBe(true);
    expect(records.filter((frame) => frame.type === 'user')).toHaveLength(2);
  });
  it('reads native models/efforts without sending a model prompt and reports native authentication', async () => {
    const f = await fixture();
    expect(await f.adapter.catalog.status()).toMatchObject({
      authenticated: true,
      available: true,
      version: '2.1.310 (Claude Code)',
    });
    const models = await f.adapter.catalog.models();
    expect(models.map((model) => model.model)).toEqual([
      'default',
      'opus',
      'fable',
      'sonnet',
      'haiku',
    ]);
    expect(models.map((model) => model.isDefault)).toEqual([true, false, false, false, false]);
    for (const model of models) {
      expect(model.supportedReasoningEfforts).toEqual([
        'default',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      expect(model.defaultReasoningEffort).toBe('default');
    }
    expect((await f.cli.records()).filter((frame) => frame.type === 'user')).toEqual([]);
    await f.cli.set({ unauthenticated: true });
    f.adapter.invalidate();
    expect(await f.adapter.catalog.status()).toMatchObject({
      available: true,
      authenticated: false,
    });
  });
  it('uses only native effort support for custom provider models', async () => {
    const f = await fixture();
    await f.cli.set({
      models: [
        { value: 'provider/no-effort', displayName: 'No effort' },
        {
          value: 'provider/custom-effort',
          displayName: 'Custom effort',
          supportsEffort: true,
          supportedEffortLevels: ['high', 'ultracode'],
        },
      ],
    });
    expect(await f.adapter.catalog.models()).toMatchObject([
      { model: 'provider/no-effort', isDefault: true, supportedReasoningEfforts: ['default'] },
      {
        model: 'provider/custom-effort',
        isDefault: false,
        supportedReasoningEfforts: ['default', 'high', 'ultracode'],
      },
    ]);
  });
  it('persists the ID before neutral initialization, blocks bootstrap tools, preserves user guidance, and resumes the exact session', async () => {
    const f = await fixture();
    await new AgentWorkspace(f.config).prepareWorkspace(f.agent);
    await writeFile(join(f.agent.workspace, 'CLAUDE.md'), '# User guidance\nKeep this section.\n');
    const session = await f.connect();
    const saved: string[] = [];
    const id = await session.createSession((id) => saved.push(id));
    expect(saved).toEqual([id]);
    expect(f.events.every((event) => event.type === 'context_usage')).toBe(true);
    expect(await readFile(join(f.agent.workspace, 'CLAUDE.md'), 'utf8')).toContain(
      '@AGENTS.md\n<!-- isles:end -->\n\n# User guidance',
    );
    const frames = await f.cli.records();
    expect(frames.filter((frame) => frame.type === 'user')).toMatchObject([
      { message: { content: CLAUDE_INITIALIZATION_MESSAGE }, session_id: id },
    ]);
    expect(frames.find((frame) => frame.type === 'control_response')).toMatchObject({
      response: { response: { hookSpecificOutput: { permissionDecision: 'deny' } } },
    });
    const launch = frames.find((frame) => frame.type === 'launch')!;
    const args = launch.args as string[];
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toContain('acceptEdits');
    expect(args).toContain('--add-dir');
    expect(args).toContain('--permission-prompt-tool');
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--strict-mcp-config');
    expect(args.join(' ')).toContain('Bearer ${ISLES_MCP_TOKEN}');
    await session.close();
    const restored = await f.connect();
    expect(await restored.resumeSession(id)).toBe(id);
    expect((await f.cli.records()).filter((frame) => frame.type === 'user')).toHaveLength(1);
    expect(f.output.connected).toHaveBeenCalledTimes(2);
  });
  it('retains the allocated binding when the initialization model call fails', async () => {
    const f = await fixture();
    await f.cli.set({ bootstrapFailure: true });
    const session = await f.connect();
    const saved: string[] = [];
    await expect(session.createSession((id) => saved.push(id))).rejects.toThrow('Bootstrap failed');
    expect(saved).toHaveLength(1);
    expect(f.output.exit).toHaveBeenCalled();
    await f.cli.set({});
    expect(await (await f.connect()).resumeSession(saved[0]!)).toBe(saved[0]);
  });
  it('rejects missing guidance and failed MCP before sending initialization', async () => {
    const f = await fixture();
    await f.cli.set({ missingGuidance: true });
    const session = await f.connect();
    await expect(session.createSession(() => {})).rejects.toThrow('AGENTS.md');
    expect((await f.cli.records()).filter((frame) => frame.type === 'user')).toEqual([]);
    await f.cli.set({ failedMcp: true });
    await expect((await f.connect()).createSession(() => {})).rejects.toThrow('MCP');
  });
  it('rejects missing native sessions without allocating or sending a replacement', async () => {
    const f = await fixture();
    const session = await f.connect();
    await expect(session.resumeSession(randomUUID())).rejects.toThrow('No conversation found');
    expect((await f.cli.records()).filter((frame) => frame.type === 'user')).toEqual([]);
  });
  it('correlates execution to the input UUID and ignores results from earlier inputs', async () => {
    const f = await fixture();
    await f.cli.set({ pendingMcp: true });
    const session = await f.connect();
    const id = await session.createSession(() => {});
    await f.cli.set({ staleResult: true });
    const input = f.input('hello', id);
    expect(await session.submit(input)).toEqual({ turnId: input.runId });
    await vi.waitFor(() =>
      expect(f.events).toContainEqual({
        type: 'turn_completed',
        sessionId: id,
        turnId: input.runId,
        status: 'completed',
        error: null,
      }),
    );
    expect(f.events.filter((event) => event.type === 'turn_completed')).toHaveLength(1);
    await expect(session.submit({ ...f.input('bad', id), model: 'other' })).rejects.toBeInstanceOf(
      HarnessSubmissionRejected,
    );
  });
  it.each([{}, { resultOnlySteer: true }, { resultUsesSteerUuid: true }])(
    'absorbs busy input into the original turn using consumption confirmations %j',
    async (scenario) => {
      const f = await fixture();
      const session = await f.connect();
      const id = await session.createSession(() => {});
      const input = f.input('hold', id);
      await session.submit(input);
      await f.cli.set(scenario);
      const batchId = randomUUID();
      expect(
        await session.steer!({
          sessionId: id,
          expectedTurnId: input.runId,
          batchId,
          text: 'update',
        }),
      ).toEqual({ turnId: input.runId });
      await vi.waitFor(() =>
        expect(f.events.filter((event) => event.type === 'turn_completed')).toEqual([
          {
            type: 'turn_completed',
            sessionId: id,
            turnId: input.runId,
            status: 'completed',
            error: null,
          },
        ]),
      );
      expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
      expect((await f.cli.records()).filter((frame) => frame.type === 'user')).toMatchObject([
        { message: { content: CLAUDE_INITIALIZATION_MESSAGE } },
        { uuid: input.runId },
        { uuid: batchId, session_id: id, message: { content: 'update' } },
      ]);
    },
  );
  it('rejects a different session, turn, or repeated batch before writing native input', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('hold', id);
    await session.submit(input);
    const steer = {
      sessionId: id,
      expectedTurnId: input.runId,
      batchId: randomUUID(),
      text: 'more',
    };
    for (const invalid of [
      { ...steer, sessionId: randomUUID() },
      { ...steer, expectedTurnId: randomUUID() },
      { ...steer, batchId: input.runId },
    ])
      await expect(session.steer!(invalid)).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    await f.cli.set({ keepSteeredTurn: true });
    await session.steer!(steer);
    await expect(session.steer!(steer)).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    expect((await f.cli.records()).filter((frame) => frame.type === 'user')).toHaveLength(3);
  });
  it.each([{ holdSteer: true }, { subagentSteerAck: true }])(
    'waits for main-turn consumption and cancels queued inputs when stopped %j',
    async (scenario) => {
      const f = await fixture();
      const session = await f.connect();
      const id = await session.createSession(() => {});
      const input = f.input('hold', id);
      await session.submit(input);
      await f.cli.set(scenario);
      let settled = false;
      const pending = session.steer!({
        sessionId: id,
        expectedTurnId: input.runId,
        batchId: randomUUID(),
        text: 'pending',
      });
      void pending.then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.waitFor(async () =>
        expect((await f.cli.records()).filter((frame) => frame.type === 'user')).toHaveLength(3),
      );
      expect(settled).toBe(false);
      await session.interrupt(id, input.runId);
      await expect(pending).rejects.toBeInstanceOf(HarnessSubmissionRejected);
      expect(
        (await f.cli.records()).filter((frame) => frame.type === 'control_request'),
      ).toContainEqual(
        expect.objectContaining({ request: { subtype: 'interrupt', cancel_queued: true } }),
      );
      await expect(
        session.steer!({
          sessionId: id,
          expectedTurnId: input.runId,
          batchId: randomUUID(),
          text: 'late',
        }),
      ).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    },
  );
  it('publishes each native turn when queued input runs after the first result', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('hold', id);
    await session.submit(input);
    await f.cli.set({ finishBeforeSteer: true });
    const batchId = randomUUID();
    expect(
      await session.steer!({ sessionId: id, expectedTurnId: input.runId, batchId, text: 'late' }),
    ).toEqual({ turnId: batchId });
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.type === 'turn_completed')).toHaveLength(2),
    );
    expect(f.events.filter((event) => event.type === 'turn_completed')).toEqual([
      {
        type: 'turn_completed',
        sessionId: id,
        turnId: input.runId,
        status: 'completed',
        error: null,
      },
      {
        type: 'turn_completed',
        sessionId: id,
        turnId: batchId,
        status: 'completed',
        error: null,
      },
    ]);
    expect(
      f.events.flatMap((event) =>
        event.type === 'item' ? [{ turnId: event.turnId, text: event.item.text }] : [],
      ),
    ).toEqual([
      { turnId: input.runId, text: 'Original completed' },
      { turnId: batchId, text: 'Reply: late' },
    ]);
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(2);
    expect(f.output.exit).not.toHaveBeenCalled();
    await session.submit(f.input('next normal turn', id));
  });
  it('withdraws input still queued behind a finished turn when stopped', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('hold', id);
    await session.submit(input);
    await f.cli.set({ finishBeforeSteer: true, holdQueued: true });
    const pending = session.steer!({
      sessionId: id,
      expectedTurnId: input.runId,
      batchId: randomUUID(),
      text: 'queued',
    });
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(f.received).toContainEqual(
        expect.objectContaining({ type: 'result', user_message_uuid: input.runId }),
      ),
    );
    expect(f.events.filter((event) => event.type === 'turn_completed')).toEqual([
      expect.objectContaining({ turnId: input.runId, status: 'completed' }),
    ]);
    await session.interrupt(id, input.runId);
    await expect(pending).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    expect(f.events.filter((event) => event.type === 'turn_completed')).toEqual([
      expect.objectContaining({ turnId: input.runId, status: 'completed' }),
    ]);
    expect(f.output.exit).not.toHaveBeenCalled();
  });
  it('closes the connection when the CLI exits before confirming steer input', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('hold', id);
    await session.submit(input);
    await f.cli.set({ exitOnSteer: true });
    await expect(
      session.steer!({
        sessionId: id,
        expectedTurnId: input.runId,
        batchId: randomUUID(),
        text: 'unknown',
      }),
    ).rejects.not.toBeInstanceOf(HarnessSubmissionRejected);
    await expect(session.submit(f.input('after failure', id))).rejects.toBeInstanceOf(
      HarnessSubmissionRejected,
    );
  });
  it('associates a native question emitted after steer with the original platform run', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('hold', id);
    await session.submit(input);
    await f.cli.set({ steerQuestion: true, resultUsesSteerUuid: true });
    await session.steer!({
      sessionId: id,
      expectedTurnId: input.runId,
      batchId: randomUUID(),
      text: 'ask now',
    });
    await vi.waitFor(() => expect(f.questions).toHaveLength(1));
    const question = f.questions[0]!;
    expect(question.turnId).toBe(input.runId);
    session.answer(question.requestId, { answers: { 'question-0': { answers: ['Two'] } } });
    await vi.waitFor(() =>
      expect(f.events).toContainEqual(
        expect.objectContaining({
          type: 'turn_completed',
          turnId: input.runId,
          status: 'completed',
        }),
      ),
    );
  });
  it('releases the active connection and reports one exit when a steer confirmation times out', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('hold', id);
    await session.submit(input);
    await f.cli.set({ holdSteer: true, dropSteerReceipt: true });
    vi.useFakeTimers();
    const pending = session.steer!({
      sessionId: id,
      expectedTurnId: input.runId,
      batchId: randomUUID(),
      text: 'unconfirmed',
    });
    void pending.catch(() => {});
    await vi.waitFor(async () =>
      expect((await f.cli.records()).filter((frame) => frame.type === 'user')).toHaveLength(3),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    await expect(pending).rejects.toThrow('输入确认超时');
    expect(f.output.exit).toHaveBeenCalledTimes(1);
    await expect(session.submit(f.input('after timeout', id))).rejects.toBeInstanceOf(
      HarnessSubmissionRejected,
    );
    const restored = await f.connect();
    expect(await restored.resumeSession(id)).toBe(id);
  });
  it('waits beyond the transport timeout when the CLI has queued steer behind a running tool', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('hold', id);
    await session.submit(input);
    await f.cli.set({ holdSteer: true });
    vi.useFakeTimers();
    const batchId = randomUUID();
    let settled = false;
    const pending = session.steer!({
      sessionId: id,
      expectedTurnId: input.runId,
      batchId,
      text: 'long tool',
    });
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.waitFor(() =>
      expect(f.received).toContainEqual(
        expect.objectContaining({
          type: 'command_lifecycle',
          command_uuid: batchId,
          state: 'queued',
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    expect(f.output.exit).not.toHaveBeenCalled();
    vi.useRealTimers();
    await f.cli.set({ releaseHeld: true });
    await expect(pending).resolves.toEqual({ turnId: batchId });
    await vi.waitFor(() =>
      expect(f.events).toContainEqual(
        expect.objectContaining({ type: 'turn_completed', status: 'completed' }),
      ),
    );
    expect(f.output.exit).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'maps AskUserQuestion (multiSelect=%s) to the pending native request',
    async (multiSelect) => {
      const f = await fixture();
      await f.cli.set({ multiSelect });
      const session = await f.connect();
      const id = await session.createSession(() => {});
      const input = f.input('ask', id);
      await session.submit(input);
      await vi.waitFor(() => expect(f.questions).toHaveLength(1));
      const question = f.questions[0]!;
      expect(question).toMatchObject({
        sessionId: id,
        turnId: input.runId,
        questions: [{ id: 'question-0', question: 'Which result?', multiSelect }],
      });
      const answers = multiSelect ? ['One', 'Two'] : ['Two'];
      session.answer(question.requestId, { answers: { 'question-0': { answers } } });
      await vi.waitFor(() =>
        expect(f.events.some((event) => event.type === 'turn_completed')).toBe(true),
      );
      expect(
        (await f.cli.records()).find(
          (frame) =>
            frame.type === 'control_response' &&
            (frame.response as { request_id: string }).request_id === question.requestId,
        ),
      ).toMatchObject({
        response: {
          response: {
            behavior: 'allow',
            updatedInput: { answers: { 'Which result?': answers.join(', ') } },
          },
        },
      });
      expect(() =>
        session.answer(question.requestId, { answers: { 'question-0': { answers: ['One'] } } }),
      ).toThrow('已失效');
    },
  );
  it('interrupts and closes only its owned process while preserving the session for resume', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('hold', id);
    await session.submit(input);
    await session.interrupt(id, input.runId);
    await vi.waitFor(() =>
      expect(f.events).toContainEqual(
        expect.objectContaining({ type: 'turn_completed', status: 'interrupted' }),
      ),
    );
    await session.close();
    const restored = await f.connect();
    expect(await restored.resumeSession(id)).toBe(id);
  });
  it('allows stop to release a connection while bootstrap is still pending', async () => {
    const f = await fixture();
    await f.cli.set({ blockBootstrap: true });
    const session = await f.connect();
    const saved: string[] = [];
    const creating = session.createSession((id) => saved.push(id));
    void creating.catch(() => {});
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    await session.close();
    await expect(creating).rejects.toThrow('已关闭');
  });
  it('closes on an unexpected main session ID and reports ambiguous input failures', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    await session.submit(f.input('wrong-session', id));
    await vi.waitFor(() => expect(f.output.exit).toHaveBeenCalled());
    const restored = await f.connect();
    await restored.resumeSession(id);
    await f.cli.set({ exitOnInput: true });
    await expect(restored.submit(f.input('hello', id))).rejects.not.toBeInstanceOf(
      HarnessSubmissionRejected,
    );
  });
});
