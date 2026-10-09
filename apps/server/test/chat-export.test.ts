import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { chatExportFormatter } from '../src/chat/markdown.js';
import { deliveries } from '../src/storage/schema.js';
import type { ChatExportSnapshot } from '../src/storage/store.js';
import { testConfig } from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-chat-export-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const app = await buildApp({ config: testConfig(root) });
  cleanups.push(() => app.close());
  const store = app.isles.store;
  const create = (name = 'Kimi') =>
    store.createAgent({
      name,
      harness: 'codex',
      model: 'test-model',
      reasoningEffort: 'high',
      nativeHome: join(root, 'native-home'),
      canCreateGroups: false,
    });
  const say = (channelId: string, body: string, replyTo?: number) =>
    store.saveMessage(
      channelId,
      { type: 'user' },
      { body, clientId: randomUUID(), ...(replyTo && { replyTo }) },
    );
  return { app, store, create, say };
}

const snapshot = (): ChatExportSnapshot => ({
  channel: { id: 'room', kind: 'group', name: '技术评审', agentId: null },
  exportedAt: '2026-10-09T03:05:00.000Z',
  agents: [{ id: 'kimi', name: 'Kimi' }],
  messages: [
    {
      seq: 12,
      sender: 'user',
      senderId: 'user',
      body: '请检查这个实现。',
      replyTo: null,
      mentions: ['kimi'],
      createdAt: '2026-10-09T03:00:00.000Z',
    },
    {
      seq: 13,
      sender: 'agent',
      senderId: 'kimi',
      body: '找到两处需要调整的地方：\n\n1. 恢复配置。\n2. 保留 session。',
      replyTo: 12,
      mentions: [],
      createdAt: '2026-10-09T03:02:10.000Z',
    },
  ],
});

