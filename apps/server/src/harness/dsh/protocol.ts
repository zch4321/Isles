import { questionDefinitionSchema, runItemSchema } from '@isles/contracts';
import { z } from 'zod';

/** Isles native plugin wire; DSH owns model metadata, sessions, inboxes and execution. */
export const selectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
});
export const modelInfoSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  reasoning: z
    .object({
      efforts: z.array(z.object({ id: z.string().min(1), name: z.string() })),
      defaultEffort: z.string().optional(),
    })
    .optional(),
});
export const catalogSchema = z.object({
  models: z.array(modelInfoSchema),
  defaultSelection: selectionSchema.optional(),
});
export const contextUsageSchema = z.object({
  usedTokens: z.number().int().nonnegative(),
  maxTokens: z.number().int().positive().nullable(),
  estimated: z.boolean(),
});
export const sessionSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  contextUsage: contextUsageSchema.optional(),
});
export const rejectionSchema = z.object({ rejected: z.literal(true), reason: z.string().min(1) });
export const admissionSchema = z.object({
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
});
const turnId = z.string().min(1);
export const eventSchema = z.object({
  sessionId: z.string().min(1),
  event: z.discriminatedUnion('type', [
    z.object({ type: z.literal('context_usage'), usage: contextUsageSchema }),
    z.object({ type: z.literal('turn_started'), turnId }),
    z.object({
      type: z.literal('turn_completed'),
      turnId,
      status: z.enum(['completed', 'failed', 'interrupted']),
      error: z.string().nullable(),
    }),
    z.object({ type: z.literal('input_accepted'), turnId, messageId: z.string().min(1) }),
    z.object({
      type: z.literal('input_rejected'),
      messageId: z.string().min(1),
      reason: z.string(),
    }),
    z.object({ type: z.literal('item'), turnId, item: runItemSchema, append: z.boolean() }),
    z.object({ type: z.literal('item_delta'), turnId, item: runItemSchema, append: z.boolean() }),
  ]),
  eventId: z.string().optional(),
});
export const questionSchema = z.object({
  sessionId: z.string().min(1),
  turnId,
  requestId: z.union([z.string(), z.number()]),
  questions: z.array(questionDefinitionSchema).min(1),
});
export function modelSelection(model: string, effort: string) {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1)
    throw new Error(`DSH 模型格式应为 provider/model：${model}`);
  return selectionSchema.parse({
    provider: model.slice(0, slash),
    model: model.slice(slash + 1),
    ...(effort === 'default' ? {} : { reasoningEffort: effort }),
  });
}
