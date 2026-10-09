// Deliberately small projection of Codex CLI 0.161.0 generated protocol.
// Regenerate for comparison: codex app-server generate-ts --out /tmp/isles-protocol
// Official wire format: https://learn.chatgpt.com/docs/app-server (JSONL, no jsonrpc header).
import { questionDefinitionSchema } from '@isles/contracts';
import { z } from 'zod';

export type RequestId = number | string;
export const rpcFrameSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).passthrough().optional(),
});
export const threadResponseSchema = z.object({
  thread: z.object({ id: z.string().min(1) }),
  instructionSources: z.array(z.string()).default([]),
});
export const turnResponseSchema = z.object({ turn: z.object({ id: z.string().min(1) }) });
export const turnSteerResponseSchema = z.object({ turnId: z.string().min(1) });
export const turnNotificationSchema = z.object({
  threadId: z.string(),
  turn: z.object({
    id: z.string(),
    status: z.string(),
    error: z.object({ message: z.string() }).passthrough().nullable().optional(),
  }),
});
export const tokenUsageNotificationSchema = z.object({
  threadId: z.string(),
  tokenUsage: z.object({
    // `total` accumulates billed usage; `last` describes the current model context.
    last: z.object({ totalTokens: z.number().int().nonnegative() }),
    modelContextWindow: z.number().int().positive().nullable(),
  }),
});
export const inputRequestSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  questions: z
    .array(questionDefinitionSchema.omit({ multiSelect: true }))
    .min(1)
    .max(3),
  isBlocking: z.boolean(),
});

export interface NativeHandlers {
  notification: (method: string, params: Record<string, unknown>) => void;
  request: (id: RequestId, method: string, params: Record<string, unknown>) => void;
  exit: (error: Error) => void;
}
export interface NativeClient {
  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
  respond(id: RequestId, result: unknown): void;
  reject(id: RequestId, message: string): void;
  close(): Promise<void>;
}
export class NativeRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}
