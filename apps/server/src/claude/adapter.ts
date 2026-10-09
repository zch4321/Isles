import type { HarnessDescriptor, QuestionAnswer, RunItem } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  HarnessSubmissionRejected,
  type HarnessAdapter,
  type HarnessCatalog,
  type HarnessHandlers,
  type HarnessRequestId,
  type HarnessSession,
  type HarnessSteerInput,
  type HarnessTurnInput,
} from '../harness/types.js';
import type { Logger } from '../logging.js';
import type { AgentRecord } from '../storage/store.js';
import { ClaudeCatalog } from './catalog.js';
import {
  ClaudeClient,
  ClaudeInputRejected,
  type ClaudeConnection,
  type ClaudeFrame,
  type ClaudeHandlers,
} from './client.js';
import type { ClaudeEnvironment } from './environment.js';
import type { ClaudeCommand } from './executable.js';

export const CLAUDE_INITIALIZATION_MESSAGE =
  'Isles session initialized. Reply only READY. Do not use tools or send messages.';
const guidanceSchema = z.object({ memoryFiles: z.array(z.object({ path: z.string() })) });
const mcpSchema = z.object({
  mcpServers: z.array(z.object({ name: z.string(), status: z.string() })),
});
const questionInputSchema = z
  .object({
    questions: z
      .array(
        z.object({
          question: z.string(),
          header: z.string(),
          options: z.array(z.object({ label: z.string(), description: z.string() })),
          multiSelect: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(4),
  })
  .passthrough();
const object = (value: unknown): ClaudeFrame | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ClaudeFrame) : undefined;

export type ClaudeClientFactory = (
  command: ClaudeCommand,
  args: string[],
  workspace: string,
  env: Record<string, string>,
  handlers: ClaudeHandlers,
  log: Logger,
) => ClaudeConnection;

export class ClaudeAdapter implements HarnessAdapter {
  readonly descriptor: HarnessDescriptor = {
    id: 'claude',
    displayName: 'Claude Code',
    configuration: 'cli-path',
    capabilities: {
      sessionResume: true,
      interrupt: true,
      steer: true,
      userQuestions: true,
      nativeSubagents: true,
      mcp: true,
      workspaceInstructions: true,
    },
  };
  private readonly factory: ClaudeClientFactory;
  constructor(
    readonly environment: ClaudeEnvironment,
    readonly catalog: HarnessCatalog = new ClaudeCatalog(environment),
    factory?: ClaudeClientFactory,
  ) {
    this.factory =
      factory ??
      ((command, args, workspace, env, handlers, log) =>
        new ClaudeClient(command, args, workspace, env, handlers, environment.redactor, log));
  }
  get nativeHome() {
    return this.environment.home;
  }
  invalidate() {
    this.environment.invalidate();
    this.catalog.invalidate?.();
  }
  async connect(agent: AgentRecord, baseUrl: string, handlers: HarnessHandlers) {
    const session = new ClaudeSession(agent, this.environment, baseUrl, handlers, this.factory);
    handlers.connected(session);
    try {
      await session.prepare();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
}

interface ActiveInput {
  id: string;
  bootstrap: boolean;
  interrupted: boolean;
  steers: Map<string, { accepted: boolean; ended: Promise<void>; end(): void }>;
  /** A result for this run arrived; the run ends once no appended input awaits consumption. */
  idle: boolean;
  failure: Error | null;
  finish(error: Error | null): void;
}
interface PendingQuestion {
  input: z.infer<typeof questionInputSchema>;
  turnId: string;
}

class ClaudeSession implements HarnessSession {
  private client: ClaudeConnection | undefined;
  private env: Record<string, string> | undefined;
  private sessionId: string | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private active: ActiveInput | undefined;
  private startupError: Error | undefined;
  private exitReported = false;
  private questions = new Map<string, PendingQuestion>();
  private toolRuns = new Map<string, string>();
  constructor(
    private agent: AgentRecord,
    private environment: ClaudeEnvironment,
    private baseUrl: string,
    private output: HarnessHandlers,
    private factory: ClaudeClientFactory,
  ) {}
  async prepare() {
    this.env = await this.environment.launch(this.agent);
    if (this.closed) throw new Error('Claude Code 连接已停止');
    await this.environment.executable();
  }
  private native() {
    if (!this.client || this.closed) throw new ClaudeInputRejected('Claude Code 连接已关闭');
    return this.client;
  }
  private error(value: unknown) {
    return new Error(this.environment.redactor.text(value));
  }
  private async start(sessionId: string, resume: boolean, onCreated?: (id: string) => void) {
    if (this.closed || this.client || !this.env) throw new Error('Claude Code 连接状态无效');
    this.sessionId = sessionId;
    const command = await this.environment.executable();
    if (this.closed) throw new Error('Claude Code 连接已停止');
    const args = [
      resume ? `--resume=${sessionId}` : `--session-id=${sessionId}`,
      ...(this.agent.model === 'default' ? [] : ['--model', this.agent.model]),
      '--dangerously-skip-permissions',
      '--permission-prompt-tool',
      'stdio',
      ...(this.agent.reasoningEffort === 'default' ? [] : ['--effort', this.agent.reasoningEffort]),
      '--mcp-config',
      JSON.stringify({
        mcpServers: {
          isles: {
            type: 'http',
            url: `${this.baseUrl}/mcp/${this.agent.id}`,
            headers: { Authorization: 'Bearer ${ISLES_MCP_TOKEN}' },
          },
        },
      }),
    ];
    this.client = this.factory(
      command,
      args,
      this.agent.workspace,
      this.env,
      {
        event: (frame) => this.event(frame),
        request: (id, request) => this.request(id, request),
        cancel: (id) => this.questions.delete(id),
        exit: (error) => this.exit(this.startupError ?? this.error(error)),
      },
      this.environment.log.child({ agentId: this.agent.id }),
    );
    await this.native().control('initialize', {
      hooks: { PreToolUse: [{ matcher: null, hookCallbackIds: ['isles-bootstrap'] }] },
    });
    onCreated?.(sessionId);
    await this.verifyGuidance();
    const deadline = Date.now() + 30_000;
    for (;;) {
      const status = mcpSchema
        .parse(await this.native().control('mcp_status'))
        .mcpServers.find((server) => server.name === 'isles');
      if (status?.status === 'connected') break;
      if (!status || !['pending', 'connecting'].includes(status.status) || Date.now() >= deadline)
        throw new Error(
          `Claude Code 未连接 Isles MCP（${status?.status ?? 'missing'}），请检查服务与原生 MCP 配置。`,
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return sessionId;
  }
  private async verifyGuidance() {
    const context = guidanceSchema.parse(await this.native().control('get_context_usage'));
    const normalize = async (path: string) => {
      const absolute = await realpath(resolve(this.agent.workspace, path));
      return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    };
    const loaded = new Set(
      await Promise.all(context.memoryFiles.map((file) => normalize(file.path))),
    );
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      if (!loaded.has(await normalize(join(this.agent.workspace, name))))
        throw new Error(
          `Claude Code 未确认加载工作目录的 ${name}，请检查规则排除设置与 CLI 版本。`,
        );
    }
  }
  async createSession(onCreated: (id: string) => void) {
    try {
      const id = await this.start(randomUUID(), false, onCreated);
      const messageId = randomUUID();
      let timer: NodeJS.Timeout | undefined;
      const completed = new Promise<void>((resolve, reject) => {
        this.active = {
          id: messageId,
          bootstrap: true,
          interrupted: false,
          steers: new Map(),
          idle: false,
          failure: null,
          finish: (error) => {
            if (timer) clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          },
        };
        timer = setTimeout(
          () => reject(new Error('Claude Code 初始化回合超时，请核对原生会话记录。')),
          120_000,
        );
      });
      // Attach the failure observer before the input can fail or complete synchronously.
      void completed.catch(() => {});
      await this.native().sendUser(id, messageId, CLAUDE_INITIALIZATION_MESSAGE);
      await completed;
      this.active = undefined;
      return id;
    } catch (error) {
      await this.close();
      this.exit(this.error(error));
      throw error;
    }
  }
  async resumeSession(sessionId: string) {
    if (!z.uuid().safeParse(sessionId).success) throw new Error('Claude Code session ID 无效');
    try {
      return await this.start(sessionId, true);
    } catch (error) {
      await this.close();
      this.exit(this.error(error));
      throw error;
    }
  }
  async submit(input: HarnessTurnInput) {
    if (
      input.sessionId !== this.sessionId ||
      input.workspace !== this.agent.workspace ||
      input.model !== this.agent.model ||
      input.reasoningEffort !== this.agent.reasoningEffort ||
      this.active
    )
      throw new HarnessSubmissionRejected('Claude Code 输入与当前会话配置不一致');
    const active: ActiveInput = {
      id: input.runId,
      bootstrap: false,
      interrupted: false,
      steers: new Map(),
      idle: false,
      failure: null,
      finish: () => {
        for (const batch of active.steers.values()) batch.end();
      },
    };
    this.active = active;
    try {
      await this.native().sendUser(input.sessionId, input.runId, input.text);
      return { turnId: input.runId };
    } catch (error) {
      if (error instanceof ClaudeInputRejected) {
        this.active = undefined;
        throw new HarnessSubmissionRejected(error.message);
      }
      throw error;
    }
  }
  async steer(input: HarnessSteerInput) {
    const active = this.active;
    if (
      this.closed ||
      input.sessionId !== this.sessionId ||
      !active ||
      active.bootstrap ||
      active.interrupted ||
      input.expectedTurnId !== active.id ||
      input.batchId === active.id ||
      active.steers.has(input.batchId)
    )
      throw new HarnessSubmissionRejected('Claude Code 追加输入与当前执行不一致');
    let end!: () => void;
    const batch = {
      accepted: false,
      ended: new Promise<void>((resolve) => (end = resolve)),
      end: () => end(),
    };
    active.steers.set(input.batchId, batch);
    try {
      // The CLI consumes queued input at a tool boundary of the current turn, or runs it as the
      // next native turn once this one ends. The run stays open until then, so both count here.
      await Promise.race([
        this.native()
          .sendUser(input.sessionId, input.batchId, input.text, { waitForConsumption: true })
          .then(() => {
            if (!batch.accepted)
              throw new Error('Claude Code 尚未确认追加输入进入目标执行，请核对原生记录。');
          }),
        batch.ended.then(() => {
          if (!batch.accepted) throw new Error('Claude Code 连接已关闭，追加输入结果待核对。');
        }),
      ]);
      return { turnId: active.id };
    } catch (error) {
      if (error instanceof ClaudeInputRejected || error instanceof HarnessSubmissionRejected) {
        active.steers.delete(input.batchId);
        this.settle(active);
        throw new HarnessSubmissionRejected(this.environment.redactor.text(error));
      }
      // Unconfirmed input must not execute outside a tracked run; close the owning process.
      const failure = this.error(error);
      await this.close();
      this.exit(failure);
      throw failure;
    }
  }
  async interrupt(sessionId: string, turnId: string) {
    if (sessionId !== this.sessionId || this.active?.id !== turnId) return;
    this.active.interrupted = true;
    await this.native().control('interrupt', { cancel_queued: true });
  }
  answer(requestId: HarnessRequestId, answer: QuestionAnswer) {
    const key = String(requestId);
    const pending = this.questions.get(key);
    if (!pending || pending.turnId !== this.active?.id)
      throw new Error('Claude Code 原生问题已失效');
    const answers: Record<string, string> = {};
    pending.input.questions.forEach((question, index) => {
      answers[question.question] = answer.answers[`question-${index}`]?.answers.join(', ') ?? '';
    });
    this.native().respond(key, { behavior: 'allow', updatedInput: { ...pending.input, answers } });
    this.questions.delete(key);
  }
  rejectQuestion(requestId: HarnessRequestId, reason: string) {
    const key = String(requestId);
    this.questions.delete(key);
    if (!this.closed) this.native().respond(key, { behavior: 'deny', message: reason });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.active?.finish(new Error('Claude Code 连接已关闭'));
    this.questions.clear();
    this.closing = this.client?.close() ?? Promise.resolve();
    return this.closing;
  }
  private exit(error: Error) {
    if (this.exitReported) return;
    this.exitReported = true;
    this.active?.finish(error);
    this.output.exit(error);
  }
  private request(id: string, request: ClaudeFrame) {
    if (request.subtype === 'hook_callback' && request.callback_id === 'isles-bootstrap') {
      this.native().respond(
        id,
        this.active?.bootstrap
          ? {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Session initialization only; reply READY without tools.',
              },
            }
          : {},
      );
      return;
    }
    if (
      request.subtype !== 'can_use_tool' ||
      request.tool_name !== 'AskUserQuestion' ||
      !this.active ||
      this.active.bootstrap ||
      typeof request.tool_use_id !== 'string' ||
      this.toolRuns.get(request.tool_use_id) !== this.active.id
    ) {
      this.native().respond(id, {
        behavior: 'deny',
        message: 'Isles cannot accept this native request in the current run',
      });
      return;
    }
    const input = questionInputSchema.safeParse(request.input);
    if (
      !input.success ||
      new Set(input.data.questions.map((q) => q.question)).size !== input.data.questions.length
    ) {
      this.native().respond(id, { behavior: 'deny', message: 'Unsupported Claude question input' });
      return;
    }
    this.questions.set(id, { input: input.data, turnId: this.active.id });
    this.output.question({
      sessionId: this.sessionId!,
      turnId: this.active.id,
      requestId: id,
      questions: input.data.questions.map((question, index) => ({
        id: `question-${index}`,
        header: question.header,
        question: question.question,
        options: question.options,
        isOther: true,
        isSecret: false,
        multiSelect: question.multiSelect ?? false,
      })),
    });
  }
  private resultError(frame: ClaudeFrame) {
    const message =
      typeof frame.result === 'string'
        ? frame.result
        : Array.isArray(frame.errors)
          ? frame.errors.filter((error) => typeof error === 'string').join('\n')
          : 'Claude Code 原生回合失败';
    return this.error(message || 'Claude Code 原生回合失败');
  }
  private event(frame: ClaudeFrame) {
    const active = this.active;
    if (
      typeof frame.session_id === 'string' &&
      frame.session_id !== this.sessionId &&
      !frame.parent_tool_use_id
    )
      throw new Error('Claude Code 返回了不同 session ID，已拒绝继续执行');
    if (!active) {
      if (frame.type === 'result' && frame.is_error === true)
        this.startupError = this.resultError(frame);
      return;
    }
    const consumed =
      frame.type === 'user' && frame.isReplay === true
        ? [frame.uuid]
        : frame.type === 'command_lifecycle' && frame.state === 'started'
          ? [frame.command_uuid]
          : frame.type === 'result'
            ? [
                frame.user_message_uuid,
                ...(Array.isArray(frame.user_message_uuids) ? frame.user_message_uuids : []),
              ]
            : [];
    if (frame.session_id === this.sessionId && !frame.parent_tool_use_id) {
      for (const id of consumed)
        if (typeof id === 'string') {
          const batch = active.steers.get(id);
          if (batch && !batch.accepted) {
            batch.accepted = true;
            // Input queued behind a finished turn starts the next native turn of this run.
            active.idle = false;
          }
        }
      // Withdrawn input (stop cancels the native queue) no longer holds the run open.
      if (
        frame.type === 'command_lifecycle' &&
        frame.state === 'cancelled' &&
        typeof frame.command_uuid === 'string' &&
        active.steers.get(frame.command_uuid)?.accepted === false
      ) {
        active.steers.delete(frame.command_uuid);
        this.settle(active);
        if (this.active !== active) return;
      }
    }
    const matches = (id: unknown) =>
      id === active.id || (typeof id === 'string' && active.steers.get(id)?.accepted === true);
    const associated =
      matches(frame.user_message_uuid) ||
      (Array.isArray(frame.user_message_uuids) && frame.user_message_uuids.some(matches));
    if (frame.type === 'result') {
      if (!associated || frame.parent_tool_use_id) return;
      const failure =
        frame.is_error === true || frame.subtype !== 'success' ? this.resultError(frame) : null;
      if (active.bootstrap) active.finish(failure);
      else {
        active.failure ??= failure;
        active.idle = true;
        this.settle(active);
      }
      return;
    }
    if (active.bootstrap) return;
    if (
      frame.type === 'command_lifecycle' &&
      frame.command_uuid === active.id &&
      frame.state === 'started'
    ) {
      this.output.event({ type: 'turn_started', sessionId: this.sessionId!, turnId: active.id });
      return;
    }
    if (frame.type === 'assistant' && (!frame.user_message_uuid || associated)) {
      const message = object(frame.message);
      if (!message || !Array.isArray(message.content)) return;
      message.content.forEach((value, index) => {
        const block = object(value);
        if (!block || typeof block.type !== 'string') return;
        const id =
          typeof block.id === 'string' ? block.id : `${String(message.id ?? frame.uuid)}:${index}`;
        const text =
          typeof block.text === 'string'
            ? block.text
            : typeof block.thinking === 'string'
              ? block.thinking
              : `${String(block.name ?? block.type)}\n${JSON.stringify(block.input ?? {})}`;
        if (block.type === 'tool_use') this.toolRuns.set(id, active.id);
        this.item({
          id,
          type:
            block.type === 'tool_use'
              ? 'toolCall'
              : block.type === 'thinking'
                ? 'reasoning'
                : 'agentMessage',
          status: block.type === 'tool_use' ? 'running' : 'completed',
          text,
        });
      });
    } else if (frame.type === 'user' && frame.isReplay !== true) {
      const message = object(frame.message);
      if (!message || !Array.isArray(message.content)) return;
      for (const value of message.content) {
        const block = object(value);
        if (
          block?.type !== 'tool_result' ||
          typeof block.tool_use_id !== 'string' ||
          this.toolRuns.get(block.tool_use_id) !== active.id
        )
          continue;
        this.item({
          id: block.tool_use_id,
          type: 'toolCall',
          status: block.is_error ? 'failed' : 'completed',
          text:
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? []),
        });
      }
    } else if (
      frame.type === 'system' &&
      frame.subtype === 'status' &&
      typeof frame.status === 'string'
    ) {
      this.item({
        id: String(frame.uuid ?? randomUUID()),
        type: 'status',
        status: 'running',
        text: frame.status,
      });
    }
  }
  /** Complete the run once the CLI is idle and every appended input was consumed or withdrawn. */
  private settle(active: ActiveInput) {
    if (
      this.active !== active ||
      !active.idle ||
      [...active.steers.values()].some((batch) => !batch.accepted)
    )
      return;
    this.active = undefined;
    active.finish(active.failure);
    this.questions.clear();
    this.toolRuns.clear();
    this.output.event({
      type: 'turn_completed',
      sessionId: this.sessionId!,
      turnId: active.id,
      status: active.interrupted ? 'interrupted' : active.failure ? 'failed' : 'completed',
      error: active.failure?.message ?? null,
    });
  }
  private item(item: RunItem) {
    if (!this.active || this.active.bootstrap) return;
    this.output.event({
      type: 'item',
      sessionId: this.sessionId!,
      turnId: this.active.id,
      append: false,
      item: { ...item, text: this.environment.redactor.text(item.text) },
    });
  }
}
