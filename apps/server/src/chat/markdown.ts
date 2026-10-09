import { HttpError } from '../errors.js';
import { nameLabels } from '../runtime/names.js';
import type { ChatExportSnapshot } from '../storage/store.js';

/** Single-line metadata stays literal even when names contain Markdown or line breaks. */
function inline(value: string) {
  return value
    .replace(/[\r\n\u2028\u2029]/g, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\\`*_{}[\]()#+.!|-]/g, '\\$&');
}

function fileName(name: string) {
  const safe = Buffer.from(name, 'utf8')
    .toString('utf8')
    .replace(/[<>:"/\\|?*\u2028\u2029]/g, '-');
  let result = '';
  for (const original of safe) {
    const code = original.charCodeAt(0);
    const character = code < 32 || code === 127 ? '-' : original;
    if (Buffer.byteLength(result + character, 'utf8') > 180) break;
    result += character;
  }
  return result.replace(/^[.\s]+|[.\s]+$/g, '') || '聊天记录';
}

/** The browser supplies its time zone; offsets are computed for each message's own date. */
export function chatExportFormatter(timeZone: string) {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    });
  } catch {
    throw new HttpError(400, '导出时区无效，请重新导出聊天记录');
  }
  const dateTime = (value: string) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(value)).map(({ type, value }) => [type, value]),
    );
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const time = `${parts.hour}:${parts.minute}:${parts.second}`;
    const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName!.replace('GMT', '');
    return {
      label: `${date} ${time} ${offset}`,
      stamp: `${date.replaceAll('-', '')}-${time.replaceAll(':', '')}`,
    };
  };
  return (snapshot: ChatExportSnapshot) => {
    const { channel, messages } = snapshot;
    const labels = nameLabels(snapshot.agents);
    const agentName = (id: string) => labels.get(id) ?? '未知 Agent';
    const authorName = (message: ChatExportSnapshot['messages'][number]) =>
      message.sender === 'user'
        ? '用户'
        : message.sender === 'system'
          ? 'Isles'
          : agentName(message.senderId);
    const author = (message: ChatExportSnapshot['messages'][number]) =>
      `${authorName(message)}${message.sender === 'agent' ? '（Agent）' : message.sender === 'system' ? '（系统）' : ''}`;
    const name = channel.kind === 'private' ? agentName(channel.agentId!) : channel.name!;
    const title = channel.kind === 'private' ? `与 ${name} 的聊天记录` : name;
    const type = channel.kind === 'private' ? '私聊' : '群聊';
    const exported = dateTime(snapshot.exportedAt);
    const lines = [`# ${inline(title)}`, '', `- 类型：${type}`, `- 导出时间：${exported.label}`];
    if (messages.length)
      lines.push(
        `- 记录范围：${dateTime(messages[0]!.createdAt).label} 至 ${dateTime(messages.at(-1)!.createdAt).label}`,
      );
    lines.push(`- 消息数：${messages.length}`);
    const speakers = [...new Set(messages.filter((m) => m.sender !== 'system').map(author))];
    if (speakers.length) lines.push(`- 发言者：${speakers.map(inline).join('、')}`);
    const bySeq = new Map(messages.map((message) => [message.seq, message]));
    messages.forEach((message, index) => {
      if (index) lines.push('', '---');
      lines.push(
        '',
        `## #${message.seq} · ${inline(author(message))} · ${dateTime(message.createdAt).label}`,
        '',
      );
      if (message.replyTo !== null) {
        const target = bySeq.get(message.replyTo)!;
        lines.push(`回复：#${message.replyTo}（${inline(authorName(target))}）`, '');
      }
      if (message.mentions.length)
        lines.push(
          `提及：${message.mentions.map((id) => `@${inline(agentName(id))}`).join('、')}`,
          '',
        );
      lines.push(
        ...message.body
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map((line) => (line ? `> ${line}` : '>')),
      );
    });
    return {
      filename: `${type}-${fileName(name)}-${exported.stamp}.md`,
      markdown: `${lines.join('\n')}\n`,
    };
  };
}
