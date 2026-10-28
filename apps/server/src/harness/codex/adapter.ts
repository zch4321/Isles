import type { HarnessDescriptor, QuestionAnswer } from '@isles/contracts';
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
import type { AgentRecord } from '../../storage/store.js';
import { additionalWorkspacePaths } from '../../runtime/workspace-paths.js';
import { NativeCatalog } from './catalog.js';
import { StdioClient } from './client.js';
import type { NativeEnvironment } from './environment.js';
import { permissionAllowed, permissionQuestions } from '../shared/permissions.js';
import {
  approvalRequestSchema,
  inputRequestSchema,
  NativeRpcError,
  threadResponseSchema,
  tokenUsageNotificationSchema,
  turnNotificationSchema,
  turnResponseSchema,
  turnSteerResponseSchema,
  type NativeClient,
  type NativeHandlers,
} from './protocol.js';

/** Factories may publish the client before initialization to allow cancellation. */
export type CodexClientFactory = (
  agent: AgentRecord,
  handlers: NativeHandlers,
  baseUrl: string,
  connecting: (client: NativeClient) => void,
) => Promise<NativeClient>;

export class CodexAdapter implements HarnessAdapter {
  readonly descriptor: HarnessDescriptor = {
    id: 'codex',
    displayName: 'Codex',
    configuration: 'cli-path',
    capabilities: {
      sessionResume: true,
      interrupt: true,
      userQuestions: true,
      nativeSubagents: true,
      mcp: true,
      workspaceInstructions: true,
      steer: true,
    },
  };
  private readonly factory: CodexClientFactory;
  constructor(
    readonly environment: NativeEnvironment,
    readonly catalog: HarnessCatalog = new NativeCatalog(
      environment,
      environment.workspace.dataDir,
    ),
    factory?: CodexClientFactory,
  ) {
    this.factory =
      factory ??
      (async (agent, handlers, _baseUrl, connecting) => {
        const executable = await environment.executable();
        const env = await environment.launch(agent);
        const client = new StdioClient(
          executable,
          agent.workspace,
          env,
          handlers,
          environment.redactor,
          environment.log.child({ agentId: agent.id }),
        );
        try {
          connecting(client);
          await client.initialize();
          return client;
        } catch (error) {
          await client.close();
          throw error;
        }
      });
  }
  get nativeHome() {
    return this.environment.home;
  }
  invalidate() {
    this.environment.invalidate();
    this.catalog.invalidate?.();
  }
  async connect(agent: AgentRecord, baseUrl: string, handlers: HarnessHandlers) {
    const session = new CodexSession(agent, this.environment, baseUrl, handlers);
    const client = await this.factory(agent, session.handlers, baseUrl, (client) => {
      session.attach(client);
      handlers.connected(session);
    });
    if (!session.connected) {
      session.attach(client);
      handlers.connected(session);
    }
    return session;
  }
}

