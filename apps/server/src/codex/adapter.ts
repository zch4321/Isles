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
} from '../harness/types.js';
import type { AgentRecord } from '../storage/store.js';
import { NativeCatalog } from './catalog.js';
import { StdioClient } from './client.js';
import type { NativeEnvironment } from './environment.js';
import {
  inputRequestSchema,
  NativeRpcError,
  threadResponseSchema,
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
    configuration: 'codex-path',
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
  private client: NativeClient | undefined;
  private closing: Promise<void> | undefined;
  private submissions = new Map<string, { accepted: boolean }>();
  private pendingRejections: { id: HarnessRequestId; reason: string }[] = [];
  readonly handlers: NativeHandlers;
  constructor(
    private agent: AgentRecord,
    private environment: NativeEnvironment,
    private baseUrl: string,
    private output: HarnessHandlers,
  ) {
    this.handlers = {
      notification: (method, params) => this.notification(method, params),
      request: (id, method, params) => this.question(id, method, params),
      exit: (error) => output.exit(new Error(environment.redactor.text(error))),
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
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: this.environment.threadConfig(this.agent, this.baseUrl),
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
    const response = await this.native().request('thread/start', {
      ...this.threadParams(),
      ephemeral: false,
    });
    // Save the usable ID even when later persistence or instruction checks fail.
    const id = z.object({ thread: z.object({ id: z.string().min(1) }) }).parse(response).thread.id;
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
    return this.verifyGuidance(response);
  }
  async resumeSession(sessionId: string) {
    const response = await this.native().request('thread/resume', {
      ...this.threadParams(),
      threadId: sessionId,
    });
    const id = z.object({ thread: z.object({ id: z.string().min(1) }) }).parse(response).thread.id;
    if (id !== sessionId) throw new Error('恢复返回了不同 thread，已拒绝继续执行。');
    return this.verifyGuidance(response);
  }
  async submit(input: HarnessTurnInput) {
    const submission = { accepted: false };
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
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' },
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
    this.native().respond(requestId, answer);
  }
  rejectQuestion(requestId: HarnessRequestId, reason: string) {
    if (this.client) this.client.reject(requestId, reason);
    else this.pendingRejections.push({ id: requestId, reason });
  }
  async close() {
    this.closing ??= this.client?.close() ?? Promise.resolve();
    await this.closing;
  }
  private accepted(sessionId: string) {
    const submission = this.submissions.get(sessionId);
    if (submission) submission.accepted = true;
  }
  private notification(method: string, params: Record<string, unknown>) {
    if (method === 'turn/started' || method === 'turn/completed') {
      const parsed = turnNotificationSchema.safeParse(params);
      if (!parsed.success) return;
      const { threadId: sessionId, turn } = parsed.data;
      this.accepted(sessionId);
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
    if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
      if (typeof params.itemId !== 'string' || typeof params.delta !== 'string') return;
      this.output.event({
        type: 'item',
        sessionId,
        turnId,
        append: true,
        item: {
          id: params.itemId,
          type: method === 'item/agentMessage/delta' ? 'agentMessage' : 'commandExecution',
          status: 'running',
          text: this.environment.redactor.text(params.delta),
        },
      });
    } else if (method === 'item/started' || method === 'item/completed') {
      const parsed = z
        .object({ id: z.string(), type: z.string() })
        .passthrough()
        .safeParse(params.item);
      if (!parsed.success) return;
      const item = parsed.data;
      const detail: string[] = [];
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
          text: this.environment.redactor.text(detail.join('\n')),
        },
      });
    }
  }
  private question(id: HarnessRequestId, method: string, params: Record<string, unknown>) {
    const parsed = inputRequestSchema.safeParse(params);
    if (method !== 'item/tool/requestUserInput' || !parsed.success) {
      this.rejectQuestion(id, 'Isles does not support this native request');
      return;
    }
    const request = parsed.data;
    this.accepted(request.threadId);
    this.output.question({
      requestId: id,
      sessionId: request.threadId,
      turnId: request.turnId,
      questions: request.questions.map((q) => ({
        ...q,
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
}
