import { expect, test, type Page } from '@playwright/test';

const composer = (page: Page) => page.getByRole('textbox', { name: '消息输入' });
async function send(page: Page, body: string) {
  await composer(page).fill(body);
  await page.getByRole('button', { name: '发送消息' }).click();
}
async function createAgent(page: Page, name: string) {
  await page.getByRole('button', { name: '新建 Agent' }).first().click();
  await page.getByLabel('名称').fill(name);
  await page.getByLabel('模型', { exact: true }).selectOption('test-model');
  await page.getByLabel('推理等级').selectOption('max');
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
  await expect(page.getByTestId('agent-status')).toHaveText('可用');
}
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

test('saves the Codex executable path in the creation dialog and restores automatic discovery', async ({
  page,
}, testInfo) => {
  let unavailable = true;
  await page.route('**/api/codex/status*', (route) =>
    unavailable
      ? route.fulfill({
          json: {
            available: false,
            authenticated: false,
            version: null,
            binaryPath: null,
            error: '未找到本机 Codex，请指定可执行文件。',
          },
        })
      : route.continue(),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '新建 Agent', exact: true }).first().click();
  const path = page.getByLabel('Codex 可执行文件路径');
  await expect(path).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('未找到本机 Codex');
  await path.fill('C:\\Codex Custom\\codex.exe');
  unavailable = false;
  await page.getByRole('button', { name: '保存并检测', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '路径设置已保存' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '新建 Agent', exact: true }).first().click();
  if (!(await path.isVisible()))
    await page.getByRole('button', { name: 'Codex 路径设置', exact: true }).click();
  await expect(path).toHaveValue('C:\\Codex Custom\\codex.exe');
  await path.fill('');
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/codex/config') && response.request().method() === 'PUT',
    ),
    page.getByRole('button', { name: '保存并检测', exact: true }).click(),
  ]);
  expect((await response.json()).binaryPath).toBeNull();
  expect(await noHorizontalScroll(page)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('codex-path-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '取消', exact: true }).click();
});

test('opens the workspace and connects through the Web proxy to SQLite-backed health', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '让独立的 AI 一起工作。' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('服务已连接');
  await page.screenshot({ path: testInfo.outputPath('workspace.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('workspace-mobile.png'), fullPage: true });
});

test('creates an Agent, publishes MCP replies, persists reload and handles stop/resume and native questions', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await createAgent(page, '浏览器 Agent');
  await send(page, '第一轮浏览器消息');
  const replies = page.locator('[data-sender="agent"]');
  await expect(replies).toContainText('MCP 回复：第一轮浏览器消息');
  await expect(replies).toHaveCount(1);
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  const inspector = page.getByTestId('inspector');
  await inspector.locator('details[data-run] summary').first().click();
  await expect(inspector).toContainText('原生详情，不是正式回复');
  await expect(inspector).toContainText('输入：私聊 1 条');
  await expect(page.locator('[aria-label="私聊消息"]')).not.toContainText('原生详情，不是正式回复');
  await page.reload();
  await expect(replies).toContainText('MCP 回复：第一轮浏览器消息');
  await page.getByRole('button', { name: '停止 Agent' }).click();
  await expect(page.getByTestId('agent-status')).toHaveText('已停止');
  await send(page, '停止时排队');
  await expect(page.locator('[data-sender="user"]').last()).toContainText('排队中');
  await page.reload();
  await expect(page.getByTestId('agent-status')).toHaveText('已停止');
  await page.getByRole('button', { name: '恢复 Agent' }).click();
  await expect(replies.last()).toContainText('MCP 回复：停止时排队');
  await send(page, '请向我提问');
  await expect(page.getByText('浏览器 Agent 需要你的回答')).toBeVisible();
  await page.getByRole('radio', { name: /^继续/ }).check();
  await page.getByRole('button', { name: '提交回答' }).click();
  await expect(replies.last()).toContainText('MCP 回复：请向我提问');
  await expect(page.getByText('浏览器 Agent 需要你的回答')).not.toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('chat-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('chat-mobile.png'), fullPage: true });
  expect(await noHorizontalScroll(page)).toBe(false);
  expect(errors).toEqual([]);
});

test('navigates mobile chats, searches contacts and keeps drafts and IME input in the correct conversation', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const contacts = page.getByRole('navigation', { name: 'Agents', exact: true });
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  await contacts.getByRole('button').filter({ hasText: '浏览器 Agent' }).click();
  await composer(page).fill('这条草稿属于第一个 Agent');
  const messageCount = await page.locator('[data-sender="user"]').count();
  await composer(page).dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    isComposing: true,
    bubbles: true,
  });
  await expect(composer(page)).toHaveValue('这条草稿属于第一个 Agent');
  await expect(page.locator('[data-sender="user"]')).toHaveCount(messageCount);
  await page.getByRole('button', { name: '返回聊天列表' }).click();
  await page.getByRole('button', { name: '新建 Agent', exact: true }).click();
  await page.getByLabel('名称').fill('第二个 Agent');
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
  await expect(page.getByTestId('agent-status')).toHaveText('可用');
  await expect(composer(page)).toHaveValue('');
  await composer(page).fill('这是第二段对话的草稿');
  await page.getByRole('button', { name: '返回聊天列表' }).click();
  const search = page.getByRole('textbox', { name: '搜索聊天' });
  await search.fill('找不到的名称');
  await expect(page.getByRole('heading', { name: '没有找到相关聊天' })).toBeVisible();
  await search.fill('第二个');
  await expect(contacts.getByRole('button')).toHaveCount(1);
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(contacts.getByRole('button')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('chat-list-mobile.png'), fullPage: true });
  await contacts.getByRole('button').filter({ hasText: '浏览器 Agent' }).click();
  await expect(composer(page)).toHaveValue('这条草稿属于第一个 Agent');
  await composer(page).press('Shift+Enter');
  await expect(composer(page)).toHaveValue('这条草稿属于第一个 Agent\n');
  await composer(page).press('Enter');
  await expect(page.locator('[data-sender="agent"]').last()).toContainText(
    'MCP 回复：这条草稿属于第一个 Agent',
  );
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  await expect(page.getByTestId('inspector')).toBeVisible();
  await page.getByRole('button', { name: '关闭详情' }).click();
  await expect(page.getByTestId('inspector')).not.toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(false);
});

