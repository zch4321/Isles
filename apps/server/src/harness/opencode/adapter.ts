import type {
  HarnessDescriptor,
  QuestionAnswer,
  QuestionDefinition,
  RunItem,
} from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { relative } from 'node:path';
import { z } from 'zod';
import type { AgentRecord } from '../../storage/store.js';
import { additionalWorkspacePaths } from '../../runtime/workspace-paths.js';
import {
  HarnessImageInputUnsupported,
  HarnessSubmissionRejected,
  type HarnessAdapter,
  type HarnessHandlers,
  type HarnessContextUsage,
  type HarnessRequestId,
  type HarnessSession,
  type HarnessSteerInput,
  type HarnessTurnInput,
} from '../types.js';
import { OpenCodeCatalog } from './catalog.js';
import {
  OpenCodeClient,
  OpenCodeHttpError,
  type OpenCodeClientFactory,
  type OpenCodeConnection,
  type OpenCodeStream,
} from './client.js';
import type { OpenCodeEnvironment } from './environment.js';
import { permissionAllowed, permissionQuestions } from '../shared/permissions.js';
import {
  eventEnvelopeSchema,
  durableEventSchema,
  formInfoSchema,
  inboxListSchema,
  inboxResponseSchema,
  modelRef,
  modelRefSchema,
  sessionResponseSchema,
  sessionListSchema,
  permissionRequestSchema,
  permissionReplySchema,
  permissionListSchema,
  contextResponseSchema,
  modelsResponseSchema,
  modelKey,
  type OpenCodeModelRef,
  type OpenCodeEvent,
  type OpenCodeForm,
  type OpenCodePermissionRequest,
  type OpenCodePermissionRule,
} from './protocol.js';

const connectedFrame = z.object({
  type: z.literal('server.connected'),
  id: z.string().startsWith('evt_'),
  data: z.object({}),
});
function sessionPermissions(
  agent: AgentRecord,
  workspacePaths: readonly string[],
): OpenCodePermissionRule[] {
  if (agent.dangerFullAccess) return [{ action: '*', resource: '*', effect: 'allow' }];
  const slash = (path: string) => path.replaceAll('\\', '/');
  // Core uses Location-relative resources inside its project worktree, absolute ones outside.
  // Keep shell, read and other actions on their native configured policy.
  return [
    { action: 'edit', resource: '*', effect: 'allow' },
    { action: 'edit', resource: '../*', effect: 'ask' },
    { action: 'edit', resource: '/*', effect: 'ask' },
    { action: 'edit', resource: '?:/*', effect: 'ask' },
    ...workspacePaths.flatMap((path) => {
      const resources = new Set([slash(path), slash(relative(agent.workspace, path))]);
      return [...resources].filter(Boolean).flatMap((resource) =>
        [resource, `${resource.replace(/\/$/, '')}/*`].flatMap((pattern) => [
          { action: 'edit', resource: pattern, effect: 'allow' as const },
          { action: 'external_directory', resource: pattern, effect: 'allow' as const },
        ]),
      );
    }),
  ];
}
const inputRef = z.object({ sessionID: z.string(), inboxID: z.string() });
const textData = z.object({
  assistantMessageID: z.string(),
  ordinal: z.number().int(),
  text: z.string(),
});
const toolRef = z.object({ assistantMessageID: z.string(), id: z.string() });
const toolContent = z.array(
  z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
);

