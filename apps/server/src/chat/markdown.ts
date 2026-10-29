import { HttpError } from '../errors.js';
import { nameLabels } from '../runtime/names.js';
import type { ChatExportSnapshot } from '../storage/store.js';

/**
 * Single-line metadata stays literal even when names contain Markdown or line breaks.
 * Values always follow a line prefix, so only inline syntax, entity references and a
 * heading's closing `#` run need escaping; other punctuation stays readable as plain text.
 */
function inline(value: string) {
  return value
    .replace(/[\r\n\u2028\u2029]/g, ' ')
    .replace(/[\\`*_~[\]<>]|&(?=#?\w+;)/g, '\\$&')
    .replace(/#+$/, '\\$&');
}

/** Truncates by grapheme cluster so emoji sequences and combining marks stay whole. */
function fileName(name: string) {
  const safe = [...Buffer.from(name, 'utf8').toString('utf8')]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 || '<>:"/\\|?*\u2028\u2029'.includes(character)
        ? '-'
        : character;
    })
    .join('');
  let result = '';
  for (const { segment } of new Intl.Segmenter().segment(safe)) {
    if (Buffer.byteLength(result + segment, 'utf8') > 180) break;
    result += segment;
  }
  return result.replace(/^[.\s]+|[.\s]+$/g, '') || '聊天记录';
}

/** The browser supplies its time zone; offsets are computed for each message's own date. */
export function chatExportFormatter(timeZone: string, imageOrigin = 'http://127.0.0.1:4310') {
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
    throw new HttpError(400, `无法识别导出时区“${timeZone}”，请检查系统时区设置后重新导出`);
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
      if (message.body)
        lines.push(
          ...message.body
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map((line) => (line ? `> ${line}` : '>')),
        );
      for (const image of message.images) {
        const url = new URL(`/api/channels/${image.channelId}/images/${image.id}`, imageOrigin);
        lines.push('', `![${inline(image.name)}](<${url.href}>)`);
      }
    });
    return {
      filename: `${type}-${fileName(name)}-${exported.stamp}.md`,
      markdown: `${lines.join('\n')}\n`,
    };
  };
}
