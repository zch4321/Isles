import type { Agent, Channel, Message } from '@isles/contracts';

export type Directory = ReadonlyMap<string, Agent>;

export const channelTitle = (channel: Channel, directory: Directory) =>
  channel.kind === 'group'
    ? (channel.name ?? '群聊')
    : (directory.get(channel.agentId ?? '')?.name ?? 'Agent');

export const senderName = (message: Message, directory: Directory) =>
  message.sender === 'user'
    ? '你'
    : message.sender === 'system'
      ? 'Isles'
      : (directory.get(message.senderId)?.name ?? '未知 Agent');

export const lastActivity = (channel: Channel) =>
  channel.lastMessage?.createdAt ?? channel.createdAt;

export const byActivity = (a: Channel, b: Channel) =>
  lastActivity(b).localeCompare(lastActivity(a));

/** One-line preview of the latest message for chat lists. */
export function preview(channel: Channel, directory: Directory) {
  const message = channel.lastMessage;
  if (!message) return undefined;
  const text = message.body
    .replace(/[`*_#>~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (message.sender === 'user') return `你：${text}`;
  if (message.sender === 'agent' && channel.kind === 'group')
    return `${senderName(message, directory)}：${text}`;
  return text;
}
