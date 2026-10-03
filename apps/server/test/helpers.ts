import { ConfigManager } from '@isles/config';
import type { Catalog } from '../src/codex/catalog.js';
import {
  NativeRpcError,
  type NativeClient,
  type NativeHandlers,
  type RequestId,
} from '../src/codex/protocol.js';
import type { ClientFactory } from '../src/runtime/runtime.js';
import type { AgentRecord } from '../src/storage/store.js';
import { join } from 'node:path';

/** A complete app config that never reads or writes the user's real Isles home. */
export const testConfig = (root: string, environment: NodeJS.ProcessEnv = {}) =>
  new ConfigManager({
    configFilePath: join(root, 'config.toml'),
    homeDir: root,
    environment: { ISLES_DATA_DIR: root, ...environment },
  });

export const testCatalog: Catalog = {
  status: async () => ({
    available: true,
    authenticated: true,
    binaryPath: null,
    version: 'mock-codex',
    error: null,
  }),
  models: async () => [
    {
      id: 'test-model',
      model: 'test-model',
      displayName: '测试模型',
      description: '模拟原生 adapter，仅用于测试',
      supportedReasoningEfforts: ['high', 'max'],
      defaultReasoningEffort: 'high',
      isDefault: true,
    },
  ],
};
export class MockClient implements NativeClient {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  responses: { id: RequestId; result: unknown }[] = [];
  rejections: RequestId[] = [];
  closed = false;
  turnId = '';
  threadId: string;
  constructor(
    readonly agent: AgentRecord,
    readonly handlers: NativeHandlers,
    private harness: MockHarness,
    readonly baseUrl: string,
  ) {
    this.threadId = agent.threadId ?? `native-${agent.id}`;
  }
  async request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'thread/start')
      return {
        thread: { id: this.threadId },
        instructionSources: this.harness.missingGuidance
          ? []
          : [join(this.agent.workspace, 'AGENTS.md')],
      } as T;
    if (method === 'thread/inject_items') {
      this.harness.persistedThreads.add(this.threadId);
      return {} as T;
    }
    if (method === 'thread/resume') {
      if (this.harness.failResume || !this.harness.persistedThreads.has(this.threadId))
        throw new NativeRpcError('no rollout found for thread id');
      return {
        thread: { id: params.threadId },
        instructionSources: this.harness.missingGuidance
          ? []
          : [join(this.agent.workspace, 'AGENTS.md')],
      } as T;
    }
    if (method === 'turn/start') {
      if (this.harness.failTurn === 'reject') throw new NativeRpcError('input rejected');
      if (this.harness.failTurn === 'unknown') throw new Error('connection lost after write');
      this.turnId = `turn-${++this.harness.turns}`;
      const input = params.input as { text: string }[];
      this.harness.inputs.push({
        agentId: this.agent.id,
        envelope: parseMessageText(input[0]!.text, this.agent.channelId, this.agent.id),
      });
      this.handlers.notification('turn/started', {
        threadId: this.threadId,
        turn: { id: this.turnId, status: 'inProgress', error: null },
      });
      this.harness.onTurn?.(this, params);
      return { turn: { id: this.turnId } } as T;
    }
    if (method === 'turn/interrupt') {
      this.complete('interrupted');
      return {} as T;
    }
    throw new Error(`Unexpected mock request ${method}`);
  }
  complete(status = 'completed') {
    this.handlers.notification('item/completed', {
      threadId: this.threadId,
      turnId: this.turnId,
      item: { id: this.turnId, type: 'agentMessage', text: '原生详情，不是正式回复' },
    });
    this.handlers.notification('turn/completed', {
      threadId: this.threadId,
      turn: { id: this.turnId, status, error: null },
    });
  }
  question(requestId: RequestId = 700, thread?: { threadId: string; turnId: string }) {
    this.handlers.request(requestId, 'item/tool/requestUserInput', {
      threadId: thread?.threadId ?? this.threadId,
      turnId: thread?.turnId ?? this.turnId,
      itemId: 'question-item',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: 'choice',
          header: '选择',
          question: '请选择下一步',
          isOther: false,
          isSecret: false,
          options: [
            { label: '继续', description: '继续执行' },
            { label: '结束', description: '结束当前工作' },
          ],
        },
      ],
    });
  }
  respond(id: RequestId, result: unknown) {
    this.responses.push({ id, result });
  }
  reject(id: RequestId) {
    this.rejections.push(id);
  }
  async close() {
    this.closed = true;
  }
}
export interface Envelope {
  type: string;
  channels: {
    channel_id: string;
    kind: 'private' | 'group';
    name: string | null;
    skipped_unread: number;
    messages: {
      seq: number;
      sender: { type: string; id: string; name?: string };
      body: string;
      mentions_you: boolean;
    }[];
  }[];
}
export class MockHarness {
  clients: MockClient[] = [];
  persistedThreads = new Set<string>();
  turns = 0;
  inputs: { agentId: string; envelope: Envelope }[] = [];
  failResume = false;
  missingGuidance = false;
  failTurn: 'reject' | 'unknown' | undefined;
  onTurn: ((client: MockClient, params: Record<string, unknown>) => void) | undefined;
  factory: ClientFactory = async (agent, handlers, baseUrl) => {
    const client = new MockClient(agent, handlers, this, baseUrl);
    this.clients.push(client);
    return client;
  };
  latest(id: string) {
    return this.clients.filter((c) => c.agent.id === id).at(-1)!;
  }
  /** Bodies each turn of this Agent received, flattened across channels. */
  bodies(id: string) {
    return this.inputs
      .filter((i) => i.agentId === id)
      .map((i) => i.envelope.channels.flatMap((c) => c.messages.map((m) => m.body)));
  }
}

