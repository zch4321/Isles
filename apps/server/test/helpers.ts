import { ConfigManager } from '@isles/config';
import type { HarnessCatalog } from '../src/harness/types.js';
import { CodexAdapter, type CodexClientFactory } from '../src/harness/codex/adapter.js';
import { NativeEnvironment } from '../src/harness/codex/environment.js';
import type { AgentWorkspace } from '../src/runtime/workspace.js';
import {
  NativeRpcError,
  type NativeClient,
  type NativeHandlers,
  type RequestId,
} from '../src/harness/codex/protocol.js';
import type { AgentRecord, Store } from '../src/storage/store.js';
import type { Agent, Channel } from '@isles/contracts';
import { join } from 'node:path';

/** A complete app config that never reads or writes the user's real Isles home. */
export const testConfig = (root: string, environment: NodeJS.ProcessEnv = {}) =>
  new ConfigManager({
    configFilePath: join(root, 'config.toml'),
    homeDir: root,
    environment: { ISLES_DATA_DIR: root, ...environment },
  });

export const testCatalog: HarnessCatalog = {
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
export const codexAdapters =
  (catalog: HarnessCatalog = testCatalog, factory?: CodexClientFactory) =>
  (workspace: AgentWorkspace, config: ConfigManager) => [
    new CodexAdapter(new NativeEnvironment(config, workspace), catalog, factory),
  ];
export class MockClient implements NativeClient {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  responses: { id: RequestId; result: unknown }[] = [];
  rejections: RequestId[] = [];
  closed = false;
  turnId = '';
  threadId: string;
  private pendingSteers = new Set<(error: Error) => void>();
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
        envelope: parseMessageText(
          input[0]!.text,
          this.agent.channelId,
          this.agent.id,
          this.harness.directory(),
        ),
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
    if (method === 'turn/steer') {
      if (this.harness.failSteer === 'reject') throw new NativeRpcError('steer rejected', -32600);
      if (this.harness.failSteer === 'unknown') throw new Error('steer connection result unknown');
      if (params.expectedTurnId !== this.turnId)
        throw new NativeRpcError('different expected turn', -32600);
      this.harness.steers.push({
        agentId: this.agent.id,
        turnId: this.turnId,
        batchId: params.clientUserMessageId as string,
        envelope: parseMessageText(
          (params.input as { text: string }[])[0]!.text,
          this.agent.channelId,
          this.agent.id,
          this.harness.directory(),
        ),
      });
      let rejectClosed: (error: Error) => void = () => {};
      const closed = new Promise<never>((_resolve, reject) => {
        rejectClosed = reject;
        this.pendingSteers.add(rejectClosed);
      });
      try {
        await Promise.race([Promise.resolve(this.harness.onSteer?.(this, params)), closed]);
        return { turnId: this.turnId } as T;
      } finally {
        this.pendingSteers.delete(rejectClosed);
      }
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
    for (const reject of this.pendingSteers) reject(new Error('native connection closed'));
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
  private store: Store | undefined;
  useStore(store: Store) {
    this.store = store;
  }
  directory(): MessageDirectory {
    if (!this.store) throw new Error('Bind the fixture Store before delivering native input');
    return { agents: this.store.listAgents(true), channels: this.store.listChannels() };
  }
  clients: MockClient[] = [];
  persistedThreads = new Set<string>();
  turns = 0;
  inputs: { agentId: string; envelope: Envelope }[] = [];
  steers: { agentId: string; turnId: string; batchId: string; envelope: Envelope }[] = [];
  failResume = false;
  missingGuidance = false;
  failTurn: 'reject' | 'unknown' | undefined;
  failSteer: 'reject' | 'unknown' | undefined;
  onTurn: ((client: MockClient, params: Record<string, unknown>) => void) | undefined;
  onSteer:
    ((client: MockClient, params: Record<string, unknown>) => void | Promise<void>) | undefined;
  factory: CodexClientFactory = async (agent, handlers, baseUrl) => {
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

export interface MessageDirectory {
  agents: Pick<Agent, 'id' | 'name'>[];
  channels: Pick<Channel, 'id' | 'kind' | 'name' | 'agentId' | 'memberIds'>[];
}

/** Split separators only outside JSON string literals, including escaped quotes. */
function splitFields(text: string, delimiter: string): string[] {
  const fields: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted && escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && text.startsWith(delimiter, index)) {
      fields.push(text.slice(start, index));
      start = index + delimiter.length;
      index += delimiter.length - 1;
    }
  }
  if (quoted || escaped) throw new Error('Unterminated JSON name in message header');
  fields.push(text.slice(start));
  return fields;
}

/** Independent fixture lookup: reject bare UUIDs and stale/ambiguous name labels. */
function resolveLabel(label: string, directory: { id: string; name: string | null }[]) {
  const match = /^("(?:[^"\\]|\\.)*")(?:#([0-9a-f]{8,32}))?$/.exec(label);
  if (!match) throw new Error(`Invalid name label: ${label}`);
  const name = JSON.parse(match[1]!) as string;
  const candidates = directory.filter((entry) => entry.name === name);
  if (candidates.length === 1 && match[2] === undefined) return candidates[0]!;
  if (candidates.length < 2 || !match[2]) throw new Error(`Ambiguous name label: ${label}`);
  const prefix = match[2];
  const matched = candidates.filter((entry) => entry.id.replaceAll('-', '').startsWith(prefix));
  if (matched.length !== 1) throw new Error(`Ambiguous ID suffix: ${label}`);
  // The suffix is minimal, but never shorter than eight hexadecimal characters.
  if (
    prefix.length > 8 &&
    candidates.filter((entry) => entry.id.replaceAll('-', '').startsWith(prefix.slice(0, -1)))
      .length === 1
  )
    throw new Error(`Nonminimal ID suffix: ${label}`);
  return matched[0]!;
}

/** Test-only reader for the current name grammar; production never parses body metadata. */
export function parseMessageText(
  text: string,
  privateChannelId: string,
  recipientId: string,
  directory: MessageDirectory,
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
        splitFields(line.slice(1, -1), ', ').map((field) => {
          const colon = field.indexOf(': ');
          return [field.slice(0, colon), field.slice(colon + 2)];
        }),
      );
      if (fields.has_more) result.has_more = fields.has_more === 'true';
      if (!fields.channel) continue;
      const available = directory.channels.filter(
        (channel) => channel.kind === 'group' && channel.memberIds.includes(recipientId),
      );
      const resolved =
        fields.channel === 'private' ? undefined : resolveLabel(fields.channel!, available);
      const id = resolved?.id ?? privateChannelId;
      const channel = channels.get(id) ?? {
        channel_id: id,
        kind: fields.channel === 'private' ? 'private' : 'group',
        name: resolved?.name ?? null,
        skipped_unread: 0,
        messages: [],
      };
      channels.set(id, channel);
      if (fields.skipped_unread) channel.skipped_unread = Number(fields.skipped_unread);
      if (fields.next_after) result.nextAfter = Number(fields.next_after);
      if (fields.next_before) result.nextBefore = Number(fields.next_before);
      if (!fields.seq) continue;
      const sender = fields.from!;
      const author = sender.startsWith('agent:')
        ? resolveLabel(sender.slice(6), directory.agents)
        : undefined;
      const mentions = fields.mentions
        ? splitFields(fields.mentions, '|').map((label) => resolveLabel(label, directory.agents).id)
        : [];
      current = {
        seq: Number(fields.seq),
        sender: author
          ? { type: 'agent', id: author.id, name: author.name! }
          : { type: sender, id: sender },
        body: '',
        mentions_you: mentions.includes(recipientId),
      };
      channel.messages.push(current);
    } else if (current)
      current.body += `${current.body ? '\n' : ''}${line.startsWith('\\') ? line.slice(1) : line}`;
  }
  if (current) current.body = current.body.replace(/\n+$/, '');
  result.channels = [...channels.values()];
  return result;
}
