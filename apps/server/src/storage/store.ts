import {
  agentSchema,
  channelSchema,
  contextUsageSchema,
  messageKey,
  workspacePathsSchema,
} from '@isles/contracts';
import type {
  Agent,
  AgentDetail,
  Channel,
  ChannelDetail,
  ContextUsage,
  DeliveryStatus,
  IslesEvent,
  Message,
  MessageRef,
  QuestionAnswer,
  QuestionDefinition,
  Run,
  RunItem,
  RunStatus,
  UserQuestion,
  UpdateChannel,
} from '@isles/contracts';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { HttpError } from '../errors.js';
import { mergeWorkspacePaths } from '../runtime/workspace-paths.js';
import type { IslesDatabase } from './database.js';
import {
  agents,
  channelMembers,
  channels,
  deliveries,
  events,
  messages,
  questions,
  runItems,
  runs,
  steerBatches,
} from './schema.js';

export type AgentRecord = typeof agents.$inferSelect & {
  channelId: string;
  dangerFullAccess: boolean;
};
export type ChannelRecord = typeof channels.$inferSelect;
type AgentUpdate = Partial<
  Pick<
    AgentRecord,
    | 'status'
    | 'desiredState'
    | 'threadId'
    | 'error'
    | 'threadCreationAttempted'
    | 'canCreateGroups'
    | 'steerEnabled'
    | 'dangerFullAccess'
    | 'name'
    | 'model'
    | 'reasoningEffort'
    | 'workspacePaths'
  >
>;
export type Sender = { type: 'user' } | { type: 'agent'; id: string };
/** 'user' or the ID of the acting Agent. */
export type Actor = string;
export interface NewAgent {
  harness: string;
  name: string;
  model: string;
  reasoningEffort: string;
  canCreateGroups: boolean;
  steerEnabled?: boolean;
  dangerFullAccess?: boolean;
  workspacePaths?: string[] | undefined;
  /** Native storage scope of the Agent's fixed session. */
  nativeHome: string;
}
export interface MessageInput {
  body: string;
  clientId: string;
  replyTo?: number | undefined;
  mentions?: string[] | undefined;
}
/** One channel's share of a merged input. */
export interface ClaimedChannel {
  channel: ChannelRecord;
  messages: Message[];
  /** Earlier unread messages marked skipped instead of being submitted. */
  skipped: number;
}

export interface ChatExportSnapshot {
  channel: Pick<ChannelRecord, 'id' | 'kind' | 'name' | 'agentId'>;
  exportedAt: string;
  agents: { id: string; name: string }[];
  messages: Omit<Message, 'channelId' | 'clientId' | 'deliveries'>[];
}

// Each channel contributes its most recent unread messages, plus every unread mention.
const RECENT_PER_CHANNEL = 10;
const USER = 'user';
const now = () => new Date().toISOString();

const deliveryMessageJoin = and(
  eq(deliveries.channelId, messages.channelId),
  eq(deliveries.seq, messages.seq),
);
function deliveryRefs(refs: MessageRef[]) {
  const channels = new Map<string, number[]>();
  for (const ref of refs)
    channels.set(ref.channelId, [...(channels.get(ref.channelId) ?? []), ref.seq]);
  return or(
    ...[...channels].map(([channelId, seqs]) =>
      and(eq(deliveries.channelId, channelId), inArray(deliveries.seq, seqs)),
    ),
  );
}

export class Store {
  private emitter = new EventEmitter();
  /** Native execution policy is Agent configuration, recorded by the existing event log. */
  private executionAccess = new Map<string, boolean>();
  constructor(
    readonly database: IslesDatabase,
    private workspaceDir: string,
  ) {
    for (const row of this.db
      .select({ agentId: events.agentId, data: events.data })
      .from(events)
      .where(
        and(
          eq(events.type, 'agent'),
          sql`json_type(${events.data}, '$.dangerFullAccess') in ('true', 'false')`,
        ),
      )
      .orderBy(asc(events.id))
      .all()) {
      if (row.agentId)
        this.executionAccess.set(
          row.agentId,
          (JSON.parse(row.data) as { dangerFullAccess: boolean }).dangerFullAccess,
        );
    }
  }
  private get db() {
    return this.database.db;
  }