export class OpenCodeAdapter implements HarnessAdapter {
  readonly descriptor: HarnessDescriptor = {
    id: 'opencode',
    displayName: 'OpenCode',
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
  readonly catalog: OpenCodeCatalog;
  constructor(
    readonly environment: OpenCodeEnvironment,
    private factory: OpenCodeClientFactory = (...args) => new OpenCodeClient(...args),
  ) {
    this.catalog = new OpenCodeCatalog(environment, factory);
  }
  get nativeHome() {
    return this.environment.nativeHome;
  }
  invalidate() {
    this.environment.invalidate();
    this.catalog.invalidate();
  }
  async connect(agent: AgentRecord, baseUrl: string, handlers: HarnessHandlers) {
    const session = new OpenCodeSession(this.environment, this.factory, agent, baseUrl, handlers);
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
interface PendingPermission {
  request: OpenCodePermissionRequest;
  turnId?: string;
}

/** Maps one native execution interval to a platform turn, using durable log identities. */
class OpenCodeSession implements HarnessSession {
  private readonly workspacePaths: string[];
  private client?: OpenCodeConnection;
  private sessionId?: string;
  private executions = new Map<string, string>();
  private inputs = new Map<string, PendingInput>();
  private submitted = new Set<string>();
  private closing?: Promise<void>;
  private stopped = false;
  private streams = new Set<OpenCodeStream>();
  private descendants = new Set<string>();
  private nativeSeq = new Map<string, number>();
  private forms = new Map<string, OpenCodeForm>();
  private publishedForms = new Map<string, string>();
  private permissions = new Map<string, PendingPermission>();
  private ownedInputs = new Set<string>();
  private admissions = new Set<Promise<unknown>>();
  private toolNames = new Map<string, string>();
  private contextModels = new Map<string, number>();
  private contextModel?: OpenCodeModelRef;
  private contextRefresh = Promise.resolve();
  constructor(
    private environment: OpenCodeEnvironment,
    private factory: OpenCodeClientFactory,
    private agent: AgentRecord,
    private baseUrl: string,
    private handlers: HarnessHandlers,
  ) {
    this.workspacePaths = additionalWorkspacePaths(agent, environment.workspace.sharedDir);
    if (!agent.dangerFullAccess) {
      // OpenCode 2.1.4 Wildcard.match has no literal wildcard escape and always
      // normalizes backslashes, including literal backslashes in Unix filenames.
      const unsupported = this.workspacePaths.find(
        (path) => /[*?]/.test(path) || (process.platform !== 'win32' && path.includes('\\')),
      );
      if (unsupported) {
        const characters = process.platform === 'win32' ? '*、?' : '*、?、\\';
        throw new Error(
          `OpenCode 无法按字面匹配附加工作区路径“${unsupported}”。请重命名目录，移除字符 ${characters}`,
        );
      }
    }
  }
  async prepare() {
    const env = await this.environment.prepare(this.agent, this.baseUrl);
    const command = await this.environment.executable();
    if (this.closing) throw new Error('OpenCode 连接已关闭');
    this.client = this.factory(
      command,
      this.agent.workspace,
      env,
      { exit: (error) => this.fail(error) },
      this.environment.redactor,
      this.environment.log,
    );
    await this.client.start();
    await this.environment.learnCredentials(this.client);
    await this.verifyMcp();
    let connected = () => {};
    const ready = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const stream = await this.client.watch('/api/event', (frame) => {
      if (connectedFrame.safeParse(frame).success) connected();
      else this.live(frame);
    });
    this.track(stream);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready,
        stream.done.then(() => {
          throw new Error('OpenCode 事件流尚未就绪就已结束');
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('OpenCode 事件订阅超时')), 30_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async verifyMcp() {
    const schema = z.object({
      data: z.array(
        z.object({
          name: z.string(),
          status: z.object({ status: z.string(), error: z.string().optional() }),
        }),
      ),
    });
    const path = `/api/mcp?location%5Bdirectory%5D=${encodeURIComponent(this.agent.workspace)}`;
    const deadline = Date.now() + 20_000;
    while (true) {
      const result = schema.parse(await this.native().request('GET', path));
      const isles = result.data.find((server) => server.name === 'isles')?.status;
      if (isles?.status === 'connected') return;
      if ((isles && isles.status !== 'pending') || Date.now() >= deadline)
        throw new Error(
          `OpenCode Isles MCP 连接失败：${this.environment.redactor.text(isles?.error ?? '连接超时')}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  private native() {
    if (!this.client || this.closing) throw new Error('OpenCode 连接已关闭');
    return this.client;
  }
  async createSession(onCreated: (id: string) => void) {
    const id = `ses_${randomUUID().replaceAll('-', '')}`;
    // Caller-provided native IDs make an uncertain creation recoverable without a replacement.
    onCreated(id);
    const session = sessionResponseSchema.parse(
      await this.native().request('POST', '/api/session', {
        id,
        title: this.agent.name,
        location: { directory: this.agent.workspace },
        model: modelRef(this.agent.model, this.agent.reasoningEffort),
        permissions: sessionPermissions(this.agent, this.workspacePaths),
      }),
    ).data;
    if (session.id !== id) throw new Error('OpenCode 创建返回了不同 session');
    await this.bind(session);
    await this.readPermissions(id);
    return id;
  }
  async resumeSession(id: string) {
    const session = sessionResponseSchema.parse(
      await this.native().request('GET', `/api/session/${id}`),
    ).data;
    if (session.id !== id) throw new Error('OpenCode 恢复返回了不同 session');
    const inbox = inboxListSchema.parse(
      await this.native().request('GET', `/api/session/${id}/inbox`),
    );
    if (inbox.data.length) throw new Error('OpenCode 原生会话有待处理输入，请先核对原生收件箱。');
    await this.native().request('PATCH', `/api/session/${id}`, {
      title: this.agent.name,
      permissions: sessionPermissions(this.agent, this.workspacePaths),
    });
    await this.bind(session);
    await this.restoreChildren(id);
    for (const descendant of this.descendants) await this.readPermissions(descendant);
    return id;
  }
  private async restoreChildren(parentID: string, visited = new Set<string>([parentID])) {
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ parentID });
      if (cursor) query.set('cursor', cursor);
      const page = sessionListSchema.parse(
        await this.native().request('GET', `/api/session?${query}`),
      );
      for (const child of page.data) {
        if (child.parentID !== parentID || visited.has(child.id)) continue;
        visited.add(child.id);
        if ((await realpath(child.location.directory)) !== (await realpath(this.agent.workspace)))
          throw new Error('OpenCode 子 session 的工作目录与 Agent 不一致');
        await this.native().request('PATCH', `/api/session/${child.id}`, {
          permissions: sessionPermissions(this.agent, this.workspacePaths),
        });
        this.descendants.add(child.id);
        await this.restoreChildren(child.id, visited);
      }
      cursor = page.cursor?.next ?? undefined;
    } while (cursor);
  }
  private async readPermissions(sessionID: string) {
    const { data } = permissionListSchema.parse(
      await this.native().request('GET', `/api/session/${sessionID}/permission`),
    );
    for (const request of data) await this.receivePermission(request);
  }
  private async bind(session: z.infer<typeof sessionResponseSchema>['data']) {
    if ((await realpath(session.location.directory)) !== (await realpath(this.agent.workspace)))
      throw new Error('OpenCode session 的工作目录与 Agent 不一致');
    this.sessionId = session.id;
    this.descendants.add(session.id);
    this.contextModel = session.model ?? modelRef(this.agent.model, this.agent.reasoningEffort);
    try {
      const models = modelsResponseSchema.parse(
        await this.native().request('GET', '/api/model'),
      ).data;
      this.contextModels = new Map(
        models
          .filter((model) => model.limit && model.limit.context > 0)
          .map((model) => [modelKey(model), model.limit!.context]),
      );
    } catch (error) {
      this.environment.log.warn(
        { error: this.environment.redactor.text(error) },
        'OpenCode context model read failed',
      );
    }
    await this.refreshContext();
  }
  private refreshContext() {
    const sessionId = this.sessionId;
    this.contextRefresh = this.contextRefresh
      .then(async () => {
        if (!sessionId || this.closing || sessionId !== this.sessionId) return;
        const messages = contextResponseSchema.parse(
          await this.native().request('GET', `/api/session/${sessionId}/context`),
        ).data;
        if (this.closing || sessionId !== this.sessionId || !messages.length) return;
        // Same latest-call boundary as OpenCode's TUI contextUsage. Compaction's
        // own request usage describes the old prompt, never its replacement.
        const compacted = messages.findLastIndex(
          (message) => message.type === 'compaction' && message.status === 'completed',
        );
        const last = messages.findLast(
          (message, index) => index > compacted && message.type === 'assistant' && message.tokens,
        );
        let usage: HarnessContextUsage | null;
        if (last?.tokens) {
          const tokens = last.tokens;
          usage = {
            usedTokens:
              tokens.input +
              tokens.output +
              tokens.reasoning +
              tokens.cache.read +
              tokens.cache.write,
            maxTokens: this.contextModel
              ? (this.contextModels.get(modelKey(this.contextModel)) ?? null)
              : null,
            estimated: false,
          };
        } else if (compacted >= 0 && messages[compacted]?.providerContext !== undefined) {
          // Native compaction can retain an opaque encrypted provider window
          // while summary/recent are empty. Its size needs the next call's
          // provider usage; clear the pre-compaction sample until then.
          usage = null;
        } else {
          // OpenCode core util/token.ts uses four characters per token. Price
          // only active message content, excluding IDs and compaction billing.
          const content = messages
            .slice(Math.max(0, compacted))
            .map((message) =>
              message.type === 'compaction'
                ? { summary: message.summary, recent: message.recent }
                : (message.content ?? message.text ?? ''),
            );
          usage = {
            usedTokens: Math.max(0, Math.round(JSON.stringify(content).length / 4)),
            maxTokens: this.contextModel
              ? (this.contextModels.get(modelKey(this.contextModel)) ?? null)
              : null,
            estimated: true,
          };
        }
        this.handlers.event({ type: 'context_usage', sessionId, usage });
      })
      .catch((error: unknown) => {
        this.environment.log.warn(
          { error: this.environment.redactor.text(error) },
          'OpenCode context usage refresh failed',
        );
      });
    return this.contextRefresh;
  }
  async submit(input: HarnessTurnInput) {
    input.submissionState?.('preparing');
    if (
      input.sessionId !== this.sessionId ||
      this.executions.has(input.sessionId) ||
      this.inputs.size ||
      this.stopped
    )
      throw new HarnessSubmissionRejected('OpenCode session 当前无法开始执行');
    if (input.images?.length) {
      const supported = await this.supportsImage(input.model);
      if (this.stopped || this.executions.has(input.sessionId) || this.inputs.size)
        throw new HarnessSubmissionRejected('OpenCode session 当前无法开始执行');
      if (supported === false)
        throw new HarnessImageInputUnsupported(
          '当前 OpenCode 模型不支持图片输入，请选择支持图片输入的模型并恢复 Agent',
        );
    }
    await this.native().request('POST', `/api/session/${input.sessionId}/model`, {
      model: modelRef(input.model, input.reasoningEffort),
    });
    if (this.stopped || this.executions.has(input.sessionId) || this.inputs.size)
      throw new HarnessSubmissionRejected('OpenCode session 当前无法开始执行');
    const id = `msg_isles_${input.runId}`;
    if (this.submitted.has(id)) throw new HarnessSubmissionRejected('OpenCode 输入批次已投递');
    input.submissionState?.('submitting');
    return this.send(id, input.text, input.images);
  }
  private async supportsImage(model: string): Promise<boolean | undefined> {
    try {
      const models = modelsResponseSchema.parse(await this.native().request('GET', '/api/model'));
      return models.data
        .find((entry) => modelKey(entry) === model)
        ?.capabilities.input.includes('image');
    } catch (error) {
      this.environment.log.warn(
        { error: this.environment.redactor.text(error) },
        'OpenCode image capability lookup failed',
      );
      return undefined;
    }
  }
  async steer(input: HarnessSteerInput) {
    if (
      this.stopped ||
      input.sessionId !== this.sessionId ||
      this.executions.get(input.sessionId) !== input.expectedTurnId
    )
      throw new HarnessSubmissionRejected('OpenCode 当前执行已结束，追加消息进入下一轮');
    return this.send(`msg_isles_${input.batchId}`, input.text);
  }
  private async send(id: string, text: string, images?: HarnessTurnInput['images']) {
    if (this.submitted.has(id)) throw new HarnessSubmissionRejected('OpenCode 输入批次已投递');
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
      timer: setTimeout(() => {
        reject(new Error('OpenCode 输入接收确认超时，结果待核对'));
      }, 60_000),
    };
    this.submitted.add(id);
    this.inputs.set(id, pending);
    this.ownedInputs.add(id);
    try {
      const response = inboxResponseSchema.parse(await this.admit(id, text, images)).data;
      if (
        response.id !== id ||
        response.sessionID !== this.sessionId ||
        response.type !== 'user' ||
        response.delivery !== 'steer'
      )
        throw new Error('OpenCode 输入确认的身份无效，结果待核对');
      // Durable admission may wait at a long-running tool boundary. Consumption settles
      // on inbox.delivered, terminal execution, or connection loss, without a tool timeout.
      clearTimeout(pending.timer);
      return await pending.promise;
    } catch (error) {
      clearTimeout(pending.timer);
      if (pending.accepted) return pending.accepted;
      this.inputs.delete(id);
      const refused =
        error instanceof HarnessSubmissionRejected ||
        (error instanceof OpenCodeHttpError && [400, 401, 403, 404, 409].includes(error.status));
      const reason = refused
        ? new HarnessSubmissionRejected(this.environment.redactor.text(error))
        : (error as Error);
      pending.reject(reason);
      if (refused) this.ownedInputs.delete(id);
      if (!refused) this.fail(reason);
      throw reason;
    }
  }
  private async admit(id: string, text: string, images?: HarnessTurnInput['images']) {
    const request = this.native().request('POST', `/api/session/${this.sessionId}/prompt`, {
      id,
      text: images?.length ? `${text}\n\n${images.map((image) => image.label).join('\n')}` : text,
      ...(images?.length
        ? {
            files: images.map((image) => ({
              uri: `data:${image.mimeType};base64,${image.data}`,
              name: image.label,
            })),
          }
        : {}),
      delivery: 'steer',
      metadata: { isles: this.agent.id },
    });
    this.admissions.add(request);
    try {
      return await request;
    } finally {
      this.admissions.delete(request);
    }
  }
  private track(stream: OpenCodeStream) {
    this.streams.add(stream);
    void stream.done.then(
      () => {
        if (!this.closing) this.fail(new Error('OpenCode 事件流已断开，执行结果待核对'));
      },
      (error: unknown) =>
        this.fail(error instanceof Error ? error : new Error('OpenCode 原生事件无效')),
    );
  }
  private event(event: OpenCodeEvent) {
    const sessionId = z.string().parse(event.data.sessionID);
    if (sessionId === this.sessionId) {
      if (event.type === 'session.model.selected' || event.type === 'session.step.started') {
        const model = modelRefSchema.safeParse(event.data.model);
        if (model.success) this.contextModel = model.data;
        else this.environment.log.warn('OpenCode context model event invalid');
      }
      if (
        [
          'session.model.selected',
          'session.step.ended',
          'session.step.failed',
          'session.compaction.ended',
          'session.revert.committed',
        ].includes(event.type)
      )
        void this.refreshContext();
    }
    if (event.type === 'session.execution.started') {
      if (this.executions.has(sessionId))
        throw new Error('OpenCode session 在当前执行结束前开始了另一执行');
      this.executions.set(sessionId, event.id);
      this.handlers.event({ type: 'turn_started', sessionId, turnId: event.id });
      if (this.stopped)
        void this.client
          ?.request('POST', `/api/session/${sessionId}/interrupt?resume=false`)
          .catch((error: unknown) => this.fail(error as Error));
      for (const form of this.forms.values()) if (form.sessionID === sessionId) this.question(form);
      for (const pending of this.permissions.values())
        if (pending.request.sessionID === sessionId) this.permissionQuestion(pending);
      return;
    }
    if (event.type === 'session.inbox.delivered' || event.type === 'session.inbox.cancelled') {
      if (sessionId !== this.sessionId) return;
      const { inboxID } = inputRef.parse(event.data);
      const pending = this.inputs.get(inboxID);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.inputs.delete(inboxID);
      this.ownedInputs.delete(inboxID);
      const turnId = this.executions.get(sessionId);
      if (event.type.endsWith('cancelled'))
        pending.reject(new HarnessSubmissionRejected('OpenCode 已取消待处理输入'));
      else if (!turnId) pending.reject(new Error('OpenCode 输入缺少原生执行，结果待核对'));
      else {
        pending.accepted = { turnId };
        pending.resolve(pending.accepted);
      }
      return;
    }
    const turnId = this.executions.get(sessionId);
    if (!turnId) return;
    if (
      [
        'session.execution.succeeded',
        'session.execution.failed',
        'session.execution.interrupted',
      ].includes(event.type)
    ) {
      void this.clearPermissions(sessionId).catch((error: unknown) => this.fail(error as Error));
      this.expireForms(sessionId);
      this.executions.delete(sessionId);
      for (const key of this.toolNames.keys())
        if (key.startsWith(`${sessionId}:`)) this.toolNames.delete(key);
      this.handlers.event({
        type: 'turn_completed',
        sessionId,
        turnId,
        status: event.type.endsWith('succeeded')
          ? 'completed'
          : event.type.endsWith('failed')
            ? 'failed'
            : 'interrupted',
        error: event.type.endsWith('failed') ? this.errorText(event.data.error) : null,
      });
      return;
    }
    this.item(event, sessionId, turnId);
  }
  private item(event: OpenCodeEvent, sessionId: string, turnId: string) {
    const data = event.data;
    let item: RunItem | undefined;
    if (event.type === 'session.text.ended' || event.type === 'session.reasoning.ended') {
      const text = textData.parse(data);
      item = {
        id: `${text.assistantMessageID}:${event.type}:${text.ordinal}`,
        type: event.type.includes('reasoning') ? 'reasoning' : 'agentMessage',
        status: 'completed',
        text: text.text,
      };
    } else if (event.type.startsWith('session.tool.')) {
      const ref = toolRef.parse(data);
      const key = `${ref.assistantMessageID}:${ref.id}`;
      const toolKey = `${sessionId}:${key}`;
      if (event.type === 'session.tool.input.started')
        this.toolNames.set(toolKey, z.string().parse(data.name));
      if (
        event.type === 'session.tool.called' ||
        event.type === 'session.tool.success' ||
        event.type === 'session.tool.failed'
      ) {
        const name = this.toolNames.get(toolKey) ?? ref.id;
        const content =
          data.content === undefined
            ? ''
            : toolContent
                .parse(data.content)
                .map((value) => value.text ?? JSON.stringify(value))
                .join('\n');
        item = {
          id: key,
          type: name.includes('isles') ? 'mcpToolCall' : 'toolCall',
          status: event.type.endsWith('called')
            ? 'running'
            : event.type.endsWith('failed')
              ? 'failed'
              : 'completed',
          text: `${name}\n${event.type.endsWith('called') ? JSON.stringify(z.record(z.string(), z.unknown()).parse(data.input)) : content || this.errorText(data.error)}`,
        };
      }
    }
    if (item)
      this.handlers.event({
        type: 'item',
        sessionId,
        turnId,
        append: false,
        item: { ...item, text: this.environment.redactor.output(item.text) },
      });
  }
  private live(frame: unknown) {
    const event = eventEnvelopeSchema.parse(frame);
    if (event.type === 'permission.asked') {
      void this.receivePermission(permissionRequestSchema.parse(event.data)).catch(
        (error: unknown) => this.fail(error as Error),
      );
      return;
    }
    if (event.type === 'permission.replied') {
      const reply = permissionReplySchema.parse(event.data);
      if (this.permissions.get(reply.requestID)?.request.sessionID === reply.sessionID) {
        if (reply.reply === 'reject') this.expireSessionPermissions(reply.sessionID);
        else this.expirePermission(reply.requestID);
      }
      return;
    }
    if (
      event.type === 'session.created' &&
      typeof event.data.parentID === 'string' &&
      this.descendants.has(event.data.parentID)
    )
      this.descendants.add(z.string().parse(event.data.sessionID));
    if (event.type === 'form.created') {
      const form = formInfoSchema.parse(event.data.form);
      if (!this.descendants.has(form.sessionID) || this.stopped || this.forms.has(form.id)) return;
      if (
        form.fields.some(
          (field) => !['string', 'multiselect'].includes(field.type) || field.when || field.hidden,
        )
      ) {
        void this.native()
          .request(
            'DELETE',
            `/api/session/${form.sessionID}/form/${form.id}?message=${encodeURIComponent('请使用文本或选项问题')}`,
          )
          .catch((error: unknown) => this.fail(error as Error));
        return;
      }
      this.forms.set(form.id, form);
      this.question(form);
    }
    const sessionId = event.data.sessionID;
    if (typeof sessionId !== 'string' || !this.descendants.has(sessionId)) return;
    if (event.durable) {
      const committed = durableEventSchema.parse(event);
      if (committed.durable.aggregateID !== sessionId)
        throw new Error('OpenCode 事件的 session 身份无效');
      if (committed.durable.seq <= (this.nativeSeq.get(sessionId) ?? -1)) return;
      this.nativeSeq.set(sessionId, committed.durable.seq);
    } else if (
      event.type.startsWith('session.execution.') ||
      event.type.startsWith('session.inbox.')
    ) {
      throw new Error('OpenCode 执行事件缺少提交确认');
    }
    this.event(event);
  }

  private async receivePermission(request: OpenCodePermissionRequest) {
    if (this.permissions.has(request.id)) return;
    if (
      !this.descendants.has(request.sessionID) ||
      (!this.executions.has(request.sessionID) &&
        !(request.sessionID === this.sessionId && this.inputs.size)) ||
      this.stopped ||
      this.closing
    ) {
      await this.replyPermission(request, 'reject');
      return;
    }
    const pending: PendingPermission = { request };
    this.permissions.set(request.id, pending);
    this.permissionQuestion(pending);
  }
  private permissionQuestion(pending: PendingPermission) {
    const request = pending.request;
    const turnId = this.executions.get(request.sessionID);
    if (!turnId || pending.turnId) return;
    pending.turnId = turnId;
    const text = this.environment.redactor.output(
      [request.message, `OpenCode 请求执行 ${request.action}`, ...request.resources]
        .filter(Boolean)
        .join('\n'),
    );
    this.handlers.question({
      sessionId: request.sessionID,
      turnId: pending.turnId,
      requestId: request.id,
      questions: permissionQuestions(text),
    });
  }
  private expirePermission(id: string) {
    const pending = this.permissions.get(id);
    if (!pending) return;
    this.permissions.delete(id);
    if (pending.turnId)
      this.handlers.event({
        type: 'question_expired',
        sessionId: pending.request.sessionID,
        turnId: pending.turnId,
        requestId: id,
      });
  }
  private expireSessionPermissions(sessionID: string) {
    for (const [id, pending] of this.permissions)
      if (pending.request.sessionID === sessionID) this.expirePermission(id);
  }
  private async replyPermission(request: OpenCodePermissionRequest, decision: 'once' | 'reject') {
    if (!this.client) return;
    try {
      await this.client.request(
        'POST',
        `/api/session/${request.sessionID}/permission/${request.id}/reply`,
        {
          decision,
        },
      );
    } catch (error) {
      // A native client or interruption may settle the request before our HTTP reply arrives.
      if (!(error instanceof OpenCodeHttpError && error.status === 404)) throw error;
    }
  }
  private async clearPermissions(sessionID?: string) {
    const requests = new Map<string, OpenCodePermissionRequest>();
    for (const [id, pending] of this.permissions) {
      if (sessionID && pending.request.sessionID !== sessionID) continue;
      requests.set(pending.request.sessionID, pending.request);
      this.expirePermission(id);
    }
    for (const request of requests.values()) await this.replyPermission(request, 'reject');
  }
  private question(form: OpenCodeForm) {
    const turnId = this.executions.get(form.sessionID);
    if (!turnId || this.publishedForms.has(form.id)) return;
    this.publishedForms.set(form.id, turnId);
    const questions: QuestionDefinition[] = form.fields.map((field) => ({
      id: field.key,
      header: field.title ?? form.title,
      question: field.description ?? field.title ?? form.title,
      isOther: field.custom === true,
      isSecret: false,
      multiSelect: field.type === 'multiselect',
      options:
        field.options?.map((option) => ({
          label: option.label,
          description: option.description ?? '',
        })) ?? null,
    }));
    this.handlers.question({
      sessionId: form.sessionID,
      turnId,
      requestId: form.id,
      questions,
    });
  }
  private expireForms(sessionID?: string) {
    for (const [id, form] of this.forms) {
      if (sessionID && form.sessionID !== sessionID) continue;
      this.forms.delete(id);
      const turnId = this.publishedForms.get(id);
      this.publishedForms.delete(id);
      if (turnId)
        this.handlers.event({
          type: 'question_expired',
          sessionId: form.sessionID,
          turnId,
          requestId: id,
        });
    }
  }
  answer(requestId: HarnessRequestId, answer: QuestionAnswer) {
    const pending = this.permissions.get(String(requestId));
    if (pending) {
      const decision = permissionAllowed(answer) ? 'once' : 'reject';
      // Runtime records this answered question; only other released requests expire.
      this.permissions.delete(pending.request.id);
      if (decision === 'reject') this.expireSessionPermissions(pending.request.sessionID);
      void this.replyPermission(pending.request, decision).catch((error: unknown) =>
        this.fail(error as Error),
      );
      return;
    }
    const form = this.forms.get(String(requestId));
    if (!form || !this.executions.has(form.sessionID)) return;
    const values: Record<string, string | string[]> = {};
    for (const field of form.fields) {
      const answers = answer.answers[field.key]?.answers;
      if (!answers?.length) throw new Error('OpenCode 问题尚未填写');
      const mapped = answers.map(
        (value) => field.options?.find((option) => option.label === value)?.value ?? value,
      );
      values[field.key] = field.type === 'multiselect' ? mapped : mapped[0]!;
    }
    this.forms.delete(form.id);
    this.publishedForms.delete(form.id);
    void this.native()
      .request('POST', `/api/session/${form.sessionID}/form/${form.id}/reply`, { answer: values })
      .catch((error: unknown) => this.fail(error as Error));
  }
  rejectQuestion(requestId: HarnessRequestId, reason: string) {
    const pending = this.permissions.get(String(requestId));
    if (pending) {
      this.expireSessionPermissions(pending.request.sessionID);
      void this.replyPermission(pending.request, 'reject').catch((error: unknown) =>
        this.fail(error as Error),
      );
      return;
    }
    const form = this.forms.get(String(requestId));
    if (!form || this.closing) return;
    this.forms.delete(form.id);
    this.publishedForms.delete(form.id);
    void this.native()
      .request(
        'DELETE',
        `/api/session/${form.sessionID}/form/${form.id}?message=${encodeURIComponent(reason)}`,
      )
      .catch((error: unknown) => this.fail(error as Error));
  }
  async interrupt(sessionId: string, turnId: string) {
    if (!this.descendants.has(sessionId) || this.executions.get(sessionId) !== turnId) return;
    this.stopped = true;
    this.expireForms();
    await this.clearPermissions();
    await this.clearInputs();
    await this.interruptExecutions();
  }
  private async interruptExecutions() {
    // Native interrupt stops one session. Each owned descendant has its own coordinator.
    for (const sessionId of this.executions.keys())
      await this.client?.request('POST', `/api/session/${sessionId}/interrupt?resume=false`);
  }
  private async clearInputs() {
    if (!this.client || !this.sessionId) return;
    // An inbox cancellation before admission is a native no-op. Wait for every
    // submitted HTTP request before the final cancellation pass.
    await Promise.allSettled(this.admissions);
    for (const id of this.ownedInputs)
      await this.client.request('DELETE', `/api/session/${this.sessionId}/inbox/${id}`);
    this.ownedInputs.clear();
  }
  private errorText(error: unknown): string {
    if (error === undefined) return '';
    if (typeof error === 'string') return this.environment.redactor.text(error);
    const value = z
      .object({
        message: z.string().optional(),
        data: z.object({ message: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .safeParse(error);
    return this.environment.redactor.text(
      value.success
        ? (value.data.message ?? value.data.data?.message ?? JSON.stringify(error))
        : JSON.stringify(error),
    );
  }
  private fail(error: Error) {
    if (this.closing) return;
    for (const input of this.inputs.values()) {
      clearTimeout(input.timer);
      input.reject(error);
    }
    this.inputs.clear();
    this.handlers.exit(new Error(this.environment.redactor.text(error)));
    void this.close();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      this.stopped = true;
      this.expireForms();
      for (const input of this.inputs.values()) {
        clearTimeout(input.timer);
        input.reject(new Error('OpenCode 连接已关闭'));
      }
      this.inputs.clear();
      try {
        await this.clearPermissions();
        await this.clearInputs();
        await this.interruptExecutions();
      } catch (error) {
        this.environment.log.warn({ err: error }, 'OpenCode pending input cleanup failed');
      }
      for (const stream of this.streams) stream.close();
      await this.client?.close();
    });
    return this.closing;
  }
}
