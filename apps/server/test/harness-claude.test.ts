import { ConfigManager } from '@isles/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter, CLAUDE_INITIALIZATION_MESSAGE } from '../src/claude/adapter.js';
import { ClaudeEnvironment } from '../src/claude/environment.js';
import { ClaudeClient, type ClaudeFrame } from '../src/claude/client.js';
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
  const adapter = new ClaudeAdapter(
    environment,
    undefined,
    (command, args, cwd, env, handlers, log) =>
      new ClaudeClient(
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
      ),
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
  return { root, cli, config, adapter, agent, events, received, questions, output, connect, input };
}

describe('Claude CLI adapter', () => {
  it('reads native models/efforts without sending a model prompt and reports native authentication', async () => {
    const f = await fixture();
    expect(await f.adapter.catalog.status()).toMatchObject({
      authenticated: true,
      available: true,
      version: '2.1.285 (Claude Code)',
    });
    expect(await f.adapter.catalog.models()).toMatchObject([
      {
        model: 'default',
        supportedReasoningEfforts: ['default', 'low', 'high', 'max'],
        defaultReasoningEffort: 'default',
      },
      { model: 'haiku', supportedReasoningEfforts: ['default'] },
    ]);
    expect((await f.cli.records()).filter((frame) => frame.type === 'user')).toEqual([]);
    await f.cli.set({ unauthenticated: true });
    f.adapter.invalidate();
    expect(await f.adapter.catalog.status()).toMatchObject({
      available: true,
      authenticated: false,
    });
  });
  it('persists the ID before neutral initialization, blocks bootstrap tools, preserves user guidance, and resumes the exact session', async () => {
    const f = await fixture();
    await new AgentWorkspace(f.config).prepareWorkspace(f.agent);
    await writeFile(join(f.agent.workspace, 'CLAUDE.md'), '# User guidance\nKeep this section.\n');
    const session = await f.connect();
    const saved: string[] = [];
    const id = await session.createSession((id) => saved.push(id));
    expect(saved).toEqual([id]);
    expect(f.events).toEqual([]);
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
    expect(args).toContain('--dangerously-skip-permissions');
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
  it('withdraws unconsumed input when the original turn ends before its acknowledgement', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('hold', id);
    await session.submit(input);
    await f.cli.set({ finishBeforeSteer: true });
    const batchId = randomUUID();
    await expect(
      session.steer!({ sessionId: id, expectedTurnId: input.runId, batchId, text: 'too late' }),
    ).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    expect(await f.cli.records()).toContainEqual(
      expect.objectContaining({
        type: 'control_request',
        request: { subtype: 'cancel_async_message', message_uuid: batchId },
      }),
    );
    expect(f.events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
    await session.submit(f.input('next normal turn', id));
  });
  it.each([
    { finishBeforeSteer: true, cancelFails: true },
    { lateSteer: true, cancelFails: true },
    { exitOnSteer: true },
  ])(
    'closes ambiguous steer outcomes without treating them as a definite refusal %j',
    async (scenario) => {
      const f = await fixture();
      const session = await f.connect();
      const id = await session.createSession(() => {});
      const input = f.input('hold', id);
      await session.submit(input);
      await f.cli.set(scenario);
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
    },
  );
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
    await expect(pending).rejects.toBeInstanceOf(HarnessSubmissionRejected);
    expect(f.output.exit).not.toHaveBeenCalled();
  });
  it('maps AskUserQuestion and sends the answer only to the pending native request', async () => {
    const f = await fixture();
    const session = await f.connect();
    const id = await session.createSession(() => {});
    const input = f.input('ask', id);
    await session.submit(input);
    await vi.waitFor(() => expect(f.questions).toHaveLength(1));
    const question = f.questions[0]!;
    expect(question).toMatchObject({
      sessionId: id,
      turnId: input.runId,
      questions: [{ id: 'question-0', question: 'Which result?' }],
    });
    session.answer(question.requestId, { answers: { 'question-0': { answers: ['Two'] } } });
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
        response: { behavior: 'allow', updatedInput: { answers: { 'Which result?': 'Two' } } },
      },
    });
    expect(() =>
      session.answer(question.requestId, { answers: { 'question-0': { answers: ['One'] } } }),
    ).toThrow('已失效');
  });
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
