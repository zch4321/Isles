import type { QuestionAnswer, QuestionDefinition, RunItem } from '@isles/contracts';
import { z } from 'zod';
import {
  HarnessSubmissionRejected,
  type HarnessAdapter,
  type HarnessCatalog,
  type HarnessHandlers,
  type HarnessRequestId,
  type HarnessSession,
  type HarnessTurnInput,
} from '../types.js';
import type { AgentRecord } from '../../storage/store.js';
import { AcpCatalog } from './catalog.js';
import {
  AcpClient,
  AcpRpcError,
  initializeAcp,
  type AcpClientFactory,
  type AcpConnection,
} from './client.js';
import type { AcpHarness } from './harness.js';
import {
  chunkSchema,
  elicitationRequestSchema,
  newSessionResultSchema,
  permissionRequestSchema,
  planSchema,
  promptResultSchema,
  selectValues,
  sessionStateSchema,
  sessionUpdateSchema,
  toolCallSchema,
  usageUpdateSchema,
  type AcpConfigOption,
  type AcpFormField,
  type AcpRequestId,
  type AcpSessionState,
} from './protocol.js';

const BUSY_RETRY_MS = 60_000;

/** The busy refusal Kimi and other ACP agents return while another turn runs. */
function busy(error: unknown) {
  return (
    error instanceof AcpRpcError &&
    error.code === -32600 &&
    z.object({ code: z.literal('turn.agent_busy') }).safeParse(error.data).success
  );
}

