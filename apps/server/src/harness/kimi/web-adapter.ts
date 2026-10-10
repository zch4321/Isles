import type { QuestionAnswer, RunItem } from '@isles/contracts';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { AgentRecord } from '../../storage/store.js';
import {
  HarnessSubmissionRejected,
  type HarnessAdapter,
  type HarnessCatalog,
  type HarnessContextUsage,
  type HarnessHandlers,
  type HarnessRequestId,
  type HarnessSession,
  type HarnessSteerInput,
  type HarnessTurnInput,
} from '../types.js';
import { KimiWebCatalog } from './web-catalog.js';
import {
  KimiWebClient,
  KimiWebError,
  type KimiWebClientFactory,
  type KimiWebConnection,
} from './web-client.js';
import type { KimiWebEnvironment } from './web-environment.js';
import {
  kimiApprovalSchema,
  kimiEventSchema,
  kimiModelsSchema,
  kimiPromptSchema,
  kimiPromptsSchema,
  kimiQuestionSchema,
  kimiSessionSchema,
  kimiSnapshotSchema,
  kimiStatusSchema,
  kimiText,
  type KimiWebEvent,
  type KimiWebQuestion,
} from './web-protocol.js';

const INPUT_CONFIRMATION_MS = 60_000;
interface PendingInput {
  id: string;
  expectedTurnId?: string;
  accepted?: { turnId: string };
  promise: Promise<{ turnId: string }>;
  resolve(value: { turnId: string }): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface Turn {
  promptId: string;
  id?: string;
  ended?: { status: 'completed' | 'interrupted' | 'failed'; error: string | null };
  inputs: Map<string, PendingInput>;
}
interface Child {
  turnId: string;
  name: string;
  model?: string;
}
interface Segment {
  id: string;
  type: 'agentMessage' | 'reasoning';
  text: string;
}
interface Tool {
  name: string;
  input: string;
  output: string;
}
interface ApprovalForm {
  id: string;
  labels: string[];
}

export class KimiWebAdapter implements HarnessAdapter {
  readonly catalog: HarnessCatalog;
  private readonly factory: KimiWebClientFactory;
  constructor(
    readonly environment: KimiWebEnvironment,
    catalog?: HarnessCatalog,
    factory?: KimiWebClientFactory,
  ) {
    this.factory = factory ?? ((...args) => new KimiWebClient(...args));
    this.catalog = catalog ?? new KimiWebCatalog(environment, this.factory);
  }
  get descriptor() {
    return this.environment.descriptor;
  }
  get nativeHome() {
    return this.environment.home;
  }
  invalidate() {
    this.environment.invalidate();
    this.catalog.invalidate?.();
  }
  async connect(agent: AgentRecord, baseUrl: string, handlers: HarnessHandlers) {
    const session = new KimiWebSession(agent, baseUrl, this.environment, this.factory, handlers);
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

class KimiWebSession implements HarnessSession {
  private client?: KimiWebConnection;
  private sessionId?: string;
  private active: Turn | undefined;
  private closing?: Promise<void>;
  private stopped = false;
  private exitReported = false;
  private cursor = 0;
  private epoch?: string;
  private readonly children = new Map<string, Child>();
  private readonly childEvents = new Map<string, KimiWebEvent[]>();
  private readonly segments = new Map<string, Segment>();
  private readonly offsets = new Map<string, number>();
  private readonly tools = new Map<string, Tool>();
  private readonly questions = new Map<string, KimiWebQuestion>();
  private readonly approvals = new Map<string, ApprovalForm>();
  private readonly owned = new Set<string>();
  private readonly admissions = new Set<Promise<unknown>>();
  private readonly models = new Map<string, number>();
  private buffered: KimiWebEvent[] = [];
  private bound = false;
  private contextRefresh: Promise<void> | undefined;
  private contextRefreshPending = false;
  private contextRevision = 0;
  private contextUsage?: HarnessContextUsage;
  private contextModel?: string;
  private segmentCounter = 0;
  constructor(
    private readonly agent: AgentRecord,
    private readonly baseUrl: string,
    private readonly environment: KimiWebEnvironment,
    private readonly factory: KimiWebClientFactory,
    private readonly handlers: HarnessHandlers,
  ) {}
  async prepare() {
    const env = await this.environment.prepare(this.agent, this.baseUrl);
    if (this.stopped) throw new Error('Kimi Code 连接已停止');
    await this.environment.learnSecrets();
    if (this.stopped) throw new Error('Kimi Code 连接已停止');
    const executable = await this.environment.executable();
    if (this.stopped) throw new Error('Kimi Code 连接已停止');
    this.client = this.factory(
      executable,
      this.agent.workspace,
      env,
      {
        event: (frame) => this.frame(frame),
        exit: (error) => this.fail(error),
      },
      this.environment.redactor,
      this.environment.log.child({ agentId: this.agent.id }),
    );
    if (this.stopped) {
      await this.client.close();
      throw new Error('Kimi Code 连接已停止');
    }
    await this.client.start();
    if (this.stopped) {
      await this.client.close();
      throw new Error('Kimi Code 连接已停止');
    }
  }
  private native() {
    if (!this.client || this.stopped) throw new Error('Kimi Code 连接已关闭');
    return this.client;
  }
  private path(suffix = '') {
    return `/api/v1/sessions/${encodeURIComponent(this.sessionId!)}/${suffix}`;
  }
  private async trustWorkspace() {
    const workspace = z
      .object({ id: z.string().min(1), root: z.string() })
      .parse(
        await this.native().request('POST', '/api/v1/workspaces', { root: this.agent.workspace }),
      );
    if ((await realpath(workspace.root)) !== (await realpath(this.agent.workspace)))
      throw new Error('Kimi Code 工作目录与 Agent 不一致');
    await this.native().request(
      'POST',
      `/api/v1/workspaces/${encodeURIComponent(workspace.id)}/trust`,
    );
  }
  async createSession(onCreated: (sessionId: string) => void) {
    await this.trustWorkspace();
    const session = kimiSessionSchema.parse(
      await this.native().request('POST', '/api/v1/sessions', {
        title: this.agent.name,
        metadata: { cwd: this.agent.workspace },
      }),
    );
    this.sessionId = session.id;
    onCreated(session.id);
    await this.bind(session);
    return session.id;
  }
  async resumeSession(sessionId: string) {
    await this.trustWorkspace();
    const session = kimiSessionSchema.parse(
      await this.native().request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}`),
    );
    if (session.id !== sessionId) throw new Error('Kimi Code 恢复返回了不同 session');
    this.sessionId = sessionId;
    await this.bind(session);
    return sessionId;
  }
  private async bind(session: z.infer<typeof kimiSessionSchema>) {
    if ((await realpath(session.metadata.cwd)) !== (await realpath(this.agent.workspace)))
      throw new Error('Kimi Code session 的工作目录与 Agent 不一致');
    // Snapshot materializes a cold main agent; project MCP must already be trusted.
    const snapshot = kimiSnapshotSchema.parse(
      await this.native().request('GET', this.path('snapshot')),
    );
    if (snapshot.session.id !== this.sessionId)
      throw new Error('Kimi Code snapshot 的 session 不一致');
    this.cursor = snapshot.as_of_seq;
    this.epoch = snapshot.epoch;
    const prompts = kimiPromptsSchema.parse(
      await this.native().request('GET', this.path('prompts')),
    );
    for (const prompt of [
      ...prompts.queued,
      ...(prompts.active?.status === 'blocked' ? [prompts.active] : []),
    ]) {
      if (!this.isOwnedPrompt(prompt))
        throw new Error('Kimi Code 原生会话有待处理输入，请先核对原生收件箱');
      await this.native().request(
        'POST',
        this.path(`prompts/${encodeURIComponent(prompt.prompt_id)}:abort`),
      );
    }
    if (prompts.active && prompts.active.status !== 'blocked')
      throw new Error('Kimi Code 原生会话正在执行，请等待原执行结束');
    const status = kimiStatusSchema.parse(await this.native().request('GET', this.path('status')));
    if (status.busy) throw new Error('Kimi Code 原生会话正在执行，请等待原执行结束');
    await this.native().request('POST', this.path('profile'), {
      agent_config: this.configuration(),
    });
    const models = kimiModelsSchema.parse(await this.native().request('GET', '/api/v1/models'));
    for (const model of models.items)
      if (model.max_context_size > 0) this.models.set(model.model, model.max_context_size);
    await this.native().subscribe(this.sessionId!, { seq: this.cursor, epoch: this.epoch });
    this.bound = true;
    const buffered = this.buffered;
    this.buffered = [];
    for (const frame of buffered) this.event(frame);
    await this.refreshContext();
  }
  private isOwnedPrompt(prompt: z.infer<typeof kimiPromptSchema>) {
    const prefix = `isles-${this.agent.id}-`;
    return (
      prompt.prompt_id.startsWith(prefix) &&
      z.uuid().safeParse(prompt.prompt_id.slice(prefix.length)).success
    );
  }
  private promptId(id: string) {
    return `isles-${this.agent.id}-${id}`;
  }
  private configuration() {
    return {
      permission_mode: 'yolo',
      ...(this.agent.model === 'default' ? {} : { model: this.agent.model }),
      ...(this.agent.reasoningEffort === 'default' ? {} : { thinking: this.agent.reasoningEffort }),
    };
  }
  async submit(input: HarnessTurnInput) {
    if (
      this.stopped ||
      this.active ||
      input.sessionId !== this.sessionId ||
      input.workspace !== this.agent.workspace ||
      input.model !== this.agent.model ||
      input.reasoningEffort !== this.agent.reasoningEffort
    )
      throw new HarnessSubmissionRejected('Kimi Code 输入与当前会话配置不一致');
    const prompts = kimiPromptsSchema.parse(
      await this.native().request('GET', this.path('prompts')),
    );
    if (prompts.active || prompts.queued.length)
      throw new HarnessSubmissionRejected('Kimi Code 原生会话有待处理输入，请等待原执行结束');
    const active: Turn = { promptId: this.promptId(input.runId), inputs: new Map() };
    this.active = active;
    return this.send(active, active.promptId, input.text);
  }
  async steer(input: HarnessSteerInput) {
    const active = this.active;
    if (
      this.stopped ||
      input.sessionId !== this.sessionId ||
      !active?.id ||
      active.ended ||
      active.id !== input.expectedTurnId
    )
      throw new HarnessSubmissionRejected('Kimi Code 当前执行已结束，追加消息进入下一轮');
    const prompts = kimiPromptsSchema.parse(
      await this.native().request('GET', this.path('prompts')),
    );
    if (this.active !== active || active.ended || prompts.active?.prompt_id !== active.promptId)
      throw new HarnessSubmissionRejected('Kimi Code 当前执行已结束，追加消息进入下一轮');
    return this.send(active, this.promptId(input.batchId), input.text, input.expectedTurnId);
  }
  private async send(active: Turn, id: string, text: string, expectedTurnId?: string) {
    if (this.owned.has(id)) throw new HarnessSubmissionRejected('Kimi Code 输入批次已投递');
    let resolve!: PendingInput['resolve'];
    let reject!: PendingInput['reject'];
    const promise = new Promise<{ turnId: string }>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void promise.catch(() => {});
    const pending: PendingInput = {
      id,
      ...(expectedTurnId === undefined ? {} : { expectedTurnId }),
      resolve,
      reject,
      promise,
      timer: setTimeout(
        () => this.fail(new Error('Kimi Code 输入接收确认超时，结果待核对')),
        INPUT_CONFIRMATION_MS,
      ),
    };
    active.inputs.set(id, pending);
    this.owned.add(id);
    const admission = this.native().request('POST', this.path('prompts'), {
      prompt_id: id,
      content: [{ type: 'text', text }],
      metadata: { isles_agent_id: this.agent.id },
      ...this.configuration(),
    });
    this.admissions.add(admission);
    let admitted = false;
    try {
      const result = kimiPromptSchema.parse(await admission);
      if (result.prompt_id !== id) throw new Error('Kimi Code 输入确认的身份无效，结果待核对');
      admitted = true;
      if (expectedTurnId) {
        if (this.active !== active || active.ended || active.id !== expectedTurnId)
          throw new Error('Kimi Code 追加输入跨越了原生执行边界，结果待核对');
        const before = kimiPromptsSchema.parse(
          await this.native().request('GET', this.path('prompts')),
        );
        if (
          before.active?.prompt_id !== active.promptId ||
          !before.queued.some((item) => item.prompt_id === id)
        )
          throw new Error('Kimi Code 追加输入的原生执行归属待核对');
        await this.native().request('POST', this.path(`prompts/${encodeURIComponent(id)}:steer`));
        // The event confirms actual consumption. REST success alone cannot prove turn identity.
      }
      return await pending.promise;
    } catch (error) {
      if (pending.accepted) return pending.accepted;
      clearTimeout(pending.timer);
      active.inputs.delete(id);
      const refused =
        !admitted &&
        (error instanceof HarnessSubmissionRejected ||
          (error instanceof KimiWebError &&
            [40001, 40110, 40111, 40112, 40113, 40401].includes(error.code)));
      const reason = refused
        ? new HarnessSubmissionRejected(this.environment.redactor.text(error))
        : this.error(error);
      pending.reject(reason);
      if (refused) {
        this.owned.delete(id);
        if (!active.id && !active.inputs.size && this.active === active) this.active = undefined;
        this.finish(active);
      } else this.fail(reason);
      throw reason;
    } finally {
      this.admissions.delete(admission);
    }
  }
  private frame(value: unknown) {
    if (z.object({ type: z.literal('resync_required') }).safeParse(value).success) {
      this.fail(new Error('Kimi Code 事件游标已失效，执行结果待核对'));
      return;
    }
    // Control acknowledgements are owned by the web client.
    const parsed = kimiEventSchema.safeParse(value);
    if (!parsed.success) {
      this.fail(new Error('Kimi Code 原生事件格式无效'));
      return;
    }
    if (!this.bound) {
      this.buffered.push(parsed.data);
      return;
    }
    try {
      this.event(parsed.data);
    } catch (error) {
      this.fail(this.error(error));
    }
  }
  private event(frame: KimiWebEvent) {
    if (this.stopped || (frame.session_id ?? frame.payload.sessionId) !== this.sessionId) return;
    if (
      frame.type === 'resync_required' ||
      (frame.epoch && this.epoch && frame.epoch !== this.epoch)
    ) {
      this.fail(new Error('Kimi Code 事件游标已失效，执行结果待核对'));
      return;
    }
    if (!frame.volatile) {
      if (frame.seq <= this.cursor) return;
      this.cursor = frame.seq;
    }
    this.consume(frame);
  }
  private consume(frame: KimiWebEvent) {
    const payload = frame.payload;
    const agentId = payload.agentId ?? 'main';
    const active = this.active;
    if (agentId === 'main' && frame.type === 'agent.status.updated') {
      const status = z
        .object({
          contextTokens: z.number().int().nonnegative(),
          maxContextTokens: z.number().int().nonnegative().optional(),
          model: z.string().optional(),
        })
        .safeParse(payload);
      if (status.success) {
        this.contextRevision++;
        this.reportContext(
          status.data.contextTokens,
          status.data.maxContextTokens,
          status.data.model,
        );
      } else void this.refreshContext();
    } else if (
      agentId === 'main' &&
      ['turn.step.completed', 'turn.ended', 'compaction.completed'].includes(frame.type)
    )
      void this.refreshContext();
    if (!active) return;
    if (agentId === 'main' && frame.type === 'turn.started') {
      const data = z.object({ turnId: z.number().int(), promptId: z.string() }).parse(payload);
      if (data.promptId !== active.promptId || active.id) {
        if (this.owned.has(data.promptId))
          this.fail(new Error('Kimi Code 输入进入了不同执行，结果待核对'));
        return;
      }
      active.id = String(data.turnId);
      this.handlers.event({ type: 'turn_started', sessionId: this.sessionId!, turnId: active.id });
      this.accept(active, data.promptId);
      return;
    }
    if (agentId === 'main' && frame.type === 'prompt.steered') {
      const data = z
        .object({ activePromptId: z.string(), promptIds: z.array(z.string()) })
        .parse(payload);
      for (const id of data.promptIds) {
        const pending = active.inputs.get(id);
        if (!pending) continue;
        if (
          !active.id ||
          active.ended ||
          data.activePromptId !== active.promptId ||
          pending.expectedTurnId !== active.id
        ) {
          this.fail(new Error('Kimi Code 追加输入进入了不同执行，结果待核对'));
          return;
        }
        this.accept(active, id);
      }
      return;
    }
    if (agentId === 'main' && frame.type === 'prompt.aborted') {
      const id = z.string().parse(payload.promptId);
      const pending = active.inputs.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        active.inputs.delete(id);
        this.owned.delete(id);
        pending.reject(new HarnessSubmissionRejected('Kimi Code 已取消待处理输入'));
      }
      this.finish(active);
      return;
    }
    if (!active.id) return;
    if (agentId === 'main' && frame.type === 'turn.ended') {
      if (String(payload.turnId) !== active.id) return;
      const reason = z.enum(['completed', 'cancelled', 'failed', 'blocked']).parse(payload.reason);
      active.ended = {
        status:
          reason === 'cancelled' ? 'interrupted' : reason === 'completed' ? 'completed' : 'failed',
        error:
          payload.error === undefined
            ? reason === 'blocked'
              ? 'Kimi Code 执行已阻塞'
              : null
            : this.error(payload.error).message,
      };
      this.finish(active);
      return;
    }
    if (frame.type === 'subagent.spawned') {
      const childId = z.string().parse(payload.subagentId);
      const parent = typeof payload.parentAgentId === 'string' ? payload.parentAgentId : agentId;
      if (parent !== 'main' && this.children.get(parent)?.turnId !== active.id) return;
      const child: Child = {
        turnId: active.id,
        name: z.string().parse(payload.subagentName),
        ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
      };
      this.children.set(childId, child);
      this.item(active.id, {
        id: `subagent:${childId}`,
        type: 'subagent',
        status: 'running',
        text: `${this.childLabel(childId, child)}\n${kimiText(payload.description)}`,
      });
      const queued = this.childEvents.get(childId) ?? [];
      this.childEvents.delete(childId);
      for (const event of queued) this.consume(event);
      return;
    }
    if (frame.type.startsWith('subagent.')) {
      const childId = z.string().parse(payload.subagentId);
      const child = this.children.get(childId);
      if (!child || child.turnId !== active.id) return;
      const terminal = ['subagent.completed', 'subagent.failed', 'subagent.cancelled'].includes(
        frame.type,
      );
      this.item(active.id, {
        id: `subagent:${childId}`,
        type: 'subagent',
        status:
          frame.type === 'subagent.failed'
            ? 'failed'
            : frame.type === 'subagent.cancelled'
              ? 'interrupted'
              : terminal
                ? 'completed'
                : 'running',
        text: `${this.childLabel(childId, child)}\n${kimiText(payload.resultSummary ?? payload.error ?? payload.reason ?? frame.type)}`,
      });
      return;
    }
    if (agentId !== 'main' && this.children.get(agentId)?.turnId !== active.id) {
      if (!this.children.has(agentId)) {
        const queued = this.childEvents.get(agentId) ?? [];
        queued.push(frame);
        this.childEvents.set(agentId, queued);
      }
      return;
    }
    if (agentId === 'main' && payload.turnId !== undefined && String(payload.turnId) !== active.id)
      return;
    if (frame.type === 'event.question.requested') {
      const question = kimiQuestionSchema.parse(payload);
      this.questions.set(question.question_id, question);
      this.handlers.question({
        sessionId: this.sessionId!,
        turnId: active.id,
        requestId: question.question_id,
        questions: question.questions.map((item) => ({
          id: item.id,
          header: item.header ?? '',
          question: [item.question, item.body].filter(Boolean).join('\n'),
          isOther: item.allow_other !== false,
          isSecret: false,
          multiSelect: item.multi_select === true,
          options: item.options.map((option) => ({
            label: option.label,
            description: option.description ?? '',
          })),
        })),
      });
      return;
    }
    if (['event.question.answered', 'event.question.dismissed'].includes(frame.type)) {
      this.questions.delete(z.string().parse(payload.question_id));
      return;
    }
    if (frame.type === 'event.approval.requested') {
      const approval = kimiApprovalSchema.parse(payload);
      const plan = z
        .object({
          kind: z.literal('plan_review'),
          plan: z.string(),
          options: z.array(z.object({ label: z.string() })).optional(),
        })
        .safeParse(approval.tool_input_display);
      if (plan.success || approval.tool_name === 'ExitPlanMode') {
        const labels =
          plan.success && plan.data.options?.length
            ? plan.data.options.map((option) => option.label)
            : ['Approve'];
        const requestId = `approval:${approval.approval_id}`;
        this.approvals.set(requestId, { id: approval.approval_id, labels });
        this.handlers.question({
          sessionId: this.sessionId!,
          turnId: active.id,
          requestId,
          questions: [
            {
              id: 'approval',
              header: '计划确认',
              question: plan.success ? plan.data.plan : approval.action,
              isOther: true,
              isSecret: false,
              multiSelect: false,
              options: [...labels, 'Reject', 'Revise'].map((label) => ({ label, description: '' })),
            },
          ],
        });
        return;
      }
      // Isles grants tools full access. Interactive AskUserQuestion remains its own event family.
      void this.native()
        .request('POST', this.path(`approvals/${encodeURIComponent(approval.approval_id)}`), {
          decision: 'approved',
        })
        .catch((error: unknown) => this.fail(this.error(error)));
      return;
    }
    this.detail(active.id, agentId, frame);
  }
  private accept(active: Turn, id: string) {
    const pending = active.inputs.get(id);
    if (!pending || !active.id) return;
    pending.accepted = { turnId: active.id };
    clearTimeout(pending.timer);
    active.inputs.delete(id);
    pending.resolve(pending.accepted);
    if (id !== active.promptId) this.owned.delete(id);
    this.finish(active);
  }
  private detail(turnId: string, agentId: string, frame: KimiWebEvent) {
    const payload = frame.payload;
    const key = `${agentId}:${payload.turnId ?? turnId}`;
    if (frame.type === 'turn.step.started') {
      this.endSegment(key, turnId, agentId);
      this.offsets.delete(`${key}:agentMessage`);
      this.offsets.delete(`${key}:reasoning`);
      return;
    }
    if (frame.type === 'assistant.delta' || frame.type === 'thinking.delta') {
      const type = frame.type === 'assistant.delta' ? 'agentMessage' : 'reasoning';
      const delta = z.string().parse(payload.delta);
      if (frame.offset !== undefined) {
        const offsetKey = `${key}:${type}`;
        const offset = this.offsets.get(offsetKey) ?? 0;
        if (frame.offset < offset) return;
        if (frame.offset > offset) throw new Error('Kimi Code 流式内容存在缺口，执行结果待核对');
        this.offsets.set(offsetKey, offset + delta.length);
      }
      let segment = this.segments.get(key);
      let append = true;
      if (!segment || segment.type !== type) {
        this.endSegment(key, turnId, agentId, 'item_delta');
        segment = { id: `${key}:${++this.segmentCounter}`, type, text: '' };
        this.segments.set(key, segment);
        append = false;
      }
      segment.text += delta;
      this.item(
        turnId,
        {
          id: segment.id,
          type,
          status: 'running',
          text: (append ? '' : this.prefix(agentId)) + delta,
        },
        'item_delta',
        append,
      );
      return;
    }
    if (
      frame.type === 'tool.call.started' ||
      frame.type === 'tool.result' ||
      frame.type === 'tool.progress'
    ) {
      const id = z.string().parse(payload.toolCallId);
      const toolKey = `${key}:tool:${id}`;
      const known = this.tools.has(toolKey);
      const tool = this.tools.get(toolKey) ?? { name: id, input: '', output: '' };
      let progressText: string | undefined;
      let append = false;
      if (frame.type === 'tool.call.started') {
        tool.name = z.string().parse(payload.name);
        tool.input = kimiText(payload.args);
      } else if (frame.type === 'tool.result') tool.output = kimiText(payload.output);
      else {
        const update = z
          .object({ text: z.string().optional(), replace: z.boolean().optional() })
          .passthrough()
          .parse(payload.update);
        if (update.text === undefined || (!update.text && !update.replace)) return;
        append = known && !update.replace;
        progressText = append ? (tool.output ? '' : '\n') + update.text : undefined;
        tool.output = update.replace ? (update.text ?? '') : tool.output + (update.text ?? '');
      }
      this.endSegment(key, turnId, agentId, frame.type === 'tool.progress' ? 'item_delta' : 'item');
      this.tools.set(toolKey, tool);
      this.item(
        turnId,
        {
          id: toolKey,
          type: tool.name.startsWith('mcp__') ? 'mcpToolCall' : 'toolCall',
          status:
            frame.type === 'tool.result'
              ? payload.isError === true
                ? 'failed'
                : 'completed'
              : 'running',
          text:
            progressText ??
            `${this.prefix(agentId)}${tool.name}\n${tool.input}${tool.output ? `\n${tool.output}` : ''}`,
        },
        frame.type === 'tool.progress' ? 'item_delta' : 'item',
        append,
      );
    }
    if (agentId !== 'main' && frame.type === 'turn.ended')
      this.endSegment(
        key,
        turnId,
        agentId,
        'item',
        payload.reason === 'cancelled'
          ? 'interrupted'
          : payload.reason === 'failed' || payload.reason === 'blocked'
            ? 'failed'
            : 'completed',
      );
  }
  private childLabel(id: string, child: Child) {
    return `子代理 ${child.name} (${id})${child.model ? ` · ${child.model}` : ''}`;
  }
  private prefix(agentId: string) {
    const child = this.children.get(agentId);
    return child ? `${this.childLabel(agentId, child)}\n` : '';
  }
  private endSegment(
    key: string,
    turnId: string,
    agentId: string,
    type: 'item' | 'item_delta' = 'item',
    status: RunItem['status'] = 'completed',
  ) {
    const segment = this.segments.get(key);
    if (!segment) return;
    this.item(
      turnId,
      {
        id: segment.id,
        type: segment.type,
        status,
        text: this.prefix(agentId) + segment.text,
      },
      type,
    );
    this.segments.delete(key);
  }
  private item(
    turnId: string,
    item: RunItem,
    type: 'item' | 'item_delta' = 'item',
    append = false,
  ) {
    this.handlers.event({
      type,
      sessionId: this.sessionId!,
      turnId,
      append,
      item: { ...item, text: this.environment.redactor.output(item.text) },
    });
  }
  private finish(active: Turn) {
    if (this.active !== active || !active.id || !active.ended || active.inputs.size) return;
    for (const key of this.segments.keys())
      this.endSegment(
        key,
        active.id,
        key.slice(0, key.lastIndexOf(':')),
        'item',
        active.ended.status,
      );
    this.active = undefined;
    this.questions.clear();
    this.approvals.clear();
    this.tools.clear();
    this.childEvents.clear();
    this.offsets.clear();
    this.handlers.event({
      type: 'turn_completed',
      sessionId: this.sessionId!,
      turnId: active.id,
      ...active.ended,
    });
    this.owned.delete(active.promptId);
  }
  private refreshContext() {
    this.contextRefreshPending = true;
    if (this.contextRefresh) return this.contextRefresh;
    this.contextRefresh = Promise.resolve()
      .then(async () => {
        while (this.contextRefreshPending && this.sessionId && !this.stopped) {
          this.contextRefreshPending = false;
          const revision = this.contextRevision;
          const status = kimiStatusSchema.parse(
            await this.native().request('GET', this.path('status')),
          );
          if (this.stopped) return;
          // A native status event received while GET was in flight is newer than its response.
          if (revision === this.contextRevision)
            this.reportContext(status.context_tokens, status.max_context_tokens, status.model);
        }
      })
      .catch((error: unknown) => {
        this.environment.log.warn(
          { error: this.environment.redactor.text(error) },
          'Kimi Code context usage refresh failed',
        );
      })
      .finally(() => {
        this.contextRefresh = undefined;
      });
    return this.contextRefresh;
  }
  private reportContext(usedTokens: number, maxTokens?: number, model?: string) {
    if (model !== undefined) this.contextModel = model;
    const usage: HarnessContextUsage = {
      usedTokens,
      maxTokens: this.models.get(this.contextModel ?? this.agent.model) ?? (maxTokens || null),
      // The public API reports the native count without exposing its measured/estimated split.
      estimated: true,
    };
    if (
      this.contextUsage?.usedTokens === usage.usedTokens &&
      this.contextUsage.maxTokens === usage.maxTokens
    )
      return;
    this.contextUsage = usage;
    this.handlers.event({ type: 'context_usage', sessionId: this.sessionId!, usage });
  }
  answer(requestId: HarnessRequestId, answer: QuestionAnswer) {
    const approval = this.approvals.get(String(requestId));
    if (approval) {
      const values = answer.answers.approval?.answers;
      if (values?.length !== 1) throw new Error('Kimi Code 计划请选择一个答案');
      const label = values[0]!;
      const approved = approval.labels.includes(label);
      const known = approved || label === 'Reject' || label === 'Revise';
      this.approvals.delete(String(requestId));
      void this.native()
        .request('POST', this.path(`approvals/${encodeURIComponent(approval.id)}`), {
          decision: approved ? 'approved' : 'rejected',
          selected_label: known ? label : 'Revise',
          ...(known ? {} : { feedback: label }),
        })
        .catch((error: unknown) => this.fail(this.error(error)));
      return;
    }
    const question = this.questions.get(String(requestId));
    if (!question || !this.active?.id) throw new Error('Kimi Code 原生问题已失效');
    const answers: Record<string, unknown> = {};
    for (const item of question.questions) {
      const values = answer.answers[item.id]?.answers;
      if (!values?.length) throw new Error('Kimi Code 问题尚未填写');
      const selected = values.flatMap((value) => {
        const option = item.options.find((candidate) => candidate.label === value);
        return option ? [option.id] : [];
      });
      const other = values.filter(
        (value) => !item.options.some((option) => option.label === value),
      );
      if (other.length && item.allow_other === false)
        throw new Error('Kimi Code 问题请选择提供的选项');
      if (item.multi_select)
        answers[item.id] = other.length
          ? { kind: 'multi_with_other', option_ids: selected, other_text: other.join('\n') }
          : { kind: 'multi', option_ids: selected };
      else {
        if (values.length !== 1) throw new Error('Kimi Code 问题请选择一个答案');
        answers[item.id] = selected.length
          ? { kind: 'single', option_id: selected[0] }
          : { kind: 'other', text: other[0] };
      }
    }
    this.questions.delete(question.question_id);
    void this.native()
      .request('POST', this.path(`questions/${encodeURIComponent(question.question_id)}`), {
        answers,
        method: 'click',
      })
      .catch((error: unknown) => this.fail(this.error(error)));
  }
  rejectQuestion(requestId: HarnessRequestId) {
    const approval = this.approvals.get(String(requestId));
    if (approval && !this.stopped) {
      this.approvals.delete(String(requestId));
      void this.native()
        .request('POST', this.path(`approvals/${encodeURIComponent(approval.id)}`), {
          decision: 'cancelled',
        })
        .catch((error: unknown) => this.fail(this.error(error)));
      return;
    }
    const question = this.questions.get(String(requestId));
    if (!question || this.stopped) return;
    this.questions.delete(question.question_id);
    void this.native()
      .request('POST', this.path(`questions/${encodeURIComponent(question.question_id)}:dismiss`))
      .catch((error: unknown) => {
        if (!(error instanceof KimiWebError && error.code === 40909)) this.fail(this.error(error));
      });
  }
  async interrupt(sessionId: string, turnId: string) {
    if (sessionId !== this.sessionId || this.active?.id !== turnId) return;
    await this.clearQuestions();
    await this.clearInputs();
  }
  private async clearQuestions() {
    if (!this.client || !this.sessionId) return;
    const questions = [...this.questions.values()];
    const approvals = [...this.approvals.values()];
    this.questions.clear();
    this.approvals.clear();
    for (const question of questions) {
      try {
        await this.client.request(
          'POST',
          this.path(`questions/${encodeURIComponent(question.question_id)}:dismiss`),
        );
      } catch (error) {
        if (!(error instanceof KimiWebError && [40909, 40902, 40405].includes(error.code)))
          throw error;
      }
    }
    for (const approval of approvals) {
      try {
        await this.client.request(
          'POST',
          this.path(`approvals/${encodeURIComponent(approval.id)}`),
          { decision: 'cancelled' },
        );
      } catch (error) {
        if (!(error instanceof KimiWebError && [40902, 40404].includes(error.code))) throw error;
      }
    }
  }
  private async clearInputs() {
    if (!this.client || !this.sessionId) return;
    await Promise.allSettled(this.admissions);
    // Cancel queued inputs before the active prompt so none can launch on cancellation.
    const ids = [...this.owned].sort(
      (a, b) => Number(a === this.active?.promptId) - Number(b === this.active?.promptId),
    );
    for (const id of ids) {
      try {
        await this.client.request('POST', this.path(`prompts/${encodeURIComponent(id)}:abort`));
      } catch (error) {
        if (!(error instanceof KimiWebError && [40402, 40903].includes(error.code))) throw error;
      }
    }
    this.owned.clear();
  }
  private error(value: unknown) {
    return new Error(this.environment.redactor.text(value));
  }
  private fail(error: Error) {
    if (this.exitReported || this.closing) return;
    this.exitReported = true;
    for (const input of this.active?.inputs.values() ?? []) {
      clearTimeout(input.timer);
      input.reject(error);
    }
    this.handlers.exit(this.error(error));
    void this.close();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    for (const input of this.active?.inputs.values() ?? []) {
      clearTimeout(input.timer);
      input.reject(new Error('Kimi Code 连接已关闭，输入结果待核对'));
    }
    this.closing = Promise.resolve().then(async () => {
      try {
        await this.clearQuestions();
      } catch (error) {
        this.environment.log.warn(
          { error: this.environment.redactor.text(error) },
          'Kimi Code pending question cleanup failed',
        );
      }
      try {
        await this.clearInputs();
      } catch (error) {
        this.environment.log.warn(
          { error: this.environment.redactor.text(error) },
          'Kimi Code pending input cleanup failed',
        );
      }
      await this.client?.close();
    });
    return this.closing;
  }
}
