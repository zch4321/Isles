import { z } from 'zod';

/** Agent Client Protocol v1 frames used by Isles. Unknown fields and variants pass through. */
export const ACP_PROTOCOL_VERSION = 1;
export type AcpRequestId = string | number;

export const rpcFrameSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const initializeResultSchema = z
  .object({
    protocolVersion: z.number(),
    agentCapabilities: z
      .object({
        loadSession: z.boolean().optional(),
        mcpCapabilities: z.object({ http: z.boolean().optional() }).passthrough().optional(),
        sessionCapabilities: z
          .object({
            resume: z.object({}).passthrough().nullish(),
            close: z.object({}).passthrough().nullish(),
            delete: z.object({}).passthrough().nullish(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    agentInfo: z.object({ version: z.string().optional() }).passthrough().nullish(),
  })
  .passthrough();
export type AcpInitializeResult = z.infer<typeof initializeResultSchema>;

const selectValueSchema = z
  .object({ value: z.string(), name: z.string(), description: z.string().nullish() })
  .passthrough();
export const configOptionSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    type: z.string(),
    category: z.string().nullish(),
    currentValue: z.unknown(),
    options: z
      .array(
        z.union([
          selectValueSchema,
          z.object({ group: z.string(), options: z.array(selectValueSchema) }).passthrough(),
        ]),
      )
      .optional(),
  })
  .passthrough();
export type AcpConfigOption = z.infer<typeof configOptionSchema>;

export const sessionStateSchema = z
  .object({
    configOptions: z.array(configOptionSchema).nullish(),
    modes: z
      .object({
        currentModeId: z.string(),
        availableModes: z.array(z.object({ id: z.string() }).passthrough()),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type AcpSessionState = z.infer<typeof sessionStateSchema>;
export const newSessionResultSchema = sessionStateSchema.extend({ sessionId: z.string().min(1) });
export const promptResultSchema = z.object({ stopReason: z.string() }).passthrough();

const contentBlockSchema = z.object({ type: z.string() }).passthrough();
export const toolCallContentSchema = z
  .object({
    type: z.string(),
    content: contentBlockSchema.optional(),
    path: z.string().optional(),
  })
  .passthrough();
export const toolCallSchema = z
  .object({
    toolCallId: z.string(),
    title: z.string().nullish(),
    kind: z.string().nullish(),
    status: z.string().nullish(),
    content: z.array(toolCallContentSchema).nullish(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
  })
  .passthrough();
export const sessionUpdateSchema = z
  .object({
    sessionId: z.string(),
    update: z.object({ sessionUpdate: z.string() }).passthrough(),
  })
  .passthrough();
export const chunkSchema = z.object({ content: contentBlockSchema }).passthrough();
export const usageUpdateSchema = z.object({
  sessionUpdate: z.literal('usage_update'),
  used: z.number().int().nonnegative(),
  size: z.number().int().positive(),
});
export const planSchema = z
  .object({
    entries: z.array(
      z.object({ content: z.string(), status: z.string().optional() }).passthrough(),
    ),
  })
  .passthrough();

export const permissionRequestSchema = z
  .object({
    sessionId: z.string(),
    toolCall: z.object({ toolCallId: z.string(), title: z.string().nullish() }).passthrough(),
    options: z.array(z.object({ optionId: z.string(), kind: z.string() }).passthrough()),
  })
  .passthrough();

const choiceSchema = z
  .object({ const: z.string(), title: z.string().optional(), description: z.string().optional() })
  .passthrough();
const fieldSchema = z
  .object({
    type: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    oneOf: z.array(choiceSchema).optional(),
    anyOf: z.array(choiceSchema).optional(),
    enum: z.array(z.string()).optional(),
    items: z
      .object({
        anyOf: z.array(choiceSchema).optional(),
        oneOf: z.array(choiceSchema).optional(),
        enum: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type AcpFormField = z.infer<typeof fieldSchema>;
export const elicitationRequestSchema = z
  .object({
    sessionId: z.string().optional(),
    mode: z.literal('form'),
    message: z.string(),
    requestedSchema: z.object({ properties: z.record(z.string(), fieldSchema) }).passthrough(),
  })
  .passthrough();

export type AcpSelectValue = z.infer<typeof selectValueSchema>;
/** Every selectable value of a select option, flattening option groups. */
export function selectValues(option: AcpConfigOption | undefined): AcpSelectValue[] {
  return (option?.options ?? []).flatMap((entry) =>
    'group' in entry && Array.isArray(entry.options)
      ? (entry.options as AcpSelectValue[])
      : [entry as AcpSelectValue],
  );
}
