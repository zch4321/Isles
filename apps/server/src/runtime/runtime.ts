import {
  answerQuestionSchema,
  questionDefinitionSchema,
  type CreateAgent,
  type CreateGroup,
  type Message,
  type QuestionAnswer,
  type QuestionDefinition,
  type Run,
  type SendMessage,
  type UpdateAgent,
} from '@isles/contracts';
import { z } from 'zod';
import { join, resolve } from 'node:path';
import type { Catalog } from '../codex/catalog.js';
import { StdioClient } from '../codex/client.js';
import type { NativeEnvironment } from '../codex/environment.js';
import {
  inputRequestSchema,
  NativeRpcError,
  threadResponseSchema,
  turnNotificationSchema,
  turnResponseSchema,
  type NativeClient,
  type NativeHandlers,
  type RequestId,
} from '../codex/protocol.js';
import { HttpError } from '../errors.js';
import type { Actor, AgentRecord, ClaimedChannel, MessageInput, Store } from '../storage/store.js';
import { formatMessages, MessageLabels } from './envelope.js';

export type ClientFactory = (
  agent: AgentRecord,
  handlers: NativeHandlers,
  baseUrl: string,
) => Promise<NativeClient>;
interface Active {
  run: Run;
  turnId: string | null;
  done: Promise<void>;
  finish: () => void;
  requests: Map<string, RequestId>;
}
interface Handle {
  client?: NativeClient;
  active?: Active;
  task?: Promise<void>;
  // A newer stop/resume/delete supersedes a control request waiting on native I/O.
  controlRevision?: number;
  // Restart the idle native process so it reloads its MCP tool list.
  refresh?: boolean;
}
export class Runtime {
  private handles = new Map<string, Handle>();
  private deleting = new Set<string>();
  private baseUrl: string | undefined;
  private closing = false;
  readonly factory: ClientFactory;
  constructor(
    readonly store: Store,
    readonly catalog: Catalog,
    readonly environment: NativeEnvironment,
    factory?: ClientFactory,
  ) {
    this.factory =
      factory ??
      (async (agent, handlers) => {
        const executable = await environment.executable();
        const env = await environment.launch(agent);
        const client = new StdioClient(
          executable,
          agent.workspace,
          env,
          handlers,
          environment.redactor,
        );
        // Publish the connection before initialize so stop/shutdown can terminate it.
        this.handle(agent.id).client = client;
        try {
          await client.initialize();
          return client;
        } catch (error) {
          await client.close();
          throw error;
        }
      });
    store.recoverOnBoot();
  }
  private handle(id: string) {
    let handle = this.handles.get(id);
    if (!handle) {
      handle = {};
      this.handles.set(id, handle);
    }
    return handle;
  }
  start(baseUrl: string) {
    this.baseUrl = baseUrl;
    for (const agent of this.store.listAgents())
      if (agent.desiredState === 'running' && agent.status !== 'error') this.kick(agent.id);
  }

  // Agents, channels and messages

  messageLabels(id: string) {
    return new MessageLabels(id, this.store.listAgents(true), this.store.channelsOf(id));
  }