test('runs a group discussion with mentions, pause and member management', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByRole('button', { name: '新建群聊' }).click();
  await page.getByLabel('群名').fill('方案讨论');
  await page.getByRole('checkbox', { name: /浏览器 Agent/ }).check();
  await page.getByRole('checkbox', { name: /第二个 Agent/ }).check();
  await page.getByRole('button', { name: '创建群聊', exact: true }).click();
  await expect(page.getByRole('heading', { name: '方案讨论', level: 1 })).toBeVisible();
  const feed = page.locator('[aria-label="群聊消息"]');
  await expect(feed.locator('[data-sender="system"]')).toContainText('用户创建了群聊“方案讨论”');

  await composer(page).fill('请大家看看，');
  await composer(page).press('@');
  const picker = page.getByRole('listbox', { name: '提及成员' });
  await expect(picker.getByRole('option')).toHaveCount(2);
  await composer(page).pressSequentially('第二');
  await expect(picker.getByRole('option')).toHaveCount(1);
  await composer(page).press('Enter');
  await expect(composer(page)).toHaveValue('请大家看看，@第二个 Agent ');
  await composer(page).pressSequentially('你怎么看');
  await composer(page).press('Enter');
  await expect(feed.locator('[data-sender="user"] .mention')).toHaveText('@第二个 Agent');
  // Every member is woken, whoever is mentioned; each answers once and the round settles.
  const replies = feed.locator('[data-sender="agent"]');
  await expect(replies).toHaveCount(2);
  for (const name of ['浏览器 Agent', '第二个 Agent'])
    await expect(feed.getByRole('article', { name: `${name}的消息` })).toHaveCount(1);

  await page.getByRole('button', { name: '暂停讨论' }).click();
  await expect(page.getByTestId('group-status')).toHaveText('已暂停');
  await send(page, '暂停期间的消息');
  await expect(page.getByText('讨论已暂停：新消息会保存')).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(replies).toHaveCount(2);
  await page.getByRole('button', { name: '继续讨论' }).click();
  await expect(replies).toHaveCount(4);
  await expect(replies.last()).toContainText('MCP 回复：暂停期间的消息');

  await page.getByRole('button', { name: '群聊详情', exact: true }).click();
  const inspector = page.getByTestId('inspector');
  const members = inspector.getByRole('list', { name: '群成员' }).getByRole('listitem');
  await expect(members).toHaveCount(2);
  await inspector.getByRole('button', { name: '查看 第二个 Agent 的详情' }).click();
  const permission = inspector.getByRole('switch', { name: '允许拉群' });
  await expect(permission).toHaveAttribute('aria-checked', 'false');
  await permission.click();
  await expect(permission).toHaveAttribute('aria-checked', 'true');
  await inspector.getByRole('button', { name: '返回群聊详情' }).click();
  await page.screenshot({ path: testInfo.outputPath('group-desktop.png'), fullPage: true });
  await inspector.getByRole('button', { name: '将 第二个 Agent 移出群聊' }).click();
  await expect(members).toHaveCount(1);
  await expect(feed.locator('[data-sender="system"]').last()).toContainText('移出了群聊');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.screenshot({ path: testInfo.outputPath('group-mobile.png'), fullPage: true });
  expect(await noHorizontalScroll(page)).toBe(false);
  expect(errors).toEqual([]);
});

test('receives busy input through MCP without creating another native turn or leaving a queued badge', async ({
  page,
}) => {
  await page.goto('/');
  await createAgent(page, '收信 Agent');
  await send(page, '请在执行中收信');
  await expect(page.getByText('收信 Agent 需要你的回答')).toBeVisible();
  await send(page, '执行中的更新');
  const message = page.locator('[data-sender="user"]').last();
  await expect(message).toContainText('排队中');
  await page.getByRole('radio', { name: /^继续/ }).check();
  await page.getByRole('button', { name: '提交回答' }).click();
  const replies = page.locator('[data-sender="agent"]');
  await expect(replies).toHaveCount(2);
  await expect(replies.last()).toContainText('MCP 回复：执行中的更新');
  await expect(page.getByTestId('agent-status')).toHaveText('可用');
  await expect(message).not.toContainText('排队中');
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  await expect(page.getByTestId('inspector').locator('details[data-run]')).toHaveCount(1);
  await page.reload();
  await expect(replies).toHaveCount(2);
  await expect(message).not.toContainText('排队中');
});

test('shows a recoverable connection error instead of a connected state', async ({ page }) => {
  await page.route('**/api/health', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('服务未连接');
  await page.unroute('**/api/health');
  await page.getByRole('button', { name: '重新连接服务' }).click();
  await expect(page.getByRole('status')).toContainText('服务已连接');
});
