import type { Agent, Channel, Message } from '@isles/contracts';
import type { ChannelRecord, ClaimedChannel } from '../storage/store.js';

export type Directory = ReadonlyMap<string, Pick<Agent, 'name' | 'harness' | 'model'>>;
export const directoryOf = (agents: Agent[]): Directory =>
  new Map(agents.map((agent) => [agent.id, agent]));
export const channelView = (channel: ChannelRecord | Channel) => ({
  channel_id: channel.id,
  kind: channel.kind,
  name: channel.name,
});

type Named = { id: string; name: string };
type NamedChannel = Pick<Channel, 'id' | 'kind' | 'name' | 'agentId'>;
const quote = (name: string) =>
  JSON.stringify(name).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const compactId = (id: string) => id.replaceAll('-', '');

/** Short IDs only disambiguate display names; tool addresses remain full UUIDs. */
function uniquePrefix(id: string, peers: string[]) {
  const value = compactId(id);
  let length = Math.min(8, value.length);
  while (
    length < value.length &&
    peers.some((other) => other !== id && compactId(other).startsWith(value.slice(0, length)))
  )
    length++;
  return value.slice(0, length);
}

function namedLabels(entries: Named[]) {
  const names = new Map(entries.map(({ id, name }) => [id, name]));
  const peers = new Map<string, string[]>();
  for (const [id, name] of names) peers.set(name, [...(peers.get(name) ?? []), id]);
  return new Map(
    [...names].map(([id, name]) => {
      const sameName = peers.get(name)!;
      return [id, `${quote(name)}${sameName.length > 1 ? `#${uniquePrefix(id, sameName)}` : ''}`];
    }),
  );
}

/** One fresh directory snapshot is shared by all headers and paging markers in a result. */
export class MessageLabels {
  private readonly agentLabels: Map<string, string>;
  private readonly groupLabels: Map<string, string>;
  constructor(
    private readonly recipientId: string,
    agents: Named[],
    channels: NamedChannel[],
  ) {
    this.agentLabels = namedLabels(agents);
    this.groupLabels = namedLabels(
      channels
        .filter((channel) => channel.kind === 'group')
        .map((channel) => ({
          id: channel.id,
          name: channel.name ?? '群聊',
        })),
    );
  }
  agent(id: string) {
    const label = this.agentLabels.get(id);
    if (label === undefined) throw new Error(`消息目录缺少 Agent: ${id}`);
    return label;
  }
  channel(channel: NamedChannel) {
    if (channel.kind === 'private' && channel.agentId === this.recipientId) return 'private';
    const label = this.groupLabels.get(channel.id);
    if (label === undefined) throw new Error(`消息目录缺少群聊: ${channel.id}`);
    return label;
  }
}

/** Only platform-generated headers begin with '['. Escape reserved body lines reversibly. */
export function escapeMessageBody(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (['[', '\\'].includes(line.trimStart()[0] ?? '') ? `\\${line}` : line))
    .join('\n');
}

export function formatChannelMessages(
  labels: MessageLabels,
  channel: ChannelRecord | Channel,
  messages: Message[],
  skipped = 0,
) {
  const label = labels.channel(channel);
  const blocks: string[] = [];
  if (skipped) blocks.push(`[channel: ${label}, skipped_unread: ${skipped}]`);
  for (const message of messages) {
    const sender =
      message.sender === 'agent' ? `agent:${labels.agent(message.senderId)}` : message.sender;
    const fields = [`channel: ${label}`, `seq: ${message.seq}`, `from: ${sender}`];
    if (message.replyTo !== null) fields.push(`reply_to: ${message.replyTo}`);
    if (message.mentions.length)
      fields.push(`mentions: ${message.mentions.map((id) => labels.agent(id)).join('|')}`);
    blocks.push(`[${fields.join(', ')}]\n${escapeMessageBody(message.body)}`);
  }
  return blocks.join('\n\n');
}

/** The same text representation is used for turn input and MCP inbox/history results. */
export function formatMessages(labels: MessageLabels, input: ClaimedChannel[]) {
  return input
    .map(({ channel, messages, skipped }) =>
      formatChannelMessages(labels, channel, messages, skipped),
    )
    .filter(Boolean)
    .join('\n\n');
}
