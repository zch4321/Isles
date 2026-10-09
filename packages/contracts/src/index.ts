import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('isles'),
  database: z.literal('ready'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const agentStatusSchema = z.enum([
  'creating',
  'recovering',
  'ready',
  'running',
  'stopped',
  'deleted',
  'error',
]);
export const deliveryStatusSchema = z.enum([
  'queued',
  'submitting',
  // Appending to the active native turn; awaiting its acceptance acknowledgment.
  'steering',
  'accepted',
  // Returned through an Agent's MCP inbox/history read; not a completed native turn.
  'received',
  'completed',
  'cancelled',
  'failed',
  'uncertain',
  // Unread when the Agent was woken but outside the merged input; readable through history only.
  'skipped',
]);
export const runStatusSchema = z.enum([
  'starting',
  'running',
  'waiting',
  'completed',
  'interrupted',
  'failed',
  'uncertain',
]);
export const harnessIdSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9-]*$/);
export const harnessCapabilitiesSchema = z.object({
  sessionResume: z.boolean(),
  interrupt: z.boolean(),
  steer: z.boolean(),
  userQuestions: z.boolean(),
  nativeSubagents: z.boolean(),
  mcp: z.boolean(),
  workspaceInstructions: z.boolean(),
});
export const harnessDescriptorSchema = z.object({
  id: harnessIdSchema,
  displayName: z.string(),
  configuration: z.enum(['cli-path']).nullable(),
  capabilities: harnessCapabilitiesSchema,
});
export const createAgentSchema = z
  .object({
    harness: harnessIdSchema,
    name: z.string().trim().min(1).max(80),
    model: z.string().min(1).max(120),
    reasoningEffort: z.string().min(1).max(24),
    canCreateGroups: z.boolean().default(false),
    steerEnabled: z.boolean().default(false),
  })
  .strict();
export const updateAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    model: z.string().trim().min(1).max(120).optional(),
    reasoningEffort: z.string().trim().min(1).max(24).optional(),
    canCreateGroups: z.boolean().optional(),
    steerEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '请至少修改一个字段' });
export const sendMessageSchema = z
  .object({
    body: z.string().trim().min(1).max(32_000),
    clientId: z.string().min(1).max(120),
    replyTo: z.number().int().positive().optional(),
    mentions: z.array(z.string().uuid()).max(50).optional(),
  })
  .strict();
export const createGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    memberIds: z.array(z.string().uuid()).max(50),
  })
  .strict();
export const updateChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    paused: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '请至少修改一个字段' });
export const addMembersSchema = z
  .object({ agentIds: z.array(z.string().uuid()).min(1).max(50) })
  .strict();

export const agentSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  harness: harnessIdSchema,
  model: z.string(),
  reasoningEffort: z.string(),
  /** The Agent's private chat with the user. */
  channelId: z.string().uuid(),
  workspace: z.string(),
  threadId: z.string().nullable(),
  canCreateGroups: z.boolean(),
  steerEnabled: z.boolean(),
  desiredState: z.enum(['running', 'stopped']),
  status: agentStatusSchema,
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const messageRefSchema = z.object({
  channelId: z.string().uuid(),
  seq: z.number().int().positive(),
});
export type MessageRef = z.infer<typeof messageRefSchema>;
/** A derived UI/map key, never a second stored message identifier. */
export const messageKey = (message: MessageRef) => `${message.channelId}:${message.seq}`;

