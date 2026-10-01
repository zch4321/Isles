import {
  agentDetailSchema,
  agentSchema,
  channelDetailSchema,
  channelSchema,
  codexStatusSchema,
  messagePageSchema,
  messageSchema,
  modelSchema,
  type CreateAgent,
  type CreateGroup,
  type QuestionAnswer,
  type SendMessage,
} from '@isles/contracts';
import { z } from 'zod';

const errorSchema = z.object({ error: z.string() });

export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  data?: unknown,
  method = data === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    ...(data === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  }).catch(() => {
    throw new Error('无法连接 Isles 服务');
  });
  // Proxies can answer with non-JSON bodies when the server is down.
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new Error(
      errorSchema.safeParse(body).data?.error ?? `服务请求失败（${response.status}）`,
    );
  return schema.parse(body);
}

export const fetchCodex = () => api('/codex/status', codexStatusSchema);
export const fetchModels = () => api('/codex/models', z.object({ models: z.array(modelSchema) }));

export const fetchAgents = () =>
  api('/agents', z.object({ agents: z.array(agentSchema), cursor: z.number() }));
export const fetchAgentDetail = (id: string) => api(`/agents/${id}`, agentDetailSchema);
export const createAgent = (input: CreateAgent) => api('/agents', agentSchema, input);
export const updateAgent = (id: string, input: { canCreateGroups: boolean }) =>
  api(`/agents/${id}`, agentSchema, input, 'PATCH');
export const controlAgent = (id: string, action: 'stop' | 'resume') =>
  api(`/agents/${id}/${action}`, agentSchema, {});
export const answerQuestion = (agentId: string, questionId: string, answer: QuestionAnswer) =>
  api(
    `/agents/${agentId}/questions/${questionId}/answer`,
    z.object({ status: z.literal('answered') }),
    answer,
  );

export const fetchChannels = () =>
  api('/channels', z.object({ channels: z.array(channelSchema), cursor: z.number() }));
export const fetchChannelDetail = (id: string) => api(`/channels/${id}`, channelDetailSchema);
export const createGroup = (input: CreateGroup) => api('/channels', channelSchema, input);
export const updateChannel = (id: string, input: { name?: string; paused?: boolean }) =>
  api(`/channels/${id}`, channelSchema, input, 'PATCH');
export const addMembers = (id: string, agentIds: string[]) =>
  api(`/channels/${id}/members`, channelSchema, { agentIds });
export const removeMember = (id: string, agentId: string) =>
  api(`/channels/${id}/members/${agentId}`, channelSchema, undefined, 'DELETE');
export const sendMessage = (channelId: string, input: SendMessage) =>
  api(`/channels/${channelId}/messages`, messageSchema, input);
export const fetchOlderMessages = (channelId: string, before: number) =>
  api(`/channels/${channelId}/messages?before=${before}&limit=100`, messagePageSchema);