describe('Markdown chat export', () => {
  it('preserves the agreed format, original sequence, reply and mention', () => {
    const result = chatExportFormatter('Asia/Shanghai')(snapshot());
    expect(result.filename).toBe('群聊-技术评审-20261009-110500.md');
    expect(result.markdown).toBe(`# 技术评审

- 类型：群聊
- 导出时间：2026-10-09 11:05:00 +08:00
- 记录范围：2026-10-09 11:00:00 +08:00 至 2026-10-09 11:02:10 +08:00
- 消息数：2
- 发言者：用户、Kimi（Agent）

## #12 · 用户 · 2026-10-09 11:00:00 +08:00

提及：@Kimi

> 请检查这个实现。

---

## #13 · Kimi（Agent） · 2026-10-09 11:02:10 +08:00

回复：#12（用户）

> 找到两处需要调整的地方：
>
> 1. 恢复配置。
> 2. 保留 session。
`);
  });

  it('uses each message date to determine daylight-saving offsets and never reorders history', () => {
    const data = snapshot();
    data.messages[0]!.createdAt = '2026-07-09T12:00:00.000Z';
    data.messages[1]!.createdAt = '2026-01-09T12:00:00.000Z';
    const { markdown } = chatExportFormatter('America/New_York')(data);
    expect(markdown).toContain('## #12 · 用户 · 2026-07-09 08:00:00 -04:00');
    expect(markdown).toContain('## #13 · Kimi（Agent） · 2026-01-09 07:00:00 -05:00');
    expect(markdown.indexOf('## #12')).toBeLessThan(markdown.indexOf('## #13'));
  });

  it('escapes metadata, keeps body Markdown intact and disambiguates colliding short IDs', () => {
    const data = snapshot();
    const firstId = '12345678-1234-4000-8000-000000000001';
    const secondId = '12345678-2234-4000-8000-000000000002';
    data.channel.name = '标题\n## 伪造标题 <b>*';
    data.agents = [
      { id: firstId, name: '同名 [A]' },
      { id: secondId, name: '同名 [A]' },
    ];
    data.messages[0]!.body = '# 正文标题\r\n\r\n```ts\r\nconst x = 1;';
    data.messages[0]!.mentions = [firstId, secondId];
    data.messages[1]!.senderId = secondId;
    const { markdown } = chatExportFormatter('UTC')(data);
    expect(markdown).toContain('# 标题 ## 伪造标题 \\<b\\>\\*\n');
    expect(markdown).toContain('@同名 \\[A\\]#123456781');
    expect(markdown).toContain('@同名 \\[A\\]#123456782');
    expect(markdown).toContain('> # 正文标题\n>\n> ```ts\n> const x = 1;\n\n---\n\n## #13');
  });

  it('keeps ordinary punctuation readable and neutralises entities and closing heading marks', () => {
    const data = snapshot();
    data.channel.name = 'GPT-5.1 (测试) R&D &copy; 1. + #';
    data.agents = [{ id: 'kimi', name: 'Kimi_v2 ~beta~ #1' }];
    const { markdown } = chatExportFormatter('UTC')(data);
    expect(markdown).toContain('# GPT-5.1 (测试) R&D \\&copy; 1. + \\#\n');
    expect(markdown).toContain('## #13 · Kimi\\_v2 \\~beta\\~ #1（Agent） · ');
  });

  it('generates a portable UTF-8 filename for long names and path characters', () => {
    const data = snapshot();
    data.channel.name = `../路径\\:*?<>|"${'😀'.repeat(120)}`;
    const { filename } = chatExportFormatter('UTC')(data);
    expect(filename).toMatch(/^群聊-/);
    expect(filename).not.toMatch(/[<>:"/\\|?*\r\n]/);
    expect(Buffer.byteLength(filename, 'utf8')).toBeLessThan(255);
    expect(filename).not.toContain('\uFFFD');
  });

  it('truncates long filenames at grapheme boundaries', () => {
    const data = snapshot();
    const family = '👨‍👩‍👧‍👦';
    data.channel.name = `a${family.repeat(20)}`;
    const { filename } = chatExportFormatter('UTC')(data);
    expect(filename).toBe(`群聊-a${family.repeat(7)}-20261009-030500.md`);
  });

  it('exports every message beyond the page limit with no receipt or execution side effects', async () => {
    const { app, store, create, say } = await fixture();
    const agent = create();
    for (let seq = 1; seq <= 151; seq++)
      say(agent.channelId, `消息 ${seq}`, seq === 151 ? 1 : undefined);
    expect(store.channelDetail(agent.channelId).messages).toHaveLength(100);
    const state = store.database.db.select().from(deliveries).all();
    const cursor = store.cursor();
    const response = await app.inject(
      `/api/channels/${agent.channelId}/export?timeZone=Asia%2FShanghai`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(response.headers['content-disposition']).toContain(
      'attachment; filename="chat-history.md"; filename*=UTF-8\'\'',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('# 与 Kimi 的聊天记录');
    expect(response.body).toContain('- 消息数：151');
    expect(response.body.match(/^## #\d+/gm)).toHaveLength(151);
    expect(response.body).toContain('> 消息 1\n');
    expect(response.body).toContain('回复：#1（用户）');
    expect(response.body).toContain('> 消息 151\n');
    expect(store.database.db.select().from(deliveries).all()).toEqual(state);
    expect(store.cursor()).toBe(cursor);
    expect(store.agentDetail(agent.id).runs).toEqual([]);
  });

  it('retains the captured history and author names when messages and names change afterwards', async () => {
    const { store, create, say } = await fixture();
    const agent = create('原名称');
    say(agent.channelId, '原消息');
    const captured = store.chatExportSnapshot(agent.channelId);
    store.updateAgent(agent.id, { name: '新名称' });
    say(agent.channelId, '后续消息');
    const result = chatExportFormatter('UTC')(captured);
    expect(result.markdown).toContain('# 与 原名称 的聊天记录');
    expect(result.markdown).toContain('- 消息数：1');
    expect(result.markdown).not.toContain('新名称');
    expect(result.markdown).not.toContain('后续消息');
  });

  it('exports deleted group history, system messages and retired authors without mixing channels', async () => {
    const { app, store, create, say } = await fixture();
    const alice = create('Alice');
    const bob = create('Bob');
    const group = store.createGroup('user', '历史群聊', [alice.id, bob.id]);
    const first = say(group.id, '群消息');
    store.saveMessage(
      group.id,
      { type: 'agent', id: alice.id },
      {
        body: '**Agent 正式回复**',
        clientId: randomUUID(),
        replyTo: first.seq,
        mentions: [bob.id],
      },
    );
    say(alice.channelId, '私聊内容');
    store.deleteAgent(alice.id);
    store.deleteGroup(group.id);
    const response = await app.inject(`/api/channels/${group.id}/export`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('# 历史群聊');
    expect(response.body).toContain('Alice（Agent）');
    expect(response.body).toContain('Isles（系统）');
    expect(response.body).toContain('> **Agent 正式回复**');
    expect(response.body).toContain('提及：@Bob');
    expect(response.body).not.toContain('私聊内容');
    expect((await app.inject(`/api/channels/${alice.channelId}/export`)).statusCode).toBe(200);
  });

  it('downloads an empty private chat and rejects missing channels and invalid time zones', async () => {
    const { app, create } = await fixture();
    const agent = create();
    const response = await app.inject(`/api/channels/${agent.channelId}/export`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('- 消息数：0\n');
    expect(response.body).not.toContain('- 记录范围：');
    expect(response.body).not.toContain('## #');
    expect((await app.inject('/api/channels/missing/export')).statusCode).toBe(404);
    const invalid = await app.inject(
      `/api/channels/${agent.channelId}/export?timeZone=Wrong%2FZone`,
    );
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('无法识别导出时区“Wrong/Zone”，请检查系统时区设置后重新导出');
  });
});