  async createAgent(input: CreateAgent) {
    if (!this.baseUrl) throw new HttpError(503, 'Runtime 尚未监听本机端口');
    const status = await this.catalog.status();
    if (!status.available || !status.authenticated)
      throw new HttpError(503, status.error ?? 'Codex 原生认证不可用');
    const model = (await this.catalog.models()).find((m) => m.model === input.model);
    if (!model || !model.supportedReasoningEfforts.includes(input.reasoningEffort))
      throw new HttpError(400, '请选择实际可用的模型和推理等级');
    const agent = this.store.createAgent({
      ...input,
      canCreateGroups: input.canCreateGroups ?? false,
      nativeHome: this.environment.home,
    });
    this.kick(agent.id);
    return this.store.publicAgent(agent.id);
  }
  async updateAgent(id: string, update: UpdateAgent) {
    let agent = this.managed(id);
    const changesModel = () =>
      (update.model !== undefined && update.model !== agent.model) ||
      (update.reasoningEffort !== undefined && update.reasoningEffort !== agent.reasoningEffort);
    if (changesModel()) {
      const status = await this.catalog.status();
      agent = this.managed(id);
      if (changesModel()) {
        if (!status.available || !status.authenticated)
          throw new HttpError(503, status.error ?? 'Codex 原生认证不可用');
        const models = await this.catalog.models();
        // Another partial edit may have completed while the catalog was loading.
        agent = this.managed(id);
        if (changesModel()) {
          const model = models.find((m) => m.model === (update.model ?? agent.model));
          if (
            !model ||
            !model.supportedReasoningEfforts.includes(
              update.reasoningEffort ?? agent.reasoningEffort,
            )
          )
            throw new HttpError(400, '请选择实际可用的模型和推理等级');
        }
      }
    }
    const changed = Object.fromEntries(
      Object.entries(update).filter(
        ([key, value]) => value !== undefined && value !== agent[key as keyof AgentRecord],
      ),
    ) as Partial<Pick<AgentRecord, 'name' | 'model' | 'reasoningEffort' | 'canCreateGroups'>>;
    if (Object.keys(changed).length) {
      this.store.updateAgent(id, changed);
      // The running turn keeps its captured configuration; reconnect loads guidance and MCP tools
      // for the next turn while resuming the same native thread.
      const handle = this.handles.get(id);
      if (handle) {
        handle.refresh = true;
        this.kick(id);
      }
    }
    return this.store.publicAgent(id);
  }
  send(channelId: string, input: SendMessage) {
    const channel = this.store.getChannel(channelId);
    if (channel.kind === 'private' && channel.agentId && this.deleting.has(channel.agentId))
      throw new HttpError(409, 'Agent 正在删除，不能继续发送消息');
    const message = this.store.saveMessage(channelId, { type: 'user' }, input);
    this.wake(message);
    return message;
  }
  /** An Agent's official message through MCP. */
  publish(agentId: string, channelId: string, input: MessageInput) {
    this.running(agentId);
    const message = this.store.saveMessage(
      channelId,
      { type: 'agent', id: agentId },
      { ...input, body: this.environment.redactor.text(input.body) },
    );
    this.wake(message);
    return message;
  }
  private wake(message: Message) {
    for (const d of message.deliveries) if (d.status === 'queued') this.kick(d.agentId);
  }
  private managed(id: string) {
    const agent = this.store.getAgent(id);
    if (agent.status === 'deleted') throw new HttpError(410, 'Agent 已删除，历史仅供查看');
    if (this.deleting.has(id)) throw new HttpError(409, 'Agent 正在删除，请等待操作完成');
    return agent;
  }
  private running(agentId: string) {
    if (this.managed(agentId).desiredState !== 'running')
      throw new HttpError(409, 'Agent 已停止，不能继续操作');
  }
  receiveMessages(agentId: string, query: { channelId?: string | undefined; limit: number }) {
    this.running(agentId);
    if (query.channelId !== undefined) {
      this.store.getChannel(query.channelId);
      if (!this.store.isMember(query.channelId, agentId))
        throw new HttpError(403, '只能访问自己所在的频道');
    }
    return this.store.receiveMessages(agentId, query);
  }
  private mayOrganize(actor: Actor) {
    if (actor === 'user') return;
    this.running(actor);
    if (!this.store.getAgent(actor).canCreateGroups)
      throw new HttpError(403, '该 Agent 没有拉群权限');
  }
  createGroup(actor: Actor, input: CreateGroup) {
    this.mayOrganize(actor);
    return this.store.createGroup(actor, input.name, input.memberIds);
  }
  addMembers(channelId: string, actor: Actor, agentIds: string[]) {
    this.mayOrganize(actor);
    this.store.addMembers(channelId, actor, agentIds);
    return this.store.publicChannel(channelId);
  }
  removeMember(channelId: string, agentId: string) {
    this.store.removeMember(channelId, agentId);
    return this.store.publicChannel(channelId);
  }
  updateChannel(id: string, update: { name?: string | undefined; paused?: boolean | undefined }) {
    const paused = this.store.getChannel(id).paused;
    const channel = this.store.updateChannel(id, update);
    // Pausing never interrupts a running turn; resuming wakes members with saved unread.
    if (paused && !channel.paused) for (const agentId of channel.memberIds) this.kick(agentId);
    return channel;
  }

