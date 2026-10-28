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
} from '../types.js';
import type { Logger } from '../../logging.js';
import type { AgentRecord } from '../../storage/store.js';
import { additionalWorkspacePaths } from '../../runtime/workspace-paths.js';
import { permissionAllowed, permissionQuestions } from '../shared/permissions.js';
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
const contextUsageSchema = z.object({
  totalTokens: z.number().int().nonnegative(),
  maxTokens: z.number().int().positive(),
});
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

interface NativeTurn {
  id: string;
  sessionId: string;
  bootstrap: boolean;
  interrupted: boolean;
  finish?(error: Error | null): void;
}
interface PendingQuestion {
  input: z.infer<typeof questionInputSchema>;
  turn: NativeTurn;
}

class ClaudeSession implements HarnessSession {
  private readonly workspacePaths: string[];
  private client: ClaudeConnection | undefined;
  private env: Record<string, string> | undefined;
  private sessionId: string | undefined;
  private contextUsageRevision = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  private rootTurn: NativeTurn | undefined;
  private turns = new Map<string, NativeTurn>();
  private receipts = new Map<string, { target?: NativeTurn; turn?: NativeTurn }>();
  private childSessions = new Map<string, string>();
  private childTurns = new Map<string, NativeTurn>();
  private startupError: Error | undefined;
  private exitReported = false;
  private questions = new Map<string, PendingQuestion>();
  private approvals = new Map<string, { input: ClaudeFrame; turn: NativeTurn }>();
  private toolRuns = new Map<string, NativeTurn>();
  constructor(
    private agent: AgentRecord,
    private environment: ClaudeEnvironment,
    private baseUrl: string,
    private output: HarnessHandlers,
    private factory: ClaudeClientFactory,
  ) {
    this.workspacePaths = additionalWorkspacePaths(agent, environment.workspace.sharedDir);
  }
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
      ...(this.agent.dangerFullAccess
        ? ['--dangerously-skip-permissions']
        : ['--permission-mode', 'acceptEdits']),
      '--add-dir',
      ...this.workspacePaths,
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
        cancel: (id) => this.expireRequests(id),
        exit: (error) => this.exit(this.startupError ?? this.error(error)),
      },
      this.environment.log.child({ agentId: this.agent.id }),
    );
    await this.native().control('initialize', {
      hooks: { PreToolUse: [{ matcher: null, hookCallbackIds: ['isles-bootstrap'] }] },
    });
    onCreated?.(sessionId);
    const context = await this.verifyGuidance();
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
    this.contextUsage(sessionId, context);
    return sessionId;
  }
  private async verifyGuidance() {
    const response = await this.native().control('get_context_usage', { detail: 'summary' });
    const context = guidanceSchema.parse(response);
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
    return response;
  }
  private contextUsage(sessionId: string, response: unknown) {
    const usage = contextUsageSchema.safeParse(response);
    if (!usage.success || this.closed || sessionId !== this.sessionId) return;
    this.output.event({
      type: 'context_usage',
      sessionId,
      usage: {
        usedTokens: usage.data.totalTokens,
        maxTokens: usage.data.maxTokens,
        estimated: true,
      },
    });
  }
  private async refreshContextUsage(sessionId: string) {
    const revision = ++this.contextUsageRevision;
    try {
      const response = await this.native().control('get_context_usage', { detail: 'summary' });
      // Native controls can finish out of order while appended inputs complete successive turns.
      if (revision === this.contextUsageRevision) this.contextUsage(sessionId, response);
    } catch (error) {
      if (!this.closed)
        this.environment.log.warn(
          { err: this.error(error) },
          'Claude Code context usage unavailable',
        );
    }
  }
  async createSession(onCreated: (id: string) => void) {
    try {
      const id = await this.start(randomUUID(), false, onCreated);
      const messageId = randomUUID();
      let timer: NodeJS.Timeout | undefined;
      const completed = new Promise<void>((resolve, reject) => {
        this.rootTurn = {
          id: messageId,
          sessionId: id,
          bootstrap: true,
          interrupted: false,
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
      this.rootTurn = undefined;
      await this.refreshContextUsage(id);
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
      this.closed ||
      this.rootTurn ||
      [...this.receipts.values()].some((receipt) => !receipt.turn)
    )
      throw new HarnessSubmissionRejected('Claude Code 输入与当前会话配置不一致');
    const receipt: { turn?: NativeTurn } = {};
    this.receipts.set(input.runId, receipt);
    try {
      await this.native().sendUser(input.sessionId, input.runId, input.text);
      if (!receipt.turn) throw new Error('Claude Code 尚未确认输入所属原生回合');
      return { turnId: receipt.turn.id };
    } catch (error) {
      if (error instanceof ClaudeInputRejected) {
        this.receipts.delete(input.runId);
        throw new HarnessSubmissionRejected(error.message);
      }
      throw error;
    }
  }
  async steer(input: HarnessSteerInput) {
    const active = this.rootTurn;
    if (
      this.closed ||
      input.sessionId !== this.sessionId ||
      !active ||
      active.bootstrap ||
      active.interrupted ||
      input.expectedTurnId !== active.id ||
      input.batchId === active.id ||
      this.receipts.has(input.batchId)
    )
      throw new HarnessSubmissionRejected('Claude Code 追加输入与当前执行不一致');
    const receipt: { target: NativeTurn; turn?: NativeTurn } = { target: active };
    this.receipts.set(input.batchId, receipt);
    try {
      await this.native().sendUser(input.sessionId, input.batchId, input.text, {
        waitForConsumption: true,
      });
      if (!receipt.turn) throw new Error('Claude Code 尚未确认追加输入所属原生回合');
      return { turnId: receipt.turn.id };
    } catch (error) {
      if (error instanceof ClaudeInputRejected || error instanceof HarnessSubmissionRejected) {
        this.receipts.delete(input.batchId);
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
    if (sessionId !== this.sessionId || this.closed) return;
    if (
      this.rootTurn?.id !== turnId &&
      ![...this.receipts.values()].some(
        (receipt) => receipt.target?.id === turnId && !receipt.turn,
      ) &&
      !this.childTurns.size
    )
      return;
    for (const turn of this.turns.values()) turn.interrupted = true;
    this.expireRequests(undefined, true);
    await this.native().control('interrupt', { cancel_queued: true });
  }
  answer(requestId: HarnessRequestId, answer: QuestionAnswer) {
    const key = String(requestId);
    const approval = this.approvals.get(key);
    if (approval) {
      if (!this.turns.has(this.turnKey(approval.turn)))
        throw new Error('Claude Code 原生权限请求已失效');
      const allowed = permissionAllowed(answer);
      this.approvals.delete(key);
      this.native().respond(
        key,
        allowed
          ? { behavior: 'allow', updatedInput: approval.input }
          : { behavior: 'deny', message: '用户拒绝本次执行' },
      );
      return;
    }
    const pending = this.questions.get(key);
    if (!pending || !this.turns.has(this.turnKey(pending.turn)))
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
    this.approvals.delete(key);
    if (!this.closed) this.native().respond(key, { behavior: 'deny', message: reason });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.expireRequests(undefined, true);
    this.closed = true;
    this.rootTurn?.finish?.(new Error('Claude Code 连接已关闭'));
    this.questions.clear();
    this.turns.clear();
    this.receipts.clear();
    this.toolRuns.clear();
    this.childTurns.clear();
    this.childSessions.clear();
    this.closing = this.client?.close() ?? Promise.resolve();
    return this.closing;
  }
  private exit(error: Error) {
    if (this.exitReported) return;
    this.exitReported = true;
    this.expireRequests();
    this.rootTurn?.finish?.(error);
    this.turns.clear();
    this.receipts.clear();
    this.toolRuns.clear();
    this.childTurns.clear();
    this.childSessions.clear();
    this.output.exit(error);
  }
  private request(id: string, request: ClaudeFrame) {
    if (request.subtype === 'hook_callback' && request.callback_id === 'isles-bootstrap') {
      this.native().respond(
        id,
        this.rootTurn?.bootstrap
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
    const turn =
      typeof request.tool_use_id === 'string' ? this.toolRuns.get(request.tool_use_id) : undefined;
    if (request.subtype !== 'can_use_tool' || !turn || !this.turns.has(this.turnKey(turn))) {
      this.native().respond(id, {
        behavior: 'deny',
        message: 'Isles cannot accept this native request in the current run',
      });
      return;
    }
    if (request.tool_name !== 'AskUserQuestion') {
      if (request.requires_user_interaction === true) {
        this.native().respond(id, {
          behavior: 'deny',
          message: '该原生请求需要专用交互，请在 Claude Code 会话中处理。',
        });
        return;
      }
      const input = object(request.input);
      if (!input || typeof request.tool_name !== 'string') {
        this.native().respond(id, { behavior: 'deny', message: '原生权限请求无效' });
        return;
      }
      this.approvals.set(id, { input, turn });
      this.output.question({
        sessionId: turn.sessionId,
        turnId: turn.id,
        requestId: id,
        questions: permissionQuestions(
          this.environment.redactor.output(
            [
              request.tool_name,
              typeof request.decision_reason === 'string' ? request.decision_reason : '',
              JSON.stringify(input),
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        ),
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
    this.questions.set(id, { input: input.data, turn });
    this.output.question({
      sessionId: turn.sessionId,
      turnId: turn.id,
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
  private turnKey(turn: Pick<NativeTurn, 'sessionId' | 'id'>) {
    return JSON.stringify([turn.sessionId, turn.id]);
  }
  private beginTurn(sessionId: string, id: string) {
    const key = this.turnKey({ sessionId, id });
    const existing = this.turns.get(key);
    if (existing) return existing;
    const turn: NativeTurn = { sessionId, id, bootstrap: false, interrupted: false };
    this.turns.set(key, turn);
    if (sessionId === this.sessionId) this.rootTurn = turn;
    else this.childTurns.set(sessionId, turn);
    this.output.event({ type: 'turn_started', sessionId, turnId: id });
    return turn;
  }
  private completeTurn(turn: NativeTurn, failure: Error | null) {
    if (turn.bootstrap) {
      turn.finish?.(failure);
      return;
    }
    if (!this.turns.delete(this.turnKey(turn))) return;
    for (const [id, pending] of [...this.questions, ...this.approvals])
      if (pending.turn === turn) this.expireRequests(id);
    for (const [id, owner] of this.toolRuns) if (owner === turn) this.toolRuns.delete(id);
    if (this.rootTurn === turn) this.rootTurn = undefined;
    if (this.childTurns.get(turn.sessionId) === turn) this.childTurns.delete(turn.sessionId);
    this.output.event({
      type: 'turn_completed',
      sessionId: turn.sessionId,
      turnId: turn.id,
      status: turn.interrupted ? 'interrupted' : failure ? 'failed' : 'completed',
      error: failure?.message ?? null,
    });
    if (turn.sessionId === this.sessionId) void this.refreshContextUsage(turn.sessionId);
  }
  private event(frame: ClaudeFrame) {
    if (this.closed) return;
    const root = this.sessionId;
    if (!root) return;
    if (typeof frame.session_id !== 'string') return;
    if (frame.isReplay === true && frame.type !== 'user') return;
    const parent =
      typeof frame.parent_tool_use_id === 'string' ? frame.parent_tool_use_id : undefined;
    if (typeof frame.session_id === 'string' && frame.session_id !== root && !parent)
      throw new Error('Claude Code 返回了不同 session ID，已拒绝继续执行');
    // Forwarded children are linked by native Agent tools or task_started frames.
    const sessionId = parent ? this.childSessions.get(parent) : root;
    if (!sessionId) return;
    if (this.rootTurn?.bootstrap) {
      if (
        !parent &&
        frame.type === 'result' &&
        (frame.user_message_uuid === this.rootTurn.id ||
          (Array.isArray(frame.user_message_uuids) &&
            frame.user_message_uuids.includes(this.rootTurn.id)))
      )
        this.completeTurn(
          this.rootTurn,
          frame.is_error === true || frame.subtype !== 'success' ? this.resultError(frame) : null,
        );
      return;
    }
    if (
      frame.type === 'system' &&
      frame.subtype === 'task_started' &&
      typeof frame.task_id === 'string' &&
      typeof frame.tool_use_id === 'string'
    ) {
      const nativeId = typeof frame.agent_id === 'string' ? frame.agent_id : frame.task_id;
      const previous = this.childSessions.get(frame.tool_use_id);
      const childId =
        previous && this.childTurns.has(previous)
          ? previous
          : root + '/agents/' + encodeURIComponent(nativeId);
      this.childSessions.set(frame.tool_use_id, childId);
      this.childSessions.set(frame.task_id, childId);
      this.beginTurn(childId, typeof frame.run_id === 'string' ? frame.run_id : frame.task_id);
      return;
    }
    if (
      frame.type === 'system' &&
      frame.subtype === 'task_notification' &&
      typeof frame.task_id === 'string'
    ) {
      const childId = this.childSessions.get(frame.task_id);
      const child = childId ? this.childTurns.get(childId) : undefined;
      if (child) {
        child.interrupted ||= ['stopped', 'cancelled', 'killed'].includes(String(frame.status));
        this.item(child, {
          id: frame.task_id,
          type: 'status',
          status: frame.status === 'failed' ? 'failed' : 'completed',
          text: String(frame.summary ?? frame.status ?? 'completed'),
        });
        this.completeTurn(
          child,
          frame.status === 'failed'
            ? this.error(frame.summary ?? 'Claude Code 子代理执行失败')
            : null,
        );
      }
      return;
    }
    if (
      frame.type === 'system' &&
      ['task_updated', 'task_progress'].includes(String(frame.subtype)) &&
      typeof frame.task_id === 'string'
    ) {
      const childId = this.childSessions.get(frame.task_id);
      const child = childId ? this.childTurns.get(childId) : undefined;
      const patch = object(frame.patch);
      if (child)
        this.item(child, {
          id: String(frame.uuid ?? frame.task_id + ':status'),
          type: 'status',
          status:
            patch?.status === 'failed'
              ? 'failed'
              : patch?.status === 'completed'
                ? 'completed'
                : 'running',
          text: String(frame.description ?? frame.summary ?? patch?.status ?? frame.subtype),
        });
      return;
    }
    const commandId = typeof frame.command_uuid === 'string' ? frame.command_uuid : undefined;
    if (!parent && frame.type === 'command_lifecycle' && frame.state === 'cancelled' && commandId) {
      this.receipts.delete(commandId);
      return;
    }
    let turn = parent ? this.childTurns.get(sessionId) : this.rootTurn;
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
    if (frame.type === 'command_lifecycle' && frame.state === 'started' && commandId)
      turn ??= this.beginTurn(sessionId, commandId);
    if (!parent) {
      for (const id of consumed) {
        if (typeof id !== 'string') continue;
        const receipt = this.receipts.get(id);
        if (!receipt || receipt.turn) continue;
        if (!turn) turn = this.beginTurn(root, id);
        receipt.turn ??= turn;
      }
    }
    const inputId =
      typeof frame.user_message_uuid === 'string' ? frame.user_message_uuid : undefined;
    const receiptTurn = inputId ? this.receipts.get(inputId)?.turn : undefined;
    if (receiptTurn && !this.turns.has(this.turnKey(receiptTurn))) return;
    // Autonomous wakeups have no command/input UUID. Their first live assistant UUID
    // identifies the native turn until its result arrives.
    if (
      !turn &&
      frame.type === 'assistant' &&
      frame.isReplay !== true &&
      typeof frame.uuid === 'string'
    )
      turn = this.beginTurn(
        sessionId,
        typeof frame.user_message_uuid === 'string'
          ? frame.user_message_uuid
          : String(frame.uuid ?? randomUUID()),
      );
    if (!turn && frame.type === 'result' && object(frame.origin) && typeof frame.uuid === 'string')
      turn = this.beginTurn(sessionId, frame.uuid);
    if (!turn) {
      if (!parent && frame.type === 'result' && frame.is_error === true && !frame.user_message_uuid)
        this.startupError = this.resultError(frame);
      return;
    }
    const associated =
      Boolean(parent) ||
      !inputId ||
      inputId === turn.id ||
      this.receipts.get(inputId)?.turn === turn;
    if (frame.type === 'result') {
      if (!associated) return;
      this.completeTurn(
        turn,
        frame.is_error === true || frame.subtype !== 'success' ? this.resultError(frame) : null,
      );
      return;
    }
    if (frame.type === 'assistant' && associated) {
      const message = object(frame.message);
      if (!message || !Array.isArray(message.content)) return;
      message.content.forEach((value, index) => {
        const block = object(value);
        if (!block || typeof block.type !== 'string') return;
        const id =
          typeof block.id === 'string' ? block.id : String(message.id ?? frame.uuid) + ':' + index;
        const text =
          typeof block.text === 'string'
            ? block.text
            : typeof block.thinking === 'string'
              ? block.thinking
              : String(block.name ?? block.type) + '\n' + JSON.stringify(block.input ?? {});
        if (block.type === 'tool_use') {
          this.toolRuns.set(id, turn!);
          if (block.name === 'Agent' || block.name === 'Task')
            this.childSessions.set(id, root + '/agents/' + encodeURIComponent(id));
        }
        this.item(turn!, {
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
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const owner = this.toolRuns.get(block.tool_use_id);
        if (!owner) continue;
        this.item(owner, {
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
      this.item(turn, {
        id: String(frame.uuid ?? randomUUID()),
        type: 'status',
        status: 'running',
        text: frame.status,
      });
    } else if (frame.type === 'tool_progress' && typeof frame.tool_use_id === 'string') {
      const owner = this.toolRuns.get(frame.tool_use_id);
      if (owner)
        this.item(owner, {
          id: frame.tool_use_id + ':progress',
          type: 'status',
          status: 'running',
          text:
            String(frame.tool_name ?? 'Tool') +
            ' · ' +
            String(frame.elapsed_time_seconds ?? 0) +
            's',
        });
    }
  }
  private expireRequests(id?: string, deny = false) {
    for (const [key, pending] of [...this.questions, ...this.approvals]) {
      if (id !== undefined && key !== id) continue;
      this.questions.delete(key);
      this.approvals.delete(key);
      if (deny && this.client && !this.closed)
        this.client.respond(key, { behavior: 'deny', message: '执行已结束' });
      this.output.event({
        type: 'question_expired',
        sessionId: pending.turn.sessionId,
        turnId: pending.turn.id,
        requestId: key,
      });
    }
  }
  private item(turn: NativeTurn, item: RunItem) {
    if (turn.bootstrap) return;
    this.output.event({
      type: 'item',
      sessionId: turn.sessionId,
      turnId: turn.id,
      append: false,
      item: { ...item, text: this.environment.redactor.output(item.text) },
    });
  }
}
