import { expect, test } from '@playwright/test';
import type { Channel } from '@isles/contracts';

test('shows deleted group as read-only when a refresh fails after deletion', async ({ page }) => {
  const response = await page.request.post('/api/channels', {
    data: { name: '删除后刷新失败', memberIds: [] },
  });
  expect(response.ok()).toBe(true);
  const group = (await response.json()) as Channel;
  await page.addInitScript((id) => localStorage.setItem('isles.channel', id), group.id);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: group.name!, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '群聊详情', exact: true }).click();
  const inspector = page.getByTestId('inspector');
  await inspector.getByRole('button', { name: '删除群聊', exact: true }).click();
  let failRefresh = false;
  let failedRequests = 0;
  await page.route(
    (url) => url.pathname === '/api/channels' || url.pathname === `/api/channels/${group.id}`,
    async (route) => {
      if (failRefresh && route.request().method() === 'GET') {
        failedRequests++;
        await route.fulfill({ status: 503, json: { error: '列表刷新失败' } });
      } else await route.continue();
    },
  );
  failRefresh = true;
  const dialog = page.getByRole('dialog', { name: '删除群聊', exact: true });
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(inspector).toContainText('此群聊已删除，对话以只读方式保留');
  await expect(page.getByTestId('group-status')).toHaveText('已删除');
  await expect(page.getByRole('textbox', { name: '消息输入' })).toHaveCount(0);
  await expect.poll(() => failedRequests).toBeGreaterThan(0);
});