class CodexSession implements HarnessSession {
  private readonly workspacePaths: string[];
  private sessionId: string | undefined;
  private client: NativeClient | undefined;
  private closing: Promise<void> | undefined;
  private submissions = new Map<string, { clientId: string; accepted: boolean }>();
  private live = false;
  private pendingRejections: { id: HarnessRequestId; reason: string }[] = [];
  private approvals = new Map<
    HarnessRequestId,
    {
      method: string;
      threadId: string;
      turnId: string;
      permissions?: z.infer<typeof approvalRequestSchema>['permissions'];
    }
  >();
  private children = new Set<string>();
  private inputs = new Map<HarnessRequestId, { threadId: string; turnId: string }>();
  private reasoning = new Map<
    string,
    { summary: Map<number, string>; content: Map<number, string> }
  >();
  private fileChanges = new Map<string, string>();
  readonly handlers: NativeHandlers;
  constructor(
    private agent: AgentRecord,
    private environment: NativeEnvironment,
    private baseUrl: string,
    private output: HarnessHandlers,
  ) {
    this.workspacePaths = additionalWorkspacePaths(agent, environment.workspace.sharedDir);
    this.handlers = {
      notification: (method, params) => this.notification(method, params),
      request: (id, method, params) => this.question(id, method, params),
      exit: (error) => {
        this.live = false;
        this.expireRequests();
        output.exit(new Error(environment.redactor.text(error)));
      },
    };
  }
  get connected() {
    return this.client !== undefined;
  }
  attach(client: NativeClient) {
    this.client = client;
    for (const { id, reason } of this.pendingRejections) client.reject(id, reason);
    this.pendingRejections.length = 0;
  }
  private native() {
    if (!this.client) throw new Error('Codex 连接尚未建立');
    return this.client;
  }
  private threadParams() {
    return {
      model: this.agent.model,
      cwd: this.agent.workspace,
      approvalPolicy: this.agent.dangerFullAccess ? 'never' : 'on-request',
      sandbox: this.agent.dangerFullAccess ? 'danger-full-access' : 'workspace-write',
      config: {
        ...this.environment.threadConfig(this.agent, this.baseUrl),
        ...(!this.agent.dangerFullAccess
          ? {
              'sandbox_workspace_write.writable_roots': this.workspacePaths,
              'sandbox_workspace_write.network_access': true,
            }
          : {}),
      },
    };
  }
  private verifyGuidance(response: unknown) {
    const parsed = threadResponseSchema.parse(response);
    const normalize = (path: string) =>
      process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    const expected = normalize(join(this.agent.workspace, 'AGENTS.md'));
    if (!parsed.instructionSources.some((path) => normalize(path) === expected))
      throw new Error(
        'Codex 未确认加载工作目录的 AGENTS.md，请检查规则覆盖、读取大小限制和 CLI 版本。',
      );
    return parsed.thread.id;
  }
  async createSession(onCreated: (sessionId: string) => void) {
    this.live = false;
    this.children.clear();
    const response = await this.native().request('thread/start', {
      ...this.threadParams(),
      ephemeral: false,
    });
    // Save the usable ID even when later persistence or instruction checks fail.
    const id = z.object({ thread: z.object({ id: z.string().min(1) }) }).parse(response).thread.id;
    this.sessionId = id;
    onCreated(id);
    await this.native().request('thread/inject_items', {
      threadId: id,
      items: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Isles session initialized.' }],
        },
      ],
    });
    const verified = this.verifyGuidance(response);
    this.observeHistory(response);
    if (this.closing) throw new Error('Codex 连接已关闭');
    this.live = true;
    return verified;
  }
  async resumeSession(sessionId: string) {
    this.live = false;
    this.children.clear();
    this.sessionId = sessionId;
    const response = await this.native().request('thread/resume', {
      ...this.threadParams(),
      threadId: sessionId,
    });
    const id = z.object({ thread: z.object({ id: z.string().min(1) }) }).parse(response).thread.id;
    if (id !== sessionId) throw new Error('恢复返回了不同 thread，已拒绝继续执行。');
    const verified = this.verifyGuidance(response);
    this.observeHistory(response);
    if (this.closing) throw new Error('Codex 连接已关闭');
    this.live = true;
    return verified;
  }
  async submit(input: HarnessTurnInput) {
    const submission = { clientId: input.runId, accepted: false };
    this.submissions.set(input.sessionId, submission);
    try {
      const response = turnResponseSchema.parse(
        await this.native().request('turn/start', {
          threadId: input.sessionId,
          clientUserMessageId: input.runId,
          input: [{ type: 'text', text: input.text, text_elements: [] }],
          model: input.model,
          effort: input.reasoningEffort,
          cwd: input.workspace,
          approvalPolicy: this.agent.dangerFullAccess ? 'never' : 'on-request',
          sandboxPolicy: this.agent.dangerFullAccess
            ? { type: 'dangerFullAccess' }
            : {
                type: 'workspaceWrite',
                writableRoots: [this.agent.workspace, ...this.workspacePaths],
                networkAccess: true,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              },
        }),
      );
      return { turnId: response.turn.id };
    } catch (error) {
      if (error instanceof NativeRpcError && !submission.accepted)
        throw new HarnessSubmissionRejected(this.environment.redactor.text(error));
      throw error;
    } finally {
      if (this.submissions.get(input.sessionId) === submission)
        this.submissions.delete(input.sessionId);
    }
  }
  async interrupt(sessionId: string, turnId: string) {
    this.expireRequests(undefined, true);
    await this.native().request('turn/interrupt', { threadId: sessionId, turnId });
  }
  async steer(input: HarnessSteerInput) {
    try {
      const response = turnSteerResponseSchema.parse(
        await this.native().request('turn/steer', {
          threadId: input.sessionId,
          expectedTurnId: input.expectedTurnId,
          clientUserMessageId: input.batchId,
          input: [{ type: 'text', text: input.text, text_elements: [] }],
        }),
      );
      if (response.turnId !== input.expectedTurnId)
        throw new Error('Codex steer 返回了不同 turn，执行结果待核对。');
      return response;
    } catch (error) {
      const message = this.environment.redactor.text(error);
      if (error instanceof NativeRpcError) {
        if (error.code !== undefined && [-32600, -32601, -32602].includes(error.code))
          throw new HarnessSubmissionRejected(message);
        throw new NativeRpcError(message, error.code);
      }
      throw new Error(message, { cause: error });
    }
  }
  answer(requestId: HarnessRequestId, answer: QuestionAnswer) {
    const approval = this.approvals.get(requestId);
    if (approval) {
      const allowed = permissionAllowed(answer);
      this.approvals.delete(requestId);
      this.native().respond(requestId, this.approvalResponse(approval, allowed));
      return;
    }
    if (!this.inputs.delete(requestId)) throw new Error('Codex 原生请求已失效');
    this.native().respond(requestId, answer);
  }
  rejectQuestion(requestId: HarnessRequestId, reason: string) {
    this.inputs.delete(requestId);
    const approval = this.approvals.get(requestId);
    if (approval) {
      this.approvals.delete(requestId);
      this.native().respond(requestId, this.approvalResponse(approval, false));
      return;
    }
    if (this.client) this.client.reject(requestId, reason);
    else this.pendingRejections.push({ id: requestId, reason });
  }
  async close() {
    this.live = false;
    this.expireRequests(undefined, true);
    this.closing ??= this.client?.close() ?? Promise.resolve();
    await this.closing;
  }
  private ownedThread(sessionId: string) {
    return sessionId === this.sessionId || this.children.has(sessionId);
  }
  private observeItem(item: Record<string, unknown>) {
    if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string')
      this.children.add(item.agentThreadId);
  }
  private observeHistory(response: unknown) {
    const history = z
      .object({
        thread: z.object({
          turns: z
            .array(
              z.object({
                items: z.array(z.record(z.string(), z.unknown())),
              }),
            )
            .optional(),
        }),
      })
      .parse(response);
    for (const turn of history.thread.turns ?? [])
      for (const item of turn.items) this.observeItem(item);
  }
  private accepted(sessionId: string, item: Record<string, unknown>) {
    const submission = this.submissions.get(sessionId);
    if (submission && item.type === 'userMessage' && item.clientId === submission.clientId)
      submission.accepted = true;
  }
  private notification(method: string, params: Record<string, unknown>) {
    if (method === 'thread/started') {
      const thread = z
        .object({ id: z.string(), parentThreadId: z.string().nullish() })
        .safeParse(params.thread);
      if (
        thread.success &&
        (thread.data.parentThreadId === this.sessionId ||
          (thread.data.parentThreadId && this.children.has(thread.data.parentThreadId)))
      )
        this.children.add(thread.data.id);
      return;
    }
    if (typeof params.threadId !== 'string' || !this.ownedThread(params.threadId)) return;
    if (method === 'item/started' || method === 'item/completed') {
      const item = z.record(z.string(), z.unknown()).safeParse(params.item);
      if (item.success) this.observeItem(item.data);
    }
    // Initialization may replay history; only live notifications describe new work.
    if (!this.live) return;
    if (method === 'serverRequest/resolved') {
      if (
        typeof params.threadId === 'string' &&
        (typeof params.requestId === 'string' || typeof params.requestId === 'number')
      )
        this.expireRequests(params.threadId, false, params.requestId);
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const parsed = tokenUsageNotificationSchema.safeParse(params);
      if (!parsed.success) return;
      const { last, modelContextWindow } = parsed.data.tokenUsage;
      this.output.event({
        type: 'context_usage',
        sessionId: parsed.data.threadId,
        usage: { usedTokens: last.totalTokens, maxTokens: modelContextWindow, estimated: false },
      });
      return;
    }
    if (method === 'turn/started' || method === 'turn/completed') {
      const parsed = turnNotificationSchema.safeParse(params);
      if (!parsed.success) return;
      const { threadId: sessionId, turn } = parsed.data;
      if (method === 'turn/completed') {
        this.expireRequests(sessionId, false, undefined, turn.id);
        for (const key of this.fileChanges.keys())
          if (key.startsWith(`${sessionId}:${turn.id}:`)) this.fileChanges.delete(key);
        for (const key of this.reasoning.keys())
          if (key.startsWith(`${sessionId}:${turn.id}:`)) this.reasoning.delete(key);
      }
      const snapshot = z
        .object({
          items: z.array(z.record(z.string(), z.unknown())),
        })
        .safeParse(params.turn);
      if (snapshot.success)
        for (const item of snapshot.data.items) {
          this.observeItem(item);
          this.accepted(sessionId, item);
        }
      this.output.event(
        method === 'turn/started'
          ? { type: 'turn_started', sessionId, turnId: turn.id }
          : {
              type: 'turn_completed',
              sessionId,
              turnId: turn.id,
              status:
                turn.status === 'completed'
                  ? 'completed'
                  : turn.status === 'interrupted'
                    ? 'interrupted'
                    : 'failed',
              error: turn.error ? this.environment.redactor.text(turn.error.message) : null,
            },
      );
      return;
    }
    if (typeof params.threadId !== 'string') return;
    const sessionId = params.threadId;
    const turnId = typeof params.turnId === 'string' ? params.turnId : null;
    if (
      method === 'item/reasoning/summaryTextDelta' ||
      method === 'item/reasoning/textDelta' ||
      method === 'item/reasoning/summaryPartAdded'
    ) {
      if (typeof params.itemId !== 'string') return;
      const summary = method !== 'item/reasoning/textDelta';
      const index = summary ? params.summaryIndex : params.contentIndex;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return;
      if (method !== 'item/reasoning/summaryPartAdded' && typeof params.delta !== 'string') return;
      const key = `${sessionId}:${turnId}:${params.itemId}`;
      let parts = this.reasoning.get(key);
      if (!parts) {
        parts = { summary: new Map(), content: new Map() };
        this.reasoning.set(key, parts);
      }
      const section = summary ? parts.summary : parts.content;
      section.set(
        index,
        (section.get(index) ?? '') + (typeof params.delta === 'string' ? params.delta : ''),
      );
      this.output.event({
        type: 'item_delta',
        sessionId,
        turnId,
        append: false,
        item: {
          id: params.itemId,
          type: 'reasoning',
          status: 'running',
          text: this.environment.redactor.output(
            [parts.summary, parts.content]
              .flatMap((sections) =>
                [...sections].sort(([a], [b]) => a - b).map(([, text]) => text),
              )
              .filter(Boolean)
              .join('\n'),
          ),
        },
      });
    } else if (
      method === 'item/agentMessage/delta' ||
      method === 'item/commandExecution/outputDelta' ||
      method === 'item/plan/delta'
    ) {
      if (typeof params.itemId !== 'string' || typeof params.delta !== 'string') return;
      this.output.event({
        type: 'item_delta',
        sessionId,
        turnId,
        append: true,
        item: {
          id: params.itemId,
          type:
            method === 'item/agentMessage/delta'
              ? 'agentMessage'
              : method === 'item/plan/delta'
                ? 'plan'
                : 'commandExecution',
          status: 'running',
          text: this.environment.redactor.output(params.delta),
        },
      });
    } else if (method === 'item/started' || method === 'item/completed') {
      const parsed = z
        .object({ id: z.string(), type: z.string() })
        .passthrough()
        .safeParse(params.item);
      if (!parsed.success) return;
      const item = parsed.data;
      this.accepted(sessionId, item);
      if (item.type === 'fileChange' && Array.isArray(item.changes))
        this.fileChanges.set(`${sessionId}:${turnId}:${item.id}`, JSON.stringify(item.changes));
      if (method === 'item/started' && (item.type === 'agentMessage' || item.type === 'reasoning'))
        return;
      const detail: string[] = [];
      if (item.type === 'reasoning') {
        for (const sections of [item.summary, item.content])
          if (Array.isArray(sections))
            detail.push(...sections.filter((text): text is string => typeof text === 'string'));
        if (method === 'item/completed') this.reasoning.delete(`${sessionId}:${turnId}:${item.id}`);
      }
      if (item.type === 'subAgentActivity')
        for (const key of ['kind', 'agentThreadId', 'agentPath', 'model', 'reasoningEffort'])
          if (typeof item[key] === 'string') detail.push(`${key}: ${item[key]}`);
      for (const key of [
        'text',
        'command',
        'aggregatedOutput',
        'server',
        'tool',
        'status',
        'exitCode',
      ]) {
        if (typeof item[key] === 'string' || typeof item[key] === 'number')
          detail.push(key === 'text' ? String(item[key]) : `${key}: ${String(item[key])}`);
      }
      this.output.event({
        type: 'item',
        sessionId,
        turnId,
        append: false,
        item: {
          id: item.id,
          type: item.type,
          status: method === 'item/completed' ? 'completed' : 'running',
          text: this.environment.redactor.output(detail.join('\n')),
        },
      });
    }
  }
  private question(id: HarnessRequestId, method: string, params: Record<string, unknown>) {
    if (
      [
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
      ].includes(method)
    ) {
      const parsed = approvalRequestSchema.safeParse(params);
      if (
        !parsed.success ||
        !this.live ||
        !this.ownedThread(parsed.data.threadId) ||
        (method === 'item/permissions/requestApproval' && !parsed.data.permissions)
      ) {
        this.native().respond(
          id,
          method === 'item/permissions/requestApproval'
            ? { permissions: {}, scope: 'turn' }
            : { decision: 'decline' },
        );
        return;
      }
      const request = parsed.data;
      this.approvals.set(id, { method, ...request });
      this.output.question({
        requestId: id,
        sessionId: request.threadId,
        turnId: request.turnId,
        questions: permissionQuestions(
          this.environment.redactor.output(
            [
              request.command ??
                (method === 'item/fileChange/requestApproval' ? '文件修改' : '扩展执行权限'),
              request.reason,
              request.cwd,
              request.grantRoot,
              request.permissions ? JSON.stringify(request.permissions) : '',
              request.additionalPermissions ? JSON.stringify(request.additionalPermissions) : '',
              this.fileChanges.get(`${request.threadId}:${request.turnId}:${request.itemId}`),
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        ),
      });
      return;
    }
    const parsed = inputRequestSchema.safeParse(params);
    if (
      method !== 'item/tool/requestUserInput' ||
      !parsed.success ||
      !this.live ||
      !this.ownedThread(parsed.data.threadId)
    ) {
      this.rejectQuestion(id, 'Isles does not support this native request');
      return;
    }
    const request = parsed.data;
    this.inputs.set(id, { threadId: request.threadId, turnId: request.turnId });
    this.output.question({
      requestId: id,
      sessionId: request.threadId,
      turnId: request.turnId,
      questions: request.questions.map((q) => ({
        ...q,
        multiSelect: false,
        header: this.environment.redactor.text(q.header),
        question: this.environment.redactor.text(q.question),
        options:
          q.options?.map((o) => ({
            label: this.environment.redactor.text(o.label),
            description: this.environment.redactor.text(o.description),
          })) ?? null,
      })),
    });
  }
  private approvalResponse(
    approval: {
      method: string;
      permissions?: z.infer<typeof approvalRequestSchema>['permissions'];
    },
    allowed: boolean,
  ) {
    if (approval.method !== 'item/permissions/requestApproval')
      return { decision: allowed ? 'accept' : 'decline' };
    return {
      permissions: allowed
        ? {
            ...(approval.permissions?.network ? { network: approval.permissions.network } : {}),
            ...(approval.permissions?.fileSystem
              ? { fileSystem: approval.permissions.fileSystem }
              : {}),
          }
        : {},
      scope: 'turn',
    };
  }
  private expireRequests(
    threadId?: string,
    deny = false,
    requestId?: HarnessRequestId,
    turnId?: string,
  ) {
    for (const [id, approval] of this.approvals) {
      if (
        (threadId && approval.threadId !== threadId) ||
        (turnId && approval.turnId !== turnId) ||
        (requestId !== undefined && id !== requestId)
      )
        continue;
      this.approvals.delete(id);
      if (deny && this.client) this.client.respond(id, this.approvalResponse(approval, false));
      this.output.event({
        type: 'question_expired',
        sessionId: approval.threadId,
        turnId: approval.turnId,
        requestId: id,
      });
    }
    for (const [id, input] of this.inputs) {
      if (
        (threadId && input.threadId !== threadId) ||
        (turnId && input.turnId !== turnId) ||
        (requestId !== undefined && id !== requestId)
      )
        continue;
      this.inputs.delete(id);
      if (deny && this.client) this.client.reject(id, 'Codex input request cancelled');
      this.output.event({
        type: 'question_expired',
        sessionId: input.threadId,
        turnId: input.turnId,
        requestId: id,
      });
    }
  }
}