/** Test-only reader for the documented text grammar; production never parses body text as metadata. */
export function parseMessageText(
  text: string,
  privateChannelId = 'private',
  recipientId = '',
): Envelope & { has_more: boolean; nextAfter: number | null; nextBefore: number | null } {
  const channels = new Map<string, Envelope['channels'][number]>();
  let current: Envelope['channels'][number]['messages'][number] | undefined;
  const result = {
    type: 'isles.messages',
    channels: [] as Envelope['channels'],
    has_more: false,
    nextAfter: null as number | null,
    nextBefore: null as number | null,
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('[') && line.endsWith(']')) {
      if (current) current.body = current.body.replace(/\n+$/, '');
      current = undefined;
      const fields = Object.fromEntries(
        line
          .slice(1, -1)
          .split(', ')
          .map((field) => {
            const colon = field.indexOf(': ');
            return [field.slice(0, colon), field.slice(colon + 2)];
          }),
      );
      if (fields.has_more) result.has_more = fields.has_more === 'true';
      if (!fields.channel) continue;
      const id = fields.channel === 'private' ? privateChannelId : fields.channel;
      const channel = channels.get(id) ?? {
        channel_id: id,
        kind: fields.channel === 'private' ? 'private' : 'group',
        name: null,
        skipped_unread: 0,
        messages: [],
      };
      channels.set(id, channel);
      if (fields.skipped_unread) channel.skipped_unread = Number(fields.skipped_unread);
      if (fields.next_after) result.nextAfter = Number(fields.next_after);
      if (fields.next_before) result.nextBefore = Number(fields.next_before);
      if (!fields.seq) continue;
      const sender = fields.from!;
      current = {
        seq: Number(fields.seq),
        sender: sender.startsWith('agent:')
          ? { type: 'agent', id: sender.slice(6) }
          : { type: sender, id: sender },
        body: '',
        mentions_you: (fields.mentions ?? '').split('|').includes(recipientId),
      };
      channel.messages.push(current);
    } else if (current)
      current.body += `${current.body ? '\n' : ''}${line.startsWith('\\') ? line.slice(1) : line}`;
  }
  if (current) current.body = current.body.replace(/\n+$/, '');
  result.channels = [...channels.values()];
  return result;
}
