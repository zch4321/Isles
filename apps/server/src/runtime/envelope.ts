import type { Agent, Channel, Message } from '@isles/contracts';
import type { ChannelRecord, ClaimedChannel } from '../storage/store.js';

/** Looks up Agents by ID for sender and mention names. */
export type Directory = ReadonlyMap<string, Pick<Agent, 'name' | 'harness' | 'model'>>;

export function directoryOf(agents: Agent[]): Directory {
  return new Map(agents.map((a) => [a.id, a]));
}

// Metadata comes from stored columns, never from the body, so a body cannot pose as another sender.
export function agentView(message: Message, recipientId: string, directory: Directory) {
  const agent = message.sender === 'agent' ? directory.get(message.senderId) : undefined;
  return {
    message_id: message.id,
    seq: message.seq,
    sender: agent
      ? {
          type: 'agent',
          id: message.senderId,
          name: agent.name,
          harness: agent.harness,
          model: agent.model,
        }
      : { type: message.sender, id: message.senderId },
    body: message.body,
    reply_to: message.replyTo,
    mentions: message.mentions.map((id) => ({ id, name: directory.get(id)?.name ?? null })),
    mentions_you: message.mentions.includes(recipientId),
    created_at: message.createdAt,
  };
}

export function channelView(channel: ChannelRecord | Channel) {
  return { channel_id: channel.id, kind: channel.kind, name: channel.name };
}

/** The single text input of one turn: every claimed channel with its unread messages. */
export function unreadEnvelope(recipientId: string, input: ClaimedChannel[], directory: Directory) {
  return {
    type: 'isles.unread',
    channels: input.map(({ channel, messages, skipped }) => ({
      ...channelView(channel),
      skipped_unread: skipped,
      messages: messages.map((m) => agentView(m, recipientId, directory)),
    })),
  };
}

export function buildEnvelope(recipientId: string, input: ClaimedChannel[], directory: Directory) {
  return JSON.stringify(unreadEnvelope(recipientId, input, directory));
}
