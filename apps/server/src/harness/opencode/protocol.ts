import { z } from 'zod';

// OpenCode v2.0.25 native HTTP protocol, pinned to anomalyco/opencode b44eea9.
export const modelRefSchema = z.object({
  providerID: z.string().min(1),
  id: z.string().min(1),
  variant: z.string().min(1).optional(),
});
export type OpenCodeModelRef = z.infer<typeof modelRefSchema>;
export const sessionInfoSchema = z
  .object({
    id: z.string().startsWith('ses_'),
    location: z.object({ directory: z.string().min(1) }),
    model: modelRefSchema.optional(),
    outcome: z.enum(['succeeded', 'failed', 'interrupted']).optional(),
    time: z
      .object({
        created: z.number(),
        updated: z.number(),
        idle: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export const sessionResponseSchema = z.object({ data: sessionInfoSchema });
export const inboxItemSchema = z.object({
  id: z.string().startsWith('msg_'),
  sessionID: z.string().startsWith('ses_'),
  type: z.enum(['user', 'synthetic', 'compaction', 'move']),
  delivery: z.enum(['steer', 'queue']),
  payload: z.record(z.string(), z.unknown()),
  time: z.object({ created: z.number() }),
});
export const inboxResponseSchema = z.object({ data: inboxItemSchema });
export const inboxListSchema = z.object({ data: z.array(inboxItemSchema) });
export const eventEnvelopeSchema = z
  .object({
    id: z.string().startsWith('evt_'),
    type: z.string(),
    created: z.number(),
    location: z.object({ directory: z.string() }).optional(),
    durable: z
      .object({
        aggregateID: z.string(),
        seq: z.number().int().nonnegative(),
        version: z.number().int().positive(),
      })
      .optional(),
    data: z.record(z.string(), z.unknown()),
  })
  .passthrough();
export const durableEventSchema = eventEnvelopeSchema.extend({
  durable: z.object({
    aggregateID: z.string(),
    seq: z.number().int().nonnegative(),
    version: z.number().int().positive(),
  }),
});
export type OpenCodeEvent = z.infer<typeof eventEnvelopeSchema>;
export const modelInfoSchema = z
  .object({
    id: z.string().min(1),
    modelID: z.string().min(1),
    providerID: z.string().min(1),
    name: z.string(),
    enabled: z.boolean(),
    variants: z.array(z.object({ id: z.string().min(1) }).passthrough()),
    capabilities: z.object({
      tools: z.boolean(),
      input: z.array(z.string()),
      output: z.array(z.string()),
    }),
  })
  .passthrough();
export type OpenCodeModel = z.infer<typeof modelInfoSchema>;
export const modelsResponseSchema = z.object({ data: z.array(modelInfoSchema) });
export const defaultModelResponseSchema = z.object({ data: modelInfoSchema.optional() });
export const modelKey = (model: Pick<OpenCodeModelRef, 'providerID' | 'id'>) =>
  `${model.providerID}/${model.id}`;
export function modelRef(model: string, effort: string): OpenCodeModelRef {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1)
    throw new Error(`OpenCode 模型格式应为 provider/model：${model}`);
  return modelRefSchema.parse({
    providerID: model.slice(0, slash),
    id: model.slice(slash + 1),
    ...(effort === 'default' ? {} : { variant: effort }),
  });
}
export const formOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export const formFieldSchema = z
  .object({
    key: z.string(),
    type: z.enum(['string', 'number', 'integer', 'boolean', 'multiselect', 'external']),
    title: z.string().optional(),
    description: z.string().optional(),
    options: z.array(formOptionSchema).optional(),
    custom: z.boolean().optional(),
    required: z.boolean().optional(),
  })
  .passthrough();
export const formInfoSchema = z.object({
  id: z.string().startsWith('frm_'),
  sessionID: z.string(),
  title: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  fields: z.array(formFieldSchema).min(1),
});
export type OpenCodeForm = z.infer<typeof formInfoSchema>;

export const credentialsResponseSchema = z.object({
  data: z.array(z.object({ value: z.record(z.string(), z.unknown()) })),
});