  // Scheduling

  private runnable(id: string) {
    const agent = this.store.getAgent(id);
    return agent.desiredState === 'running' && agent.status !== 'error';
  }
  kick(id: string) {
    if (this.closing || !this.baseUrl) return;
    const handle = this.handle(id);
    if (handle.task || handle.active) return;
    handle.task = this.pump(id, handle).finally(() => {
      delete handle.task;
      // Also covers input that arrived after the pump decided to stop.
      if (this.closing || !handle.client || !this.runnable(id)) return;
      if (handle.refresh || this.store.hasPendingMessages(id)) this.kick(id);
    });
  }
  private async connect(id: string, handle: Handle) {
    const agent = this.store.getAgent(id);
    if (agent.desiredState !== 'running' || this.closing) return;
    if (agent.threadCreationAttempted && !agent.threadId)
      throw new Error('原生 thread 创建结果不明，不能创建替代 thread；请核对原生记录。');
    // A thread only exists in the Codex home it was created in; another home cannot resume it.
    if (agent.nativeHome !== this.environment.home)
      throw new Error(
        `该 Agent 的原生会话位于 ${agent.nativeHome}，当前 Codex 目录是 ${this.environment.home}，无法恢复原会话，也不会创建替代会话。`,
      );
    this.store.updateAgent(id, {
      status: agent.threadId ? 'recovering' : 'creating',
      error: null,
    });
    await this.environment.prepareWorkspace(agent);
    const client = await this.factory(
      agent,
      {
        notification: (method, params) => this.notification(id, handle, method, params),
        request: (requestId, method, params) =>
          this.serverRequest(id, handle, requestId, method, params),
        exit: (error) => this.connectionExited(id, handle, error),
      },
      this.baseUrl!,
    );
    handle.client = client;
    if (this.store.getAgent(id).desiredState !== 'running' || this.closing) {
      await client.close();
      delete handle.client;
      return;
    }
    const params = {
      model: agent.model,
      cwd: agent.workspace,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: this.environment.threadConfig(agent, this.baseUrl!),
    };
    if (!agent.threadId) this.store.updateAgent(id, { threadCreationAttempted: true });
    const response = threadResponseSchema.parse(
      await client.request(
        agent.threadId ? 'thread/resume' : 'thread/start',
        agent.threadId ? { ...params, threadId: agent.threadId } : { ...params, ephemeral: false },
      ),
    );
    if (agent.threadId && response.thread.id !== agent.threadId)
      throw new Error('恢复返回了不同 thread，已拒绝继续执行。');
    if (!agent.threadId) this.store.updateAgent(id, { threadId: response.thread.id });
    if (!agent.threadId) {
      // CLI 0.159.2 still defers an empty rollout. A neutral assistant item
      // persists it without a model turn; all environment rules come from AGENTS.md.
      // Persist even on guidance validation failure so fixing the file can resume this ID.
      await client.request('thread/inject_items', {
        threadId: response.thread.id,
        items: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Isles session initialized.' }],
          },
        ],
      });
    }
    const normalize = (path: string) =>
      process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    const expectedGuidance = normalize(join(agent.workspace, 'AGENTS.md'));
    if (!response.instructionSources.some((path) => normalize(path) === expectedGuidance))
      throw new Error(
        'Codex 未确认加载工作目录的 AGENTS.md，请检查规则覆盖、读取大小限制和 CLI 版本。',
      );
    this.store.updateAgent(id, {
      threadId: response.thread.id,
      status: this.store.getAgent(id).desiredState === 'running' ? 'ready' : 'stopped',
      error: null,
    });
  }
  private async pump(id: string, handle: Handle) {
    try {
      while (!this.closing && this.runnable(id)) {
        if (handle.refresh && handle.client) {
          // Codex loads MCP tools when it starts; the same thread is resumed below.
          const client = handle.client;
          delete handle.client;
          await client.close();
        }
        delete handle.refresh;
        if (!handle.client) await this.connect(id, handle);
        // An edit during workspace preparation or initialization must reload guidance
        // before any queued input starts its first turn.
        if (handle.refresh) continue;
        const agent = this.store.getAgent(id);
        if (
          !handle.client ||
          !agent.threadId ||
          !this.runnable(id) ||
          !this.store.hasPendingMessages(id)
        )
          break;
        const claimed = this.store.startRun(id, agent.threadId);
        if (!claimed) break;
        await this.turn(id, handle, handle.client, agent, claimed.run, claimed.input);
      }
    } catch (error) {
      if (!this.closing && this.store.getAgent(id).desiredState === 'running')
        this.store.updateAgent(id, {
          status: 'error',
          error: this.environment.redactor.text(error),
        });
      await handle.client?.close();
      delete handle.client;
    }
  }
  private async turn(
    id: string,
    handle: Handle,
    client: NativeClient,
    agent: AgentRecord,
    run: Run,
    input: ClaimedChannel[],
  ) {
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active: Active = { run, turnId: null, done, finish, requests: new Map() };
    handle.active = active;
    this.store.updateAgent(id, { status: 'running' });
    try {
      const response = turnResponseSchema.parse(
        await client.request('turn/start', {
          threadId: run.threadId,
          clientUserMessageId: run.id,
          input: [
            {
              type: 'text',
              text: formatMessages(this.messageLabels(id), input),
              text_elements: [],
            },
          ],
          model: agent.model,
          effort: agent.reasoningEffort,
          cwd: agent.workspace,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' },
        }),
      );
      active.turnId = response.turn.id;
      this.store.acceptRun(run.id, response.turn.id);
      await done;
    } catch (error) {
      const rejected = error instanceof NativeRpcError && !active.turnId;
      if (!this.store.getRun(run.id).finishedAt)
        this.store.finishRun(
          run.id,
          rejected ? 'failed' : 'uncertain',
          rejected ? 'failed' : 'uncertain',
          this.environment.redactor.text(error),
        );
      if (this.store.getAgent(id).desiredState === 'running')
        this.store.updateAgent(id, {
          status: 'error',
          error: this.environment.redactor.text(error),
        });
      return;
    } finally {
      if (handle.active === active) delete handle.active;
    }
    if (!this.closing && this.runnable(id)) this.store.updateAgent(id, { status: 'ready' });
  }
  private connectionExited(id: string, handle: Handle, error: Error) {
    delete handle.client;
    if (handle.active) {
      this.store.finishRun(
        handle.active.run.id,
        'uncertain',
        'uncertain',
        this.environment.redactor.text(error),
      );
      handle.active.finish();
    }
    if (!this.closing && this.store.getAgent(id).desiredState === 'running')
      this.store.updateAgent(id, {
        status: 'error',
        error: this.environment.redactor.text(error),
      });
  }
  private notification(
    id: string,
    handle: Handle,
    method: string,
    params: Record<string, unknown>,
  ) {
    const active = handle.active;
    if (!active || params.threadId !== active.run.threadId) return;
    if (method === 'turn/started' || method === 'turn/completed') {
      const parsed = turnNotificationSchema.safeParse(params);
      if (!parsed.success || (active.turnId && active.turnId !== parsed.data.turn.id)) return;
      active.turnId = parsed.data.turn.id;
      this.store.acceptRun(active.run.id, active.turnId);
      if (method === 'turn/completed') {
        const status = parsed.data.turn.status;
        const error = parsed.data.turn.error
          ? this.environment.redactor.text(parsed.data.turn.error.message)
          : null;
        this.store.finishRun(
          active.run.id,
          status === 'completed'
            ? 'completed'
            : status === 'interrupted'
              ? 'interrupted'
              : 'failed',
          status === 'completed' ? 'completed' : status === 'interrupted' ? 'cancelled' : 'failed',
          error,
        );
        if (status === 'failed')
          this.store.updateAgent(id, { status: 'error', error: error ?? '原生 turn 失败' });
        active.finish();
      }
      return;
    }
    if (params.turnId && active.turnId && params.turnId !== active.turnId) return;
    if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
      if (typeof params.itemId !== 'string' || typeof params.delta !== 'string') return;
      const previous = this.store
        .getRun(active.run.id)
        .items.find((item) => item.id === params.itemId);
      this.store.updateItem(
        active.run.id,
        {
          id: params.itemId,
          type:
            previous?.type ??
            (method.includes('agentMessage') ? 'agentMessage' : 'commandExecution'),
          status: 'running',
          text: this.environment.redactor.text(params.delta),
        },
        true,
      );
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = z
        .object({ id: z.string(), type: z.string() })
        .passthrough()
        .safeParse(params.item);
      if (!item.success) return;
      const value = item.data;
      const strings = [
        'text',
        'command',
        'aggregatedOutput',
        'server',
        'tool',
        'status',
        'exitCode',
      ];
      const detail: string[] = [];
      for (const key of strings)
        if (typeof value[key] === 'string' || typeof value[key] === 'number')
          detail.push(key === 'text' ? String(value[key]) : `${key}: ${String(value[key])}`);
      // No raw arguments/config/result objects, auth material or reasoning blobs.
      this.store.updateItem(active.run.id, {
        id: value.id,
        type: value.type,
        status: method === 'item/completed' ? 'completed' : 'running',
        text: this.environment.redactor.text(detail.join('\n')),
      });
    }
  }
  private serverRequest(
    id: string,
    handle: Handle,
    requestId: RequestId,
    method: string,
    params: Record<string, unknown>,
  ) {
    const client = handle.client;
    if (!client) return;
    const active = handle.active;
    const request = inputRequestSchema.safeParse(params);
    // The process belongs to this Agent alone, so another thread is one of its own sub-agents;
    // its questions are answered while the main turn that started it is running.
    const main = request.success && request.data.threadId === active?.run.threadId;
    if (
      method === 'item/tool/requestUserInput' &&
      request.success &&
      active &&
      (!main || !active.turnId || request.data.turnId === active.turnId) &&
      this.store.getAgent(id).desiredState === 'running' &&
      !this.store.getRun(active.run.id).finishedAt
    ) {
      if (main) {
        active.turnId = request.data.turnId;
        this.store.acceptRun(active.run.id, active.turnId);
      }
      const definitions: QuestionDefinition[] = request.data.questions.map((q) => ({
        ...q,
        question: this.environment.redactor.text(q.question),
        options:
          q.options?.map((o) => ({
            label: this.environment.redactor.text(o.label),
            description: this.environment.redactor.text(o.description),
          })) ?? null,
      }));
      const questionId = this.store.createQuestion(
        id,
        active.run.id,
        request.data.turnId,
        requestId,
        definitions,
      );
      active.requests.set(questionId, requestId);
      return;
    }
    client.reject(requestId, `Isles does not support this native request: ${method}`);
  }
  answer(id: string, questionId: string, value: QuestionAnswer) {
    const answers = answerQuestionSchema.parse(value);
    const question = this.store.getQuestion(questionId);
    const handle = this.handles.get(id);
    const requestId = handle?.active?.requests.get(questionId);
    if (question.agentId !== id) throw new HttpError(404, '问题不存在');
    if (
      question.status !== 'pending' ||
      requestId === undefined ||
      !handle?.client ||
      handle.active?.run.id !== question.runId ||
      this.store.getAgent(id).desiredState !== 'running' ||
      this.store.getRun(question.runId).finishedAt
    )
      throw new HttpError(409, '原生问题已失效，不能提交答案');
    if (
      Object.keys(answers.answers).length !== question.questions.length ||
      question.questions.some((q) => !answers.answers[q.id])
    )
      throw new HttpError(400, '请回答该请求中的所有问题');
    for (const q of question.questions) {
      questionDefinitionSchema.parse(q);
      const response = answers.answers[q.id]!;
      if (
        q.options &&
        !q.isOther &&
        response.answers.some((a) => !q.options!.some((o) => o.label === a))
      )
        throw new HttpError(400, '答案必须属于问题给出的选项');
      if (q.isSecret) response.answers.forEach((a) => this.environment.redactor.add(a));
    }
    // The live connection/request identity is checked before responding. If it
    // closes afterwards, crash recovery marks any still pending question expired.
    handle.client.respond(requestId, answers);
    handle.active.requests.delete(questionId);
    this.store.answerQuestion(questionId, answers);
  }
  async stop(id: string) {
    this.managed(id);
    const handle = this.handle(id);
    handle.controlRevision = (handle.controlRevision ?? 0) + 1;
    await this.halt(id);
  }
  /** Deletion uses the same interruption path while it blocks other management actions. */
  private async halt(id: string) {
    this.store.getAgent(id);
    this.store.updateAgent(id, { desiredState: 'stopped', status: 'stopped', error: null });
    const handle = this.handles.get(id);
    if (!handle) return;
    const client = handle.client;
    if (handle.active) {
      const active = handle.active;
      this.store.finishRun(
        active.run.id,
        'interrupted',
        'cancelled',
        '用户停止了 Agent；该输入不会再次投递。',
      );
      active.finish();
      if (client && active.turnId)
        await Promise.race([
          client
            .request('turn/interrupt', { threadId: active.run.threadId, turnId: active.turnId })
            .catch(() => {}),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 2_000);
            timer.unref();
          }),
        ]);
    }
    await client?.close();
    if (handle.client === client) delete handle.client;
  }
  async resume(id: string) {
    let agent = this.managed(id);
    const handle = this.handle(id);
    if (agent.desiredState === 'running' && handle.active)
      throw new HttpError(409, 'Agent 正在执行，请先停止');
    const revision = (handle.controlRevision ?? 0) + 1;
    handle.controlRevision = revision;
    const current = () => {
      const agent = this.managed(id);
      if (handle.controlRevision !== revision)
        throw new HttpError(409, 'Agent 的运行状态已被其他操作更改，请重试');
      return agent;
    };
    await handle.task;
    agent = current();
    if (agent.threadCreationAttempted && !agent.threadId)
      throw new HttpError(409, '原生 thread 创建结果不明，无法用新 thread 替代；请核对原生记录。');
    const client = handle.client;
    await client?.close();
    current();
    if (handle.client === client) delete handle.client;
    this.store.updateAgent(id, { desiredState: 'running', status: 'recovering', error: null });
    this.kick(id);
  }
  async deleteAgent(id: string) {
    const agent = this.store.getAgent(id);
    if (agent.status === 'deleted') return this.store.publicAgent(id);
    if (this.deleting.has(id)) throw new HttpError(409, 'Agent 正在删除，请等待操作完成');
    this.deleting.add(id);
    const handle = this.handle(id);
    handle.controlRevision = (handle.controlRevision ?? 0) + 1;
    try {
      await this.halt(id);
      await this.handles.get(id)?.task;
      const deleted = this.store.deleteAgent(id);
      this.handles.delete(id);
      return deleted;
    } finally {
      this.deleting.delete(id);
    }
  }
  async close() {
    this.closing = true;
    for (const handle of this.handles.values()) {
      if (handle.active && !this.store.getRun(handle.active.run.id).finishedAt) {
        this.store.finishRun(
          handle.active.run.id,
          'uncertain',
          'uncertain',
          '服务关闭时原生执行尚未结束，结果待核对；不会自动重投。',
        );
        this.store.updateAgent(handle.active.run.agentId, {
          status: 'error',
          error: '上次执行结果待核对，请查看原生记录后显式恢复。',
        });
        handle.active.finish();
      }
    }
    await Promise.all(
      [...this.handles.values()].map(async (handle) => {
        await handle.client?.close();
        await handle.task;
      }),
    );
  }
}