  // Transactions are strictly synchronous; no RPC or model wait belongs here.
  private change<T>(fn: () => T): T {
    const cursor = this.cursor();
    const result = this.database.sqlite.transaction(fn)();
    const committed = this.eventsAfter(cursor);
    for (const event of committed)
      if (
        event.type === 'agent' &&
        event.agentId &&
        typeof event.data.dangerFullAccess === 'boolean'
      )
        this.executionAccess.set(event.agentId, event.data.dangerFullAccess);
    for (const event of committed) this.emitter.emit('event', event);
    return result;
  }
  private event(
    type: IslesEvent['type'],
    scope: { agentId?: string | null; channelId?: string | null },
    data: IslesEvent['data'],
  ) {
    this.db
      .insert(events)
      .values({
        type,
        agentId: scope.agentId ?? null,
        channelId: scope.channelId ?? null,
        data: JSON.stringify(data),
        createdAt: now(),
      })
      .run();
  }
  cursor(): number {
    return this.db
      .select({ id: sql<number>`coalesce(max(${events.id}), 0)` })
      .from(events)
      .get()!.id;
  }
  eventsAfter(cursor: number, limit = 500): IslesEvent[] {
    return this.db
      .select()
      .from(events)
      .where(gt(events.id, cursor))
      .orderBy(asc(events.id))
      .limit(limit)
      .all()
      .map((r) => ({ ...r, data: JSON.parse(r.data) as IslesEvent['data'] }));
  }
  subscribe(listener: (event: IslesEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  // Agents

  getAgent(id: string): AgentRecord {
    const agent = this.db.select().from(agents).where(eq(agents.id, id)).get();
    const channel = this.db.select().from(channels).where(eq(channels.agentId, id)).get();
    if (!agent || !channel) throw new HttpError(404, 'Agent 不存在');
    return {
      ...agent,
      channelId: channel.id,
      dangerFullAccess: this.executionAccess.get(id) ?? false,
    };
  }
  publicAgent(id: string): Agent {
    return agentSchema.parse(this.getAgent(id));
  }
  listAgents(includeDeleted = false): Agent[] {
    return this.db
      .select({ id: agents.id })
      .from(agents)
      .where(includeDeleted ? undefined : ne(agents.status, 'deleted'))
      .orderBy(asc(agents.createdAt))
      .all()
      .map((r) => this.publicAgent(r.id));
  }
  createAgent(input: NewAgent): AgentRecord {
    return this.change(() => this.insertAgent(input));
  }
  createAgents(input: NewAgent, count: number): AgentRecord[] {
    if (!Number.isInteger(count) || count < 1 || count > 50)
      throw new HttpError(400, '创建数量须为 1 到 50 的整数');
    return this.change(() => {
      const prefix = `${input.name}-`;
      let last = 0n;
      for (const { name } of this.db.select({ name: agents.name }).from(agents).all()) {
        if (!name.startsWith(prefix)) continue;
        const suffix = name.slice(prefix.length);
        if (!/^[1-9][0-9]*$/.test(suffix)) continue;
        const number = BigInt(suffix);
        if (number > last) last = number;
      }
      const names = Array.from(
        { length: count },
        (_, index) => `${prefix}${last + BigInt(index) + 1n}`,
      );
      if (names.some((name) => name.length > 80))
        throw new HttpError(400, '生成的 Agent 名称超过 80 个字符，请缩短名称前缀');
      return names.map((name) => this.insertAgent({ ...input, name }));
    });
  }
  /** Call only inside change, so a batch publishes events after every Agent is committed. */
  private insertAgent(input: NewAgent): AgentRecord {
    const id = randomUUID();
    const channelId = randomUUID();
    const { dangerFullAccess = false, ...record } = input;
    const root = join(this.workspaceDir, 'agents', id);
    this.db
      .insert(agents)
      .values({
        id,
        ...record,
        workspacePaths: this.validWorkspacePaths(input.workspacePaths ?? []),
        status: 'creating',
        workspace: join(root, 'workspace'),
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    this.db
      .insert(channels)
      .values({
        id: channelId,
        kind: 'private',
        agentId: id,
        createdBy: USER,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    this.db
      .insert(channelMembers)
      .values({ channelId, agentId: id, addedBy: USER, joinedAt: now() })
      .run();
    this.event('agent', { agentId: id }, { status: 'creating', dangerFullAccess });
    this.event('channel', { channelId }, { created: true });
    return { ...this.getAgent(id), dangerFullAccess };
  }
  updateAgent(id: string, update: AgentUpdate) {
    const record = { ...update };
    delete record.dangerFullAccess;
    if (record.workspacePaths !== undefined)
      record.workspacePaths = this.validWorkspacePaths(record.workspacePaths);
    this.change(() => {
      if (this.getAgent(id).status === 'deleted') throw new HttpError(410, '该 Agent 已删除');
      this.db
        .update(agents)
        .set({ ...record, updatedAt: now() })
        .where(eq(agents.id, id))
        .run();
      this.event('agent', { agentId: id }, update);
    });
  }
  private validWorkspacePaths(paths: readonly string[]): string[] {
    const result = workspacePathsSchema.safeParse(paths);
    if (!result.success)
      throw new HttpError(400, '工作目录路径须为 1 到 4096 个字符，并使用单行文本');
    return mergeWorkspacePaths(result.data);
  }
  /** Append once; later edits and group removal retain the Agent's own directory list. */
  appendWorkspacePaths(agentIds: string[], paths: readonly string[]): string[] {
    return this.change(() => this.appendAgentWorkspacePaths(agentIds, paths));
  }
  private appendAgentWorkspacePaths(agentIds: string[], paths: readonly string[]): string[] {
    if (!paths.length) return [];
    const changed: string[] = [];
    for (const id of new Set(agentIds)) {
      const agent = this.getAgent(id);
      if (agent.status === 'deleted') continue;
      const workspacePaths = this.validWorkspacePaths(
        mergeWorkspacePaths(agent.workspacePaths, paths),
      );
      if (JSON.stringify(workspacePaths) === JSON.stringify(agent.workspacePaths)) continue;
      this.db
        .update(agents)
        .set({ workspacePaths, updatedAt: now() })
        .where(eq(agents.id, id))
        .run();
      this.event('agent', { agentId: id }, { workspacePaths });
      changed.push(id);
    }
    return changed;
  }
  /** Latest native context snapshot belongs to the current session, including after restart. */
  contextUsage(id: string): ContextUsage | null {
    const agent = this.getAgent(id);
    const latest = this.db
      .select({ data: events.data })
      .from(events)
      .where(
        and(
          eq(events.agentId, id),
          eq(events.type, 'agent'),
          sql`json_type(${events.data}, '$.contextUsage') is not null`,
        ),
      )
      .orderBy(desc(events.id))
      .limit(1)
      .get();
    if (!latest) return null;
    const usage = (JSON.parse(latest.data) as { contextUsage: ContextUsage | null }).contextUsage;
    return usage?.sessionId === agent.threadId ? contextUsageSchema.parse(usage) : null;
  }
  recordContextUsage(
    id: string,
    sessionId: string,
    usage: Omit<ContextUsage, 'sessionId' | 'updatedAt'> | null,
  ) {
    const agent = this.getAgent(id);
    if (agent.status === 'deleted' || agent.threadId !== sessionId) return;
    if (usage === null) {
      this.change(() => this.event('agent', { agentId: id }, { contextUsage: null }));
      return;
    }
    const snapshot = contextUsageSchema.safeParse({ ...usage, sessionId, updatedAt: now() });
    if (!snapshot.success) return;
    this.change(() => this.event('agent', { agentId: id }, { contextUsage: snapshot.data }));
  }
  /** Cancel existing admissions at the replacement boundary while retaining their history. */
  beginNewSession(id: string) {
    this.change(() => {
      const agent = this.getAgent(id);
      if (agent.status === 'deleted') throw new HttpError(410, '该 Agent 已删除');
      const cancelled = this.db
        .update(deliveries)
        .set({ status: 'cancelled', updatedAt: now() })
        .where(
          and(
            eq(deliveries.agentId, id),
            inArray(deliveries.status, ['queued', 'submitting', 'steering']),
          ),
        )
        .returning({ channelId: deliveries.channelId })
        .all();
      // Pending deliveries retain their original session binding for later native receipts.
      for (const batch of this.db
        .select({ runId: steerBatches.runId })
        .from(steerBatches)
        .where(and(eq(steerBatches.agentId, id), eq(steerBatches.status, 'pending')))
        .all())
        this.settlePendingSteers(batch.runId, 'cancelled', '新建会话操作已取消待投递消息。');
      const expired = this.db
        .update(questions)
        .set({ status: 'expired' })
        .where(and(eq(questions.agentId, id), eq(questions.status, 'pending')))
        .returning({ id: questions.id })
        .all();
      const update = {
        threadId: null,
        threadCreationAttempted: false,
        status: 'creating' as const,
        error: null,
      };
      this.db
        .update(agents)
        .set({ ...update, updatedAt: now() })
        .where(eq(agents.id, id))
        .run();
      this.event(
        'agent',
        { agentId: id },
        {
          ...update,
          contextUsage: null,
          previousSessionId: agent.threadId,
          sessionReset: 'started',
        },
      );
      for (const channelId of new Set(cancelled.map((d) => d.channelId)))
        this.event('delivery', { agentId: id, channelId }, { status: 'cancelled' });
      if (expired.length) this.event('question', { agentId: id }, { status: 'expired' });
    });
  }
  completeNewSession(id: string, previousSessionId: string | null) {
    this.change(() => {
      const agent = this.getAgent(id);
      this.systemMessage(agent.channelId, '已新建会话，后续消息使用新的上下文。');
      this.event(
        'agent',
        { agentId: id },
        {
          previousSessionId,
          sessionId: agent.threadId,
          sessionReset: 'completed',
        },
      );
    });
  }
  /** Retire an Agent while retaining its identity, native session and historical records. */
  deleteAgent(id: string): Agent {
    return this.change(() => {
      const agent = this.getAgent(id);
      if (agent.status === 'deleted') return this.publicAgent(id);
      const joined = this.channelsOf(id);
      const update = {
        status: 'deleted' as const,
        desiredState: 'stopped' as const,
        canCreateGroups: false,
        error: null,
      };
      this.db
        .update(agents)
        .set({ ...update, updatedAt: now() })
        .where(eq(agents.id, id))
        .run();
      this.db.delete(channelMembers).where(eq(channelMembers.agentId, id)).run();
      const cancelled = this.db
        .update(deliveries)
        .set({ status: 'cancelled', updatedAt: now() })
        .where(
          and(
            eq(deliveries.agentId, id),
            inArray(deliveries.status, ['queued', 'skipped', 'submitting', 'steering']),
          ),
        )
        .returning({ channelId: deliveries.channelId })
        .all();
      const interrupted = this.db
        .update(runs)
        .set({ status: 'interrupted', finishedAt: now() })
        .where(and(eq(runs.agentId, id), inArray(runs.status, ['starting', 'running', 'waiting'])))
        .returning({ id: runs.id })
        .all();
      const expired = this.db
        .update(questions)
        .set({ status: 'expired' })
        .where(and(eq(questions.agentId, id), eq(questions.status, 'pending')))
        .returning({ id: questions.id })
        .all();
      for (const batch of this.db
        .select({ runId: steerBatches.runId })
        .from(steerBatches)
        .where(and(eq(steerBatches.agentId, id), eq(steerBatches.status, 'pending')))
        .all())
        this.settlePendingSteers(
          batch.runId,
          'cancelled',
          'Agent 已删除，未确认的 steer 不再投递。',
        );
      this.event('agent', { agentId: id }, update);
      for (const channel of joined) {
        if (channel.kind === 'group')
          this.systemMessage(channel.id, `用户删除了 ${agent.name}，该 Agent 已退出群聊。`);
        this.event('channel', { agentId: id, channelId: channel.id }, { members: 'removed' });
      }
      for (const channelId of new Set(cancelled.map((d) => d.channelId)))
        this.event('delivery', { agentId: id, channelId }, { status: 'cancelled' });
      for (const run of interrupted)
        this.event('run', { agentId: id }, { runId: run.id, status: 'interrupted' });
      if (expired.length) this.event('question', { agentId: id }, { status: 'expired' });
      return this.publicAgent(id);
    });
  }
  private agentName(id: string) {
    return this.db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name;
  }
  private actorName(actor: Actor) {
    return actor === USER ? '用户' : (this.agentName(actor) ?? '未知 Agent');
  }

  // Channels

  getChannel(id: string): ChannelRecord {
    const channel = this.db.select().from(channels).where(eq(channels.id, id)).get();
    if (!channel) throw new HttpError(404, '频道不存在');
    return channel;
  }
  private group(id: string): ChannelRecord {
    const channel = this.getChannel(id);
    if (channel.kind !== 'group') throw new HttpError(400, '私聊不能修改名称或成员');
    if (this.groupDeletedAt(id)) throw new HttpError(410, '群聊已删除');
    return channel;
  }
  /** Permanent terminal marker; event retention must always preserve group_deleted rows. */
  groupDeletedAt(id: string): string | null {
    return (
      this.db
        .select({ createdAt: events.createdAt })
        .from(events)
        .where(and(eq(events.type, 'group_deleted'), eq(events.channelId, id)))
        .orderBy(asc(events.id))
        .limit(1)
        .get()?.createdAt ?? null
    );
  }
  private liveChannel() {
    return notExists(
      this.db
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.type, 'group_deleted'), eq(events.channelId, channels.id))),
    );
  }
  memberIds(channelId: string): string[] {
    return this.db
      .select({ agentId: channelMembers.agentId })
      .from(channelMembers)
      .where(eq(channelMembers.channelId, channelId))
      .orderBy(asc(channelMembers.joinedAt))
      .all()
      .map((r) => r.agentId);
  }
  isMember(channelId: string, agentId: string) {
    return Boolean(
      this.db
        .select()
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.agentId, agentId)))
        .get(),
    );
  }
  publicChannel(id: string): Channel {
    const channel = this.getChannel(id);
    const last = this.db
      .select()
      .from(messages)
      .where(eq(messages.channelId, id))
      .orderBy(desc(messages.seq))
      .limit(1)
      .all();
    return channelSchema.parse({
      ...channel,
      deletedAt: channel.kind === 'group' ? this.groupDeletedAt(id) : null,
      memberIds: this.memberIds(id),
      lastMessage: this.withDeliveries(last)[0] ?? null,
    });
  }
  listChannels(includeDeleted = false): Channel[] {
    return this.db
      .select({ id: channels.id })
      .from(channels)
      .where(includeDeleted ? undefined : this.liveChannel())
      .orderBy(asc(channels.createdAt))
      .all()
      .map((r) => this.publicChannel(r.id));
  }
  channelsOf(agentId: string): Channel[] {
    return this.db
      .select({ id: channelMembers.channelId })
      .from(channelMembers)
      .innerJoin(channels, eq(channelMembers.channelId, channels.id))
      .where(and(eq(channelMembers.agentId, agentId), this.liveChannel()))
      .all()
      .map((r) => this.publicChannel(r.id));
  }
  private existingAgents(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const found = this.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(inArray(agents.id, unique), ne(agents.status, 'deleted')))
      .all();
    if (found.length !== unique.length) throw new HttpError(400, '只能添加已有的 Agent');
    return unique;
  }
  createGroup(
    actor: Actor,
    name: string,
    memberIds: string[],
    workspacePaths: string[] = [],
  ): Channel {
    const members = this.existingAgents(actor === USER ? memberIds : [actor, ...memberIds]);
    const paths = this.validWorkspacePaths(workspacePaths);
    const id = randomUUID();
    this.change(() => {
      this.db
        .insert(channels)
        .values({
          id,
          kind: 'group',
          name,
          workspacePaths: paths,
          createdBy: actor,
          createdAt: now(),
          updatedAt: now(),
        })
        .run();
      for (const agentId of members)
        this.db
          .insert(channelMembers)
          .values({ channelId: id, agentId, addedBy: actor, joinedAt: now() })
          .run();
      this.appendAgentWorkspacePaths(members, paths);
      const names = members.map((m) => this.agentName(m)).join('、');
      this.systemMessage(
        id,
        `${this.actorName(actor)}创建了群聊“${name}”${names ? `，成员：${names}` : ''}。`,
      );
      this.event('channel', { channelId: id }, { created: true });
    });
    return this.publicChannel(id);
  }
  /** Retire only this group; merged native turns and member identities remain intact. */
  deleteGroup(id: string): Channel {
    return this.change(() => {
      const channel = this.getChannel(id);
      if (channel.kind !== 'group') throw new HttpError(400, '私聊不能删除');
      if (this.groupDeletedAt(id)) return this.publicChannel(id);
      this.systemMessage(id, '用户删除了群聊，聊天历史已保留。');
      this.db
        .update(channels)
        .set({ paused: true, updatedAt: now() })
        .where(eq(channels.id, id))
        .run();
      this.db.delete(channelMembers).where(eq(channelMembers.channelId, id)).run();
      const cancelled = this.db
        .update(deliveries)
        .set({ status: 'cancelled', updatedAt: now() })
        .where(
          and(
            eq(deliveries.channelId, id),
            inArray(deliveries.status, ['queued', 'skipped', 'submitting', 'steering']),
          ),
        )
        .returning({ agentId: deliveries.agentId })
        .all();
      this.event('group_deleted', { channelId: id }, { paused: true });
      for (const agentId of new Set(cancelled.map((d) => d.agentId)))
        this.event('delivery', { agentId, channelId: id }, { status: 'cancelled' });
      return this.publicChannel(id);
    });
  }
  updateChannel(id: string, update: UpdateChannel) {
    const channel = this.group(id);
    this.change(() => {
      const set: Partial<ChannelRecord> = {};
      if (update.workspacePaths !== undefined) {
        const paths = this.validWorkspacePaths(update.workspacePaths);
        if (JSON.stringify(paths) !== JSON.stringify(channel.workspacePaths)) {
          set.workspacePaths = paths;
          const added = mergeWorkspacePaths(channel.workspacePaths, paths).slice(
            channel.workspacePaths.length,
          );
          this.appendAgentWorkspacePaths(this.memberIds(id), added);
        }
      }
      if (update.name !== undefined && update.name !== channel.name) {
        set.name = update.name;
        this.systemMessage(id, `用户将群名改为“${update.name}”。`);
      }
      if (update.paused !== undefined && update.paused !== channel.paused) {
        set.paused = update.paused;
        this.systemMessage(
          id,
          update.paused
            ? '用户暂停了群讨论：新消息会保存，但暂不自动投递给任何 Agent；主动读取仍然可用。'
            : '用户继续了群讨论。',
        );
      }
      if (!Object.keys(set).length) return;
      this.db
        .update(channels)
        .set({ ...set, updatedAt: now() })
        .where(eq(channels.id, id))
        .run();
      this.event('channel', { channelId: id }, set);
    });
    return this.publicChannel(id);
  }
  /** Returns the Agents that were actually added. */
  addMembers(id: string, actor: Actor, agentIds: string[]): string[] {
    const channel = this.group(id);
    if (actor !== USER && !this.isMember(id, actor))
      throw new HttpError(403, '只能邀请 Agent 加入自己所在的群');
    const added = this.existingAgents(agentIds).filter((a) => !this.isMember(id, a));
    if (!added.length) return [];
    this.change(() => {
      for (const agentId of added)
        this.db
          .insert(channelMembers)
          .values({ channelId: id, agentId, addedBy: actor, joinedAt: now() })
          .run();
      this.appendAgentWorkspacePaths(added, channel.workspacePaths);
      this.systemMessage(
        id,
        `${this.actorName(actor)}邀请 ${added.map((a) => this.agentName(a)).join('、')} 加入了群聊。更早的消息可以通过历史读取。`,
      );
      this.event('channel', { channelId: id }, { members: 'added' });
    });
    return added;
  }
  removeMember(id: string, agentId: string) {
    this.group(id);
    if (!this.isMember(id, agentId)) throw new HttpError(404, '该 Agent 不在群中');
    this.change(() => {
      this.db
        .delete(channelMembers)
        .where(and(eq(channelMembers.channelId, id), eq(channelMembers.agentId, agentId)))
        .run();
      // A removed member no longer receives anything still waiting for it here.
      this.db
        .update(deliveries)
        .set({ status: 'cancelled', updatedAt: now() })
        .where(
          and(
            eq(deliveries.channelId, id),
            eq(deliveries.agentId, agentId),
            inArray(deliveries.status, ['queued', 'skipped', 'steering']),
          ),
        )
        .run();
      this.systemMessage(id, `用户将 ${this.agentName(agentId)} 移出了群聊。`);
      this.event('channel', { channelId: id }, { members: 'removed' });
    });
  }

  // Messages

  /** All formal history in one read snapshot; exporting does not acknowledge deliveries. */
  chatExportSnapshot(channelId: string): ChatExportSnapshot {
    return this.database.sqlite.transaction(() => {
      const channel = this.getChannel(channelId);
      const exportedAt = now();
      const rows = this.db
        .select({
          seq: messages.seq,
          sender: messages.sender,
          senderId: messages.senderId,
          body: messages.body,
          replyTo: messages.replyTo,
          mentions: messages.mentions,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(eq(messages.channelId, channelId), lte(messages.seq, channel.nextMessageSeq - 1)),
        )
        .orderBy(asc(messages.seq))
        .all();
      return {
        channel: {
          id: channel.id,
          kind: channel.kind,
          name: channel.name,
          agentId: channel.agentId,
        },
        exportedAt,
        agents: this.db.select({ id: agents.id, name: agents.name }).from(agents).all(),
        messages: rows.map((row) => ({ ...row, mentions: JSON.parse(row.mentions) as string[] })),
      };
    })();
  }

  private withDeliveries(rows: (typeof messages.$inferSelect)[]): Message[] {
    const byMessage = new Map<string, Message['deliveries']>();
    if (rows.length)
      for (const d of this.db
        .select({
          channelId: deliveries.channelId,
          seq: deliveries.seq,
          agentId: deliveries.agentId,
          status: deliveries.status,
        })
        .from(deliveries)
        .where(deliveryRefs(rows))
        .all())
        byMessage.set(messageKey(d), [
          ...(byMessage.get(messageKey(d)) ?? []),
          { agentId: d.agentId, status: d.status },
        ]);
    return rows.map((r) => ({
      ...r,
      mentions: JSON.parse(r.mentions) as string[],
      deliveries: byMessage.get(messageKey(r)) ?? [],
    }));
  }
  listMessages(
    channelId: string,
    query: { after?: number; before?: number; limit?: number } = {},
  ): Message[] {
    this.getChannel(channelId);
    const predicates = [eq(messages.channelId, channelId)];
    if (query.after !== undefined) predicates.push(gt(messages.seq, query.after));
    if (query.before !== undefined) predicates.push(lt(messages.seq, query.before));
    const recent = query.after === undefined;
    const rows = this.db
      .select()
      .from(messages)
      .where(and(...predicates))
      .orderBy(recent ? desc(messages.seq) : asc(messages.seq))
      .limit(query.limit ?? 100)
      .all();
    return this.withDeliveries(recent ? rows.reverse() : rows);
  }
  /** Record only the messages actually returned, without changing existing run outcomes. */
  private recordReceipt(agentId: string, refs: MessageRef[]) {
    refs = refs.filter(
      (ref) => !this.groupDeletedAt(ref.channelId) && this.isMember(ref.channelId, agentId),
    );
    if (!refs.length) return;
    const updated = this.db
      .update(deliveries)
      .set({ status: 'received', updatedAt: now() })
      .where(
        and(
          eq(deliveries.agentId, agentId),
          deliveryRefs(refs),
          inArray(deliveries.status, ['queued', 'skipped']),
        ),
      )
      .returning({ channelId: deliveries.channelId })
      .all();
    for (const channelId of new Set(updated.map((d) => d.channelId)))
      this.event('delivery', { agentId, channelId }, { status: 'received' });
  }
  markMessagesReceived(agentId: string, refs: MessageRef[]) {
    this.change(() => this.recordReceipt(agentId, refs));
  }
  /** Pull queued messages into the current native turn; pagination never discards unread. */
  receiveMessages(
    agentId: string,
    query: { channelId?: string | undefined; limit: number },
  ): { input: ClaimedChannel[]; hasMore: boolean } {
    return this.change(() => {
      const rows = this.db
        .select({ message: messages, channel: channels })
        .from(deliveries)
        .innerJoin(messages, deliveryMessageJoin)
        .innerJoin(channels, eq(deliveries.channelId, channels.id))
        .innerJoin(
          channelMembers,
          and(eq(channelMembers.channelId, channels.id), eq(channelMembers.agentId, agentId)),
        )
        .where(
          and(
            eq(deliveries.agentId, agentId),
            eq(deliveries.status, 'queued'),
            this.liveChannel(),
            query.channelId === undefined ? undefined : eq(channels.id, query.channelId),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(channels.id), asc(messages.seq))
        .limit(query.limit + 1)
        .all();
      const page = rows.slice(0, query.limit);
      this.recordReceipt(
        agentId,
        page.map((r) => r.message),
      );
      const byChannel = new Map<string, ClaimedChannel>();
      const received = this.withDeliveries(page.map((r) => r.message));
      page.forEach(({ channel }, index) => {
        const entry = byChannel.get(channel.id) ?? { channel, messages: [], skipped: 0 };
        entry.messages.push(received[index]!);
        byChannel.set(channel.id, entry);
      });
      return { input: [...byChannel.values()], hasMore: rows.length > query.limit };
    });
  }
  private insertMessage(
    channelId: string,
    sender: { type: 'user' | 'agent' | 'system'; id: string },
    input: MessageInput & { mentions: string[] },
  ) {
    const seq = this.db
      .update(channels)
      .set({ nextMessageSeq: sql`${channels.nextMessageSeq} + 1` })
      .where(eq(channels.id, channelId))
      .returning({ seq: sql<number>`${channels.nextMessageSeq} - 1` })
      .get()!.seq;
    const message = {
      channelId,
      seq,
      sender: sender.type,
      senderId: sender.id,
      body: input.body,
      clientId: input.clientId,
      replyTo: input.replyTo ?? null,
      mentions: JSON.stringify(input.mentions),
      createdAt: now(),
    };
    this.db.insert(messages).values(message).run();
    // Every member except the sender receives it, whatever the mentions say.
    for (const agentId of this.memberIds(channelId))
      if (sender.type !== 'agent' || agentId !== sender.id)
        this.db
          .insert(deliveries)
          .values({
            seq,
            agentId,
            channelId,
            status: 'queued',
            updatedAt: now(),
          })
          .run();
    const channel = this.getChannel(channelId);
    this.event('message', { channelId, agentId: channel.agentId }, { seq });
    return message;
  }
  private systemMessage(channelId: string, body: string) {
    this.insertMessage(
      channelId,
      { type: 'system', id: 'system' },
      { body, clientId: randomUUID(), mentions: [] },
    );
  }
  saveMessage(channelId: string, sender: Sender, input: MessageInput): Message {
    const channel = this.getChannel(channelId);
    if (channel.kind === 'group' && this.groupDeletedAt(channelId))
      throw new HttpError(409, '群聊已删除，历史只读');
    if (channel.kind === 'private' && this.getAgent(channel.agentId!).status === 'deleted')
      throw new HttpError(409, '该 Agent 已删除，私聊历史只读');
    const senderId = sender.type === 'user' ? USER : sender.id;
    if (sender.type === 'agent' && !this.isMember(channelId, sender.id))
      throw new HttpError(403, '只能在自己所在的频道发言');
    const members = new Set(this.memberIds(channelId));
    const mentions = [...new Set(input.mentions ?? [])].filter((m) => m !== senderId);
    if (mentions.some((m) => !members.has(m))) throw new HttpError(400, '只能 @ 该频道的成员');
    return this.change(() => {
      const existing = this.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            eq(messages.sender, sender.type),
            eq(messages.senderId, senderId),
            eq(messages.clientId, input.clientId),
          ),
        )
        .get();
      if (existing) {
        if (
          existing.body !== input.body ||
          existing.replyTo !== (input.replyTo ?? null) ||
          existing.mentions !== JSON.stringify(mentions)
        )
          throw new HttpError(409, '去重标识已用于不同内容');
        return this.withDeliveries([existing])[0]!;
      }
      if (input.replyTo) {
        const parent = this.db
          .select()
          .from(messages)
          .where(and(eq(messages.channelId, channelId), eq(messages.seq, input.replyTo)))
          .get();
        if (!parent || parent.channelId !== channel.id)
          throw new HttpError(400, '只能回复同一频道中的消息');
      }
      const message = this.insertMessage(
        channelId,
        { type: sender.type, id: senderId },
        { ...input, mentions },
      );
      return this.withDeliveries([message])[0]!;
    });
  }

  // Scheduling

  /** Include parked group messages as well as admissions whose outcome is still pending. */
  pendingMessageCount(agentId: string): number {
    return this.db
      .select({ count: sql<number>`count(*)` })
      .from(deliveries)
      .innerJoin(messages, deliveryMessageJoin)
      .innerJoin(channels, eq(deliveries.channelId, channels.id))
      .where(
        and(
          eq(deliveries.agentId, agentId),
          inArray(deliveries.status, ['queued', 'submitting', 'steering']),
          this.liveChannel(),
          ne(messages.sender, 'system'),
        ),
      )
      .get()!.count;
  }
  hasActiveRun(agentId: string): boolean {
    return Boolean(
      this.db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(eq(runs.agentId, agentId), inArray(runs.status, ['starting', 'running', 'waiting'])),
        )
        .limit(1)
        .get(),
    );
  }
  /** Unread user or Agent messages in unpaused channels; system notices never wake anyone. */
  hasPendingMessages(agentId: string): boolean {
    return Boolean(
      this.db
        .select({ seq: deliveries.seq })
        .from(deliveries)
        .innerJoin(messages, deliveryMessageJoin)
        .innerJoin(channels, eq(deliveries.channelId, channels.id))
        .where(
          and(
            eq(deliveries.agentId, agentId),
            eq(deliveries.status, 'queued'),
            eq(channels.paused, false),
            this.liveChannel(),
            ne(messages.sender, 'system'),
          ),
        )
        .limit(1)
        .get(),
    );
  }
  /** Read only queued deliveries; initial turns and steering share the same trim policy. */
  private selectQueued(agentId: string) {
    const rows = this.db
      .select({ message: messages, channel: channels })
      .from(deliveries)
      .innerJoin(messages, deliveryMessageJoin)
      .innerJoin(channels, eq(deliveries.channelId, channels.id))
      .innerJoin(
        channelMembers,
        and(eq(channelMembers.channelId, channels.id), eq(channelMembers.agentId, agentId)),
      )
      .where(
        and(
          eq(deliveries.agentId, agentId),
          eq(deliveries.status, 'queued'),
          eq(channels.paused, false),
          this.liveChannel(),
        ),
      )
      .orderBy(asc(channels.createdAt), asc(messages.seq))
      .all();
    if (!rows.length) return undefined;
    const byChannel = new Map<string, { channel: ChannelRecord; rows: typeof rows }>();
    for (const row of rows) {
      const entry = byChannel.get(row.channel.id) ?? { channel: row.channel, rows: [] };
      entry.rows.push(row);
      byChannel.set(row.channel.id, entry);
    }
    const included: MessageRef[] = [];
    const skipped: MessageRef[] = [];
    const claims: { channel: ChannelRecord; refs: MessageRef[]; skipped: number }[] = [];
    for (const { channel, rows: unread } of byChannel.values()) {
      const refs: MessageRef[] = [];
      let skippedHere = 0;
      unread.forEach(({ message }, index) => {
        const addressed =
          channel.kind === 'private'
            ? message.sender === 'user'
            : (JSON.parse(message.mentions) as string[]).includes(agentId);
        if (addressed || index >= unread.length - RECENT_PER_CHANNEL) refs.push(message);
        else {
          skipped.push(message);
          skippedHere++;
        }
      });
      included.push(...refs);
      claims.push({ channel, refs, skipped: skippedHere });
    }
    return { rows, included, skipped, claims };
  }
  private markClaim(
    agentId: string,
    refs: MessageRef[],
    set: Partial<typeof deliveries.$inferInsert>,
  ) {
    if (refs.length)
      this.db
        .update(deliveries)
        .set({ ...set, updatedAt: now() })
        .where(
          and(eq(deliveries.agentId, agentId), eq(deliveries.status, 'queued'), deliveryRefs(refs)),
        )
        .run();
  }
  private claimedInput(
    selection: NonNullable<ReturnType<Store['selectQueued']>>,
  ): ClaimedChannel[] {
    const messagesByKey = new Map(
      this.withDeliveries(selection.rows.map((r) => r.message)).map((m) => [messageKey(m), m]),
    );
    return selection.claims.map((claim) => ({
      channel: claim.channel,
      messages: claim.refs.map((m) => messagesByKey.get(messageKey(m))!),
      skipped: claim.skipped,
    }));
  }
  /** Atomically claim one initial input using the same policy as in-turn steering. */
  startRun(agentId: string, threadId: string): { run: Run; input: ClaimedChannel[] } | undefined {
    return this.change(() => {
      const selection = this.selectQueued(agentId);
      if (!selection) return undefined;
      const id = randomUUID();
      this.db
        .insert(runs)
        .values({ id, agentId, threadId, status: 'starting', createdAt: now() })
        .run();
      this.markClaim(agentId, selection.included, { status: 'submitting', runId: id });
      this.markClaim(agentId, selection.skipped, { status: 'skipped' });
      this.event('run', { agentId }, { runId: id });
      for (const claim of selection.claims)
        this.event('delivery', { agentId, channelId: claim.channel.id }, { runId: id });
      return {
        run: this.getRun(id),
        input: this.claimedInput(selection),
      };
    });
  }
  findNativeRun(agentId: string, sessionId: string, turnId: string): Run | undefined {
    const row = this.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.agentId, agentId), eq(runs.threadId, sessionId), eq(runs.turnId, turnId)))
      .get();
    return row ? this.getRun(row.id) : undefined;
  }
  /** Record one native activity that began without a claimed Isles message. */
  observeRun(agentId: string, sessionId: string, turnId: string): Run {
    return this.change(() => {
      const existing = this.findNativeRun(agentId, sessionId, turnId);
      if (existing) return existing;
      const id = randomUUID();
      this.db
        .insert(runs)
        .values({
          id,
          agentId,
          threadId: sessionId,
          turnId,
          status: 'running',
          createdAt: now(),
        })
        .run();
      this.event('run', { agentId }, { runId: id });
      return this.getRun(id);
    });
  }
  claimSteer(
    agentId: string,
    runId: string,
    turnId: string,
  ): { id: string; input: ClaimedChannel[] } | undefined {
    return this.change(() => {
      const agent = this.getAgent(agentId);
      const run = this.db.select().from(runs).where(eq(runs.id, runId)).get();
      if (
        !agent.steerEnabled ||
        agent.desiredState !== 'running' ||
        agent.status !== 'running' ||
        !run ||
        run.agentId !== agentId ||
        run.turnId !== turnId ||
        run.finishedAt ||
        !['running', 'waiting'].includes(run.status)
      )
        return undefined;
      const selection = this.selectQueued(agentId);
      if (!selection) return undefined;
      const id = randomUUID();
      // Persist only addressing metadata, never a second copy of message bodies or credentials.
      const refs = (items: MessageRef[]) => items.map(({ channelId, seq }) => ({ channelId, seq }));
      this.db
        .insert(steerBatches)
        .values({
          id,
          agentId,
          runId,
          turnId,
          status: 'pending',
          included: JSON.stringify(refs(selection.included)),
          skipped: JSON.stringify(refs(selection.skipped)),
          createdAt: now(),
        })
        .run();
      this.markClaim(agentId, selection.included, {
        status: 'steering',
        runId,
        turnId,
        steerId: id,
      });
      this.markClaim(agentId, selection.skipped, { status: 'skipped', runId, turnId, steerId: id });
      for (const claim of selection.claims)
        this.event(
          'delivery',
          { agentId, channelId: claim.channel.id },
          { runId, steerId: id, status: 'steering' },
        );
      return { id, input: this.claimedInput(selection) };
    });
  }
  getSteer(id: string) {
    const row = this.db.select().from(steerBatches).where(eq(steerBatches.id, id)).get();
    if (!row) throw new HttpError(404, 'Steer 批次不存在');
    return {
      ...row,
      included: JSON.parse(row.included) as MessageRef[],
      skipped: JSON.parse(row.skipped) as MessageRef[],
    };
  }
  private settleSteer(
    id: string,
    status: 'accepted' | 'rejected' | 'uncertain',
    error: string | null,
    delivery: DeliveryStatus,
    acceptedRun?: { id: string; turnId: string },
  ) {
    const batch = this.getSteer(id);
    if (batch.status !== 'pending' && !(status === 'accepted' && batch.status === 'uncertain'))
      return;
    this.db
      .update(steerBatches)
      .set({ status, error, finishedAt: now() })
      .where(eq(steerBatches.id, id))
      .run();
    const restored = status === 'rejected';
    const changed = this.db
      .update(deliveries)
      .set({
        status: delivery,
        ...(acceptedRun ? { runId: acceptedRun.id, turnId: acceptedRun.turnId } : {}),
        ...(restored ? { runId: null, turnId: null, steerId: null } : {}),
        updatedAt: now(),
      })
      .where(
        and(
          eq(deliveries.steerId, id),
          inArray(
            deliveries.status,
            restored
              ? ['steering', 'skipped']
              : status === 'accepted'
                ? ['steering', 'uncertain', 'cancelled', 'failed']
                : ['steering'],
          ),
          status === 'accepted' ? deliveryRefs(batch.included) : undefined,
        ),
      )
      .returning({ channelId: deliveries.channelId })
      .all();
    for (const channelId of new Set(changed.map((d) => d.channelId)))
      this.event(
        'delivery',
        { agentId: batch.agentId, channelId },
        { runId: acceptedRun?.id ?? batch.runId, steerId: id, status: delivery },
      );
  }
  acceptSteer(id: string, acceptedTurnId: string, acceptedRunId?: string) {
    this.change(() => {
      const batch = this.getSteer(id);
      if (batch.status === 'accepted' || batch.status === 'rejected') return;
      const original = this.getRun(batch.runId);
      const accepted = acceptedRunId ? this.getRun(acceptedRunId) : original;
      if (
        accepted.agentId !== batch.agentId ||
        accepted.threadId !== original.threadId ||
        accepted.turnId !== acceptedTurnId ||
        (!acceptedRunId && batch.turnId !== acceptedTurnId)
      )
        throw new HttpError(409, 'Steer 确认的原生 turn 与执行不符');
      this.settleSteer(id, 'accepted', null, 'accepted', {
        id: accepted.id,
        turnId: acceptedTurnId,
      });
      if (accepted.id !== original.id) {
        this.event('run', { agentId: batch.agentId }, { runId: original.id });
        this.event('run', { agentId: batch.agentId }, { runId: accepted.id });
      }
    });
  }
  rejectSteer(id: string, error: string) {
    this.change(() => this.settleSteer(id, 'rejected', error, 'queued'));
  }
  uncertainSteer(id: string, error: string) {
    this.change(() => this.settleSteer(id, 'uncertain', error, 'uncertain'));
  }
  private settlePendingSteers(
    runId: string,
    delivery: 'cancelled' | 'uncertain',
    error: string | null,
  ) {
    const batches = this.db
      .select({ id: steerBatches.id })
      .from(steerBatches)
      .where(and(eq(steerBatches.runId, runId), eq(steerBatches.status, 'pending')))
      .all();
    for (const batch of batches) this.settleSteer(batch.id, 'uncertain', error, delivery);
  }
  acceptRun(runId: string, turnId: string) {
    this.change(() => {
      const run = this.getRun(runId);
      if (run.turnId && run.turnId !== turnId)
        throw new HttpError(409, '输入确认的原生 turn 与执行不符');
      this.db
        .update(runs)
        .set({
          turnId,
          ...(!run.finishedAt
            ? { status: run.status === 'waiting' ? ('waiting' as const) : ('running' as const) }
            : {}),
        })
        .where(eq(runs.id, runId))
        .run();
      const accepted = this.db
        .update(deliveries)
        .set({ turnId, status: 'accepted', updatedAt: now() })
        .where(
          and(
            eq(deliveries.runId, runId),
            isNull(deliveries.steerId),
            inArray(deliveries.status, ['submitting', 'uncertain', 'cancelled', 'failed']),
          ),
        )
        .returning({ channelId: deliveries.channelId })
        .all();
      for (const channelId of new Set(accepted.map((d) => d.channelId)))
        this.event('delivery', { agentId: run.agentId, channelId }, { runId, status: 'accepted' });
      this.event('run', { agentId: run.agentId }, { runId });
    });
  }
  finishRun(
    runId: string,
    status: RunStatus,
    delivery: 'failed' | 'cancelled' | 'uncertain',
    error: string | null = null,
  ) {
    this.change(() => {
      const run = this.getRun(runId);
      // Completion cannot acknowledge a pending steer. Stop/shutdown must settle it,
      // including when the native completion arrived before its submission ACK.
      if (status === 'interrupted' || status === 'uncertain')
        this.settlePendingSteers(runId, 'uncertain', error);
      if (run.finishedAt) return;
      this.db
        .update(runs)
        .set({ status, error, finishedAt: now() })
        .where(eq(runs.id, runId))
        .run();
      const finished = this.db
        .update(deliveries)
        .set({ status: delivery, updatedAt: now() })
        .where(and(eq(deliveries.runId, runId), eq(deliveries.status, 'submitting')))
        .returning({ channelId: deliveries.channelId })
        .all();
      this.db
        .update(questions)
        .set({ status: 'expired' })
        .where(and(eq(questions.runId, runId), eq(questions.status, 'pending')))
        .run();
      this.event('run', { agentId: run.agentId }, { runId, status });
      for (const channelId of new Set(finished.map((d) => d.channelId)))
        this.event('delivery', { agentId: run.agentId, channelId }, { runId, status: delivery });
      this.event('question', { agentId: run.agentId }, { runId });
    });
  }
  getRun(id: string): Run {
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get();
    if (!row) throw new HttpError(404, '执行不存在');
    const inputs: Run['inputs'] = [];
    for (const d of this.db
      .select({
        channelId: deliveries.channelId,
        seq: deliveries.seq,
        steerId: deliveries.steerId,
        included: steerBatches.included,
      })
      .from(deliveries)
      .innerJoin(messages, deliveryMessageJoin)
      .leftJoin(steerBatches, eq(steerBatches.id, deliveries.steerId))
      .where(eq(deliveries.runId, id))
      .orderBy(asc(messages.createdAt), asc(messages.seq))
      .all()) {
      if (
        d.steerId &&
        !(JSON.parse(d.included ?? '[]') as MessageRef[]).some(
          (ref) => messageKey(ref) === messageKey(d),
        )
      )
        continue;
      const group = inputs.find((i) => i.channelId === d.channelId);
      if (group) group.messageSeqs.push(d.seq);
      else inputs.push({ channelId: d.channelId, messageSeqs: [d.seq] });
    }
    const items = this.db
      .select({
        id: runItems.id,
        type: runItems.type,
        status: runItems.status,
        text: runItems.text,
      })
      .from(runItems)
      .where(eq(runItems.runId, id))
      .all();
    return { ...row, inputs, items };
  }
  /** Complete snapshots share one transaction and one execution notification. */
  updateItems(runId: string, items: RunItem[]) {
    if (!items.length) return;
    const run = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) throw new HttpError(404, '执行不存在');
    if (run.finishedAt) return;
    this.change(() => {
      for (const item of items) {
        const text = item.text.slice(-128_000);
        this.db
          .insert(runItems)
          .values({ ...item, text, key: `${runId}:${item.id}`, runId })
          .onConflictDoUpdate({ target: runItems.key, set: { ...item, text } })
          .run();
      }
      this.event('run', { agentId: run.agentId }, { runId });
    });
  }

  // Native questions

  createQuestion(
    agentId: string,
    runId: string,
    turnId: string,
    nativeRequestId: string | number,
    definition: QuestionDefinition[],
  ) {
    return this.change(() => {
      const id = randomUUID();
      this.db
        .insert(questions)
        .values({
          id,
          agentId,
          runId,
          turnId,
          nativeRequestId: JSON.stringify(nativeRequestId),
          definition: JSON.stringify(definition),
          status: 'pending',
          createdAt: now(),
        })
        .run();
      this.db.update(runs).set({ status: 'waiting' }).where(eq(runs.id, runId)).run();
      this.event('question', { agentId }, { questionId: id });
      return id;
    });
  }
  getQuestion(id: string) {
    const row = this.db.select().from(questions).where(eq(questions.id, id)).get();
    if (!row) throw new HttpError(404, '问题不存在');
    return { ...row, questions: JSON.parse(row.definition) as QuestionDefinition[] };
  }
  answerQuestion(id: string, answers: QuestionAnswer) {
    this.change(() => {
      const q = this.getQuestion(id);
      const saved = structuredClone(answers);
      for (const question of q.questions)
        if (question.isSecret) saved.answers[question.id] = { answers: ['[redacted]'] };
      this.db
        .update(questions)
        .set({ status: 'answered', answer: JSON.stringify(saved) })
        .where(eq(questions.id, id))
        .run();
      const pending = this.db
        .select()
        .from(questions)
        .where(and(eq(questions.runId, q.runId), eq(questions.status, 'pending')))
        .get();
      if (!pending)
        this.db
          .update(runs)
          .set({ status: 'running' })
          .where(and(eq(runs.id, q.runId), eq(runs.status, 'waiting'), isNull(runs.finishedAt)))
          .run();
      this.event('question', { agentId: q.agentId }, { questionId: id });
    });
  }
  /** A native phase can release an interaction while its public execution continues. */
  expireQuestion(id: string) {
    const question = this.getQuestion(id);
    if (question.status !== 'pending') return;
    this.change(() => {
      this.db.update(questions).set({ status: 'expired' }).where(eq(questions.id, id)).run();
      const pending = this.db
        .select({ id: questions.id })
        .from(questions)
        .where(and(eq(questions.runId, question.runId), eq(questions.status, 'pending')))
        .limit(1)
        .get();
      if (!pending) {
        const changed = this.db
          .update(runs)
          .set({ status: 'running' })
          .where(
            and(
              eq(runs.id, question.runId),
              eq(runs.status, 'waiting'),
              sql`${runs.finishedAt} is null`,
            ),
          )
          .returning({ id: runs.id })
          .get();
        if (changed) this.event('run', { agentId: question.agentId }, { runId: question.runId });
      }
      this.event('question', { agentId: question.agentId }, { questionId: id, status: 'expired' });
    });
  }
  private pendingQuestions(agentIds: string[]): UserQuestion[] {
    if (!agentIds.length) return [];
    return this.db
      .select({
        id: questions.id,
        agentId: questions.agentId,
        runId: questions.runId,
        status: questions.status,
        definition: questions.definition,
        createdAt: questions.createdAt,
      })
      .from(questions)
      .where(and(inArray(questions.agentId, agentIds), eq(questions.status, 'pending')))
      .orderBy(asc(questions.createdAt))
      .all()
      .map(({ definition, ...q }) => ({
        ...q,
        questions: JSON.parse(definition) as QuestionDefinition[],
      }));
  }

  // Snapshots

  agentDetail(id: string): AgentDetail {
    const agent = this.publicAgent(id);
    const history = this.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.agentId, id))
      .orderBy(desc(runs.createdAt))
      .limit(30)
      .all();
    return {
      agent,
      contextUsage: this.contextUsage(id),
      pendingMessageCount: this.pendingMessageCount(id),
      runs: history.map((r) => this.getRun(r.id)),
      questions: this.pendingQuestions([id]),
      cursor: this.cursor(),
    };
  }
  channelDetail(id: string): ChannelDetail {
    const channel = this.publicChannel(id);
    return {
      channel,
      messages: this.listMessages(id),
      questions: this.pendingQuestions(channel.memberIds),
      cursor: this.cursor(),
    };
  }
  recoverOnBoot() {
    // Pending ACKs also exist after a normal native completion. They must never fall
    // through the active-run query and become eligible for redelivery.
    const pendingSteers = this.db
      .select({ id: steerBatches.id })
      .from(steerBatches)
      .where(eq(steerBatches.status, 'pending'))
      .all();
    this.change(() => {
      for (const batch of pendingSteers)
        this.settleSteer(
          batch.id,
          'uncertain',
          '服务在 steer 确认持久化前退出，原生结果待核对；不会自动重投。',
          'uncertain',
        );
    });
    const active = this.db
      .select({ id: runs.id, agentId: runs.agentId })
      .from(runs)
      .where(inArray(runs.status, ['starting', 'running', 'waiting']))
      .all();
    for (const r of active) {
      if (this.getAgent(r.agentId).status === 'deleted') {
        this.finishRun(r.id, 'interrupted', 'cancelled');
        continue;
      }
      this.finishRun(
        r.id,
        'uncertain',
        'uncertain',
        '服务在执行结束前退出，原生结果待核对；不会自动重投。',
      );
    }
    // Retry each running Agent's connection once on boot; only queued input is scheduled.
    for (const agent of this.listAgents()) {
      if (agent.desiredState === 'stopped') this.updateAgent(agent.id, { status: 'stopped' });
      else this.updateAgent(agent.id, { status: 'recovering', error: null });
    }
  }
}
