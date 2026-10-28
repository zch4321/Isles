import {
  answerQuestionSchema,
  questionDefinitionSchema,
  type CreateAgent,
  type CreateAgents,
  type CreateGroup,
  type Message,
  type QuestionAnswer,
  type QuestionDefinition,
  type Run,
  type SendMessage,
  type UpdateAgent,
  type UpdateChannel,
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
import type {
  Actor,
  AgentRecord,
  ClaimedChannel,
  MessageInput,
  NewAgent,
  Store,
} from '../storage/store.js';
import { formatMessages, MessageLabels } from './envelope.js';
import { RunOutputBuffer } from './output.js';
import type { AgentWorkspace } from './workspace.js';
import {
  mergeWorkspacePaths,
  normalizeWorkspacePaths,
  workspacePathIdentity,
  workspacePathKey,
} from './workspace-paths.js';

interface Active {
  run: Run;
  turnId: string | null;
  output: RunOutputBuffer;
  finished: boolean;
  requests: Map<string, HarnessRequestId>;
  steerTask?: Promise<void>;
  steerBatchId?: string;
  steerRejected?: boolean;
}
interface Handle {
  workspacePaths?: string[];
  session?: HarnessSession;
  rootSessionId?: string;
  nativeSubagents?: boolean;
  // An exited connection still owns its process until asynchronous cleanup finishes.
  retiring?: Promise<void>;
  active?: Active;
  activities: Map<string, Active>;
  submitting?: {
    active: Active;
    buffered: ({ event: HarnessEvent } | { question: HarnessQuestion })[];
  };
  steerTask?: Promise<void>;
  steering?: Active;
  task?: Promise<void>;
  // A newer stop/resume/delete supersedes a control request waiting on native I/O.
  controlRevision?: number;
  // Restart the idle native process so it reloads its MCP tool list.
  refresh?: boolean;
}
export class Runtime {
  private handles = new Map<string, Handle>();
  private deleting = new Set<string>();
  private resetting = new Set<string>();
  private baseUrl: string | undefined;
  private closing = false;
  private readonly log: Logger;
  private workspaceSettingsTask: Promise<void> = Promise.resolve();
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
      handle = { activities: new Map() };
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
    const prepared = await this.prepareAgent(input);
    const agent = this.store.createAgent(this.withSharedWorkspaces(prepared));
    this.startCreatedAgent(agent);
    return this.store.publicAgent(agent.id);
  }
  async createAgents(input: CreateAgents) {
    const { count = 1, ...configuration } = input;
    const prepared = await this.prepareAgent(configuration);
    const agents = this.store.createAgents(this.withSharedWorkspaces(prepared), count);
    for (const agent of agents) this.startCreatedAgent(agent);
    return agents.map((agent) => this.store.publicAgent(agent.id));
  }
  private startCreatedAgent(agent: AgentRecord) {
    this.log.info({ agentId: agent.id, harness: agent.harness }, 'Agent created');
    this.kick(agent.id);
  }
  private withSharedWorkspaces(agent: NewAgent): NewAgent {
    return {
      ...agent,
      workspacePaths: normalizeWorkspacePaths(
        mergeWorkspacePaths(this.workspace.sharedWorkspacePaths, agent.workspacePaths ?? []),
      ),
    };
  }
  configureSharedWorkspaces(paths: string[]) {
    if (this.closing) throw new HttpError(503, 'Isles 正在关闭，请稍后重试');
    // Keep the saved defaults and their one-way additions ordered across concurrent UI saves.
    const operation = this.workspaceSettingsTask.then(async () => {
      const selected = normalizeWorkspacePaths(paths);
      const previous = new Set(this.workspace.sharedWorkspacePaths.map(workspacePathIdentity));
      const additions = selected.filter((path) => !previous.has(workspacePathKey(path)));
      await this.workspace.configureSharedWorkspaces(selected);
      const changed = this.store.appendWorkspacePaths(
        this.store.listAgents().map((agent) => agent.id),
        additions,
      );
      this.refreshWorkspaceConfiguration(changed);
      return this.workspace.workspaceSettings();
    });
    this.workspaceSettingsTask = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  private refreshWorkspaceConfiguration(ids: readonly string[]) {
    for (const id of new Set(ids)) {
      const handle = this.handles.get(id);
      if (!handle) continue;
      const paths = this.store.getAgent(id).workspacePaths;
      if (JSON.stringify(paths) === JSON.stringify(handle.workspacePaths)) continue;
      handle.refresh = true;
      this.kick(id);
    }
  }
  private async prepareAgent(input: CreateAgent): Promise<NewAgent> {
    if (!this.baseUrl) throw new HttpError(503, 'Runtime 尚未监听本机端口');
    const adapter = this.harnesses.get(input.harness);
    this.validateSteer(adapter.descriptor.capabilities.steer, input.steerEnabled);
    const status = await adapter.catalog.status();
    if (!status.available || !status.authenticated)
      throw new HttpError(503, status.error ?? `${adapter.descriptor.displayName} 原生认证不可用`);
    const model = (await adapter.catalog.models()).find((m) => m.model === input.model);
    if (!model || !model.supportedReasoningEfforts.includes(input.reasoningEffort))
      throw new HttpError(400, '请选择实际可用的模型和推理等级');
    return {
      ...input,
      workspacePaths: normalizeWorkspacePaths(input.workspacePaths ?? []),
      canCreateGroups: input.canCreateGroups ?? false,
      steerEnabled: input.steerEnabled ?? false,
      dangerFullAccess: input.dangerFullAccess ?? false,
      nativeHome: adapter.nativeHome,
    };
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
    if (update.workspacePaths !== undefined)
      update = { ...update, workspacePaths: normalizeWorkspacePaths(update.workspacePaths) };
    const changed = Object.fromEntries(
      Object.entries(update).filter(
        ([key, value]) =>
          value !== undefined &&
          (key === 'workspacePaths'
            ? JSON.stringify(value) !== JSON.stringify(agent.workspacePaths)
            : value !== agent[key as keyof AgentRecord]),
      ),
    ) as Partial<
      Pick<
        AgentRecord,
        | 'name'
        | 'model'
        | 'reasoningEffort'
        | 'canCreateGroups'
        | 'steerEnabled'
        | 'dangerFullAccess'
        | 'workspacePaths'
      >
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
    if (this.resetting.has(id)) throw new HttpError(409, 'Agent 正在新建会话，请等待操作完成');
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
    if (actor !== 'user' && input.workspacePaths?.length)
      throw new HttpError(403, '共享工作区由用户在群设置中配置');
    const paths = normalizeWorkspacePaths(input.workspacePaths ?? []);
    const channel = this.store.createGroup(actor, input.name, input.memberIds, paths);
    if (paths.length) this.refreshWorkspaceConfiguration(channel.memberIds);
    return channel;
  }
  deleteGroup(id: string) {
    return this.store.deleteGroup(id);
  }
  addMembers(channelId: string, actor: Actor, agentIds: string[]) {
    this.mayOrganize(actor);
    normalizeWorkspacePaths(this.store.getChannel(channelId).workspacePaths);
    const added = this.store.addMembers(channelId, actor, agentIds);
    this.refreshWorkspaceConfiguration(added);
    return this.store.publicChannel(channelId);
  }
  removeMember(channelId: string, agentId: string) {
    this.store.removeMember(channelId, agentId);
    return this.store.publicChannel(channelId);
  }
  updateChannel(id: string, update: UpdateChannel) {
    if (update.workspacePaths !== undefined)
      update = { ...update, workspacePaths: normalizeWorkspacePaths(update.workspacePaths) };
    const paused = this.store.getChannel(id).paused;
    const channel = this.store.updateChannel(id, update);
    if (update.workspacePaths !== undefined) this.refreshWorkspaceConfiguration(channel.memberIds);
    // Pausing never interrupts a running turn; resuming wakes members with saved unread.
    if (paused && !channel.paused) for (const agentId of channel.memberIds) this.kick(agentId);
    return channel;
  }

  // Scheduling

  private runnable(id: string) {
    const agent = this.store.getAgent(id);
    return agent.desiredState === 'running' && agent.status !== 'error' && !this.resetting.has(id);
  }
  kick(id: string) {
    if (this.closing || !this.baseUrl || this.resetting.has(id)) return;
    const handle = this.handle(id);
    if (handle.active) {
      this.kickSteer(id, handle, handle.active);
      return;
    }
    if (handle.task) return;
    handle.task = this.pump(id, handle).finally(() => {
      delete handle.task;
      // Also covers input that arrived after the pump decided to stop.
      if (
        this.closing ||
        !handle.session ||
        handle.steerTask ||
        (handle.refresh && handle.activities.size) ||
        !this.runnable(id)
      )
        return;
      if ((!handle.activities.size && handle.refresh) || this.store.hasPendingMessages(id))
        this.kick(id);
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
      JSON.stringify(agent.workspacePaths) === JSON.stringify(handle.workspacePaths) &&
      agent.steerEnabled &&
      this.runnable(id) &&
      this.harnesses.get(agent.harness).descriptor.capabilities.steer &&
      !this.store.getRun(active.run.id).finishedAt
    );
  }
  private kickSteer(id: string, handle: Handle, active: Active) {
    if (handle.steerTask || active.steerTask || !this.canSteer(id, handle, active)) return;
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
          const actual =
            this.store.findNativeRun(id, active.run.threadId, response.turnId) ??
            this.store.observeRun(id, active.run.threadId, response.turnId);
          if (!actual.finishedAt) {
            if (
              handle.session === client &&
              !this.closing &&
              this.store.getAgent(id).desiredState === 'running'
            )
              this.observe(id, handle, actual.threadId, response.turnId);
            else {
              const stopped = this.store.getAgent(id).desiredState === 'stopped';
              this.store.finishRun(
                actual.id,
                stopped ? 'interrupted' : 'uncertain',
                stopped ? 'cancelled' : 'uncertain',
                '原生连接已关闭，投递已确认',
              );
            }
          }
          this.store.acceptSteer(batch.id, response.turnId, actual.id);
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
        delete handle.steerTask;
        delete handle.steering;
        if (this.store.hasPendingMessages(id) || (!handle.activities.size && handle.refresh))
          this.kick(id);
      });
    handle.steerTask = active.steerTask;
    handle.steering = active;
  }
  private async connect(id: string, handle: Handle, previousSessionId?: string | null) {
    const agent = this.store.getAgent(id);
    if ((agent.desiredState !== 'running' && !this.resetting.has(id)) || this.closing) return;
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
    handle.workspacePaths = [...agent.workspacePaths];
    await this.workspace.prepareWorkspace(agent);
    let connection: HarnessSession | undefined;
    let bound = false;
    const session = await adapter.connect(agent, this.baseUrl!, {
      connected: (value) => {
        connection = value;
        handle.session = value;
        if (
          this.closing ||
          (this.store.getAgent(id).desiredState !== 'running' && !this.resetting.has(id))
        )
          void value
            .close()
            .catch((error: unknown) =>
              this.log.warn({ err: error, agentId: id }, 'Closing a stopped native session failed'),
            );
      },
      event: (event) => {
        if (
          (bound || event.type === 'context_usage') &&
          connection &&
          handle.session === connection
        )
          this.event(id, handle, event);
      },
      question: (question) => {
        if (bound && connection && handle.session === connection)
          this.question(id, handle, question);
      },
      exit: (error) => {
        if (connection && handle.session === connection) this.connectionExited(id, handle, error);
      },
    });
    if (connection !== session) throw new Error('Harness 未发布正确的原生连接');
    if (adapter.descriptor.capabilities.steer && !session.steer)
      throw new Error('Harness 声明支持 steer，但未提供投递方法');
    if (
      (this.store.getAgent(id).desiredState !== 'running' && !this.resetting.has(id)) ||
      this.closing
    ) {
      await session.close();
      if (handle.session === session) delete handle.session;
      return;
    }
    if (handle.session !== session)
      throw new Error('原生连接已在启动期间退出，请恢复 Agent 后重试。');
    let sessionId: string;
    if (agent.threadId) {
      sessionId = await session.resumeSession(agent.threadId);
      if (sessionId !== agent.threadId) throw new Error('恢复返回了不同 thread，已拒绝继续执行。');
    } else {
      this.store.updateAgent(id, { threadCreationAttempted: true });
      sessionId = await session.createSession((createdId) => {
        if (!createdId) throw new Error('Harness 返回了空的原生 session ID');
        if (createdId === previousSessionId)
          throw new Error('Harness 返回了原会话 ID，请检查原生会话创建接口。');
        const saved = this.store.getAgent(id).threadId;
        if (saved && saved !== createdId)
          throw new Error('Harness 试图替换已保存的原生 session 绑定');
        this.store.updateAgent(id, { threadId: createdId });
      });
      if (sessionId !== this.store.getAgent(id).threadId)
        throw new Error('Harness 新建的 session 与已保存绑定不一致');
    }
    if (handle.session !== session)
      throw new Error('原生连接已在会话初始化期间退出，请恢复 Agent 后重试。');
    this.store.updateAgent(id, {
      threadId: sessionId,
      status: this.store.getAgent(id).desiredState === 'running' ? 'ready' : 'stopped',
      error: null,
    });
    bound = true;
    handle.rootSessionId = sessionId;
    handle.nativeSubagents = adapter.descriptor.capabilities.nativeSubagents;
    this.log.info(
      { agentId: id, harness: agent.harness, sessionId },
      agent.threadId ? 'Native session resumed' : 'Native session created',
    );
  }
  private async pump(id: string, handle: Handle) {
    try {
      while (!this.closing && this.runnable(id)) {
        if (handle.active || handle.submitting || handle.steerTask) break;
        if (handle.retiring) {
          await handle.retiring;
          if (this.closing || !this.runnable(id)) break;
        }
        if (handle.refresh && handle.activities.size) break;
        if (handle.refresh && handle.session && !handle.activities.size) {
          // Reconnect through the adapter to reload settings and tools in the same session.
          const client = handle.session;
          delete handle.session;
          await client.close();
        }
        if (!handle.activities.size) delete handle.refresh;
        if (!handle.session) await this.connect(id, handle);
        // An edit during workspace preparation or initialization must reload guidance
        // before any queued input starts its first turn.
        if (handle.refresh && !handle.activities.size) continue;
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
      await handle.retiring;
    }
  }
  private activity(run: Run, turnId: string | null = run.turnId): Active {
    return { run, turnId, output: new RunOutputBuffer(), finished: false, requests: new Map() };
  }
  private activityKey(sessionId: string, turnId: string) {
    return JSON.stringify([sessionId, turnId]);
  }
  private allActivities(handle: Handle) {
    return [
      ...new Set([
        ...handle.activities.values(),
        ...(handle.submitting ? [handle.submitting.active] : []),
        ...(handle.steering?.steerBatchId &&
        this.store.getSteer(handle.steering.steerBatchId).status === 'pending'
          ? [handle.steering]
          : []),
      ]),
    ];
  }
  private observe(id: string, handle: Handle, sessionId: string, turnId: string) {
    const key = this.activityKey(sessionId, turnId);
    const existing = handle.activities.get(key);
    if (existing) return existing;
    const run =
      this.store.findNativeRun(id, sessionId, turnId) ??
      this.store.observeRun(id, sessionId, turnId);
    if (run.finishedAt) return undefined;
    const active = this.activity(run, turnId);
    handle.activities.set(key, active);
    if (sessionId === this.store.getAgent(id).threadId) handle.active = active;
    this.activityStatus(id, handle);
    return active;
  }
  private activityStatus(id: string, handle: Handle) {
    const agent = this.store.getAgent(id);
    if (this.closing || agent.desiredState !== 'running' || agent.status === 'error') return;
    const status = handle.activities.size || handle.submitting ? 'running' : 'ready';
    if (agent.status !== status) this.store.updateAgent(id, { status });
  }
  private finishActivity(
    handle: Handle,
    active: Active,
    status: 'completed' | 'interrupted' | 'failed' | 'uncertain',
    error: string | null = null,
  ) {
    if (active.finished) {
      if (status === 'interrupted' || status === 'uncertain')
        this.store.finishRun(
          active.run.id,
          status,
          status === 'interrupted' ? 'cancelled' : 'uncertain',
          error,
        );
      return;
    }
    this.flushOutput(active, status === 'uncertain' ? 'failed' : status);
    this.store.finishRun(
      active.run.id,
      status,
      status === 'interrupted' ? 'cancelled' : status === 'failed' ? 'failed' : 'uncertain',
      error,
    );
    active.finished = true;
    active.requests.clear();
    if (active.turnId)
      handle.activities.delete(this.activityKey(active.run.threadId, active.turnId));
    if (handle.active === active) delete handle.active;
  }
  private replay(id: string, handle: Handle, pending: NonNullable<Handle['submitting']>) {
    if (!handle.session || this.closing || this.store.getAgent(id).desiredState !== 'running')
      return;
    for (const entry of pending.buffered)
      if ('event' in entry) this.event(id, handle, entry.event);
      else this.question(id, handle, entry.question);
  }
  private async turn(
    id: string,
    handle: Handle,
    client: HarnessSession,
    agent: AgentRecord,
    run: Run,
    input: ClaimedChannel[],
  ) {
    const active = this.activity(run, null);
    const pending: NonNullable<Handle['submitting']> = { active, buffered: [] };
    handle.submitting = pending;
    this.activityStatus(id, handle);
    try {
      const response = await client.submit({
        sessionId: run.threadId,
        runId: run.id,
        text: formatMessages(this.messageLabels(id), input),
        model: agent.model,
        reasoningEffort: agent.reasoningEffort,
        workspace: agent.workspace,
      });
      const existing = this.store.findNativeRun(id, run.threadId, response.turnId);
      if (existing && existing.id !== run.id)
        throw new Error('原生提交返回已记录的活动，请核对投递结果');
      this.store.acceptRun(run.id, response.turnId);
      active.turnId = response.turnId;
      active.run = this.store.getRun(run.id);
      delete handle.submitting;
      if (
        !active.finished &&
        handle.session === client &&
        this.store.getAgent(id).desiredState === 'running'
      ) {
        handle.activities.set(this.activityKey(run.threadId, response.turnId), active);
        handle.active = active;
        this.replay(id, handle, pending);
        this.kickSteer(id, handle, active);
      }
      this.log.info({ agentId: id, runId: run.id, turnId: response.turnId }, 'Input accepted');
    } catch (error) {
      delete handle.submitting;
      const rejected = error instanceof HarnessSubmissionRejected;
      this.log.error(
        { err: error, agentId: id, runId: run.id },
        rejected ? 'Input rejected' : 'Input result is uncertain',
      );
      this.finishActivity(
        handle,
        active,
        rejected ? 'failed' : 'uncertain',
        this.workspace.redactor.text(error),
      );
      this.replay(id, handle, pending);
      if (this.store.getAgent(id).desiredState === 'running')
        this.store.updateAgent(id, { status: 'error', error: this.workspace.redactor.text(error) });
    } finally {
      if (handle.submitting === pending) delete handle.submitting;
      this.activityStatus(id, handle);
    }
  }
  private connectionExited(id: string, handle: Handle, error: Error) {
    this.log.error({ err: error, agentId: id }, 'Native process exited unexpectedly');
    const exited = handle.session;
    delete handle.session;
    if (exited) {
      const retiring = Promise.resolve()
        .then(() => exited.close())
        .catch((error: unknown) =>
          this.log.warn({ err: error, agentId: id }, 'Exited native session cleanup failed'),
        );
      handle.retiring = retiring;
      void retiring.then(() => {
        if (handle.retiring === retiring) delete handle.retiring;
      });
    }
    for (const active of this.allActivities(handle))
      this.finishActivity(handle, active, 'uncertain', this.workspace.redactor.text(error));
    if (!this.closing && this.store.getAgent(id).desiredState === 'running')
      this.store.updateAgent(id, { status: 'error', error: this.workspace.redactor.text(error) });
  }
  private flushOutput(active: Active, status: 'completed' | 'interrupted' | 'failed') {
    if (active.finished) return;
    this.store.updateItems(
      active.run.id,
      active.output.flush(status).map((item) => ({
        ...item,
        text: this.workspace.redactor.output(item.text),
      })),
    );
  }
  private event(id: string, handle: Handle, event: HarnessEvent) {
    if (!handle.session || this.closing) return;
    if (event.type === 'context_usage') {
      if (event.sessionId === this.store.getAgent(id).threadId)
        this.store.recordContextUsage(id, event.sessionId, event.usage);
      return;
    }
    const main = event.sessionId === handle.rootSessionId;
    if (!main && !handle.nativeSubagents) return;
    if (main && handle.submitting) {
      handle.submitting.buffered.push({ event });
      return;
    }
    const turnId = event.turnId ?? (main ? handle.active?.turnId : undefined);
    if (!turnId) return;
    // Finished identities remain in storage, so late fragments cannot reopen an activity.
    const active =
      event.type === 'question_expired'
        ? handle.activities.get(this.activityKey(event.sessionId, turnId))
        : this.observe(id, handle, event.sessionId, turnId);
    if (!active || active.finished) return;
    if (event.type === 'turn_started') {
      if (main) {
        handle.active = active;
        this.kickSteer(id, handle, active);
      }
      return;
    }
    if (event.type === 'turn_completed') {
      const error = event.error ? this.workspace.redactor.text(event.error) : null;
      this.finishActivity(handle, active, event.status, error);
      if (main && event.status === 'failed')
        this.store.updateAgent(id, { status: 'error', error: error ?? '原生活动失败' });
      this.activityStatus(id, handle);
      this.kick(id);
      return;
    }
    if (event.type === 'question_expired') {
      for (const [questionId, requestId] of active.requests)
        if (requestId === event.requestId) {
          this.store.expireQuestion(questionId);
          active.requests.delete(questionId);
        }
      return;
    }
    const item = active.output.update(event.item, event.append, event.type === 'item_delta');
    if (event.type === 'item_delta') return;
    this.store.updateItems(active.run.id, [
      { ...item, text: this.workspace.redactor.output(item.text) },
    ]);
  }
  private question(id: string, handle: Handle, request: HarnessQuestion) {
    const session = handle.session;
    if (!session) return;
    const agent = this.store.getAgent(id);
    const main = request.sessionId === agent.threadId;
    const capabilities = this.harnesses.get(agent.harness).descriptor.capabilities;
    if (main && handle.submitting && !this.closing && agent.desiredState === 'running') {
      handle.submitting.buffered.push({ question: request });
      return;
    }
    const active =
      !this.closing &&
      agent.desiredState === 'running' &&
      capabilities.userQuestions &&
      (main || capabilities.nativeSubagents)
        ? this.observe(id, handle, request.sessionId, request.turnId)
        : undefined;
    if (!active || active.finished) {
      session.rejectQuestion(request.requestId, 'Native activity is unavailable');
      return;
    }
    const definitions: QuestionDefinition[] = request.questions.map((definition) => {
      const q = questionDefinitionSchema.parse(definition);
      return {
        ...q,
        header: this.workspace.redactor.text(q.header),
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
  }
  answer(id: string, questionId: string, value: QuestionAnswer) {
    const answers = answerQuestionSchema.parse(value);
    const question = this.store.getQuestion(questionId);
    const handle = this.handles.get(id);
    const active =
      handle &&
      [...handle.activities.values()].find((activity) => activity.run.id === question.runId);
    const requestId = active?.requests.get(questionId);
    if (question.agentId !== id) throw new HttpError(404, '问题不存在');
    if (
      question.status !== 'pending' ||
      requestId === undefined ||
      !handle?.session ||
      !active ||
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
      if (!q.multiSelect && response.answers.length !== 1)
        throw new HttpError(400, '该问题请选择一个答案');
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
    active.requests.delete(questionId);
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
    // Fence native callbacks while every recorded activity is stopped together.
    delete handle.session;
    const activities = this.allActivities(handle);
    const interruptions = activities.filter((active) => !active.finished && active.turnId);
    for (const active of activities)
      this.finishActivity(handle, active, 'interrupted', '用户停止了 Agent');
    if (
      client &&
      this.harnesses.get(this.store.getAgent(id).harness).descriptor.capabilities.interrupt
    )
      await Promise.all(
        interruptions.map((active) =>
          Promise.race([
            client
              .interrupt(active.run.threadId, active.turnId!)
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
          ]),
        ),
      );
    await client?.close();
    await handle.retiring;
  }
  async resume(id: string) {
    let agent = this.managed(id);
    const handle = this.handle(id);
    if (agent.desiredState === 'running' && (handle.activities.size || handle.submitting))
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
    await handle.steerTask;
    await handle.retiring;
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
  /** User-requested replacement is serialized against every admission and management action. */
  async newSession(id: string) {
    if (!this.baseUrl || this.closing) throw new HttpError(503, 'Runtime 尚未就绪');
    const agent = this.managed(id);
    const handle = this.handle(id);
    // Native initialization and outstanding turn cleanup must finish before their
    // connection can be replaced; the displayed status alone does not imply work.
    if (
      handle.task ||
      handle.steerTask ||
      handle.submitting ||
      handle.activities.size ||
      this.store.hasActiveRun(id)
    )
      throw new HttpError(409, 'Agent 正在执行或初始化，请等待空闲后新建会话。');
    this.resetting.add(id);
    handle.controlRevision = (handle.controlRevision ?? 0) + 1;
    let task: Promise<void> | undefined;
    try {
      // Establish the boundary synchronously. Incoming messages now wait for the new session.
      this.store.beginNewSession(id);
      task = this.replaceSession(id, handle, agent.threadId);
      handle.task = task;
      await task;
      return this.store.publicAgent(id);
    } finally {
      if (handle.task === task) delete handle.task;
      this.resetting.delete(id);
      if (
        !this.closing &&
        this.runnable(id) &&
        (handle.refresh || this.store.hasPendingMessages(id))
      )
        this.kick(id);
    }
  }
  private async replaceSession(id: string, handle: Handle, previousSessionId: string | null) {
    try {
      await handle.retiring;
      const previous = handle.session;
      // Fence late events and exits from the old process before shutdown awaits native I/O.
      if (handle.session === previous) delete handle.session;
      await previous?.close();
      delete handle.refresh;
      if (this.closing) throw new Error('服务正在关闭，请启动后继续新建会话。');
      await this.connect(id, handle, previousSessionId);
      if (this.closing || !this.store.getAgent(id).threadId)
        throw new Error('新会话初始化尚未完成，请查看 Agent 状态。');
      this.store.completeNewSession(id, previousSessionId);
      this.log.info(
        { agentId: id, previousSessionId, sessionId: this.store.getAgent(id).threadId },
        'Agent started a new native session',
      );
    } catch (error) {
      const reason = this.workspace.redactor.text(error);
      this.store.updateAgent(id, { desiredState: 'stopped', status: 'error', error: reason });
      await handle.session?.close();
      delete handle.session;
      this.log.warn({ agentId: id, reason }, 'New native session initialization failed');
      throw new HttpError(503, reason);
    }
  }
  async deleteAgent(id: string) {
    const agent = this.store.getAgent(id);
    if (agent.status === 'deleted') return this.store.publicAgent(id);
    if (this.deleting.has(id)) throw new HttpError(409, 'Agent 正在删除，请等待操作完成');
    if (this.resetting.has(id)) throw new HttpError(409, 'Agent 正在新建会话，请等待操作完成');
    this.deleting.add(id);
    const handle = this.handle(id);
    handle.controlRevision = (handle.controlRevision ?? 0) + 1;
    try {
      await this.halt(id);
      await this.handles.get(id)?.task;
      await handle.steerTask;
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
    await this.workspaceSettingsTask;
    for (const [id, handle] of this.handles) {
      const activities = this.allActivities(handle);
      for (const active of activities) this.flushOutput(active, 'interrupted');
      for (const active of activities)
        this.finishActivity(
          handle,
          active,
          'uncertain',
          '服务关闭时原生活动仍在执行，请恢复后查看原生状态',
        );
      if (activities.length && this.store.getAgent(id).desiredState === 'running')
        this.store.updateAgent(id, { status: 'error', error: '原生活动状态待核对，请恢复 Agent' });
    }
    await Promise.all(
      [...this.handles.values()].map(async (handle) => {
        const session = handle.session;
        delete handle.session;
        await session?.close();
        await handle.task?.catch((error: unknown) =>
          this.log.warn({ err: error }, 'Agent initialization ended during shutdown'),
        );
        await handle.steerTask;
        await handle.retiring;
      }),
    );
  }
}
