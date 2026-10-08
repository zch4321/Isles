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
import type { HarnessRegistry } from '../harness/registry.js';
import {
  HarnessSubmissionRejected,
  type HarnessEvent,
  type HarnessQuestion,
  type HarnessRequestId,
  type HarnessSession,
} from '../harness/types.js';
import { HttpError } from '../errors.js';
import type { Logger } from '../logging.js';
import type { Actor, AgentRecord, ClaimedChannel, MessageInput, Store } from '../storage/store.js';
import { formatMessages, MessageLabels } from './envelope.js';
import type { AgentWorkspace } from './workspace.js';

interface Active {
  run: Run;
  turnId: string | null;
  done: Promise<void>;
  finish: () => void;
  requests: Map<string, HarnessRequestId>;
  steerTask?: Promise<void>;
  steerBatchId?: string;
  steerRejected?: boolean;
}
interface Handle {
  session?: HarnessSession;
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
  private readonly log: Logger;
  constructor(
    readonly store: Store,
    readonly harnesses: HarnessRegistry,
    readonly workspace: AgentWorkspace,
  ) {
    this.log = workspace.log.child({ module: 'runtime' });
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
    const adapter = this.harnesses.get(input.harness);
    this.validateSteer(adapter.descriptor.capabilities.steer, input.steerEnabled);
    const status = await adapter.catalog.status();
    if (!status.available || !status.authenticated)
      throw new HttpError(503, status.error ?? `${adapter.descriptor.displayName} 原生认证不可用`);
    const model = (await adapter.catalog.models()).find((m) => m.model === input.model);
    if (!model || !model.supportedReasoningEfforts.includes(input.reasoningEffort))
      throw new HttpError(400, '请选择实际可用的模型和推理等级');
    const agent = this.store.createAgent({
      ...input,
      canCreateGroups: input.canCreateGroups ?? false,
      steerEnabled: input.steerEnabled ?? false,
      nativeHome: adapter.nativeHome,
    });
    this.log.info({ agentId: agent.id, harness: agent.harness }, 'Agent created');
    this.kick(agent.id);
    return this.store.publicAgent(agent.id);
  }
  async updateAgent(id: string, update: UpdateAgent) {
    let agent = this.managed(id);
    const adapter = this.harnesses.get(agent.harness);
    this.validateSteer(adapter.descriptor.capabilities.steer, update.steerEnabled);
    const changesModel = () =>
      (update.model !== undefined && update.model !== agent.model) ||
      (update.reasoningEffort !== undefined && update.reasoningEffort !== agent.reasoningEffort);
    if (changesModel()) {
      const status = await adapter.catalog.status();
      agent = this.managed(id);
      if (changesModel()) {
        if (!status.available || !status.authenticated)
          throw new HttpError(
            503,
            status.error ?? `${adapter.descriptor.displayName} 原生认证不可用`,
          );
        const models = await adapter.catalog.models();
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
    ) as Partial<
      Pick<AgentRecord, 'name' | 'model' | 'reasoningEffort' | 'canCreateGroups' | 'steerEnabled'>
    >;
    if (Object.keys(changed).length) {
      this.store.updateAgent(id, changed);
      // The running turn keeps its captured configuration; reconnect loads guidance and MCP tools
      // for the next turn while resuming the same native thread.
      const handle = this.handles.get(id);
      if (handle) {
        if (Object.keys(changed).some((key) => key !== 'steerEnabled')) handle.refresh = true;
        this.kick(id);
      }
    }
    return this.store.publicAgent(id);
  }
  private validateSteer(supported: boolean, enabled: boolean | undefined) {
    if (enabled && !supported) throw new HttpError(400, '该 Harness 不支持 steer 投递');
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
      { ...input, body: this.workspace.redactor.text(input.body) },
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
  deleteGroup(id: string) {
    return this.store.deleteGroup(id);
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
    if (handle.active) {
      this.kickSteer(id, handle, handle.active);
      return;
    }
    if (handle.task) return;
    handle.task = this.pump(id, handle).finally(() => {
      delete handle.task;
      // Also covers input that arrived after the pump decided to stop.
      if (this.closing || !handle.session || !this.runnable(id)) return;
      if (handle.refresh || this.store.hasPendingMessages(id)) this.kick(id);
    });
  }
  private canSteer(id: string, handle: Handle, active: Active) {
    const agent = this.store.getAgent(id);
    return (
      !this.closing &&
      !this.deleting.has(id) &&
      handle.active === active &&
      !!handle.session &&
      !!active.turnId &&
      !active.steerRejected &&
      agent.steerEnabled &&
      this.runnable(id) &&
      this.harnesses.get(agent.harness).descriptor.capabilities.steer &&
      !this.store.getRun(active.run.id).finishedAt
    );
  }
  private kickSteer(id: string, handle: Handle, active: Active) {
    if (active.steerTask || !this.canSteer(id, handle, active)) return;
    // Let native callbacks finish binding the initial turn before claiming more input.
    active.steerTask = Promise.resolve()
      .then(async () => {
        if (!this.canSteer(id, handle, active)) return;
        const client = handle.session!;
        const turnId = active.turnId!;
        const batch = this.store.claimSteer(id, active.run.id, turnId);
        if (!batch) return;
        active.steerBatchId = batch.id;
        try {
          const response = await client.steer!({
            sessionId: active.run.threadId,
            expectedTurnId: turnId,
            batchId: batch.id,
            text: formatMessages(this.messageLabels(id), batch.input),
          });
          if (response.turnId !== turnId) throw new Error('Steer 确认返回了不同的原生 turn');
          this.store.acceptSteer(batch.id, response.turnId);
          this.log.debug(
            { agentId: id, runId: active.run.id, batchId: batch.id },
            'Steer accepted',
          );
        } catch (error) {
          const reason = this.workspace.redactor.text(error);
          const context = { err: error, agentId: id, runId: active.run.id, batchId: batch.id };
          if (error instanceof HarnessSubmissionRejected) {
            this.log.warn(context, 'Steer rejected; messages return to the queue');
            this.store.rejectSteer(batch.id, reason);
            // A turn may have ended before its completion notification arrived. Retry only
            // through the next normal turn, not repeatedly against this native turn.
            active.steerRejected = true;
          } else {
            this.log.error(context, 'Steer result is uncertain');
            this.store.uncertainSteer(batch.id, reason);
            if (
              !this.closing &&
              !this.deleting.has(id) &&
              handle.active === active &&
              handle.session === client &&
              this.store.getAgent(id).desiredState === 'running'
            )
              this.store.updateAgent(id, {
                status: 'error',
                error: `Steer 投递结果待核对，不会自动重投：${reason}`,
              });
          }
        }
      })
      .finally(() => {
        delete active.steerBatchId;
        delete active.steerTask;
        if (this.canSteer(id, handle, active) && this.store.hasPendingMessages(id))
          this.kickSteer(id, handle, active);
      });
  }
  private async connect(id: string, handle: Handle) {
    const agent = this.store.getAgent(id);
    if (agent.desiredState !== 'running' || this.closing) return;
    if (agent.threadCreationAttempted && !agent.threadId)
      throw new Error('原生 thread 创建结果不明，不能创建替代 thread；请核对原生记录。');
    const adapter = this.harnesses.get(agent.harness);
    if (agent.nativeHome !== adapter.nativeHome)
      throw new Error(
        `该 Agent 的原生会话位于 ${agent.nativeHome}，当前 ${adapter.descriptor.displayName} 目录是 ${adapter.nativeHome}，无法恢复原会话，也不会创建替代会话。`,
      );
    this.store.updateAgent(id, {
      status: agent.threadId ? 'recovering' : 'creating',
      error: null,
    });
    await this.workspace.prepareWorkspace(agent);
    let connection: HarnessSession | undefined;
    const session = await adapter.connect(agent, this.baseUrl!, {
      connected: (value) => {
        connection = value;
        handle.session = value;
        if (this.closing || this.store.getAgent(id).desiredState !== 'running')
          void value
            .close()
            .catch((error: unknown) =>
              this.log.warn({ err: error, agentId: id }, 'Closing a stopped native session failed'),
            );
      },
      event: (event) => {
        if (connection && handle.session === connection) this.event(id, handle, event);
      },
      question: (question) => {
        if (connection && handle.session === connection) this.question(id, handle, question);
      },
      exit: (error) => {
        if (connection && handle.session === connection) this.connectionExited(id, handle, error);
      },
    });
    if (connection !== session) throw new Error('Harness 未发布正确的原生连接');
    handle.session = session;
    if (adapter.descriptor.capabilities.steer && !session.steer)
      throw new Error('Harness 声明支持 steer，但未提供投递方法');
    if (this.store.getAgent(id).desiredState !== 'running' || this.closing) {
      await session.close();
      if (handle.session === session) delete handle.session;
      return;
    }
    let sessionId: string;
    if (agent.threadId) {
      sessionId = await session.resumeSession(agent.threadId);
      if (sessionId !== agent.threadId) throw new Error('恢复返回了不同 thread，已拒绝继续执行。');
    } else {
      this.store.updateAgent(id, { threadCreationAttempted: true });
      sessionId = await session.createSession((createdId) => {
        if (!createdId) throw new Error('Harness 返回了空的原生 session ID');
        const saved = this.store.getAgent(id).threadId;
        if (saved && saved !== createdId)
          throw new Error('Harness 试图替换已保存的原生 session 绑定');
        this.store.updateAgent(id, { threadId: createdId });
      });
      if (sessionId !== this.store.getAgent(id).threadId)
        throw new Error('Harness 新建的 session 与已保存绑定不一致');
    }
    this.store.updateAgent(id, {
      threadId: sessionId,
      status: this.store.getAgent(id).desiredState === 'running' ? 'ready' : 'stopped',
      error: null,
    });
    this.log.info(
      { agentId: id, harness: agent.harness, sessionId },
      agent.threadId ? 'Native session resumed' : 'Native session created',
    );
  }
  private async pump(id: string, handle: Handle) {
    try {
      while (!this.closing && this.runnable(id)) {
        if (handle.refresh && handle.session) {
          // Reconnect through the adapter to reload settings and tools in the same session.
          const client = handle.session;
          delete handle.session;
          await client.close();
        }
        delete handle.refresh;
        if (!handle.session) await this.connect(id, handle);
        // An edit during workspace preparation or initialization must reload guidance
        // before any queued input starts its first turn.
        if (handle.refresh) continue;
        const agent = this.store.getAgent(id);
        if (
          !handle.session ||
          !agent.threadId ||
          !this.runnable(id) ||
          !this.store.hasPendingMessages(id)
        )
          break;
        const claimed = this.store.startRun(id, agent.threadId);
        if (!claimed) break;
        await this.turn(id, handle, handle.session, agent, claimed.run, claimed.input);
      }
    } catch (error) {
      if (!this.closing && this.store.getAgent(id).desiredState === 'running') {
        this.log.error({ err: error, agentId: id }, 'Agent stopped with an error');
        this.store.updateAgent(id, {
          status: 'error',
          error: this.workspace.redactor.text(error),
        });
      } else this.log.debug({ err: error, agentId: id }, 'Native session ended while stopping');
      await handle.session?.close();
      delete handle.session;
    }
  }
  private async turn(
    id: string,
    handle: Handle,
    client: HarnessSession,
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
      const response = await client.submit({
        sessionId: run.threadId,
        runId: run.id,
        text: formatMessages(this.messageLabels(id), input),
        model: agent.model,
        reasoningEffort: agent.reasoningEffort,
        workspace: agent.workspace,
      });
      if (active.turnId && active.turnId !== response.turnId)
        throw new Error('原生 turn 确认与已绑定的运行不一致，结果待核对');
      active.turnId = response.turnId;
      this.store.acceptRun(run.id, response.turnId);
      this.log.info({ agentId: id, runId: run.id, turnId: response.turnId }, 'Run started');
      this.kickSteer(id, handle, active);
      await done;
    } catch (error) {
      const rejected = error instanceof HarnessSubmissionRejected && !active.turnId;
      this.log.error(
        { err: error, agentId: id, runId: run.id },
        rejected ? 'Run submission rejected' : 'Run result is uncertain',
      );
      if (!this.store.getRun(run.id).finishedAt)
        this.store.finishRun(
          run.id,
          rejected ? 'failed' : 'uncertain',
          rejected ? 'failed' : 'uncertain',
          this.workspace.redactor.text(error),
        );
      if (this.store.getAgent(id).desiredState === 'running')
        this.store.updateAgent(id, {
          status: 'error',
          error: this.workspace.redactor.text(error),
        });
      // An uncertain initial submission must not leave its pending steer RPC waiting
      // on an untracked native turn. Closing settles outstanding adapter requests.
      if (active.steerTask) await client.close();
      return;
    } finally {
      // A completion event can precede the steer ACK. Settle it before another turn
      // starts, so definite refusal can safely return the claimed messages to the queue.
      await active.steerTask;
      if (handle.active === active) delete handle.active;
    }
    if (!this.closing && this.runnable(id)) this.store.updateAgent(id, { status: 'ready' });
  }
  private connectionExited(id: string, handle: Handle, error: Error) {
    this.log.error(
      { err: error, agentId: id, runId: handle.active?.run.id },
      'Native process exited unexpectedly',
    );
    delete handle.session;
    if (handle.active) {
      this.store.finishRun(
        handle.active.run.id,
        'uncertain',
        'uncertain',
        this.workspace.redactor.text(error),
      );
      handle.active.finish();
    }
    if (!this.closing && this.store.getAgent(id).desiredState === 'running')
      this.store.updateAgent(id, {
        status: 'error',
        error: this.workspace.redactor.text(error),
      });
  }
  private event(id: string, handle: Handle, event: HarnessEvent) {
    const active = handle.active;
    if (!active || event.sessionId !== active.run.threadId) return;
    const run = this.store.getRun(active.run.id);
    if (run.finishedAt) return;
    if (event.type === 'turn_started' || event.type === 'turn_completed') {
      if (active.turnId && active.turnId !== event.turnId) return;
      active.turnId = event.turnId;
      this.store.acceptRun(active.run.id, active.turnId);
      if (event.type === 'turn_started') this.kickSteer(id, handle, active);
      if (event.type === 'turn_completed') {
        const error = event.error ? this.workspace.redactor.text(event.error) : null;
        this.store.finishRun(
          active.run.id,
          event.status,
          event.status === 'completed'
            ? 'completed'
            : event.status === 'interrupted'
              ? 'cancelled'
              : 'failed',
          error,
        );
        if (event.status === 'failed')
          this.store.updateAgent(id, { status: 'error', error: error ?? '原生 turn 失败' });
        const context = { agentId: id, runId: active.run.id, status: event.status, reason: error };
        if (event.status === 'failed') this.log.warn(context, 'Run finished');
        else this.log.info(context, 'Run finished');
        active.finish();
      }
      return;
    }
    if (event.turnId && active.turnId && event.turnId !== active.turnId) return;
    const previous = event.append ? run.items.find((item) => item.id === event.item.id) : undefined;
    this.store.updateItem(
      active.run.id,
      {
        ...event.item,
        type: previous?.type ?? event.item.type,
        text: this.workspace.redactor.text(event.item.text),
      },
      event.append,
    );
  }
  private question(id: string, handle: Handle, request: HarnessQuestion) {
    const session = handle.session;
    if (!session) return;
    const active = handle.active;
    const main = request.sessionId === active?.run.threadId;
    const capabilities = this.harnesses.get(this.store.getAgent(id).harness).descriptor
      .capabilities;
    if (
      capabilities.userQuestions &&
      (main || capabilities.nativeSubagents) &&
      active &&
      (!main || !active.turnId || request.turnId === active.turnId) &&
      this.store.getAgent(id).desiredState === 'running' &&
      !this.store.getRun(active.run.id).finishedAt
    ) {
      if (main) {
        active.turnId = request.turnId;
        this.store.acceptRun(active.run.id, active.turnId);
        this.kickSteer(id, handle, active);
      }
      const definitions: QuestionDefinition[] = request.questions.map((definition) => {
        const q = questionDefinitionSchema.parse(definition);
        return {
          ...q,
          question: this.workspace.redactor.text(q.question),
          options:
            q.options?.map((option) => ({
              label: this.workspace.redactor.text(option.label),
              description: this.workspace.redactor.text(option.description),
            })) ?? null,
        };
      });
      const questionId = this.store.createQuestion(
        id,
        active.run.id,
        request.turnId,
        request.requestId,
        definitions,
      );
      active.requests.set(questionId, request.requestId);
      return;
    }
    session.rejectQuestion(
      request.requestId,
      'Isles cannot accept this native question in the current run',
    );
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
      !handle?.session ||
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
      if (q.isSecret) response.answers.forEach((a) => this.workspace.redactor.add(a));
    }
    // The live connection/request identity is checked before responding. If it
    // closes afterwards, crash recovery marks any still pending question expired.
    handle.session.answer(requestId, answers);
    handle.active.requests.delete(questionId);
    this.store.answerQuestion(questionId, answers);
  }
  async stop(id: string) {
    this.managed(id);
    const handle = this.handle(id);
    handle.controlRevision = (handle.controlRevision ?? 0) + 1;
    await this.halt(id);
    this.log.info({ agentId: id }, 'Agent stopped');
  }
  /** Deletion uses the same interruption path while it blocks other management actions. */
  private async halt(id: string) {
    this.store.getAgent(id);
    this.store.updateAgent(id, { desiredState: 'stopped', status: 'stopped', error: null });
    const handle = this.handles.get(id);
    if (!handle) return;
    const client = handle.session;
    if (handle.active) {
      const active = handle.active;
      this.store.finishRun(
        active.run.id,
        'interrupted',
        'cancelled',
        '用户停止了 Agent；该输入不会再次投递。',
      );
      active.finish();
      if (
        client &&
        active.turnId &&
        this.harnesses.get(this.store.getAgent(id).harness).descriptor.capabilities.interrupt
      )
        await Promise.race([
          client
            .interrupt(active.run.threadId, active.turnId)
            .catch((error: unknown) =>
              this.log.warn(
                { err: error, agentId: id, runId: active.run.id },
                'Native interrupt failed',
              ),
            ),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 2_000);
            timer.unref();
          }),
        ]);
    }
    await client?.close();
    if (handle.session === client) delete handle.session;
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
    const client = handle.session;
    await client?.close();
    current();
    if (handle.session === client) delete handle.session;
    this.store.updateAgent(id, { desiredState: 'running', status: 'recovering', error: null });
    this.log.info({ agentId: id }, 'Agent resumed');
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
      this.log.info({ agentId: id }, 'Agent deleted');
      return deleted;
    } finally {
      this.deleting.delete(id);
    }
  }
  async close() {
    this.closing = true;
    for (const handle of this.handles.values()) {
      if (
        handle.active &&
        (!this.store.getRun(handle.active.run.id).finishedAt ||
          (handle.active.steerBatchId &&
            this.store.getSteer(handle.active.steerBatchId).status === 'pending'))
      ) {
        this.store.finishRun(
          handle.active.run.id,
          'uncertain',
          'uncertain',
          '服务关闭时原生执行尚未结束，结果待核对；不会自动重投。',
        );
        this.log.warn(
          { agentId: handle.active.run.agentId, runId: handle.active.run.id },
          'Run left uncertain at shutdown',
        );
        if (this.store.getAgent(handle.active.run.agentId).desiredState === 'running')
          this.store.updateAgent(handle.active.run.agentId, {
            status: 'error',
            error: '上次执行结果待核对，请查看原生记录后显式恢复。',
          });
        handle.active.finish();
      }
    }
    await Promise.all(
      [...this.handles.values()].map(async (handle) => {
        await handle.session?.close();
        await handle.task;
      }),
    );
  }
}
