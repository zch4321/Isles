import { expect, test, type Page } from '@playwright/test';
import type { Agent, Channel, Message } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function seed(page: Page, prefix: string) {
  const agents: Agent[] = [];
  const groups: Channel[] = [];
  for (let index = 1; index <= 3; index++) {
    const response = await page.request.post('/api/agents', {
      data: {
        name: `${prefix} Agent ${index}`,
        harness: 'codex',
        model: 'test-model',
        reasoningEffort: 'max',
      },
    });
    expect(response.status()).toBe(201);
    const agent = (await response.json()) as Agent;
    await expect
      .poll(
        async () => (await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent.status,
      )
      .toBe('ready');
    const stopped = await page.request.post(`/api/agents/${agent.id}/stop`);
    expect(stopped.ok()).toBe(true);
    agents.push((await stopped.json()) as Agent);
  }
  for (let index = 1; index <= 3; index++) {
    const response = await page.request.post('/api/channels', {
      data: {
        name: index === 3 ? `${prefix} 保留群聊` : `${prefix} 删除群聊 ${index}`,
        memberIds: agents.map((agent) => agent.id),
      },
    });
    expect(response.status()).toBe(201);
    const group = (await response.json()) as Channel;
    await page.request.patch(`/api/channels/${group.id}`, { data: { paused: true } });
    await page.request.post(`/api/channels/${group.id}/messages`, {
      data: { body: `${prefix} 群聊历史 ${index}`, clientId: randomUUID() },
    });
    groups.push(group);
  }
  await page.request.post(`/api/channels/${agents[0]!.channelId}/messages`, {
    data: { body: `${prefix} 私聊历史`, clientId: randomUUID() },
  });
  return {
    agents,
    groups,
    cleanup: async () => {
      for (const group of groups) await page.request.delete(`/api/channels/${group.id}`);
      for (const agent of agents) await page.request.delete(`/api/agents/${agent.id}`);
    },
  };
}

test('bulk Agent deletion confirms fixed selections, reports partial failures and retries only failed items', async ({
  page,
}, testInfo) => {
  const fixture = await seed(page, `批删-${randomUUID().slice(0, 8)}`);
  const [first, second, retained] = fixture.agents as [Agent, Agent, Agent];
  const file = join(first.workspace, 'bulk-retained.txt');
  await writeFile(file, 'workspace retained');
  const calls = new Map<string, number>();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/agents/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
    calls.set(id, (calls.get(id) ?? 0) + 1);
    if (id === second.id && calls.get(id) === 1) {
      await gate;
      return route.fulfill({ status: 503, json: { error: '模拟删除失败，请重试' } });
    }
    return route.continue();
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const open = page.getByRole('button', { name: '批量删除 Agents', exact: true });
    await open.click();
    const dialog = page.getByRole('dialog', { name: '批量删除 Agents', exact: true });
    await expect(dialog.getByRole('button', { name: '删除已选（0）', exact: true })).toBeDisabled();
    for (const agent of [first, second])
      await dialog.getByRole('checkbox', { name: `选择 ${agent.name}`, exact: true }).check();
    await dialog.getByRole('button', { name: '删除已选（2）', exact: true }).click();
    await expect(dialog).toContainText(first.name);
    await expect(dialog).toContainText(second.name);
    await expect(dialog).not.toContainText(retained.name);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    expect(calls.size).toBe(0);
    await open.click();
    await expect(dialog.getByRole('button', { name: '删除已选（0）', exact: true })).toBeDisabled();
    for (const agent of [first, second])
      await dialog.getByRole('checkbox', { name: `选择 ${agent.name}`, exact: true }).check();
    await dialog.getByRole('button', { name: '删除已选（2）', exact: true }).click();
    await page.screenshot({
      path: testInfo.outputPath('bulk-agents-confirm-mobile.png'),
      fullPage: true,
    });
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect.poll(() => calls.get(second.id)).toBe(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: /正在删除/ })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeHidden();
    release();
    await expect(dialog.getByRole('status')).toContainText('已删除 1 项');
    await expect(dialog).toContainText('模拟删除失败，请重试');
    await dialog.getByRole('button', { name: '重试失败项', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('已删除 2 项。');
    expect(calls.get(first.id)).toBe(1);
    expect(calls.get(second.id)).toBe(2);
    expect(calls.has(retained.id)).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('workspace retained');
    for (const agent of [first, second]) {
      const detail = await (await page.request.get(`/api/agents/${agent.id}`)).json();
      expect(detail.agent.status).toBe('deleted');
    }
    const untouched = await (await page.request.get(`/api/agents/${retained.id}`)).json();
    expect(untouched.agent).toMatchObject({ status: 'stopped', threadId: retained.threadId });
    const group = await (await page.request.get(`/api/channels/${fixture.groups[0]!.id}`)).json();
    expect(group.channel.memberIds).toEqual([retained.id]);
    const history = await (await page.request.get(`/api/channels/${first.channelId}`)).json();
    expect(history.messages[0].body).toContain('私聊历史');
    expect(history.messages[0].deliveries).toContainEqual({
      agentId: first.id,
      status: 'cancelled',
    });
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await expect(
      page
        .getByRole('navigation', { name: '历史对话', exact: true })
        .getByRole('button')
        .filter({ hasText: first.name }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
  } finally {
    release();
    await fixture.cleanup();
  }
});

test('bulk group deletion selects filtered groups and preserves unselected groups, members and history', async ({
  page,
}, testInfo) => {
  const prefix = `群批删-${randomUUID().slice(0, 8)}`;
  const fixture = await seed(page, prefix);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: '批量删除群聊', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '批量删除群聊', exact: true });
    await dialog.getByRole('textbox', { name: '搜索群聊', exact: true }).fill(`${prefix} 删除群聊`);
    await expect(dialog.getByRole('checkbox')).toHaveCount(2);
    await dialog.getByRole('button', { name: '全选当前搜索结果', exact: true }).click();
    await dialog.getByRole('button', { name: '删除已选（2）', exact: true }).click();
    await expect(dialog).toContainText('成员 Agent 保持各自运行状态');
    await expect(dialog).not.toContainText(fixture.groups[2]!.name!);
    await dialog.getByRole('button', { name: '返回选择', exact: true }).click();
    await dialog.getByRole('button', { name: '清空选择', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '删除已选（0）', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '全选当前搜索结果', exact: true }).click();
    await dialog.getByRole('button', { name: '删除已选（2）', exact: true }).click();
    await page.screenshot({
      path: testInfo.outputPath('bulk-groups-confirm-mobile.png'),
      fullPage: true,
    });
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('已删除 2 项。');
    for (const group of fixture.groups.slice(0, 2)) {
      const detail = await (await page.request.get(`/api/channels/${group.id}`)).json();
      expect(detail.channel.deletedAt).not.toBeNull();
      expect(detail.channel.memberIds).toEqual([]);
      const message = (detail.messages as Message[]).find(
        (message) => message.sender === 'user' && message.body.includes('群聊历史'),
      )!;
      expect(message.body).toContain('群聊历史');
      expect(
        message.deliveries.every((delivery: { status: string }) => delivery.status === 'cancelled'),
      ).toBe(true);
    }
    const kept = await (await page.request.get(`/api/channels/${fixture.groups[2]!.id}`)).json();
    expect(kept.channel.deletedAt).toBeNull();
    expect(kept.channel.memberIds.toSorted()).toEqual(
      fixture.agents.map((agent) => agent.id).toSorted(),
    );
    for (const agent of fixture.agents) {
      const detail = await (await page.request.get(`/api/agents/${agent.id}`)).json();
      expect(detail.agent).toMatchObject({ status: 'stopped', threadId: agent.threadId });
    }
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: '批量删除群聊', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '删除已选（0）', exact: true })).toBeDisabled();
    await dialog.getByRole('textbox', { name: '搜索群聊', exact: true }).fill(`${prefix} 删除群聊`);
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  } finally {
    await fixture.cleanup();
  }
});
