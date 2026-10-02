import type { Catalog } from '../src/codex/catalog.js';
import {
  NativeRpcError,
  type NativeClient,
  type NativeHandlers,
  type RequestId,
} from '../src/codex/protocol.js';
import type { ClientFactory } from '../src/runtime/runtime.js';
import type { AgentRecord } from '../src/storage/store.js';

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
    if (method === 'thread/start') return { thread: { id: this.threadId } } as T;
    if (method === 'thread/inject_items') return {} as T;
    if (method === 'thread/resume') {
      if (this.harness.failResume) throw new NativeRpcError('no rollout found for thread id');
      return { thread: { id: params.threadId } } as T;
    }
    if (method === 'turn/start') {
      if (this.harness.failTurn === 'reject') throw new NativeRpcError('input rejected');
      if (this.harness.failTurn === 'unknown') throw new Error('connection lost after write');
      this.turnId = `turn-${++this.harness.turns}`;
      const input = params.input as { text: string }[];
      this.harness.inputs.push({
        agentId: this.agent.id,
        envelope: JSON.parse(input[0]!.text) as Envelope,
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
      message_id: string;
      seq: number;
      sender: { type: string; id: string; name?: string };
      body: string;
      mentions_you: boolean;
    }[];
  }[];
}
export class MockHarness {
  clients: MockClient[] = [];
  turns = 0;
  inputs: { agentId: string; envelope: Envelope }[] = [];
  failResume = false;
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
