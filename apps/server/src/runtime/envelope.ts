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
export const channelLabel = (recipientId: string, channel: ChannelRecord | Channel) =>
  channel.kind === 'private' && channel.agentId === recipientId ? 'private' : channel.id;

/** Only platform-generated headers begin with '['. Escape reserved body lines reversibly. */
export function escapeMessageBody(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (['[', '\\'].includes(line.trimStart()[0] ?? '') ? `\\${line}` : line))
    .join('\n');
}

export function formatChannelMessages(
  recipientId: string,
  channel: ChannelRecord | Channel,
  messages: Message[],
  skipped = 0,
) {
  const label = channelLabel(recipientId, channel);
  const blocks: string[] = [];
  if (skipped) blocks.push(`[channel: ${label}, skipped_unread: ${skipped}]`);
  for (const message of messages) {
    const sender = message.sender === 'agent' ? `agent:${message.senderId}` : message.sender;
    const fields = [`channel: ${label}`, `seq: ${message.seq}`, `from: ${sender}`];
    if (message.replyTo !== null) fields.push(`reply_to: ${message.replyTo}`);
    if (message.mentions.length) fields.push(`mentions: ${message.mentions.join('|')}`);
    blocks.push(`[${fields.join(', ')}]\n${escapeMessageBody(message.body)}`);
  }
  return blocks.join('\n\n');
}

/** The same text representation is used for turn input and MCP inbox/history results. */
export function formatMessages(recipientId: string, input: ClaimedChannel[]) {
  return input
    .map(({ channel, messages, skipped }) =>
      formatChannelMessages(recipientId, channel, messages, skipped),
    )
    .filter(Boolean)
    .join('\n\n');
}
