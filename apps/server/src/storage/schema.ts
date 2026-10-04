import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const agents = sqliteTable(
  'agents',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    harness: text().notNull(),
    model: text().notNull(),
    reasoningEffort: text('reasoning_effort').notNull(),
    workspace: text().notNull(),
    nativeHome: text('native_home').notNull(),
    threadId: text('thread_id'),
    threadCreationAttempted: integer('thread_creation_attempted', { mode: 'boolean' })
      .notNull()
      .default(false),
    canCreateGroups: integer('can_create_groups', { mode: 'boolean' }).notNull().default(false),
    steerEnabled: integer('steer_enabled', { mode: 'boolean' }).notNull().default(false),
    desiredState: text('desired_state', { enum: ['running', 'stopped'] })
      .notNull()
      .default('running'),
    status: text({
      enum: ['creating', 'recovering', 'ready', 'running', 'stopped', 'deleted', 'error'],
    }).notNull(),
    error: text(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('agents_thread').on(t.harness, t.nativeHome, t.threadId)],
);

export const channels = sqliteTable(
  'channels',
  {
    id: text().primaryKey(),
    kind: text({ enum: ['private', 'group'] }).notNull(),
    name: text(),
    // The Agent of a private chat; null for groups.
    agentId: text('agent_id').references(() => agents.id),
    paused: integer({ mode: 'boolean' }).notNull().default(false),
    nextMessageSeq: integer('next_message_seq').notNull().default(1),
    // 'user' or the ID of the Agent that created the group.
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('channels_private_agent').on(t.agentId),
    check(
      'channels_kind_shape',
      sql`(${t.kind} = 'private' and ${t.agentId} is not null and ${t.name} is null) or (${t.kind} = 'group' and ${t.agentId} is null and ${t.name} is not null)`,
    ),
  ],
);

// The user is implicitly a member of every channel.
export const channelMembers = sqliteTable(
  'channel_members',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    addedBy: text('added_by').notNull(),
    joinedAt: text('joined_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.agentId] }),
    index('channel_members_agent').on(t.agentId),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    seq: integer().notNull(),
    sender: text({ enum: ['user', 'agent', 'system'] }).notNull(),
    senderId: text('sender_id').notNull(),
    body: text().notNull(),
    clientId: text('client_id').notNull(),
    replyTo: integer('reply_to'),
    // JSON array of mentioned Agent IDs.
    mentions: text().notNull().default('[]'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.seq] }),
    check('messages_positive_seq', sql`${t.seq} > 0`),
    foreignKey({ columns: [t.channelId, t.replyTo], foreignColumns: [t.channelId, t.seq] }),
    uniqueIndex('messages_dedupe').on(t.channelId, t.sender, t.senderId, t.clientId),
  ],
);

// One row per message and receiving Agent; a queued row is that Agent's unread.
export const deliveries = sqliteTable(
  'deliveries',
  {
    seq: integer().notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    status: text({
      enum: [
        'queued',
        'submitting',
        'steering',
        'accepted',
        'received',
        'completed',
        'cancelled',
        'failed',
        'uncertain',
        'skipped',
      ],
    }).notNull(),
    runId: text('run_id'),
    turnId: text('turn_id'),
    steerId: text('steer_id').references(() => steerBatches.id),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.seq, t.agentId] }),
    foreignKey({
      columns: [t.channelId, t.seq],
      foreignColumns: [messages.channelId, messages.seq],
    }),
    index('deliveries_queue').on(t.agentId, t.status),
    index('deliveries_run').on(t.runId),
    index('deliveries_steer').on(t.steerId),
  ],
);

export const runs = sqliteTable(
  'runs',
  {
    id: text().primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id'),
    status: text({
      enum: ['starting', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'uncertain'],
    }).notNull(),
    error: text(),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('runs_agent').on(t.agentId, t.createdAt)],
);

export const runItems = sqliteTable('run_items', {
  key: text().primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id),
  id: text().notNull(),
  type: text().notNull(),
  status: text().notNull(),
  text: text().notNull(),
});

export const steerBatches = sqliteTable(
  'steer_batches',
  {
    id: text().primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    turnId: text('turn_id').notNull(),
    status: text({ enum: ['pending', 'accepted', 'rejected', 'uncertain'] }).notNull(),
    // Audit references survive a definite rejection and subsequent delivery attempts.
    included: text().notNull(),
    skipped: text().notNull(),
    error: text(),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('steer_batches_run').on(t.runId),
    index('steer_batches_pending').on(t.status, t.agentId),
  ],
);

export const questions = sqliteTable('questions', {
  id: text().primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id),
  nativeRequestId: text('native_request_id').notNull(),
  turnId: text('turn_id').notNull(),
  status: text({ enum: ['pending', 'answered', 'expired'] }).notNull(),
  definition: text().notNull(),
  answer: text(),
  createdAt: text('created_at').notNull(),
});

export const events = sqliteTable('events', {
  id: integer().primaryKey({ autoIncrement: true }),
  type: text({
    enum: ['agent', 'channel', 'group_deleted', 'message', 'delivery', 'run', 'question'],
  }).notNull(),
  agentId: text('agent_id').references(() => agents.id),
  channelId: text('channel_id').references(() => channels.id),
  data: text().notNull(),
  createdAt: text('created_at').notNull(),
});

export const schema = {
  agents,
  channels,
  channelMembers,
  messages,
  deliveries,
  runs,
  steerBatches,
  runItems,
  questions,
  events,
};
