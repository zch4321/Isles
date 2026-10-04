import {
  agentDetailSchema,
  agentSchema,
  channelDetailSchema,
  channelSchema,
  harnessStatusSchema,
  harnessDescriptorSchema,
  codexConfigurationSchema,
  messagePageSchema,
  messageSchema,
  modelSchema,
  type CreateAgent,
  type CreateGroup,
  type QuestionAnswer,
  type SendMessage,
  type UpdateAgent,
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
    throw new Error('Isles 服务连接异常，请检查服务状态后重试');
  });
  // Proxies can answer with non-JSON bodies when the server is down.
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new Error(
      errorSchema.safeParse(body).data?.error ?? `服务请求失败（${response.status}）`,
    );
  return schema.parse(body);
}

export const fetchHarnesses = () =>
  api('/harnesses', z.object({ harnesses: z.array(harnessDescriptorSchema) }));
export const fetchHarnessStatus = (id: string, refresh = false) =>
  api(
    `/harnesses/${encodeURIComponent(id)}/status${refresh ? '?refresh=true' : ''}`,
    harnessStatusSchema,
  );
export const fetchCodexConfiguration = () => api('/codex/config', codexConfigurationSchema);
export const saveCodexConfiguration = (binaryPath: string | null) =>
  api('/codex/config', codexConfigurationSchema, { binaryPath }, 'PUT');
export const fetchModels = (id: string) =>
  api(`/harnesses/${encodeURIComponent(id)}/models`, z.object({ models: z.array(modelSchema) }));

export const fetchAgents = (includeDeleted = false) =>
  api(
    `/agents${includeDeleted ? '?includeDeleted=true' : ''}`,
    z.object({ agents: z.array(agentSchema), cursor: z.number() }),
  );
export const fetchAgentDetail = (id: string) => api(`/agents/${id}`, agentDetailSchema);
export const createAgent = (input: CreateAgent) => api('/agents', agentSchema, input);
export const updateAgent = (id: string, input: UpdateAgent) =>
  api(`/agents/${id}`, agentSchema, input, 'PATCH');
export const deleteAgent = (id: string) => api(`/agents/${id}`, agentSchema, undefined, 'DELETE');
export const controlAgent = (id: string, action: 'stop' | 'resume') =>
  api(`/agents/${id}/${action}`, agentSchema, {});
export const answerQuestion = (agentId: string, questionId: string, answer: QuestionAnswer) =>
  api(
    `/agents/${agentId}/questions/${questionId}/answer`,
    z.object({ status: z.literal('answered') }),
    answer,
  );

export const fetchChannels = (includeDeleted = false) =>
  api(
    `/channels${includeDeleted ? '?includeDeleted=true' : ''}`,
    z.object({ channels: z.array(channelSchema), cursor: z.number() }),
  );
export const fetchChannelDetail = (id: string) => api(`/channels/${id}`, channelDetailSchema);
export const createGroup = (input: CreateGroup) => api('/channels', channelSchema, input);
export const deleteGroup = (id: string) =>
  api(`/channels/${id}`, channelSchema, undefined, 'DELETE');
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
