import {
  agentDetailSchema,
  agentSchema,
  channelDetailSchema,
  channelSchema,
  harnessStatusSchema,
  harnessDescriptorSchema,
  cliConfigurationSchema,
  messagePageSchema,
  messageSchema,
  modelSchema,
  workspaceSettingsSchema,
  type CreateAgent,
  type CreateAgents,
  type CreateGroup,
  type QuestionAnswer,
  type SendMessage,
  type UpdateAgent,
  type UpdateChannel,
} from '@isles/contracts';
import { z } from 'zod';

const errorSchema = z.object({ error: z.string() });

async function request(path: string, data?: unknown, method = data === undefined ? 'GET' : 'POST') {
  const response = await fetch(`/api${path}`, {
    method,
    ...(data === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  }).catch(() => {
    throw new Error('Isles 服务连接异常，请检查服务状态后重试');
  });
  if (!response.ok) {
    // Proxies can answer with non-JSON bodies when the server is down.
    const body: unknown = await response.json().catch(() => undefined);
    throw new Error(
      errorSchema.safeParse(body).data?.error ?? `服务请求失败（${response.status}）`,
    );
  }
  return response;
}

export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  data?: unknown,
  method = data === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await request(path, data, method);
  const body: unknown = await response.json().catch(() => undefined);
  return schema.parse(body);
}

/** Proxies may drop or rewrite the header; the download still gets a readable name. */
function attachmentName(disposition: string | null) {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;\s]+)/i)?.[1];
  try {
    if (encoded) return decodeURIComponent(encoded);
  } catch {
    // Malformed percent-encoding falls through to the default name.
  }
  return '聊天记录.md';
}

export async function downloadChat(channelId: string) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const response = await request(
    `/channels/${encodeURIComponent(channelId)}/export?timeZone=${encodeURIComponent(timeZone)}`,
  );
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = attachmentName(response.headers.get('Content-Disposition'));
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export const fetchHarnesses = () =>
  api('/harnesses', z.object({ harnesses: z.array(harnessDescriptorSchema) }));
export const fetchWorkspaceSettings = () => api('/workspaces', workspaceSettingsSchema);
export const saveWorkspaceSettings = (workspacePaths: string[]) =>
  api('/workspaces', workspaceSettingsSchema, { workspacePaths }, 'PUT');
export const fetchHarnessStatus = (id: string, refresh = false) =>
  api(
    `/harnesses/${encodeURIComponent(id)}/status${refresh ? '?refresh=true' : ''}`,
    harnessStatusSchema,
  );
export const fetchHarnessConfiguration = (id: string) =>
  api(`/harnesses/${encodeURIComponent(id)}/config`, cliConfigurationSchema);
export const saveHarnessConfiguration = (id: string, binaryPath: string | null) =>
  api(`/harnesses/${encodeURIComponent(id)}/config`, cliConfigurationSchema, { binaryPath }, 'PUT');
export const fetchModels = (id: string) =>
  api(`/harnesses/${encodeURIComponent(id)}/models`, z.object({ models: z.array(modelSchema) }));

export const fetchAgents = (includeDeleted = false) =>
  api(
    `/agents${includeDeleted ? '?includeDeleted=true' : ''}`,
    z.object({ agents: z.array(agentSchema), cursor: z.number() }),
  );
export const fetchAgentDetail = (id: string) => api(`/agents/${id}`, agentDetailSchema);
export const createAgent = (input: CreateAgent) => api('/agents', agentSchema, input);
export const createAgents = (input: CreateAgents) =>
  api('/agents/batch', z.object({ agents: z.array(agentSchema).min(1) }), input);
export const updateAgent = (id: string, input: UpdateAgent) =>
  api(`/agents/${id}`, agentSchema, input, 'PATCH');
export const deleteAgent = (id: string) => api(`/agents/${id}`, agentSchema, undefined, 'DELETE');
export const controlAgent = (id: string, action: 'stop' | 'resume') =>
  api(`/agents/${id}/${action}`, agentSchema, {});
export const newAgentSession = (id: string) => api(`/agents/${id}/new-session`, agentSchema, {});
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
export const updateChannel = (id: string, input: UpdateChannel) =>
  api(`/channels/${id}`, channelSchema, input, 'PATCH');
export const addMembers = (id: string, agentIds: string[]) =>
  api(`/channels/${id}/members`, channelSchema, { agentIds });
export const removeMember = (id: string, agentId: string) =>
  api(`/channels/${id}/members/${agentId}`, channelSchema, undefined, 'DELETE');
export const sendMessage = (channelId: string, input: SendMessage) =>
  api(`/channels/${channelId}/messages`, messageSchema, input);
export const fetchOlderMessages = (channelId: string, before: number) =>
  api(`/channels/${channelId}/messages?before=${before}&limit=100`, messagePageSchema);
