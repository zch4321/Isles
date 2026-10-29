import type { QuestionAnswer, RunItem } from '@isles/contracts';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { AgentRecord } from '../../storage/store.js';
import { additionalWorkspacePaths } from '../../runtime/workspace-paths.js';
import { permissionAllowed, permissionQuestions } from '../shared/permissions.js';
import {
  HarnessImageInputUnsupported,
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
  cancelled?: boolean;
  promise: Promise<{ turnId: string }>;
  resolve(value: { turnId: string }): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface Turn {
  id?: string;
  currentPhaseId?: string;
  phases: Map<string, NativePhase>;
  admitting: number;
  cancelling?: boolean;
  inputs: Map<string, PendingInput>;
}
interface NativePhase {
  promptId?: string;
  ended?: { status: 'completed' | 'interrupted' | 'failed'; error: string | null };
}
interface Child {
  parentAgentId: string;
  turnId: string;
  name: string;
  model?: string;
}
interface Segment {
  id: string;
  type: 'agentMessage' | 'reasoning';
  text: string;
  agentId: string;
  phaseId: string;
}
interface Tool {
  name: string;
  input: string;
  output: string;
}
interface ApprovalForm {
  id: string;
  labels: string[];
  permission?: boolean;
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
  private readonly workspacePaths: string[];
  private client?: KimiWebConnection;
  private sessionId?: string;
  private active: Turn | undefined;
  private closing?: Promise<void>;
  private stopped = false;
  private exitReported = false;
  private cursor = 0;
  private epoch?: string;
  private readonly children = new Map<string, Child>();
  private readonly activities = new Map<string, NativePhase>();
  private readonly currentTurns = new Map<string, string>();
  private readonly interactionOwners = new Map<string, { agentId: string; turnId: string }>();
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
  ) {
    this.workspacePaths = additionalWorkspacePaths(agent, environment.workspace.sharedDir);
  }
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
    for (const path of this.workspacePaths)
      await this.native().request(
        'POST',
        `/api/v1/workspaces/${encodeURIComponent(workspace.id)}/add-dir`,
        { path, persist: false },
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
  private async supportsImage(model: string): Promise<boolean | undefined> {
    try {
      const selected =
        model === 'default'
          ? kimiStatusSchema.parse(await this.native().request('GET', this.path('status'))).model
          : model;
      const models = kimiModelsSchema.parse(await this.native().request('GET', '/api/v1/models'));
      const capabilities = models.items.find((entry) => entry.model === selected)?.capabilities;
      return capabilities?.includes('image_in');
    } catch (error) {
      this.environment.log.warn(
        { error: this.environment.redactor.text(error) },
        'Kimi Code image capability lookup failed',
      );
      return undefined;
    }
  }
  async submit(input: HarnessTurnInput) {
    input.submissionState?.('preparing');
    if (
      this.stopped ||
      this.active ||
      input.sessionId !== this.sessionId ||
      input.workspace !== this.agent.workspace ||
      input.model !== this.agent.model ||
      input.reasoningEffort !== this.agent.reasoningEffort
    )
      throw new HarnessSubmissionRejected('Kimi Code 输入与当前会话配置不一致');
    const supported = input.images?.length ? await this.supportsImage(input.model) : undefined;
    if (this.stopped || this.active)
      throw new HarnessSubmissionRejected('Kimi Code 输入与当前会话配置不一致');
    if (supported === false)
      throw new HarnessImageInputUnsupported(
        '当前 Kimi Code 模型不支持图片输入，请选择支持图片输入的模型并恢复 Agent',
      );
    const prompts = kimiPromptsSchema.parse(
      await this.native().request('GET', this.path('prompts')),
    );
    if (this.stopped || this.active || prompts.active || prompts.queued.length)
      throw new HarnessSubmissionRejected('Kimi Code 原生会话有待处理输入，请等待原执行结束');
    const promptId = this.promptId(input.runId);
    if (this.owned.has(promptId)) throw new HarnessSubmissionRejected('Kimi Code 输入批次已投递');
    input.submissionState?.('submitting');
    const active: Turn = {
      inputs: new Map(),
      phases: new Map(),
      admitting: 0,
    };
    this.active = active;
    return this.send(active, promptId, input.text, undefined, input.images);
  }
  async steer(input: HarnessSteerInput) {
    const active = this.active;
    if (
      this.stopped ||
      input.sessionId !== this.sessionId ||
      !active?.id ||
      active.cancelling ||
      !active.currentPhaseId ||
      active.phases.get(active.currentPhaseId)?.ended ||
      active.id !== input.expectedTurnId
    )
      throw new HarnessSubmissionRejected('Kimi Code 当前执行已结束，追加消息进入下一轮');
    const prompts = kimiPromptsSchema.parse(
      await this.native().request('GET', this.path('prompts')),
    );
    const phase = active.phases.get(active.currentPhaseId!);
    if (
      this.active !== active ||
      this.stopped ||
      active.cancelling ||
      !phase?.promptId ||
      phase?.ended ||
      prompts.active?.prompt_id !== phase?.promptId
    )
      throw new HarnessSubmissionRejected('Kimi Code 当前执行已结束，追加消息进入下一轮');
    return this.send(active, this.promptId(input.batchId), input.text, input.expectedTurnId);
  }
  private async send(
    active: Turn,
    id: string,
    text: string,
    expectedTurnId?: string,
    images?: HarnessTurnInput['images'],
  ) {
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
    active.admitting++;
    let admitted = false;
    // Track POST, its follow-up GET, and :steer together so cancellation waits
    // for every operation that could still consume a queued input.
    const admission = (async () => {
      const result = kimiPromptSchema.parse(
        await this.native().request('POST', this.path('prompts'), {
          prompt_id: id,
          content: [
            { type: 'text', text },
            ...(images ?? []).flatMap((image) => [
              { type: 'text', text: image.label },
              {
                type: 'image',
                name: image.label,
                source: { kind: 'path', path: image.path },
              },
            ]),
          ],
          metadata: { isles_agent_id: this.agent.id },
          ...this.configuration(),
        }),
      );
      if (result.prompt_id !== id) throw new Error('Kimi Code 输入确认的身份无效，结果待核对');
      admitted = true;
      if (
        expectedTurnId &&
        !pending.accepted &&
        !pending.cancelled &&
        !active.cancelling &&
        !this.stopped
      ) {
        const before = kimiPromptsSchema.parse(
          await this.native().request('GET', this.path('prompts')),
        );
        const phase = active.phases.get(active.currentPhaseId!);
        if (
          !pending.accepted &&
          !pending.cancelled &&
          !active.cancelling &&
          !this.stopped &&
          this.active === active &&
          !phase?.ended &&
          before.active?.prompt_id === phase?.promptId &&
          before.queued.some((item) => item.prompt_id === id)
        ) {
          try {
            await this.native().request(
              'POST',
              this.path(`prompts/${encodeURIComponent(id)}:steer`),
            );
          } catch (error) {
            // Native queue consumption races both GET and :steer. Wait for its receipt;
            // a not-pending response cannot establish that an admitted input was refused.
            if (!(error instanceof KimiWebError && error.code === 40402)) throw error;
          }
        }
        // The event confirms actual consumption. REST success alone cannot prove turn identity.
      }
    })();
    this.admissions.add(admission);
    try {
      await admission;
      return await pending.promise;
    } catch (error) {
      if (pending.accepted) return pending.accepted;
      if (pending.cancelled) throw error;
      clearTimeout(pending.timer);
      const refused =
        !admitted &&
        (error instanceof HarnessSubmissionRejected ||
          (error instanceof KimiWebError &&
            // 2.3.1 refuses a write owned by another client before admitting it.
            // Keep native ownership intact; the user can retry after it is released.
            [40001, 40110, 40111, 40112, 40113, 40401, 40931].includes(error.code)));
      const reason = refused
        ? new HarnessSubmissionRejected(this.environment.redactor.text(error))
        : this.error(error);
      pending.reject(reason);
      if (refused) {
        active.inputs.delete(id);
        this.owned.delete(id);
        this.finish(active);
      } else this.fail(reason);
      throw reason;
    } finally {
      this.admissions.delete(admission);
      active.admitting--;
      this.finish(active);
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
    if (
      this.stopped ||
      (frame.session_id ?? frame.payload.sessionId) !== this.sessionId ||
      (frame.payload.sessionId !== undefined && frame.payload.sessionId !== this.sessionId) ||
      (frame.payload.session_id !== undefined && frame.payload.session_id !== this.sessionId)
    )
      return;
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
    if (typeof payload.agent_id === 'string' && payload.agent_id !== agentId) return;
    if (agentId !== 'main' && !this.children.has(agentId)) {
      const queued = this.childEvents.get(agentId) ?? [];
      queued.push(frame);
      this.childEvents.set(agentId, queued);
      return;
    }
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
    if (frame.type === 'turn.started') {
      const data = z
        .object({ turnId: z.number().int(), promptId: z.string().optional() })
        .parse(payload);
      const phaseId = String(data.turnId);
      const key = `${agentId}:${phaseId}`;
      const known = this.activities.get(key);
      if (known) {
        if (known.promptId !== data.promptId)
          this.fail(new Error('Kimi Code 原生执行身份冲突，结果待核对'));
        return;
      }
      const phase: NativePhase = data.promptId === undefined ? {} : { promptId: data.promptId };
      this.activities.set(key, phase);
      this.expireAgentInteractions(agentId);
      this.currentTurns.set(agentId, phaseId);
      if (agentId === 'main') {
        const active: Turn = (this.active ??= {
          inputs: new Map(),
          phases: new Map(),
          admitting: 0,
        });
        active.phases.set(phaseId, phase);
        active.currentPhaseId = phaseId;
        active.id = phaseId;
      }
      this.handlers.event({
        type: 'turn_started',
        sessionId: this.address(agentId),
        turnId: phaseId,
      });
      if (agentId === 'main' && this.active && data.promptId)
        this.accept(this.active, data.promptId, phaseId);
      return;
    }
    const active = this.active;
    if (agentId === 'main' && frame.type === 'prompt.steered') {
      const data = z
        .object({ activePromptId: z.string(), promptIds: z.array(z.string()) })
        .parse(payload);
      const phase = [...this.activities.entries()].find(
        ([key, phase]) => key.startsWith('main:') && phase.promptId === data.activePromptId,
      );
      if (!active || !phase) return;
      const phaseId = phase[0].slice('main:'.length);
      for (const id of data.promptIds) {
        const pending = active.inputs.get(id);
        if (!pending || pending.accepted || pending.cancelled) continue;
        this.accept(active, id, phaseId);
      }
      return;
    }
    if (agentId === 'main' && frame.type === 'prompt.aborted') {
      const id = z.string().parse(payload.promptId);
      const pending = active?.inputs.get(id);
      if (pending && !pending.accepted && !pending.cancelled) {
        clearTimeout(pending.timer);
        pending.cancelled = true;
        pending.reject(new HarnessSubmissionRejected('Kimi Code 已取消待处理输入'));
      }
      if (active) this.finish(active);
      return;
    }
    const phaseId = String(payload.turnId ?? payload.turn_id ?? this.currentTurns.get(agentId));
    const phase = this.activities.get(`${agentId}:${phaseId}`);
    if (frame.type === 'turn.ended') {
      if (!phase || phase.ended) return;
      const reason = z.enum(['completed', 'cancelled', 'failed', 'blocked']).parse(payload.reason);
      phase.ended = {
        status:
          reason === 'cancelled' ? 'interrupted' : reason === 'completed' ? 'completed' : 'failed',
        error:
          payload.error === undefined
            ? reason === 'blocked'
              ? 'Kimi Code 执行已阻塞'
              : null
            : this.error(payload.error).message,
      };
      for (const [key, segment] of this.segments)
        if (segment.agentId === agentId && segment.phaseId === phaseId)
          this.endSegment(key, phaseId, agentId, 'item', phase.ended.status);
      this.expireAgentInteractions(agentId, phaseId);
      if (agentId === 'main' && active) this.finish(active);
      this.handlers.event({
        type: 'turn_completed',
        sessionId: this.address(agentId),
        turnId: phaseId,
        ...phase.ended,
      });
      return;
    }
    if (frame.type === 'subagent.spawned') {
      const childId = z.string().parse(payload.subagentId);
      const parent = typeof payload.parentAgentId === 'string' ? payload.parentAgentId : agentId;
      if (parent !== agentId || childId === 'main' || childId === parent || !phase) return;
      const known = this.children.get(childId);
      if (known && known.parentAgentId !== parent) return;
      const child: Child = {
        parentAgentId: parent,
        turnId: phaseId,
        name: z.string().parse(payload.subagentName),
        ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
      };
      this.children.set(childId, child);
      this.item(
        phaseId,
        {
          id: this.childItemId(childId, child),
          type: 'subagent',
          status: 'running',
          text: `${this.childLabel(childId, child)}\n${kimiText(payload.description)}`,
        },
        'item',
        false,
        parent,
      );
      const queued = this.childEvents.get(childId) ?? [];
      this.childEvents.delete(childId);
      for (const event of queued) this.consume(event);
      return;
    }
    if (frame.type.startsWith('subagent.')) {
      const childId = z.string().parse(payload.subagentId);
      const child = this.children.get(childId);
      if (!child || child.parentAgentId !== agentId) return;
      const terminal = ['subagent.completed', 'subagent.failed', 'subagent.cancelled'].includes(
        frame.type,
      );
      this.item(
        child.turnId,
        {
          id: this.childItemId(childId, child),
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
        },
        'item',
        false,
        child.parentAgentId,
      );
      return;
    }
    if (!phase || phase.ended) return;
    if (frame.type === 'event.question.requested') {
      if (phaseId !== this.currentTurns.get(agentId)) return;
      const question = kimiQuestionSchema.parse(payload);
      this.questions.set(question.question_id, question);
      this.interactionOwners.set(question.question_id, { agentId, turnId: phaseId });
      this.handlers.question({
        sessionId: this.address(agentId),
        turnId: phaseId,
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
      this.expireNativeInteraction(z.string().parse(payload.question_id), agentId, phaseId);
      return;
    }
    if (frame.type === 'event.approval.resolved') {
      this.expireNativeInteraction(
        `approval:${z.string().parse(payload.approval_id)}`,
        agentId,
        phaseId,
      );
      return;
    }
    if (frame.type === 'event.approval.requested') {
      if (phaseId !== this.currentTurns.get(agentId)) return;
      const approval = kimiApprovalSchema.parse(payload);
      this.interactionOwners.set(`approval:${approval.approval_id}`, { agentId, turnId: phaseId });
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
          sessionId: this.address(agentId),
          turnId: phaseId,
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
      const requestId = `approval:${approval.approval_id}`;
      this.approvals.set(requestId, { id: approval.approval_id, labels: [], permission: true });
      this.handlers.question({
        sessionId: this.address(agentId),
        turnId: phaseId,
        requestId,
        questions: permissionQuestions(
          this.environment.redactor.output(
            [approval.tool_name, approval.action, kimiText(approval.tool_input_display)].join('\n'),
          ),
        ),
      });
      return;
    }
    this.detail(phaseId, agentId, phaseId, frame);
  }
  private accept(active: Turn, id: string, turnId: string) {
    const pending = active.inputs.get(id);
    if (!pending || pending.accepted || pending.cancelled) return;
    pending.accepted = { turnId };
    clearTimeout(pending.timer);
    pending.resolve(pending.accepted);
    this.finish(active);
  }
  private expireInteractions(requestIds = [...this.questions.keys(), ...this.approvals.keys()]) {
    for (const requestId of requestIds) {
      const owner = this.interactionOwners.get(requestId);
      const question = this.questions.delete(requestId);
      const approval = this.approvals.delete(requestId);
      this.interactionOwners.delete(requestId);
      if (!this.stopped && !this.exitReported && owner && (question || approval))
        this.handlers.event({
          type: 'question_expired',
          sessionId: this.address(owner.agentId),
          turnId: owner.turnId,
          requestId,
        });
    }
  }
  private address(agentId: string) {
    return agentId === 'main' ? this.sessionId! : `${this.sessionId}/agents/${agentId}`;
  }
  private expireAgentInteractions(agentId: string, turnId?: string) {
    this.expireInteractions(
      [...this.interactionOwners]
        .filter(([, owner]) => owner.agentId === agentId && (!turnId || owner.turnId === turnId))
        .map(([id]) => id),
    );
  }
  private expireNativeInteraction(requestId: string, agentId: string, turnId: string) {
    const owner = this.interactionOwners.get(requestId);
    if (owner?.agentId === agentId && owner.turnId === turnId) this.expireInteractions([requestId]);
  }
  private detail(turnId: string, agentId: string, phaseId: string, frame: KimiWebEvent) {
    const payload = frame.payload;
    const key = `${agentId}:${turnId}`;
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
        segment = { id: `${key}:${++this.segmentCounter}`, type, text: '', agentId, phaseId };
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
        agentId,
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
        agentId,
      );
    }
  }
  private childLabel(id: string, child: Child) {
    return `子代理 ${child.name} (${id})${child.model ? ` · ${child.model}` : ''}`;
  }
  private childItemId(id: string, child: Child) {
    return `subagent:${child.turnId}:${id}`;
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
      false,
      agentId,
    );
    this.segments.delete(key);
  }
  private item(
    turnId: string,
    item: RunItem,
    type: 'item' | 'item_delta' = 'item',
    append = false,
    agentId = 'main',
  ) {
    this.handlers.event({
      type,
      sessionId: this.address(agentId),
      turnId,
      append,
      item: { ...item, text: this.environment.redactor.output(item.text) },
    });
  }
  private finish(active: Turn) {
    if (
      this.active !== active ||
      this.stopped ||
      this.exitReported ||
      active.admitting ||
      [...active.inputs.values()].some((input) => !input.accepted && !input.cancelled) ||
      [...active.phases.values()].some((phase) => !phase.ended)
    )
      return;
    this.active = undefined;
    for (const id of active.inputs.keys()) this.owned.delete(id);
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
      if (approval.permission) {
        if (!this.interactionOwners.has(String(requestId)))
          throw new Error('Kimi Code 原生权限请求已失效');
        const allowed = permissionAllowed(answer);
        this.approvals.delete(String(requestId));
        this.interactionOwners.delete(String(requestId));
        void this.native()
          .request('POST', this.path(`approvals/${encodeURIComponent(approval.id)}`), {
            decision: allowed ? 'approved' : 'rejected',
          })
          .catch((error: unknown) => this.fail(this.error(error)));
        return;
      }
      const values = answer.answers.approval?.answers;
      if (values?.length !== 1) throw new Error('Kimi Code 计划请选择一个答案');
      const label = values[0]!;
      const approved = approval.labels.includes(label);
      const known = approved || label === 'Reject' || label === 'Revise';
      this.approvals.delete(String(requestId));
      this.interactionOwners.delete(String(requestId));
      void this.native()
        .request('POST', this.path(`approvals/${encodeURIComponent(approval.id)}`), {
          decision: approved ? 'approved' : 'rejected',
          selected_label: known ? label : 'Revise',
          ...(known ? {} : { feedback: label }),
        })
        .catch((error: unknown) => this.fail(this.error(error)));
      return;
    }
    if (answer.answers.permission) throw new Error('Kimi Code 原生权限请求已失效');
    const question = this.questions.get(String(requestId));
    if (!question || !this.interactionOwners.has(String(requestId)))
      throw new Error('Kimi Code 原生问题已失效');
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
    this.interactionOwners.delete(question.question_id);
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
      this.interactionOwners.delete(String(requestId));
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
    this.interactionOwners.delete(question.question_id);
    void this.native()
      .request('POST', this.path(`questions/${encodeURIComponent(question.question_id)}:dismiss`))
      .catch((error: unknown) => {
        if (!(error instanceof KimiWebError && error.code === 40909)) this.fail(this.error(error));
      });
  }
  async interrupt(sessionId: string, turnId: string) {
    if (sessionId !== this.sessionId || this.active?.id !== turnId) return;
    this.active.cancelling = true;
    const belongs = (id: string) => {
      const owner = this.interactionOwners.get(id);
      return owner?.agentId === 'main' && owner.turnId === turnId;
    };
    const questions = [...this.questions.values()].filter((q) => belongs(q.question_id));
    const approvals = [...this.approvals.values()].filter((a) => belongs(`approval:${a.id}`));
    const promptId = this.activities.get(`main:${turnId}`)?.promptId;
    await this.clearInputs(promptId);
    if (!promptId && this.currentTurns.get('main') === turnId)
      await this.native().request(
        'POST',
        `/api/v1/sessions/${encodeURIComponent(this.sessionId!)}:abort`,
      );
    await this.clearQuestions(questions, approvals);
  }
  private async clearQuestions(
    questions = [...this.questions.values()],
    approvals = [...this.approvals.values()],
  ) {
    if (!this.client || !this.sessionId) return;
    this.expireInteractions([
      ...questions.map((question) => question.question_id),
      ...approvals.map((approval) => `approval:${approval.id}`),
    ]);
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
  private async clearInputs(activePromptId?: string) {
    if (!this.client || !this.sessionId) return;
    await Promise.allSettled(this.admissions);
    // Cancel queued inputs before the active prompt so none can launch on cancellation.
    const prompts = kimiPromptsSchema.parse(await this.client.request('GET', this.path('prompts')));
    const activeId = prompts.active?.prompt_id;
    const ids = [...new Set([...this.owned, ...(activePromptId ? [activePromptId] : [])])]
      .filter((id) => {
        const receipt = this.active?.inputs.get(id);
        return (
          id === activeId ||
          prompts.queued.some((prompt) => prompt.prompt_id === id) ||
          (!receipt?.accepted && !receipt?.cancelled)
        );
      })
      .sort((a, b) => Number(a === activeId) - Number(b === activeId));
    for (const id of ids) {
      try {
        await this.client.request('POST', this.path(`prompts/${encodeURIComponent(id)}:abort`));
      } catch (error) {
        if (!(error instanceof KimiWebError && [40402, 40903].includes(error.code))) throw error;
      }
    }
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
    if (this.active) this.active.cancelling = true;
    for (const input of this.active?.inputs.values() ?? []) {
      clearTimeout(input.timer);
      input.reject(new Error('Kimi Code 连接已关闭，输入结果待核对'));
    }
    this.closing = Promise.resolve().then(async () => {
      try {
        await this.clearInputs();
      } catch (error) {
        this.environment.log.warn(
          { error: this.environment.redactor.text(error) },
          'Kimi Code pending input cleanup failed',
        );
      }
      try {
        await this.clearQuestions();
      } catch (error) {
        this.environment.log.warn(
          { error: this.environment.redactor.text(error) },
          'Kimi Code pending question cleanup failed',
        );
      }
      await this.client?.close();
      this.owned.clear();
    });
    return this.closing;
  }
}
