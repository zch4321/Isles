import { sql } from 'drizzle-orm';
import {
  check,
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
    harness: text().notNull().default('codex'),
    model: text().notNull(),
    reasoningEffort: text('reasoning_effort').notNull(),
    workspace: text().notNull(),
    nativeHome: text('native_home').notNull(),
    threadId: text('thread_id'),
    threadCreationAttempted: integer('thread_creation_attempted', { mode: 'boolean' })
      .notNull()
      .default(false),
    canCreateGroups: integer('can_create_groups', { mode: 'boolean' }).notNull().default(false),
    desiredState: text('desired_state', { enum: ['running', 'stopped'] })
      .notNull()
      .default('running'),
    status: text({
      enum: ['creating', 'recovering', 'ready', 'running', 'stopped', 'error'],
    }).notNull(),
    error: text(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('agents_thread').on(t.threadId),
    check('agents_codex', sql`${t.harness} = 'codex'`),
  ],
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
    id: text().primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    seq: integer().notNull(),
    sender: text({ enum: ['user', 'agent', 'system'] }).notNull(),
    senderId: text('sender_id').notNull(),
    body: text().notNull(),
    clientId: text('client_id').notNull(),
    replyTo: text('reply_to'),
    // JSON array of mentioned Agent IDs.
    mentions: text().notNull().default('[]'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('messages_sequence').on(t.channelId, t.seq),
    uniqueIndex('messages_dedupe').on(t.channelId, t.sender, t.senderId, t.clientId),
  ],
);

// One row per message and receiving Agent; a queued row is that Agent's unread.
export const deliveries = sqliteTable(
  'deliveries',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id),
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
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.agentId] }),
    index('deliveries_queue').on(t.agentId, t.status),
    index('deliveries_run').on(t.runId),
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
  type: text({ enum: ['agent', 'channel', 'message', 'delivery', 'run', 'question'] }).notNull(),
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
  runItems,
  questions,
  events,
};
