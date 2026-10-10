import { z } from 'zod';

export const kimiSessionSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    metadata: z.object({ cwd: z.string().min(1) }).passthrough(),
  })
  .passthrough();

export const kimiPromptSchema = z
  .object({
    prompt_id: z.string().min(1),
    status: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export const kimiPromptsSchema = z.object({
  active: kimiPromptSchema.nullable(),
  queued: z.array(kimiPromptSchema),
});
export const kimiSnapshotSchema = z
  .object({
    as_of_seq: z.number().int().nonnegative(),
    epoch: z.string().min(1),
    session: kimiSessionSchema.extend({
      usage: z
        .object({
          context_tokens: z.number().int().nonnegative(),
          context_limit: z.number().int().nonnegative().optional(),
        })
        .passthrough(),
    }),
    in_flight_turn: z.unknown().nullable(),
  })
  .passthrough();
export const kimiStatusSchema = z
  .object({
    busy: z.boolean(),
    model: z.string().optional(),
    context_tokens: z.number().int().nonnegative(),
    max_context_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const kimiEventSchema = z
  .object({
    type: z.string(),
    seq: z.number().int().nonnegative(),
    epoch: z.string().optional(),
    session_id: z.string().optional(),
    volatile: z.boolean().optional(),
    offset: z.number().int().nonnegative().optional(),
    payload: z
      .object({
        agentId: z.string().optional(),
        sessionId: z.string().optional(),
        turnId: z.number().int().nonnegative().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type KimiWebEvent = z.infer<typeof kimiEventSchema>;

export const kimiQuestionSchema = z
  .object({
    question_id: z.string().min(1),
    agent_id: z.string().optional(),
    turn_id: z.number().int().nonnegative().optional(),
    questions: z
      .array(
        z.object({
          id: z.string().min(1),
          question: z.string(),
          header: z.string().optional(),
          body: z.string().optional(),
          multi_select: z.boolean().optional(),
          allow_other: z.boolean().optional(),
          options: z.array(
            z.object({
              id: z.string().min(1),
              label: z.string(),
              description: z.string().optional(),
            }),
          ),
        }),
      )
      .min(1),
  })
  .passthrough();
export type KimiWebQuestion = z.infer<typeof kimiQuestionSchema>;

export const kimiApprovalSchema = z
  .object({
    approval_id: z.string().min(1),
    tool_name: z.string(),
    action: z.string(),
    tool_input_display: z.unknown(),
  })
  .passthrough();

export const kimiModelsSchema = z.object({
  items: z.array(
    z
      .object({
        model: z.string(),
        max_context_size: z.number().int().nonnegative(),
      })
      .passthrough(),
  ),
});

export function kimiText(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
}