export const messageSchema = z.object({
  channelId: z.string().uuid(),
  seq: z.number().int().positive(),
  sender: z.enum(['user', 'agent', 'system']),
  senderId: z.string(),
  body: z.string(),
  clientId: z.string(),
  replyTo: z.number().int().positive().nullable(),
  mentions: z.array(z.string()),
  createdAt: z.string(),
  deliveries: z.array(z.object({ agentId: z.string(), status: deliveryStatusSchema })),
});
export const channelSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['private', 'group']),
  /** Group name; null for private chats, which are named after their Agent. */
  name: z.string().nullable(),
  /** The Agent of a private chat. */
  agentId: z.string().nullable(),
  paused: z.boolean(),
  /** Terminal group deletion; retained history stays readable to the human. */
  deletedAt: z.string().nullable(),
  createdBy: z.string(),
  memberIds: z.array(z.string()),
  lastMessage: messageSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const runItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  text: z.string(),
});
export const runSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  threadId: z.string(),
  turnId: z.string().nullable(),
  status: runStatusSchema,
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  /** Messages submitted in this run, grouped as the Agent saw them. */
  inputs: z.array(
    z.object({ channelId: z.string(), messageSeqs: z.array(z.number().int().positive()) }),
  ),
  items: z.array(runItemSchema),
});
export const questionDefinitionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  multiSelect: z.boolean(),
  options: z.array(z.object({ label: z.string(), description: z.string() })).nullable(),
});
export const questionSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  runId: z.string().uuid(),
  status: z.enum(['pending', 'answered', 'expired']),
  questions: z.array(questionDefinitionSchema),
  createdAt: z.string(),
});
export const answerQuestionSchema = z
  .object({
    answers: z.record(
      z.string(),
      z.object({ answers: z.array(z.string().min(1).max(8_000)).min(1).max(10) }).strict(),
    ),
  })
  .strict();
export const contextUsageSchema = z.object({
  sessionId: z.string().min(1),
  usedTokens: z.number().int().nonnegative(),
  maxTokens: z.number().int().positive().nullable(),
  estimated: z.boolean(),
  updatedAt: z.string(),
});
export const agentDetailSchema = z.object({
  agent: agentSchema,
  contextUsage: contextUsageSchema.nullable(),
  pendingMessageCount: z.number().int().nonnegative(),
  runs: z.array(runSchema),
  questions: z.array(questionSchema),
  cursor: z.number().int(),
});
export const channelDetailSchema = z.object({
  channel: channelSchema,
  messages: z.array(messageSchema),
  /** Pending native questions from the channel's member Agents. */
  questions: z.array(questionSchema),
  cursor: z.number().int(),
});
export const messagePageSchema = z.object({
  messages: z.array(messageSchema),
  nextAfter: z.number().int().nullable(),
});
export const modelSchema = z.object({
  id: z.string(),
  model: z.string(),
  displayName: z.string(),
  description: z.string(),
  supportedReasoningEfforts: z.array(z.string()),
  defaultReasoningEffort: z.string(),
  isDefault: z.boolean(),
});
export const harnessStatusSchema = z.object({
  available: z.boolean(),
  authenticated: z.boolean(),
  version: z.string().nullable(),
  binaryPath: z.string().nullable(),
  error: z.string().nullable(),
});
export const cliConfigurationUpdateSchema = z
  .object({
    binaryPath: z.string().trim().min(1).max(32_768).nullable(),
  })
  .strict();
export const cliConfigurationSchema = cliConfigurationUpdateSchema.extend({
  environmentBinaryPath: z.string().nullable(),
  configFilePath: z.string(),
});
export const eventSchema = z.object({
  id: z.number().int(),
  type: z.enum(['agent', 'channel', 'group_deleted', 'message', 'delivery', 'run', 'question']),
  agentId: z.string().uuid().nullable(),
  channelId: z.string().uuid().nullable(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type Agent = z.infer<typeof agentSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type Channel = z.infer<typeof channelSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunItem = z.infer<typeof runItemSchema>;
export type UserQuestion = z.infer<typeof questionSchema>;
export type QuestionDefinition = z.infer<typeof questionDefinitionSchema>;
export type QuestionAnswer = z.infer<typeof answerQuestionSchema>;
export type AgentDetail = z.infer<typeof agentDetailSchema>;
export type ContextUsage = z.infer<typeof contextUsageSchema>;
export type ChannelDetail = z.infer<typeof channelDetailSchema>;
export type CreateAgent = z.input<typeof createAgentSchema>;
export type UpdateAgent = z.infer<typeof updateAgentSchema>;
export type CreateGroup = z.infer<typeof createGroupSchema>;
export type SendMessage = z.infer<typeof sendMessageSchema>;
export type Model = z.infer<typeof modelSchema>;
export type HarnessId = z.infer<typeof harnessIdSchema>;
export type HarnessCapabilities = z.infer<typeof harnessCapabilitiesSchema>;
export type HarnessDescriptor = z.infer<typeof harnessDescriptorSchema>;
export type HarnessStatus = z.infer<typeof harnessStatusSchema>;
export type IslesEvent = z.infer<typeof eventSchema>;
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
