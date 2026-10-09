import type { HarnessDescriptor, QuestionAnswer } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { AgentRecord } from '../../storage/store.js';
import {
  HarnessSubmissionRejected,
  type HarnessAdapter,
  type HarnessHandlers,
  type HarnessRequestId,
  type HarnessSession,
  type HarnessTurnInput,
  type HarnessSteerInput,
} from '../types.js';
import { DshCatalog } from './catalog.js';
import { DshClient, type DshClientFactory, type DshConnection } from './client.js';
import type { DshEnvironment } from './environment.js';
import {
  admissionSchema,
  catalogSchema,
  eventSchema,
  modelSelection,
  questionSchema,
  rejectionSchema,
  sessionSchema,
} from './protocol.js';

export class DshAdapter implements HarnessAdapter {
  readonly descriptor: HarnessDescriptor = {
    id: 'dsh',
    displayName: 'DeepSeek Harness',
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
  readonly catalog: DshCatalog;
  constructor(
    readonly environment: DshEnvironment,
    private factory: DshClientFactory = (...args) => new DshClient(...args),
  ) {
    this.catalog = new DshCatalog(environment, factory);
  }
  get nativeHome() {
    return this.environment.nativeHome;
  }
  invalidate() {
    this.environment.invalidate();
    this.catalog.invalidate();
  }
  async connect(agent: AgentRecord, baseUrl: string, handlers: HarnessHandlers) {
    const session = new DshSession(this.environment, this.factory, agent, baseUrl, handlers);
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
interface PendingInput {
  promise: Promise<{ turnId: string }>;
  resolve(value: { turnId: string }): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  accepted?: { turnId: string };
}
interface Active {
  turnId?: string;
  inputs: Map<string, PendingInput>;
  submitted: Set<string>;
  ended?: { status: 'completed' | 'failed' | 'interrupted'; error: string | null };
}
class DshSession implements HarnessSession {
  private client?: DshConnection;
  private sessionId?: string;
  private active: Active | undefined;
  private closing?: Promise<void>;
  private stopped = false;
  private events = new Set<string>();
  private questions = new Set<string>();
  private admissions = new Set<Promise<unknown>>();
  constructor(
    private environment: DshEnvironment,
    private factory: DshClientFactory,
    private agent: AgentRecord,
    private baseUrl: string,
    private handlers: HarnessHandlers,
  ) {}
  async prepare() {
    const runtime = await this.environment.runtime(this.agent.workspace, this.agent, this.baseUrl);
    const command = await this.environment.executable();
    if (this.closing) throw new Error('DSH 连接已关闭');
    this.client = this.factory(
      command,
      this.agent.workspace,
      runtime,
      {
        notification: (method, params) => this.notification(method, params),
        exit: (error) => this.fail(error),
      },
      this.environment.redactor,
      this.environment.log,
    );
    // The bridge waits for Loader settlement, including MCP startup and native factories.
    catalogSchema.parse(
      this.checked(await this.native().request('isles/catalog', { requireMcp: true })),
    );
  }
  private native() {
    if (!this.client || this.closing) throw new Error('DSH 连接已关闭');
    return this.client;
  }
  private checked(value: unknown) {
    const refused = rejectionSchema.safeParse(value);
    if (refused.success)
      throw new HarnessSubmissionRejected(this.environment.redactor.text(refused.data.reason));
    return value;
  }
  async createSession(onCreated: (id: string) => void) {
    const sessionId = `ses_isles_${randomUUID().replaceAll('-', '')}`;
    onCreated(sessionId);
    await this.open('create', sessionId);
    return sessionId;
  }
  async resumeSession(sessionId: string) {
    await this.open('resume', sessionId);
    return sessionId;
  }
  private async open(mode: 'create' | 'resume', sessionId: string) {
    const session = sessionSchema.parse(
      this.checked(
        await this.native().request(`isles/session/${mode}`, {
          sessionId,
          cwd: this.agent.workspace,
          selection: modelSelection(this.agent.model, this.agent.reasoningEffort),
        }),
      ),
    );
    if (this.closing) throw new Error('DSH 连接已关闭');
    if (session.sessionId !== sessionId) throw new Error('DSH 返回了不同 session');
    if ((await realpath(session.cwd)) !== (await realpath(this.agent.workspace)))
      throw new Error('DSH session 的工作目录与 Agent 不一致');
    if (this.closing) throw new Error('DSH 连接已关闭');
    this.sessionId = sessionId;
  }
  async submit(input: HarnessTurnInput) {
    if (this.stopped || input.sessionId !== this.sessionId || this.active)
      throw new HarnessSubmissionRejected('DSH session 当前无法开始执行');
    const active: Active = { inputs: new Map(), submitted: new Set() };
    this.active = active;
    return this.send(active, 'submit', `msg_isles_${input.runId}`, input.text, {
      selection: modelSelection(input.model, input.reasoningEffort),
    });
  }
  async steer(input: HarnessSteerInput) {
    const active = this.active;
    if (
      this.stopped ||
      input.sessionId !== this.sessionId ||
      !active?.turnId ||
      active.ended ||
      active.turnId !== input.expectedTurnId
    )
      throw new HarnessSubmissionRejected('DSH 当前执行已结束，追加消息进入下一轮');
    return this.send(active, 'steer', `msg_isles_${input.batchId}`, input.text, {
      expectedTurnId: input.expectedTurnId,
    });
  }
  private async send(
    active: Active,
    kind: 'submit' | 'steer',
    messageId: string,
    text: string,
    extra: object,
  ) {
    if (active.submitted.has(messageId)) throw new HarnessSubmissionRejected('DSH 输入批次已投递');
    let resolve: PendingInput['resolve'] = () => {};
    let reject: PendingInput['reject'] = () => {};
    const promise = new Promise<{ turnId: string }>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void promise.catch(() => {});
    const pending: PendingInput = {
      promise,
      resolve,
      reject,
      timer: setTimeout(() => reject(new Error('DSH 输入接收确认超时，结果待核对')), 60_000),
    };
    active.submitted.add(messageId);
    active.inputs.set(messageId, pending);
    try {
      const receipt = admissionSchema.parse(
        this.checked(
          await this.admit(kind, {
            sessionId: this.sessionId,
            messageId,
            text,
            ...extra,
          }),
        ),
      );
      if (receipt.sessionId !== this.sessionId || receipt.messageId !== messageId)
        throw new Error('DSH 输入确认的身份无效，结果待核对');
      // An admitted input can wait for a long-running tool. Only native consumption,
      // discard or execution/lifecycle loss settles it after the enqueue receipt.
      clearTimeout(pending.timer);
      return await promise;
    } catch (error) {
      clearTimeout(pending.timer);
      if (pending.accepted) return pending.accepted;
      active.inputs.delete(messageId);
      const reason =
        error instanceof HarnessSubmissionRejected
          ? error
          : new Error(this.environment.redactor.text(error));
      pending.reject(reason);
      if (!active.turnId && !active.inputs.size && this.active === active) this.active = undefined;
      if (reason instanceof HarnessSubmissionRejected) this.finish(active);
      else this.fail(reason);
      throw reason;
    }
  }
  private async admit(kind: string, params: object) {
    const request = this.native().request(`isles/session/${kind}`, params);
    this.admissions.add(request);
    try {
      return await request;
    } finally {
      this.admissions.delete(request);
    }
  }
  private notification(method: string, params: unknown) {
    if (this.closing) return;
    if (method === 'isles/question') {
      const question = questionSchema.parse(params);
      if (
        question.sessionId !== this.sessionId ||
        question.turnId !== this.active?.turnId ||
        this.active.ended ||
        this.questions.has(String(question.requestId))
      )
        return;
      this.questions.add(String(question.requestId));
      this.handlers.question(question);
      return;
    }
    if (method !== 'isles/event') return;
    const frame = eventSchema.parse(params);
    if (frame.sessionId !== this.sessionId || !this.active) return;
    if (frame.eventId) {
      if (this.events.has(frame.eventId)) return;
      this.events.add(frame.eventId);
    }
    const active = this.active;
    const event = frame.event;
    if (event.type === 'turn_started') {
      if (active.turnId === event.turnId) return;
      if (active.turnId || active.ended) {
        this.fail(new Error('DSH 追加输入跨越了原生执行边界，结果待核对'));
        return;
      }
      active.turnId = event.turnId;
      this.handlers.event({
        type: 'turn_started',
        sessionId: this.sessionId!,
        turnId: event.turnId,
      });
    } else if (event.type === 'input_accepted' || event.type === 'input_rejected') {
      const pending = active.inputs.get(event.messageId);
      if (!pending) return;
      clearTimeout(pending.timer);
      active.inputs.delete(event.messageId);
      if (event.type === 'input_rejected')
        pending.reject(new HarnessSubmissionRejected(this.environment.redactor.text(event.reason)));
      else if (event.turnId !== active.turnId || active.ended)
        pending.reject(new Error('DSH 输入进入了不同执行，结果待核对'));
      else {
        pending.accepted = { turnId: event.turnId };
        pending.resolve(pending.accepted);
      }
      this.finish(active);
    } else if (event.turnId === active.turnId) {
      if (event.type === 'turn_completed') {
        active.ended = {
          status: event.status,
          error: event.error === null ? null : this.environment.redactor.text(event.error),
        };
        this.finish(active);
      } else
        this.handlers.event({
          type: 'item',
          sessionId: this.sessionId!,
          turnId: event.turnId,
          item: { ...event.item, text: this.environment.redactor.text(event.item.text) },
          append: event.append,
        });
    }
  }
  private finish(active: Active) {
    if (this.active !== active || !active.turnId || !active.ended || active.inputs.size) return;
    this.active = undefined;
    this.questions.clear();
    this.handlers.event({
      type: 'turn_completed',
      sessionId: this.sessionId!,
      turnId: active.turnId,
      ...active.ended,
    });
  }
  answer(requestId: HarnessRequestId, answer: QuestionAnswer) {
    if (!this.questions.delete(String(requestId))) return;
    void this.native()
      .request('isles/question/answer', {
        sessionId: this.sessionId,
        requestId,
        answers: answer.answers,
      })
      .then((value) => this.checked(value))
      .catch((error: unknown) => this.fail(error as Error));
  }
  rejectQuestion(requestId: HarnessRequestId, reason: string) {
    if (this.closing || !this.questions.delete(String(requestId))) return;
    void this.native()
      .request('isles/question/reject', { sessionId: this.sessionId, requestId, reason })
      .catch((error: unknown) => this.fail(error as Error));
  }
  async interrupt(sessionId: string, turnId: string) {
    if (sessionId !== this.sessionId || turnId !== this.active?.turnId) return;
    this.stopped = true;
    await Promise.allSettled(this.admissions);
    this.checked(
      await this.native().request('isles/session/interrupt', { sessionId, expectedTurnId: turnId }),
    );
  }
  private fail(error: Error) {
    if (this.closing) return;
    for (const pending of this.active?.inputs.values() ?? []) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.active?.inputs.clear();
    this.handlers.exit(new Error(this.environment.redactor.text(error)));
    void this.close();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      this.stopped = true;
      for (const pending of this.active?.inputs.values() ?? []) {
        clearTimeout(pending.timer);
        pending.reject(new Error('DSH 连接已关闭'));
      }
      this.active?.inputs.clear();
      await Promise.allSettled(this.admissions);
      await this.client?.close();
    });
    return this.closing;
  }
}