export class AcpAdapter implements HarnessAdapter {
  readonly catalog: HarnessCatalog;
  private readonly factory: AcpClientFactory;
  constructor(
    readonly harness: AcpHarness,
    catalog?: HarnessCatalog,
    factory?: AcpClientFactory,
  ) {
    this.factory =
      factory ??
      ((command, workspace, handlers, log) =>
        new AcpClient(
          harness.descriptor.displayName,
          command,
          harness.args,
          workspace,
          harness.env,
          handlers,
          harness.redactor,
          log,
        ));
    this.catalog = catalog ?? new AcpCatalog(harness, this.factory);
  }
  get descriptor() {
    return this.harness.descriptor;
  }
  get nativeHome() {
    return this.harness.home;
  }
  invalidate() {
    this.harness.invalidate();
    this.catalog.invalidate?.();
  }
  async connect(
    agent: AgentRecord,
    baseUrl: string,
    handlers: HarnessHandlers,
  ): Promise<HarnessSession> {
    const session = new AcpSession(agent, this.harness, baseUrl, handlers, this.factory);
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

interface ToolState {
  title: string;
  kind: string;
  status: string;
  input: string;
  output: string;
}
interface ActiveTurn {
  id: string;
  accepted: boolean;
  interrupted: boolean;
  /** The message or reasoning item that consecutive chunks extend. */
  segment: { id: string; type: 'agentMessage' | 'reasoning' } | undefined;
  segments: number;
  tools: Map<string, ToolState>;
  accept(): void;
  /** Settles submission before acceptance; afterwards the turn ends through completion events. */
  fail(error: Error): void;
}
interface PendingQuestion {
  id: AcpRequestId;
  turnId: string;
  fields: { key: string; multiple: boolean }[];
}

class AcpSession implements HarnessSession {
  private client: AcpConnection | undefined;
  private token: string | undefined;
  private sessionId: string | undefined;
  private resumeMethod: 'session/resume' | 'session/load' = 'session/resume';
  private options: AcpConfigOption[] = [];
  private mode: string | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private exitReported = false;
  private active: ActiveTurn | undefined;
  private questions = new Map<string, PendingQuestion>();
  constructor(
    private agent: AgentRecord,
    private harness: AcpHarness,
    private baseUrl: string,
    private output: HarnessHandlers,
    private factory: AcpClientFactory,
  ) {}
  private get name() {
    return this.harness.descriptor.displayName;
  }
  async prepare() {
    this.token = await this.harness.prepare(this.agent);
    await this.harness.learnSecrets();
    if (this.closed) throw new Error(`${this.name} 连接已停止`);
    await this.harness.executable();
  }
  private native() {
    if (!this.client || this.closed) throw new Error(`${this.name} 连接已关闭`);
    return this.client;
  }
  private error(value: unknown) {
    return new Error(this.harness.redactor.text(value));
  }
  private mcpServers() {
    return [
      {
        type: 'http',
        name: 'isles',
        url: `${this.baseUrl}/mcp/${this.agent.id}`,
        headers: [{ name: 'Authorization', value: `Bearer ${this.token}` }],
      },
    ];
  }
  private async open() {
    if (this.closed || this.client || !this.token) throw new Error(`${this.name} 连接状态无效`);
    const command = await this.harness.executable();
    if (this.closed) throw new Error(`${this.name} 连接已停止`);
    this.client = this.factory(
      command,
      this.agent.workspace,
      {
        notification: (method, params) => this.notification(method, params),
        request: (id, method, params) => this.request(id, method, params),
        exit: (error) => this.exit(this.error(error)),
      },
      this.harness.log.child({ agentId: this.agent.id }),
    );
    const capabilities = (await initializeAcp(this.native(), this.name)).agentCapabilities;
    if (!capabilities?.mcpCapabilities?.http)
      throw new Error(`${this.name} 未声明 HTTP MCP 支持，无法连接 Isles`);
    if (capabilities.sessionCapabilities?.resume) this.resumeMethod = 'session/resume';
    else if (capabilities.loadSession) this.resumeMethod = 'session/load';
    else throw new Error(`${this.name} 未声明 session 恢复能力`);
  }
  async createSession(onCreated: (id: string) => void) {
    try {
      await this.open();
      const result = newSessionResultSchema.parse(
        await this.native().request('session/new', {
          cwd: this.agent.workspace,
          mcpServers: this.mcpServers(),
        }),
      );
      this.sessionId = result.sessionId;
      onCreated(result.sessionId);
      await this.configure(result);
      return result.sessionId;
    } catch (error) {
      await this.close();
      this.exit(this.error(error));
      throw error;
    }
  }
  async resumeSession(sessionId: string) {
    try {
      await this.open();
      // Load replays history as updates; without an active turn they are not recorded.
      this.sessionId = sessionId;
      const state = sessionStateSchema.parse(
        await this.native()
          .request(this.resumeMethod, {
            sessionId,
            cwd: this.agent.workspace,
            mcpServers: this.mcpServers(),
          })
          .catch((error: unknown) => {
            throw error instanceof AcpRpcError
              ? new Error(`${this.name} 无法恢复原 session：${error.message}`)
              : error;
          }),
      );
      await this.configure(state);
      return sessionId;
    } catch (error) {
      await this.close();
      this.exit(this.error(error));
      throw error;
    }
  }
  /** Mode first, then model; thinking levels depend on the selected model. */
  private async configure(state: AcpSessionState) {
    this.observe(state);
    await this.applyMode();
    if (this.agent.model !== 'default') await this.select('model', this.agent.model, '模型');
    if (this.agent.reasoningEffort !== 'default')
      await this.select('thought_level', this.agent.reasoningEffort, '推理等级');
  }
  private observe(state: AcpSessionState) {
    if (state.configOptions) this.options = state.configOptions;
    const mode = this.options.find((option) => option.category === 'mode')?.currentValue;
    if (typeof mode === 'string') this.mode = mode;
    else if (state.modes) this.mode = state.modes.currentModeId;
  }
  private async applyMode() {
    const mode = this.harness.sessionMode;
    if (this.mode === mode) return;
    if (this.options.some((option) => option.category === 'mode'))
      await this.select('mode', mode, '运行模式');
    else {
      await this.native().request('session/set_mode', { sessionId: this.sessionId, modeId: mode });
      this.mode = mode;
    }
  }
  private async select(category: string, value: string, label: string) {
    const option = this.options.find((candidate) => candidate.category === category);
    if (!option || !selectValues(option).some((entry) => entry.value === value))
      throw new Error(`${this.name} 当前不支持${label} ${value}，请修改 Agent 设置`);
    // Kimi can retain an unsupported thinking value after switching models.
    if (option.currentValue === value && category !== 'thought_level') return;
    this.observe(
      sessionStateSchema.parse(
        await this.native().request('session/set_config_option', {
          sessionId: this.sessionId,
          configId: option.id,
          value,
        }),
      ),
    );
  }
  async submit(input: HarnessTurnInput) {
    if (
      this.closed ||
      input.sessionId !== this.sessionId ||
      input.workspace !== this.agent.workspace ||
      input.model !== this.agent.model ||
      input.reasoningEffort !== this.agent.reasoningEffort ||
      this.active
    )
      throw new HarnessSubmissionRejected(`${this.name} 输入与当前会话配置不一致`);
    const deadline = Date.now() + BUSY_RETRY_MS;
    for (let attempt = 0; ; attempt++) {
      // Nothing was prompted yet, so a failure here is a definite refusal.
      try {
        if (this.closed) throw new Error(`${this.name} 连接已关闭`);
        await this.applyMode();
      } catch (error) {
        throw new HarnessSubmissionRejected(this.harness.redactor.text(error));
      }
      if ((await this.prompt(input)) === 'accepted') return { turnId: input.runId };
      // A background turn of the native session holds it; the input waits for that turn.
      if (Date.now() >= deadline)
        throw new HarnessSubmissionRejected(`${this.name} 正在执行其他任务，请稍后重试`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 5_000)));
    }
  }
  private prompt(input: HarnessTurnInput) {
    return new Promise<'accepted' | 'busy'>((resolve, reject) => {
      const active: ActiveTurn = {
        id: input.runId,
        accepted: false,
        interrupted: false,
        segment: undefined,
        segments: 0,
        tools: new Map(),
        accept: () => {
          if (active.accepted) return;
          active.accepted = true;
          this.output.event({
            type: 'turn_started',
            sessionId: this.sessionId!,
            turnId: active.id,
          });
          resolve('accepted');
        },
        fail: reject,
      };
      this.active = active;
      this.native()
        .request(
          'session/prompt',
          { sessionId: input.sessionId, prompt: [{ type: 'text', text: input.text }] },
          { timeout: null },
        )
        .then((value) => {
          const { stopReason } = promptResultSchema.parse(value);
          active.accept();
          const interrupted = active.interrupted || stopReason === 'cancelled';
          this.complete(
            active,
            interrupted ? 'interrupted' : stopReason === 'refusal' ? 'failed' : 'completed',
            stopReason === 'refusal'
              ? `${this.name} 拒绝继续执行`
              : ['max_tokens', 'max_turn_requests'].includes(stopReason)
                ? `${this.name} 已达到单轮上限（${stopReason}）`
                : null,
          );
        })
        .catch((error: unknown) => {
          if (this.closed) return;
          if (error instanceof AcpRpcError) {
            if (active.accepted) this.complete(active, 'failed', error.message);
            else {
              if (this.active === active) this.active = undefined;
              if (busy(error)) resolve('busy');
              else reject(new HarnessSubmissionRejected(error.message));
            }
            return;
          }
          // Invalid results and transport failures leave the input uncertain.
          // Report through exit both before and after the first update.
          this.exit(this.error(error));
          return this.close().catch((closeError: unknown) =>
            this.harness.log.warn({ err: closeError }, 'Closing an invalid ACP session failed'),
          );
        });
    });
  }
  private complete(
    active: ActiveTurn,
    status: 'completed' | 'interrupted' | 'failed',
    error: string | null,
  ) {
    if (this.active !== active) return;
    this.endSegment(active, false, status);
    this.active = undefined;
    for (const [key, pending] of this.questions)
      if (pending.turnId === active.id) this.questions.delete(key);
    this.output.event({
      type: 'turn_completed',
      sessionId: this.sessionId!,
      turnId: active.id,
      status,
      error: error === null ? null : this.harness.redactor.text(error),
    });
  }
  async interrupt(sessionId: string, turnId: string) {
    const active = this.active;
    if (sessionId !== this.sessionId || active?.id !== turnId) return;
    active.interrupted = true;
    for (const pending of this.questions.values())
      this.native().respond(pending.id, { action: 'cancel' });
    this.questions.clear();
    this.native().notify('session/cancel', { sessionId });
  }
  answer(requestId: HarnessRequestId, answer: QuestionAnswer) {
    const key = String(requestId);
    const pending = this.questions.get(key);
    if (!pending || pending.turnId !== this.active?.id)
      throw new Error(`${this.name} 原生问题已失效`);
    const content: Record<string, string | string[]> = {};
    for (const field of pending.fields) {
      const values = answer.answers[field.key]?.answers ?? [];
      content[field.key] = field.multiple ? values : (values[0] ?? '');
    }
    this.native().respond(pending.id, { action: 'accept', content });
    this.questions.delete(key);
  }
  /** ACP form declines carry no reason. */
  rejectQuestion(requestId: HarnessRequestId) {
    const key = String(requestId);
    const pending = this.questions.get(key);
    this.questions.delete(key);
    if (pending && !this.closed) this.native().respond(pending.id, { action: 'decline' });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.active?.fail(new Error(`${this.name} 连接已关闭，输入结果待核对`));
    this.questions.clear();
    const closing = this.client?.close() ?? Promise.resolve();
    this.closing = closing;
    return closing;
  }
  private exit(error: Error) {
    if (this.exitReported) return;
    this.exitReported = true;
    this.active?.fail(error);
    this.output.exit(error);
  }
  private request(id: AcpRequestId, method: string, params: unknown) {
    const active = this.active;
    if (method === 'session/request_permission') {
      const request = permissionRequestSchema.safeParse(params);
      if (!request.success || request.data.sessionId !== this.sessionId) {
        this.native().respond(id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      active?.accept();
      // Isles runs Agents with full access. Questions arrive as forms; the permission
      // fallback for a question would otherwise select an answer for the user.
      const option =
        request.data.toolCall.title === 'AskUserQuestion'
          ? undefined
          : (request.data.options.find((candidate) => candidate.kind === 'allow_once') ??
            request.data.options.find((candidate) => candidate.kind === 'allow_always'));
      this.native().respond(id, {
        outcome: option
          ? { outcome: 'selected', optionId: option.optionId }
          : { outcome: 'cancelled' },
      });
      return;
    }
    if (method === 'elicitation/create') {
      const request = elicitationRequestSchema.safeParse(params);
      const fields = request.success ? Object.entries(request.data.requestedSchema.properties) : [];
      if (
        !request.success ||
        !active ||
        (request.data.sessionId !== undefined && request.data.sessionId !== this.sessionId) ||
        fields.length === 0 ||
        fields.some(([, field]) => !['string', 'array'].includes(field.type))
      ) {
        this.native().respond(id, { action: 'decline' });
        return;
      }
      active.accept();
      const key = String(id);
      this.questions.set(key, {
        id,
        turnId: active.id,
        fields: fields.map(([name, field]) => ({ key: name, multiple: field.type === 'array' })),
      });
      // The form message joins one line per question when each field carries only a header.
      const lines = request.data.message.split('\n');
      this.output.question({
        sessionId: this.sessionId!,
        turnId: active.id,
        requestId: key,
        questions: fields.map(([name, field], index) =>
          this.question(
            name,
            field,
            lines.length === fields.length ? lines[index]! : request.data.message,
          ),
        ),
      });
      return;
    }
    this.native().reject(id, -32601, `Isles does not provide ${method}`);
  }
  private question(id: string, field: AcpFormField, message: string): QuestionDefinition {
    const choices =
      field.oneOf ??
      field.anyOf ??
      field.items?.anyOf ??
      field.items?.oneOf ??
      (field.enum ?? field.items?.enum)?.map((value) => ({ const: value }));
    return {
      id,
      header: field.title && field.title !== message ? field.title : '',
      question: [message, field.description].filter(Boolean).join('\n'),
      isOther: false,
      isSecret: false,
      multiSelect: field.type === 'array',
      options:
        choices?.map((choice) => ({
          label: choice.const,
          description:
            'description' in choice && typeof choice.description === 'string'
              ? choice.description
              : '',
        })) ?? null,
    };
  }
  private notification(method: string, params: unknown) {
    if (method !== 'session/update') return;
    const parsed = sessionUpdateSchema.safeParse(params);
    if (!parsed.success || parsed.data.sessionId !== this.sessionId) return;
    const update = parsed.data.update;
    if (update.sessionUpdate === 'usage_update') {
      const usage = usageUpdateSchema.safeParse(update);
      if (usage.success)
        this.output.event({
          type: 'context_usage',
          sessionId: parsed.data.sessionId,
          usage: { usedTokens: usage.data.used, maxTokens: usage.data.size, estimated: false },
        });
      return;
    }
    if (update.sessionUpdate === 'current_mode_update') {
      if (typeof update.currentModeId === 'string') this.mode = update.currentModeId;
      return;
    }
    if (update.sessionUpdate === 'config_option_update') {
      const state = sessionStateSchema.safeParse(update);
      if (state.success) this.observe(state.data);
      return;
    }
    // Updates outside an Isles turn (history replay, late output after cancel) are not recorded.
    const active = this.active;
    if (!active) return;
    if (
      update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk'
    ) {
      const chunk = chunkSchema.safeParse(update);
      const text =
        chunk.success && typeof chunk.data.content.text === 'string' ? chunk.data.content.text : '';
      if (!text) return;
      active.accept();
      const type = update.sessionUpdate === 'agent_message_chunk' ? 'agentMessage' : 'reasoning';
      if (active.segment?.type !== type) {
        this.endSegment(active, true);
        active.segment = { id: `${active.id}:${++active.segments}`, type };
      }
      this.item({ id: active.segment.id, type, status: 'running', text }, true, true);
    } else if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      const call = toolCallSchema.safeParse(update);
      if (!call.success) return;
      active.accept();
      this.tool(active, call.data);
    } else if (update.sessionUpdate === 'plan') {
      const plan = planSchema.safeParse(update);
      if (!plan.success) return;
      active.accept();
      this.endSegment(active);
      this.item({
        id: `${active.id}:plan`,
        type: 'plan',
        status: plan.data.entries.every((entry) => entry.status === 'completed')
          ? 'completed'
          : 'running',
        text: plan.data.entries
          .map((entry) => `${entry.status === 'completed' ? '[x]' : '[ ]'} ${entry.content}`)
          .join('\n'),
      });
    }
  }
  /** Updates carry only changed fields; content replaces the previous content. */
  private tool(active: ActiveTurn, call: z.infer<typeof toolCallSchema>) {
    const previous = active.tools.get(call.toolCallId);
    const progress =
      previous !== undefined &&
      call.sessionUpdate === 'tool_call_update' &&
      !['completed', 'failed'].includes(previous.status) &&
      (call.status == null || call.status === previous.status);
    this.endSegment(active, progress);
    const state = previous ?? {
      title: '',
      kind: 'other',
      status: 'pending',
      input: '',
      output: '',
    };
    active.tools.set(call.toolCallId, state);
    state.title = call.title ?? state.title;
    state.kind = call.kind ?? state.kind;
    state.status = call.status ?? state.status;
    if (call.rawInput !== undefined) state.input = format(call.rawInput);
    if (call.content) {
      const text = call.content
        .map((entry) =>
          entry.type === 'diff' && entry.path
            ? entry.path
            : typeof entry.content?.text === 'string'
              ? entry.content.text
              : '',
        )
        .filter(Boolean)
        .join('\n');
      if (['completed', 'failed'].includes(state.status)) state.output = text;
      else if (call.rawInput === undefined && !state.input) state.input = text;
    }
    if (call.rawOutput !== undefined && !state.output) state.output = format(call.rawOutput);
    this.item(
      {
        id: call.toolCallId,
        type:
          state.kind === 'execute'
            ? 'commandExecution'
            : ['edit', 'delete', 'move'].includes(state.kind)
              ? 'fileChange'
              : state.kind === 'fetch'
                ? 'webSearch'
                : 'toolCall',
        status: ['completed', 'failed'].includes(state.status) ? state.status : 'running',
        text: [state.title, state.input, state.output].filter(Boolean).join('\n\n'),
      },
      false,
      progress,
    );
  }
  private endSegment(
    active: ActiveTurn,
    delta = false,
    status: 'completed' | 'interrupted' | 'failed' = 'completed',
  ) {
    const segment = active.segment;
    if (!segment) return;
    active.segment = undefined;
    this.item({ id: segment.id, type: segment.type, status, text: '' }, true, delta);
  }
  private item(item: RunItem, append = false, delta = false) {
    const active = this.active;
    if (!active) return;
    this.output.event({
      type: delta ? 'item_delta' : 'item',
      sessionId: this.sessionId!,
      turnId: active.id,
      append,
      item: { ...item, text: this.harness.redactor.output(item.text) },
    });
  }
}

function format(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
