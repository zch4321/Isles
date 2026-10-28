import { expect, test, type Page } from '@playwright/test';
import type { Agent, Channel, HarnessDescriptor } from '@isles/contracts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

const composer = (page: Page) => page.getByRole('textbox', { name: '消息输入' });
async function send(page: Page, body: string) {
  await composer(page).fill(body);
  await page.getByRole('button', { name: '发送消息' }).click();
}
async function createAgent(
  page: Page,
  name: string,
  steerEnabled = false,
  dangerFullAccess = false,
) {
  await page.getByRole('button', { name: '新建 Agent' }).first().click();
  await page.getByLabel('名称').fill(name);
  await page.getByLabel('模型', { exact: true }).selectOption('test-model');
  await page.getByLabel('推理等级').selectOption('max');
  const steering = page
    .getByRole('dialog', { name: '新建 Agent', exact: true })
    .getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true });
  await expect(steering).toHaveAttribute('aria-checked', 'false');
  if (steerEnabled) await steering.click();
  const access = page
    .getByRole('dialog', { name: '新建 Agent', exact: true })
    .getByRole('switch', { name: '完整访问', exact: true });
  await expect(access).toHaveAttribute('aria-checked', 'false');
  if (dangerFullAccess) await access.click();
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/agents/batch') && response.request().method() === 'POST',
    ),
    page.getByRole('button', { name: '创建 Agent', exact: true }).click(),
  ]);
  expect(response.request().postDataJSON()).toMatchObject({
    harness: 'codex',
    name,
    count: 1,
    steerEnabled,
    dangerFullAccess,
  });
  const { agents } = (await response.json()) as { agents: Agent[] };
  expect(agents).toHaveLength(1);
  const created = agents[0]!;
  let ready = created;
  await expect
    .poll(async () => {
      ready = (await (await page.request.get(`/api/agents/${created.id}`)).json()).agent as Agent;
      return ready;
    })
    .toMatchObject({ status: 'ready', threadId: expect.any(String) });
  await expect(page.getByTestId('agent-status')).toHaveText('可用');
  return ready;
}
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

test('keeps delivered messages independent of background activities and autonomous questions', async ({
  page,
}) => {
  await page.goto('/');
  const agent = await createAgent(page, '原生活动 Agent');
  await send(page, '验证原生后台活动');
  const detail = async () => await (await page.request.get(`/api/agents/${agent.id}`)).json();
  await expect
    .poll(async () => (await detail()).runs)
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: agent.threadId, status: 'completed' }),
        expect.objectContaining({
          threadId: `${agent.threadId}-background`,
          status: 'running',
          inputs: [],
        }),
      ]),
    );
  await expect(page.getByTestId('agent-status')).toHaveText('执行中');
  await expect(page.locator('[data-sender="user"]').last()).toContainText('已送达');
  expect((await page.request.post(`/api/__test/agents/${agent.id}/background/finish`)).ok()).toBe(
    true,
  );
  await expect(page.getByRole('group', { name: '后续处理确认后台检查结果' })).toBeVisible();
  await page.getByRole('radio', { name: /^确认/ }).check();
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect
    .poll(async () => (await detail()).runs)
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: 'autonomous-wake',
          status: 'completed',
          inputs: [],
          items: expect.arrayContaining([
            expect.objectContaining({ text: '自动唤醒后已记录结果' }),
          ]),
        }),
        expect.objectContaining({
          turnId: 'background-turn',
          status: 'completed',
          inputs: [],
          items: expect.arrayContaining([expect.objectContaining({ text: '后台检查已完成' })]),
        }),
      ]),
    );
  expect((await detail()).runs).toHaveLength(3);
  await expect(page.getByTestId('agent-status')).toHaveText('可用');
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  const inspector = page.getByTestId('inspector');
  const wake = inspector.locator('details[data-run]').filter({ hasText: 'autonomous-wake' });
  if ((await wake.getAttribute('open')) === null) await wake.locator('summary').click();
  await expect(wake.getByText('原生活动', { exact: true })).toBeVisible();
  expect((await page.request.delete(`/api/agents/${agent.id}`)).ok()).toBe(true);
});

test('saves the Codex executable path in the creation dialog and restores automatic discovery', async ({
  page,
}, testInfo) => {
  let unavailable = true;
  const customPath = join(tmpdir(), 'Codex Custom', 'codex.exe');
  await page.route('**/api/harnesses/codex/status*', (route) =>
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
  await path.fill(customPath);
  unavailable = false;
  await page.getByRole('button', { name: '保存并检测', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '路径设置已保存' })).toBeVisible();
  await page.reload();
  // Earlier management tests may leave a retained chat selected on mobile reload.
  const back = page.getByRole('button', { name: '返回聊天列表', exact: true });
  await expect(
    page.getByRole('button', { name: '新建 Agent', exact: true }).or(back).first(),
  ).toBeVisible();
  if (await back.isVisible()) await back.click();
  await page.getByRole('button', { name: '新建 Agent', exact: true }).first().click();
  if (!(await path.isVisible()))
    await page.getByRole('button', { name: 'Codex 路径设置', exact: true }).click();
  await expect(path).toHaveValue(customPath);
  await path.fill('');
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/harnesses/codex/config') &&
        response.request().method() === 'PUT',
    ),
    page.getByRole('button', { name: '保存并检测', exact: true }).click(),
  ]);
  expect((await response.json()).binaryPath).toBeNull();
  expect(await noHorizontalScroll(page)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('codex-path-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '取消', exact: true }).click();
});

test('switches registered harness catalogs and cached selections without applying Codex settings or creating a fallback Agent', async ({
  page,
}) => {
  const semantic: HarnessDescriptor = {
    id: 'semantic-test',
    displayName: 'Semantic Test',
    configuration: null,
    capabilities: {
      sessionResume: true,
      interrupt: false,
      steer: false,
      userQuestions: false,
      nativeSubagents: false,
      mcp: true,
      workspaceInstructions: true,
    },
  };
  await page.route('**/api/harnesses', async (route) => {
    const response = await route.fetch();
    const directory = (await response.json()) as { harnesses: HarnessDescriptor[] };
    await route.fulfill({ response, json: { harnesses: [...directory.harnesses, semantic] } });
  });
  await page.route('**/api/harnesses/semantic-test/status*', (route) =>
    route.fulfill({
      json: {
        available: true,
        authenticated: true,
        version: 'test-only',
        binaryPath: null,
        error: null,
      },
    }),
  );
  let modelRequests = 0;
  let releaseRefresh!: () => void;
  const refreshReady = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route('**/api/harnesses/semantic-test/models', async (route) => {
    // Hold the second read so returning to this harness must use its own cached catalog.
    if (++modelRequests === 2) await refreshReady;
    await route.fulfill({
      json: {
        models: [
          {
            id: 'semantic-model',
            model: 'semantic-model',
            displayName: 'Semantic Model',
            description: '',
            supportedReasoningEfforts: ['low', 'medium'],
            defaultReasoningEffort: 'medium',
            isDefault: true,
          },
        ],
      },
    });
  });
  const before = (await (await page.request.get('/api/agents')).json()) as { agents: Agent[] };
  await page.goto('/');
  await page.getByRole('button', { name: '新建 Agent', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建 Agent', exact: true });
  const harness = dialog.getByLabel('Harness', { exact: true });
  const model = dialog.getByLabel('模型', { exact: true });
  const effort = dialog.getByLabel('推理等级');
  const codexSettings = dialog.getByRole('button', { name: 'Codex 路径设置', exact: true });
  const steering = dialog.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true });
  await expect(harness).toHaveValue('codex');
  await expect(harness.locator('option')).toHaveText([
    'Codex',
    'Claude Code',
    'Kimi Code',
    'OpenCode',
    'DeepSeek Harness',
    'Semantic Test',
  ]);
  await expect(model).toHaveValue('test-model');
  await expect(effort).toHaveValue('high');
  await expect(codexSettings).toBeVisible();
  await expect(steering).toHaveAttribute('aria-checked', 'false');
  await steering.click();
  await expect(steering).toHaveAttribute('aria-checked', 'true');
  await dialog.getByLabel('名称').fill('Semantic catalog test');
  await harness.selectOption('semantic-test');
  await expect(model).toHaveValue('semantic-model');
  await expect(effort).toHaveValue('medium');
  await expect(effort.locator('option')).toHaveText(['low', 'medium']);
  await expect(codexSettings).toHaveCount(0);
  await expect(steering).toHaveAttribute('aria-checked', 'false');
  await expect(steering).toBeDisabled();
  await harness.selectOption('codex');
  await expect(model).toHaveValue('test-model');
  await expect(effort).toHaveValue('high');
  await expect(codexSettings).toBeVisible();
  await expect(steering).toBeEnabled();
  await expect(steering).toHaveAttribute('aria-checked', 'false');
  await Promise.all([
    page.waitForRequest((request) => request.url().endsWith('/api/harnesses/semantic-test/models')),
    harness.selectOption('semantic-test'),
  ]);
  await expect(model).toHaveValue('semantic-model');
  await expect(effort).toHaveValue('medium');
  await expect(codexSettings).toHaveCount(0);
  releaseRefresh();
  const [creation] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/agents/batch') && response.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: '创建 Agent', exact: true }).click(),
  ]);
  expect(creation.request().postDataJSON()).toEqual({
    harness: 'semantic-test',
    name: 'Semantic catalog test',
    workspacePaths: [],
    count: 1,
    model: 'semantic-model',
    reasoningEffort: 'medium',
    canCreateGroups: false,
    steerEnabled: false,
    dangerFullAccess: false,
  });
  expect(creation.status()).toBe(404);
  await expect(dialog.getByRole('alert')).toContainText('未注册的 harness：semantic-test');
  const after = (await (await page.request.get('/api/agents')).json()) as { agents: Agent[] };
  expect(after.agents.map((agent) => agent.id)).toEqual(before.agents.map((agent) => agent.id));
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
});

test('opens the workspace and connects through the Web proxy to SQLite-backed health', async ({
  page,
}, testInfo) => {
  // Exercise the empty state independently of retained history from management tests.
  await page.route(
    (url) => url.pathname === '/api/channels',
    async (route) => {
      const response = await route.fetch();
      const { cursor } = (await response.json()) as { cursor: number };
      await route.fulfill({ response, json: { channels: [], cursor } });
    },
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '让独立的 AI 一起工作。' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('服务已连接');
  await page.screenshot({ path: testInfo.outputPath('workspace.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('workspace-mobile.png'), fullPage: true });
});

test('persists per-Agent complete access through creation, edit and details on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const agent = await createAgent(page, '权限模式 Agent', false, true);
  expect(agent.dangerFullAccess).toBe(true);
  const ready = (await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent as Agent;
  const identity = {
    threadId: ready.threadId,
    workspace: agent.workspace,
    channelId: agent.channelId,
  };
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  const inspector = page.getByTestId('inspector');
  await expect(inspector.getByRole('switch', { name: '完整访问', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('button', { name: '编辑 Agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑 Agent', exact: true });
  await dialog.getByRole('switch', { name: '完整访问', exact: true }).click();
  const [edited] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/agents/${agent.id}`) &&
        response.request().method() === 'PATCH',
    ),
    dialog.getByRole('button', { name: '保存修改', exact: true }).click(),
  ]);
  expect(edited.request().postDataJSON()).toEqual({ dangerFullAccess: false });
  expect(await edited.json()).toMatchObject({ dangerFullAccess: false, ...identity });
  await expect(dialog).not.toBeVisible();
  await expect(inspector.getByRole('switch', { name: '完整访问', exact: true })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  const [enabled] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/agents/${agent.id}`) &&
        response.request().method() === 'PATCH',
    ),
    inspector.getByRole('switch', { name: '完整访问', exact: true }).click(),
  ]);
  expect(enabled.request().postDataJSON()).toEqual({ dangerFullAccess: true });
  await page.reload();
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  await expect(inspector.getByRole('switch', { name: '完整访问', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect((await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent).toMatchObject({
    dangerFullAccess: true,
    ...identity,
  });
  expect(await noHorizontalScroll(page)).toBe(false);
  expect((await page.request.delete(`/api/agents/${agent.id}`)).ok()).toBe(true);
});

test('answers native execution approval through the existing question form', async ({ page }) => {
  await page.goto('/');
  const agent = await createAgent(page, '原生授权 Agent');
  await send(page, '请请求原生执行授权');
  await expect(page.getByText(`${agent.name} 需要你的回答`)).toBeVisible();
  await expect(page.getByText('执行授权', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: /^允许本次/ }).check();
  const [answered] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes('/questions/') && response.request().method() === 'POST',
    ),
    page.getByRole('button', { name: '提交回答', exact: true }).click(),
  ]);
  expect(answered.request().postDataJSON()).toEqual({
    answers: { permission: { answers: ['允许本次'] } },
  });
  await expect(page.locator('[data-sender="agent"]').last()).toContainText(
    'MCP 回复：请请求原生执行授权',
  );
  await expect(page.getByText(`${agent.name} 需要你的回答`)).not.toBeVisible();
  expect((await page.request.delete(`/api/agents/${agent.id}`)).ok()).toBe(true);
});

test('creates an Agent, publishes MCP replies, persists reload and handles stop/resume and native questions', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const agent = await createAgent(page, '浏览器 Agent');
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
  await expect(page.getByText(`${agent.name} 需要你的回答`)).toBeVisible();
  await page.getByRole('radio', { name: /^继续/ }).check();
  await page.getByRole('button', { name: '提交回答' }).click();
  await expect(replies.last()).toContainText('MCP 回复：请向我提问');
  await expect(page.getByText(`${agent.name} 需要你的回答`)).not.toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('chat-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('chat-mobile.png'), fullPage: true });
  expect(await noHorizontalScroll(page)).toBe(false);
  expect(errors).toEqual([]);
});

test.describe('Markdown chat exports', () => {
  test.use({ timezoneId: 'Asia/Shanghai' });

  async function download(page: Page) {
    await page.getByRole('button', { name: '聊天操作', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: '导出聊天记录', exact: true }).click();
    const file = await pending;
    expect(await file.failure()).toBeNull();
    return {
      filename: file.suggestedFilename(),
      markdown: await readFile((await file.path())!, 'utf8'),
    };
  }

  test('downloads all private history on mobile, retries failures and exports a retired Agent', async ({
    page,
  }) => {
    await page.goto('/');
    const agent = await createAgent(page, 'Markdown 导出验证');
    await page.getByRole('button', { name: '停止 Agent', exact: true }).click();
    await expect(page.getByTestId('agent-status')).toHaveText('已停止');
    const empty = await download(page);
    expect(empty.markdown).toContain('- 消息数：0');
    for (let seq = 1; seq <= 105; seq++) {
      const response = await page.request.post(`/api/channels/${agent.channelId}/messages`, {
        data: {
          body: seq === 1 ? '最早隐藏消息\n\n```ts\nconst x = 1;' : `导出历史 ${seq}`,
          clientId: `export-${seq}`,
          ...(seq === 105 && { replyTo: 1, mentions: [agent.id] }),
        },
      });
      expect(response.status()).toBe(201);
    }
    await page.reload();
    await expect(page.getByRole('heading', { name: agent.name, level: 1 })).toBeVisible();
    await expect(page.getByText('最早隐藏消息', { exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });

    const exportUrl = `**/api/channels/${agent.channelId}/export*`;
    await page.route(exportUrl, (route) =>
      route.fulfill({ status: 503, json: { error: '导出服务暂时不可用，请重试' } }),
    );
    await page.getByRole('button', { name: '聊天操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '导出聊天记录', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '导出服务暂时不可用' })).toBeVisible();
    await page.unroute(exportUrl);
    const file = await download(page);
    expect(file.filename).toMatch(/^私聊-Markdown 导出验证-1-\d{8}-\d{6}\.md$/);
    expect(file.markdown).toContain(`# 与 ${agent.name} 的聊天记录`);
    expect(file.markdown).toContain('- 消息数：105');
    expect(file.markdown).toContain('> 最早隐藏消息\n>\n> ```ts\n> const x = 1;');
    expect(file.markdown).toContain('回复：#1（用户）');
    expect(file.markdown).toContain(`提及：@${agent.name}`);
    expect(file.markdown).toContain('+08:00');
    expect(file.markdown.match(/^## #\d+/gm)).toHaveLength(105);
    expect(file.markdown).not.toContain('原生详情');
    const detail = await (await page.request.get(`/api/channels/${agent.channelId}`)).json();
    expect(
      detail.messages.every((message: { deliveries: { status: string }[] }) =>
        message.deliveries.every((delivery) => delivery.status === 'queued'),
      ),
    ).toBe(true);
    await expect(page.getByRole('alert').filter({ hasText: '导出服务暂时不可用' })).toHaveCount(0);
    expect(await noHorizontalScroll(page)).toBe(false);

    expect((await page.request.delete(`/api/agents/${agent.id}`)).status()).toBe(200);
    await expect(page.getByTestId('agent-status')).toHaveText('已删除');
    const retired = await download(page);
    expect(retired.markdown).toContain('> 最早隐藏消息');
    expect(retired.markdown).toContain('- 消息数：105');
  });

  test('downloads group messages and system history after group deletion', async ({ page }) => {
    await page.goto('/');
    const agent = await createAgent(page, '群导出验证 Agent');
    await page.getByRole('button', { name: '新建群聊', exact: true }).click();
    await page.getByLabel('群名').fill('导出/群聊:*?');
    await page.getByRole('checkbox', { name: agent.name }).check();
    const [created] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/channels') && response.request().method() === 'POST',
      ),
      page.getByRole('button', { name: '创建群聊', exact: true }).click(),
    ]);
    const group = (await created.json()) as Channel;
    await send(page, '完整导出的群聊正文');
    await expect(page.locator('[data-sender="agent"]').last()).toContainText(
      'MCP 回复：完整导出的群聊正文',
    );
    expect((await page.request.delete(`/api/channels/${group.id}`)).status()).toBe(200);
    await expect(page.getByTestId('group-status')).toHaveText('已删除');
    const file = await download(page);
    expect(file.filename).toMatch(/^群聊-导出-群聊----\d{8}-\d{6}\.md$/);
    expect(file.markdown).toContain('# 导出/群聊:\\*?');
    expect(file.markdown).toContain('- 类型：群聊');
    expect(file.markdown).toContain('Isles（系统）');
    expect(file.markdown).toContain(`${agent.name}（Agent）`);
    expect(file.markdown).toContain('> 完整导出的群聊正文');
    expect(file.markdown).toContain('> MCP 回复：完整导出的群聊正文');
    expect(file.markdown).toContain('回复：#');
    expect(file.markdown).toContain('用户删除了群聊');
    // This suite shares its server; leave the live contact directory unchanged.
    expect((await page.request.delete(`/api/agents/${agent.id}`)).status()).toBe(200);
  });
});

test('navigates mobile chats, searches contacts and keeps drafts and IME input in the correct conversation', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const contacts = page.getByRole('navigation', { name: 'Agents', exact: true });
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  await contacts.getByRole('button').filter({ hasText: '浏览器 Agent-1' }).click();
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
  await contacts.getByRole('button').filter({ hasText: '浏览器 Agent-1' }).click();
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
  await page.getByRole('checkbox', { name: /浏览器 Agent-1/ }).check();
  await page.getByRole('checkbox', { name: /第二个 Agent-1/ }).check();
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
  await expect(composer(page)).toHaveValue('请大家看看，@第二个 Agent-1 ');
  await composer(page).pressSequentially('你怎么看');
  await composer(page).press('Enter');
  await expect(feed.locator('[data-sender="user"] .mention')).toHaveText('@第二个 Agent-1');
  // Every member is woken, whoever is mentioned; each answers once and the round settles.
  const replies = feed.locator('[data-sender="agent"]');
  await expect(replies).toHaveCount(2);
  for (const name of ['浏览器 Agent-1', '第二个 Agent-1'])
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
  await inspector.getByRole('button', { name: '查看 第二个 Agent-1 的详情' }).click();
  const permission = inspector.getByRole('switch', { name: '允许拉群' });
  await expect(permission).toHaveAttribute('aria-checked', 'false');
  await permission.click();
  await expect(permission).toHaveAttribute('aria-checked', 'true');
  await inspector.getByRole('button', { name: '返回群聊详情' }).click();
  await page.screenshot({ path: testInfo.outputPath('group-desktop.png'), fullPage: true });
  await inspector.getByRole('button', { name: '将 第二个 Agent-1 移出群聊' }).click();
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
  const agent = await createAgent(page, '收信 Agent');
  await send(page, '请在执行中收信');
  await expect(page.getByText(`${agent.name} 需要你的回答`)).toBeVisible();
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
  await expect(page.getByRole('status')).toContainText('服务连接异常');
  await page.unroute('**/api/health');
  await page.getByRole('button', { name: '重新连接服务' }).click();
  await expect(page.getByRole('status')).toContainText('服务已连接');
});

test('edits an Agent without resetting its effort or changing its native conversation', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const original = await createAgent(page, '编辑验证 Agent');
  await send(page, '编辑前的消息');
  await expect(page.locator('[data-sender="agent"]').last()).toContainText(
    'MCP 回复：编辑前的消息',
  );
  expect(original.threadId).toBeTruthy();
  let releaseCatalog!: () => void;
  const catalogReady = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  await page.route('**/api/harnesses/codex/models', async (route) => {
    const response = await route.fetch();
    await catalogReady;
    await route.fulfill({ response });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  await page.getByRole('button', { name: '编辑 Agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑 Agent', exact: true });
  await expect(dialog.getByLabel('推理等级')).toHaveValue('max');
  await expect(dialog.getByLabel('模型', { exact: true })).toBeDisabled();
  releaseCatalog();
  await expect(dialog.getByLabel('模型', { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('推理等级')).toHaveValue('max');
  await page.unroute('**/api/harnesses/codex/models');
  await dialog.getByLabel('名称').fill('改名后的 Agent');
  const [rename] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/agents/${original.id}`) &&
        response.request().method() === 'PATCH',
    ),
    dialog.getByRole('button', { name: '保存修改', exact: true }).click(),
  ]);
  expect(rename.request().postDataJSON()).toEqual({ name: '改名后的 Agent' });
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '改名后的 Agent', level: 1 })).toBeVisible();
  await expect(page.getByTestId('inspector')).toContainText('test-model · max');

  await page.getByRole('button', { name: '编辑 Agent', exact: true }).click();
  await dialog.getByLabel('模型', { exact: true }).selectOption('test-model-2');
  await expect(dialog.getByLabel('推理等级')).toHaveValue('max');
  await dialog.getByLabel('推理等级').selectOption('high');
  await dialog.getByRole('switch', { name: '允许拉群', exact: true }).click();
  const [edit] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/agents/${original.id}`) &&
        response.request().method() === 'PATCH',
    ),
    dialog.getByRole('button', { name: '保存修改', exact: true }).click(),
  ]);
  expect(edit.status()).toBe(200);
  expect(await edit.json()).toMatchObject({
    id: original.id,
    name: '改名后的 Agent',
    model: 'test-model-2',
    reasoningEffort: 'high',
    canCreateGroups: true,
    threadId: original.threadId,
    workspace: original.workspace,
    channelId: original.channelId,
  });
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId('inspector')).toContainText('test-model-2 · high');
  await expect(
    page.getByTestId('inspector').getByRole('switch', { name: '允许拉群' }),
  ).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(page.getByRole('heading', { name: '改名后的 Agent', level: 1 })).toBeVisible();
  await expect(page.locator('[data-sender="agent"]').last()).toContainText(
    'MCP 回复：编辑前的消息',
  );
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  await expect(page.getByTestId('inspector')).toContainText(original.threadId!);
  await page.getByRole('button', { name: '编辑 Agent', exact: true }).click();
  await expect(dialog.getByLabel('名称')).toHaveValue('改名后的 Agent');
  await expect(dialog.getByLabel('模型', { exact: true })).toHaveValue('test-model-2');
  await expect(dialog.getByLabel('推理等级')).toHaveValue('high');
  await expect(dialog.getByRole('switch', { name: '允许拉群' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath('edit-agent-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await send(page, '编辑后的消息');
  await expect(page.locator('[data-sender="agent"]').last()).toContainText(
    'MCP 回复：编辑后的消息',
  );
  const detail = (await (await page.request.get(`/api/agents/${original.id}`)).json()) as {
    agent: Agent;
  };
  expect(detail.agent.threadId).toBe(original.threadId);
  expect(errors).toEqual([]);
});

test('can edit name and permission when the model catalog is unavailable', async ({ page }) => {
  await page.goto('/');
  const original = await createAgent(page, '离线编辑 Agent');
  await page.route('**/api/harnesses/codex/models', (route) =>
    route.fulfill({ status: 503, json: { error: '模型列表暂时不可用' } }),
  );
  await page.reload();
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  await page.getByRole('button', { name: '编辑 Agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑 Agent', exact: true });
  await expect(dialog.getByLabel('模型', { exact: true })).toHaveValue('test-model');
  await expect(dialog.getByLabel('模型', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('推理等级')).toHaveValue('max');
  await dialog.getByLabel('名称').fill('离线改名 Agent');
  await dialog.getByRole('switch', { name: '允许拉群' }).click();
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/agents/${original.id}`) &&
        response.request().method() === 'PATCH',
    ),
    dialog.getByRole('button', { name: '保存修改', exact: true }).click(),
  ]);
  expect(response.request().postDataJSON()).toEqual({
    name: '离线改名 Agent',
    canCreateGroups: true,
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({
    model: original.model,
    reasoningEffort: original.reasoningEffort,
    threadId: original.threadId,
  });
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '离线改名 Agent', level: 1 })).toBeVisible();
});

test('persists per-Agent steer selected at creation and can disable it without an available model catalog', async ({
  page,
}) => {
  await page.goto('/');
  const original = await createAgent(page, '实时收信配置 Agent', true);
  expect(original.steerEnabled).toBe(true);
  expect(original.threadId).toBeTruthy();
  await page.route('**/api/harnesses/codex/models', (route) =>
    route.fulfill({ status: 503, json: { error: '模型目录暂时不可用' } }),
  );
  await page.reload();
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  const inspector = page.getByTestId('inspector');
  await expect(
    inspector.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: '编辑 Agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑 Agent', exact: true });
  const steering = dialog.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true });
  await expect(steering).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByText('模型列表加载失败', { exact: false })).toBeVisible();
  await steering.click();
  const [save] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/agents/${original.id}`) &&
        response.request().method() === 'PATCH',
    ),
    dialog.getByRole('button', { name: '保存修改', exact: true }).click(),
  ]);
  expect(save.request().postDataJSON()).toEqual({ steerEnabled: false });
  expect(save.status()).toBe(200);
  expect(await save.json()).toMatchObject({
    id: original.id,
    steerEnabled: false,
    threadId: original.threadId,
  });
  await expect(dialog).not.toBeVisible();
  await expect(
    inspector.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  await expect(
    inspector.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');
  const restored = (await (await page.request.get(`/api/agents/${original.id}`)).json()) as {
    agent: Agent;
  };
  expect(restored.agent).toMatchObject({
    steerEnabled: false,
    threadId: original.threadId,
    workspace: original.workspace,
  });
});

test('allows switching saved steer off when the current harness directory no longer advertises support', async ({
  page,
}) => {
  await page.goto('/');
  const original = await createAgent(page, '原生能力变化 Agent', true);
  await page.route('**/api/harnesses', async (route) => {
    const response = await route.fetch();
    const directory = (await response.json()) as { harnesses: HarnessDescriptor[] };
    await route.fulfill({
      response,
      json: {
        harnesses: directory.harnesses.map((harness) => ({
          ...harness,
          capabilities: { ...harness.capabilities, steer: false },
        })),
      },
    });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  await page.getByRole('button', { name: '编辑 Agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑 Agent', exact: true });
  const steering = dialog.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true });
  await expect(
    dialog.getByText('实时接收需要 harness 的 steer 支持，当前设置可关闭。'),
  ).toBeVisible();
  await expect(steering).toHaveAttribute('aria-checked', 'true');
  await expect(steering).toBeEnabled();
  await steering.click();
  await expect(steering).toBeDisabled();
  const [save] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/agents/${original.id}`) &&
        response.request().method() === 'PATCH',
    ),
    dialog.getByRole('button', { name: '保存修改', exact: true }).click(),
  ]);
  expect(save.request().postDataJSON()).toEqual({ steerEnabled: false });
  expect(save.status()).toBe(200);
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '编辑 Agent', exact: true }).click();
  await expect(steering).toHaveAttribute('aria-checked', 'false');
  await expect(steering).toBeDisabled();
});

test('deletes an Agent from contacts and groups while retaining read-only history', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const original = await createAgent(page, '删除验证 Agent');
  await send(page, '保留这条私聊历史');
  await expect(page.locator('[data-sender="agent"]').last()).toContainText(
    'MCP 回复：保留这条私聊历史',
  );
  await page.getByRole('button', { name: '新建群聊', exact: true }).click();
  await page.getByLabel('群名').fill('删除验证群');
  await page.getByRole('checkbox', { name: original.name }).check();
  await page.getByRole('button', { name: '创建群聊', exact: true }).click();
  await send(page, '保留这条群聊历史');
  const groupFeed = page.locator('[aria-label="群聊消息"]');
  await expect(groupFeed.getByRole('article', { name: `${original.name}的消息` })).toContainText(
    'MCP 回复：保留这条群聊历史',
  );
  await page.getByRole('button', { name: '群聊详情', exact: true }).click();
  const inspector = page.getByTestId('inspector');
  await inspector.getByRole('button', { name: `查看 ${original.name} 的详情` }).click();
  await expect(inspector.getByText('可用', { exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: '删除 Agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除 Agent', exact: true });
  await expect(dialog).toContainText('退出所有群聊');
  await expect(dialog).toContainText('个人工作目录及共享文件都会保留');
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const unchanged = (await (await page.request.get(`/api/agents/${original.id}`)).json()) as {
    agent: Agent;
  };
  expect(unchanged.agent.status).toBe('ready');
  await inspector.getByRole('button', { name: '返回群聊详情', exact: true }).click();
  await expect(inspector.getByRole('list', { name: '群成员' }).getByRole('listitem')).toHaveCount(
    1,
  );
  await inspector.getByRole('button', { name: `查看 ${original.name} 的详情` }).click();
  await inspector.getByRole('button', { name: '删除 Agent', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath('delete-agent-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const [deleted] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/agents/${original.id}`) &&
        response.request().method() === 'DELETE',
    ),
    dialog.getByRole('button', { name: '确认删除', exact: true }).click(),
  ]);
  expect(deleted.status()).toBe(200);
  expect(await deleted.json()).toMatchObject({
    id: original.id,
    name: original.name,
    status: 'deleted',
    threadId: original.threadId,
    workspace: original.workspace,
  });
  await expect(dialog).not.toBeVisible();
  await expect(inspector.getByRole('heading', { name: '群聊详情', exact: true })).toBeVisible();
  await expect(inspector.getByRole('list', { name: '群成员' }).getByRole('listitem')).toHaveCount(
    0,
  );
  await expect(groupFeed.getByRole('article', { name: `${original.name}的消息` })).toContainText(
    'MCP 回复：保留这条群聊历史',
  );
  const active = (await (await page.request.get('/api/agents')).json()) as { agents: Agent[] };
  expect(active.agents.some((agent) => agent.id === original.id)).toBe(false);
  const directory = (await (await page.request.get('/api/agents?includeDeleted=true')).json()) as {
    agents: Agent[];
  };
  expect(directory.agents.find((agent) => agent.id === original.id)?.status).toBe('deleted');
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.getByRole('button', { name: '返回聊天列表', exact: true }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Agents', exact: true })
      .getByRole('button')
      .filter({ hasText: original.name }),
  ).toHaveCount(0);
  await page
    .getByRole('navigation', { name: '历史对话', exact: true })
    .getByRole('button')
    .filter({ hasText: original.name })
    .click();
  await expect(page.getByRole('heading', { name: original.name, level: 1 })).toBeVisible();
  await expect(page.getByTestId('agent-status')).toHaveText('已删除');
  await expect(page.getByRole('article', { name: `${original.name}的消息` })).toContainText(
    'MCP 回复：保留这条私聊历史',
  );
  await expect(composer(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '恢复 Agent', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  await expect(inspector).toContainText('此 Agent 已删除，对话以只读方式保留');
  await expect(inspector.locator('details[data-run]')).toHaveCount(2);
  await expect(inspector.getByRole('button', { name: '编辑 Agent', exact: true })).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: '删除 Agent', exact: true })).toHaveCount(0);
  await expect(inspector.getByRole('switch')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: original.name, level: 1 })).toBeVisible();
  await expect(page.getByTestId('agent-status')).toHaveText('已删除');
  await expect(page.getByRole('article', { name: `${original.name}的消息` })).toContainText(
    'MCP 回复：保留这条私聊历史',
  );
  await expect(composer(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '恢复 Agent', exact: true })).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath('deleted-agent-history-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});

test('deletes a group into read-only history without changing its member Agent', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const original = await createAgent(page, '群删除验证 Agent');
  await send(page, '群删除前的私聊');
  await expect(page.locator('[data-sender="agent"]').last()).toContainText(
    'MCP 回复：群删除前的私聊',
  );

  await page.getByRole('button', { name: '新建群聊', exact: true }).click();
  await page.getByLabel('群名').fill('待删除的群聊');
  await page.getByRole('checkbox', { name: original.name }).check();
  await page.getByRole('button', { name: '创建群聊', exact: true }).click();
  await send(page, '保留群聊回复');
  const groupFeed = page.locator('[aria-label="群聊消息"]');
  await expect(groupFeed.getByRole('article', { name: `${original.name}的消息` })).toContainText(
    'MCP 回复：保留群聊回复',
  );
  await page.getByRole('button', { name: '群聊详情', exact: true }).click();
  const inspector = page.getByTestId('inspector');
  await inspector.getByLabel('群名').fill('改名后删除的群聊');
  await inspector.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '改名后删除的群聊', level: 1 })).toBeVisible();
  const channels = (await (await page.request.get('/api/channels')).json()) as {
    channels: Channel[];
  };
  const group = channels.channels.find((channel) => channel.name === '改名后删除的群聊')!;
  await inspector.getByRole('button', { name: '删除群聊', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除群聊', exact: true });
  await expect(dialog).toContainText('群聊历史、个人工作目录及共享文件都会保留');
  await expect(dialog).toContainText('成员 Agent 保持各自运行状态');
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(inspector.getByRole('list', { name: '群成员' }).getByRole('listitem')).toHaveCount(
    1,
  );
  const unchanged = (await (await page.request.get(`/api/channels/${group.id}`)).json()) as {
    channel: Channel;
  };
  expect(unchanged.channel.deletedAt).toBeNull();

  // Deleting a paused group must remove both pause and continue controls.
  await page.getByRole('button', { name: '暂停讨论', exact: true }).click();
  await expect(page.getByTestId('group-status')).toHaveText('已暂停');
  await inspector.getByRole('button', { name: '删除群聊', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath('delete-group-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const [deleted] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/channels/${group.id}`) &&
        response.request().method() === 'DELETE',
    ),
    dialog.getByRole('button', { name: '确认删除', exact: true }).click(),
  ]);
  expect(deleted.status()).toBe(200);
  expect(await deleted.json()).toMatchObject({ id: group.id, name: group.name, memberIds: [] });
  await expect(dialog).not.toBeVisible();
  await expect(inspector).toContainText('此群聊已删除，对话以只读方式保留');
  await expect(inspector.getByLabel('群名')).toHaveCount(0);
  await expect(inspector.getByRole('list', { name: '群成员' })).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: '添加成员', exact: true })).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: '删除群聊', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await expect(page.getByTestId('group-status')).toHaveText('已删除');
  await expect(composer(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '继续讨论', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '暂停讨论', exact: true })).toHaveCount(0);
  await expect(groupFeed.getByRole('article', { name: `${original.name}的消息` })).toContainText(
    'MCP 回复：保留群聊回复',
  );
  await page.getByRole('button', { name: '返回聊天列表', exact: true }).click();
  await expect(
    page
      .getByRole('navigation', { name: '群聊', exact: true })
      .getByRole('button')
      .filter({ hasText: group.name! }),
  ).toHaveCount(0);
  const history = page
    .getByRole('navigation', { name: '历史对话', exact: true })
    .getByRole('button')
    .filter({ hasText: group.name! });
  await expect(history).toContainText('已删除');
  await expect(history.getByText('已暂停', { exact: true })).toHaveCount(0);
  await history.click();
  await page.reload();
  await expect(page.getByRole('heading', { name: group.name!, level: 1 })).toBeVisible();
  await expect(page.getByTestId('group-status')).toHaveText('已删除');
  await expect(composer(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '继续讨论', exact: true })).toHaveCount(0);
  await expect(groupFeed.getByRole('article', { name: `${original.name}的消息` })).toContainText(
    'MCP 回复：保留群聊回复',
  );
  expect(await noHorizontalScroll(page)).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath('deleted-group-history-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '群聊详情', exact: true }).click();
  await expect(inspector).toContainText('此群聊已删除，对话以只读方式保留');
  await expect(inspector.getByText('创建', { exact: true })).toBeVisible();
  await expect(inspector.getByText('删除', { exact: true })).toBeVisible();
  await expect(inspector.getByRole('textbox')).toHaveCount(0);
  await expect(inspector.getByRole('list', { name: '群成员' })).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: '添加成员', exact: true })).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: '删除群聊', exact: true })).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath('deleted-group-details-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();

  await page.getByRole('button', { name: '返回聊天列表', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Agents', exact: true })
    .getByRole('button')
    .filter({ hasText: original.name })
    .click();
  await expect(page.getByTestId('agent-status')).toHaveText('可用');
  await send(page, '群删除后的私聊');
  await expect(page.locator('[data-sender="agent"]').last()).toContainText(
    'MCP 回复：群删除后的私聊',
  );
  const detail = (await (await page.request.get(`/api/agents/${original.id}`)).json()) as {
    agent: Agent;
  };
  expect(detail.agent).toMatchObject({
    status: 'ready',
    desiredState: original.desiredState,
    threadId: original.threadId,
    workspace: original.workspace,
    channelId: original.channelId,
  });
  expect(errors).toEqual([]);
});

test('returns an inspected group member to read-only group details after external deletion', async ({
  page,
}) => {
  await page.goto('/');
  const agent = await createAgent(page, '外部群删除 Agent');
  const created = await page.request.post('/api/channels', {
    data: { name: '外部删除群聊', memberIds: [agent.id] },
  });
  expect(created.status()).toBe(201);
  const channel = (await created.json()) as Channel;
  await page.getByRole('button', { name: '刷新聊天列表', exact: true }).click();
  await page
    .getByRole('navigation', { name: '群聊', exact: true })
    .getByRole('button')
    .filter({ hasText: channel.name! })
    .click();
  await page.getByRole('button', { name: '群聊详情', exact: true }).click();
  const inspector = page.getByTestId('inspector');
  await inspector.getByRole('button', { name: `查看 ${agent.name} 的详情`, exact: true }).click();
  await expect(inspector.getByRole('heading', { name: agent.name, exact: true })).toBeVisible();
  expect((await page.request.delete(`/api/channels/${channel.id}`)).status()).toBe(200);
  await expect(inspector.getByRole('heading', { name: '群聊详情', exact: true })).toBeVisible();
  await expect(inspector).toContainText('此群聊已删除，对话以只读方式保留');
  await expect(inspector.getByRole('button', { name: '返回群聊详情', exact: true })).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: '编辑 Agent', exact: true })).toHaveCount(0);
});

test('appends busy input through steer and displays pending delivery without starting another run', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const agent = await createAgent(page, '忙碌 steer 验证', true);
  await send(page, '保持执行以验证 steer');
  await expect(page.getByTestId('agent-status')).toHaveText('执行中');
  await send(page, '忙碌中的追加消息');
  const message = page
    .getByRole('article', { name: '你的消息', exact: true })
    .filter({ hasText: '忙碌中的追加消息' });
  await expect(message).toContainText('投递中');
  await page.screenshot({
    path: testInfo.outputPath('steer-pending.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await expect(page.locator('[data-sender="agent"]').last()).toContainText(
    'MCP steer 回复：忙碌中的追加消息',
  );
  await expect(page.getByTestId('agent-status')).toHaveText('可用');
  const detail = (await (await page.request.get(`/api/agents/${agent.id}`)).json()) as {
    agent: Agent;
    runs: { id: string; turnId: string; inputs: { channelId: string; messageSeqs: number[] }[] }[];
  };
  expect(detail.agent.threadId).toBe(agent.threadId);
  expect(detail.runs).toHaveLength(1);
  expect(detail.runs[0]!.inputs).toEqual([{ channelId: agent.channelId, messageSeqs: [1, 2] }]);
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  const steering = page
    .getByTestId('inspector')
    .getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true });
  await steering.click();
  await expect(steering).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  await expect(
    page
      .getByTestId('inspector')
      .getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');
});

test('creates Claude with independent path/model settings and joins a Codex/Claude group', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const originalPath = (await (await page.request.get('/api/harnesses/claude/config')).json())
    .binaryPath as string;
  const codexPath = (await (await page.request.get('/api/harnesses/codex/config')).json())
    .binaryPath;
  await page.getByRole('button', { name: '新建 Agent' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建 Agent', exact: true });
  await dialog.getByLabel('Harness').selectOption('claude');
  await expect(dialog.getByLabel('模型', { exact: true })).toHaveValue('test-claude-model');
  await expect(dialog.getByLabel('推理等级')).toHaveValue('default');
  await expect(
    dialog.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: 'Claude Code 路径设置', exact: true }).click();
  await expect(dialog.getByLabel('Claude Code 可执行文件路径')).toHaveValue(originalPath);
  await dialog.getByRole('button', { name: '保存并检测', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('路径设置已保存');
  expect((await (await page.request.get('/api/harnesses/codex/config')).json()).binaryPath).toBe(
    codexPath,
  );
  await dialog.getByLabel('Harness').selectOption('codex');
  await expect(dialog.getByLabel('模型', { exact: true })).toHaveValue('test-model');
  await expect(dialog.getByRole('button', { name: 'Codex 路径设置', exact: true })).toBeVisible();
  await dialog.getByLabel('Harness').selectOption('claude');
  await dialog.getByLabel('名称').fill('Claude 浏览器验证');
  await dialog.getByLabel('推理等级').selectOption('high');
  const [created] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/agents/batch') && response.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: '创建 Agent', exact: true }).click(),
  ]);
  expect(created.request().postDataJSON()).toMatchObject({
    harness: 'claude',
    model: 'test-claude-model',
    reasoningEffort: 'high',
    steerEnabled: false,
  });
  const claude = ((await created.json()) as { agents: Agent[] }).agents[0]!;
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/agents/${claude.id}`)).json()).agent.status,
    )
    .toBe('ready');
  const binding = (await (await page.request.get(`/api/agents/${claude.id}`)).json()).agent
    .threadId;
  expect(
    (await (await page.request.get(`/api/channels/${claude.channelId}`)).json()).messages,
  ).toEqual([]);
  await page.getByRole('textbox', { name: '消息输入' }).fill('浏览器 Claude 私聊');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('[data-sender="agent"]').last()).toContainText(
    'Claude MCP 回复：浏览器 Claude 私聊',
  );
  await page.getByRole('button', { name: '停止 Agent', exact: true }).click();
  await expect(page.getByTestId('agent-status')).toHaveText('已停止');
  await page.getByRole('button', { name: '恢复 Agent', exact: true }).click();
  await expect(page.getByTestId('agent-status')).toHaveText('可用');
  expect((await (await page.request.get(`/api/agents/${claude.id}`)).json()).agent.threadId).toBe(
    binding,
  );

  const codex = (await (
    await page.request.post('/api/agents', {
      data: {
        harness: 'codex',
        name: 'Codex 混合浏览器验证',
        model: 'test-model',
        reasoningEffort: 'high',
      },
    })
  ).json()) as Agent;
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/agents/${codex.id}`)).json()).agent.status,
    )
    .toBe('ready');
  await page.getByRole('button', { name: '新建群聊', exact: true }).click();
  await page.getByLabel('群名').fill('浏览器混合群');
  await page.getByRole('checkbox', { name: claude.name }).check();
  await page.getByRole('checkbox', { name: /Codex 混合浏览器验证/ }).check();
  await page.getByRole('button', { name: '创建群聊', exact: true }).click();
  await page.getByRole('textbox', { name: '消息输入' }).fill('混合群浏览器消息');
  await page.getByRole('button', { name: '发送消息' }).click();
  const feed = page.locator('[aria-label="群聊消息"]');
  await expect(feed.getByRole('article', { name: `${claude.name}的消息` })).toContainText(
    'Claude MCP 回复：混合群浏览器消息',
  );
  await expect(feed.getByRole('article', { name: 'Codex 混合浏览器验证的消息' })).toContainText(
    'MCP 回复：混合群浏览器消息',
  );
  expect(errors).toEqual([]);
});

test('steers Claude busy input through the Web in the original run and persists the preference', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建 Agent' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建 Agent', exact: true });
  await dialog.getByLabel('Harness').selectOption('claude');
  await dialog.getByLabel('名称').fill('Claude steer 浏览器验证');
  const switchControl = dialog.getByRole('switch', {
    name: '忙碌时实时接收（steer）',
    exact: true,
  });
  await expect(switchControl).toBeEnabled();
  await expect(switchControl).toHaveAttribute('aria-checked', 'false');
  await switchControl.click();
  const [created] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/agents/batch') && response.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: '创建 Agent', exact: true }).click(),
  ]);
  const agent = ((await created.json()) as { agents: Agent[] }).agents[0]!;
  expect(agent.steerEnabled).toBe(true);
  await expect(page.getByTestId('agent-status')).toHaveText('可用');
  await send(page, '保持执行以验证 Claude steer');
  await expect(page.getByTestId('agent-status')).toHaveText('执行中');
  await send(page, 'Claude 当前执行中的补充指令');
  await expect(
    page
      .getByRole('article', { name: '你的消息', exact: true })
      .filter({ hasText: 'Claude 当前执行中的补充指令' }),
  ).toContainText('投递中');
  await expect(page.locator('[data-sender="agent"]').last()).toContainText(
    'Claude MCP 回复：Claude 当前执行中的补充指令',
  );
  await expect(page.getByTestId('agent-status')).toHaveText('可用');
  const detail = await (await page.request.get(`/api/agents/${agent.id}`)).json();
  expect(detail.runs).toHaveLength(1);
  expect(detail.runs[0].inputs).toEqual([{ channelId: agent.channelId, messageSeqs: [1, 2] }]);
  const binding = detail.agent.threadId;
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  const steering = page
    .getByTestId('inspector')
    .getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true });
  await expect(steering).toHaveAttribute('aria-checked', 'true');
  await steering.click();
  await expect(steering).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  await expect(
    page
      .getByTestId('inspector')
      .getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');
  expect((await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent.threadId).toBe(
    binding,
  );
});

test('creates Kimi Code, queues busy input and answers a native multi-select question through the Web', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const kimiPath = (await (await page.request.get('/api/harnesses/kimi/config')).json())
    .binaryPath as string;
  await page.getByRole('button', { name: '新建 Agent' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建 Agent', exact: true });
  await dialog.getByLabel('Harness').selectOption('kimi');
  await expect(dialog.getByLabel('模型', { exact: true })).toHaveValue('test-kimi-model');
  await expect(dialog.getByLabel('推理等级')).toHaveValue('high');
  await expect(
    dialog.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');
  await dialog.getByRole('button', { name: 'Kimi Code 路径设置', exact: true }).click();
  await expect(dialog.getByLabel('Kimi Code 可执行文件路径')).toHaveValue(kimiPath);
  await dialog.getByLabel('名称').fill('Kimi 浏览器验证');
  const [created] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/agents/batch') && response.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: '创建 Agent', exact: true }).click(),
  ]);
  expect(created.request().postDataJSON()).toMatchObject({
    harness: 'kimi',
    model: 'test-kimi-model',
    reasoningEffort: 'high',
    steerEnabled: false,
  });
  const kimi = ((await created.json()) as { agents: Agent[] }).agents[0]!;
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/agents/${kimi.id}`)).json()).agent.status,
    )
    .toBe('ready');
  const binding = (await (await page.request.get(`/api/agents/${kimi.id}`)).json()).agent
    .threadId as string;
  expect(binding).toMatch(/^session_/);
  const input = page.getByRole('textbox', { name: '消息输入' });
  await input.fill('浏览器 Kimi 私聊');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('[data-sender="agent"]').last()).toContainText(
    'Kimi MCP 回复：浏览器 Kimi 私聊',
  );
  await input.fill('保持执行以验证 Kimi 排队');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByTestId('agent-status')).toHaveText('执行中');
  await input.fill('排队的 Kimi 消息');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('[data-sender="agent"]').last()).toContainText(
    'Kimi MCP 回复：排队的 Kimi 消息',
  );
  const runs = (await (await page.request.get(`/api/agents/${kimi.id}`)).json()).runs as {
    threadId: string;
    status: string;
  }[];
  expect(runs).toHaveLength(3);
  expect(runs.every((run) => run.threadId === binding && run.status === 'completed')).toBe(true);
  await send(page, 'Kimi 多选提问');
  await expect(page.getByText(`${kimi.name} 需要你的回答`)).toBeVisible();
  await expect(page.getByRole('button', { name: '提交回答' })).toBeDisabled();
  await page.getByRole('checkbox', { name: '代码', exact: true }).check();
  await page.getByRole('checkbox', { name: '测试', exact: true }).check();
  await page.getByRole('checkbox', { name: '文档', exact: true }).check();
  await page.getByRole('checkbox', { name: '文档', exact: true }).uncheck();
  const [answered] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/answer')),
    page.getByRole('button', { name: '提交回答' }).click(),
  ]);
  expect(answered.request().postDataJSON()).toEqual({
    answers: { scope: { answers: ['代码', '测试'] } },
  });
  await expect(page.locator('[data-sender="agent"]').last()).toContainText(
    'Kimi 多选回答：代码、测试',
  );
  await expect(page.getByText(`${kimi.name} 需要你的回答`)).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('steers Kimi within its original run and displays child progress and questions', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建 Agent' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建 Agent', exact: true });
  await dialog.getByLabel('Harness').selectOption('kimi');
  await dialog.getByLabel('名称').fill('Kimi steer 子代理验证');
  await dialog.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true }).click();
  const [created] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/agents/batch') && response.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: '创建 Agent', exact: true }).click(),
  ]);
  const agent = ((await created.json()) as { agents: Agent[] }).agents[0]!;
  try {
    expect(agent.steerEnabled).toBe(true);
    await expect(page.getByTestId('agent-status')).toHaveText('可用');
    await send(page, '保持执行以验证 Kimi steer');
    await expect(page.getByTestId('agent-status')).toHaveText('执行中');
    const before = (await (await page.request.get(`/api/agents/${agent.id}`)).json()).runs[0] as {
      id: string;
      turnId: string;
      threadId: string;
    };
    await send(page, 'Kimi 忙碌追加消息');
    await expect(page.locator('[data-sender="agent"]').last()).toContainText(
      'Kimi MCP 回复：Kimi 忙碌追加消息',
    );
    await expect
      .poll(async () => (await (await page.request.get(`/api/agents/${agent.id}`)).json()).runs)
      .toMatchObject([
        { id: before.id, turnId: before.turnId, threadId: before.threadId, status: 'completed' },
      ]);
    const detail = await (await page.request.get(`/api/agents/${agent.id}`)).json();
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0].inputs).toEqual([{ channelId: agent.channelId, messageSeqs: [1, 2] }]);

    await page.reload();
    expect(
      (await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent.steerEnabled,
    ).toBe(true);
    await send(page, 'Kimi 子代理提问');
    await expect(page.getByText(`${agent.name} 需要你的回答`)).toBeVisible();
    await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
    const inspector = page.getByTestId('inspector');
    await expect(inspector).toContainText('子代理 页面助手 (agent-browser) · test-kimi-model');
    await expect(inspector).toContainText('正在检查页面结构');
    await expect(inspector).not.toContainText('已读取页面，等待范围确认');
    await page.getByRole('checkbox', { name: '文档', exact: true }).check();
    await page.getByRole('checkbox', { name: '测试', exact: true }).check();
    const [answered] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/answer')),
      page.getByRole('button', { name: '提交回答' }).click(),
    ]);
    expect(answered.request().postDataJSON()).toEqual({
      answers: { scope: { answers: ['文档', '测试'] } },
    });
    await expect(page.locator('[data-sender="agent"]').last()).toContainText(
      'Kimi 子代理回答：文档、测试',
    );
    await expect(page.getByText(`${agent.name} 需要你的回答`)).not.toBeVisible();
    await expect(inspector).toContainText('页面检查完成');
    await expect
      .poll(async () => (await (await page.request.get(`/api/agents/${agent.id}`)).json()).runs)
      .toMatchObject([
        { threadId: `${before.threadId}/agents/agent-browser`, status: 'completed', inputs: [] },
        { status: 'completed' },
        { status: 'completed' },
      ]);
  } finally {
    await page.request.delete(`/api/agents/${agent.id}`);
  }
});

test('creates OpenCode with steer off, resumes its fixed session and answers a native multiselect question', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建 Agent' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建 Agent', exact: true });
  await dialog.getByLabel('Harness').selectOption('opencode');
  await expect(dialog.getByLabel('模型', { exact: true })).toHaveValue('fixture/fixture-model');
  await expect(dialog.getByLabel('推理等级')).toHaveValue('default');
  const steering = dialog.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true });
  await expect(steering).toBeEnabled();
  await expect(steering).toHaveAttribute('aria-checked', 'false');
  await dialog.getByLabel('名称').fill('OpenCode 浏览器验证');
  const [created] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/agents/batch') && response.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: '创建 Agent', exact: true }).click(),
  ]);
  const agent = ((await created.json()) as { agents: Agent[] }).agents[0]!;
  try {
    expect(created.request().postDataJSON()).toMatchObject({
      harness: 'opencode',
      steerEnabled: false,
    });
    await expect
      .poll(
        async () => (await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent.status,
      )
      .toBe('ready');
    const binding = (await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent
      .threadId as string;
    expect(binding).toMatch(/^ses_/);
    await send(page, '浏览器 OpenCode 私聊');
    await expect(page.locator('[data-sender="agent"]').last()).toContainText(
      'OpenCode MCP 回复：浏览器 OpenCode 私聊',
    );
    await page.getByRole('button', { name: '停止 Agent', exact: true }).click();
    await expect(page.getByTestId('agent-status')).toHaveText('已停止');
    await page.getByRole('button', { name: '恢复 Agent', exact: true }).click();
    await expect(page.getByTestId('agent-status')).toHaveText('可用');
    expect((await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent.threadId).toBe(
      binding,
    );
    await send(page, 'OpenCode 多选提问');
    await expect(page.getByText(`${agent.name} 需要你的回答`)).toBeVisible();
    await expect(page.getByRole('button', { name: '提交回答' })).toBeDisabled();
    await page.getByRole('checkbox', { name: '代码', exact: true }).check();
    await page.getByRole('checkbox', { name: '测试', exact: true }).check();
    await page.getByRole('button', { name: '提交回答' }).click();
    await expect(page.locator('[data-sender="agent"]').last()).toContainText(
      'OpenCode 多选回答：代码、测试',
    );
    const runs = (await (await page.request.get(`/api/agents/${agent.id}`)).json()).runs as {
      threadId: string;
      status: string;
    }[];
    await expect
      .poll(async () =>
        (await (await page.request.get(`/api/agents/${agent.id}`)).json()).runs.every(
          (run: { status: string }) => run.status === 'completed',
        ),
      )
      .toBe(true);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.threadId === binding)).toBe(true);
  } finally {
    await page.request.delete(`/api/agents/${agent.id}`);
  }
});

test('steers OpenCode busy input in its original native execution through the Web', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建 Agent' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建 Agent', exact: true });
  await dialog.getByLabel('Harness').selectOption('opencode');
  await dialog.getByLabel('名称').fill('OpenCode steer 浏览器验证');
  await dialog.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true }).click();
  const [created] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/agents/batch') && response.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: '创建 Agent', exact: true }).click(),
  ]);
  const agent = ((await created.json()) as { agents: Agent[] }).agents[0]!;
  try {
    expect(agent.steerEnabled).toBe(true);
    await expect(page.getByTestId('agent-status')).toHaveText('可用');
    await send(page, '保持执行以验证 OpenCode steer');
    await expect(page.getByTestId('agent-status')).toHaveText('执行中');
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/agents/${agent.id}`)).json()).runs[0]?.turnId,
      )
      .toEqual(expect.any(String));
    const before = (await (await page.request.get(`/api/agents/${agent.id}`)).json()).runs[0] as {
      id: string;
      turnId: string;
      threadId: string;
    };
    await send(page, 'OpenCode 忙碌追加消息');
    await expect(page.locator('[data-sender="agent"]').last()).toContainText(
      'OpenCode MCP 回复：OpenCode 忙碌追加消息',
    );
    await expect
      .poll(async () => (await (await page.request.get(`/api/agents/${agent.id}`)).json()).runs)
      .toMatchObject([
        { id: before.id, turnId: before.turnId, threadId: before.threadId, status: 'completed' },
      ]);
    const detail = await (await page.request.get(`/api/agents/${agent.id}`)).json();
    expect(detail.runs).toHaveLength(1);
    await page.reload();
    expect(
      (await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent.steerEnabled,
    ).toBe(true);
  } finally {
    await page.request.delete(`/api/agents/${agent.id}`);
  }
});

test('creates DSH with steer off, resumes its fixed session and answers a native multiselect question', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建 Agent' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建 Agent', exact: true });
  await dialog.getByLabel('Harness').selectOption('dsh');
  await expect(dialog.getByLabel('模型', { exact: true })).toHaveValue('fixture/nested/model');
  await expect(dialog.getByLabel('推理等级')).toHaveValue('high');
  const steering = dialog.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true });
  await expect(steering).toBeEnabled();
  await expect(steering).toHaveAttribute('aria-checked', 'false');
  await dialog.getByLabel('名称').fill('DSH 浏览器验证');
  const [created] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/agents/batch') && response.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: '创建 Agent', exact: true }).click(),
  ]);
  const agent = ((await created.json()) as { agents: Agent[] }).agents[0]!;
  try {
    expect(created.request().postDataJSON()).toMatchObject({
      harness: 'dsh',
      model: 'fixture/nested/model',
      reasoningEffort: 'high',
      steerEnabled: false,
    });
    await expect
      .poll(
        async () => (await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent.status,
      )
      .toBe('ready');
    const binding = (await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent
      .threadId as string;
    expect(binding).toMatch(/^ses_isles_/);
    await send(page, '浏览器 DSH 私聊');
    await expect(page.locator('[data-sender="agent"]').last()).toContainText(
      'DSH MCP 回复：浏览器 DSH 私聊',
    );
    await expect(page.getByTestId('agent-status')).toHaveText('可用');
    await page.getByRole('button', { name: '停止 Agent', exact: true }).click();
    await expect(page.getByTestId('agent-status')).toHaveText('已停止');
    await page.getByRole('button', { name: '恢复 Agent', exact: true }).click();
    await expect(page.getByTestId('agent-status')).toHaveText('可用');
    expect((await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent.threadId).toBe(
      binding,
    );
    await send(page, 'DSH 多选提问');
    await expect(page.getByText(`${agent.name} 需要你的回答`)).toBeVisible();
    await expect(page.getByRole('button', { name: '提交回答' })).toBeDisabled();
    await page.getByRole('checkbox', { name: '代码', exact: true }).check();
    await page.getByRole('checkbox', { name: '测试', exact: true }).check();
    await page.getByRole('button', { name: '提交回答' }).click();
    await expect(page.locator('[data-sender="agent"]').last()).toContainText(
      'DSH 多选回答：代码、测试',
    );
    await expect(page.getByText(`${agent.name} 需要你的回答`)).not.toBeVisible();
    await expect
      .poll(async () => (await (await page.request.get(`/api/agents/${agent.id}`)).json()).runs)
      .toMatchObject([
        { threadId: binding, status: 'completed' },
        { threadId: binding, status: 'completed' },
      ]);
    const detail = await (await page.request.get(`/api/agents/${agent.id}`)).json();
    expect(detail.runs).toHaveLength(2);
    expect(detail.runs[0].items).toEqual([expect.objectContaining({ text: 'DSH 原生执行详情' })]);
    expect(detail.questions).toEqual([]);
    await expect(
      page.locator('[data-sender="agent"]').filter({ hasText: 'DSH 原生执行详情' }),
    ).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/agents/${agent.id}`);
  }
});

test('steers DSH busy input in its original native execution through the Web', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建 Agent' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建 Agent', exact: true });
  await dialog.getByLabel('Harness').selectOption('dsh');
  await dialog.getByLabel('名称').fill('DSH steer 浏览器验证');
  await dialog.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true }).click();
  const [created] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/agents/batch') && response.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: '创建 Agent', exact: true }).click(),
  ]);
  const agent = ((await created.json()) as { agents: Agent[] }).agents[0]!;
  try {
    expect(created.request().postDataJSON()).toMatchObject({ harness: 'dsh', steerEnabled: true });
    expect(agent.steerEnabled).toBe(true);
    await expect(page.getByTestId('agent-status')).toHaveText('可用');
    await send(page, '保持执行以验证 DSH steer');
    await expect(page.getByTestId('agent-status')).toHaveText('执行中');
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/agents/${agent.id}`)).json()).runs[0]?.turnId,
      )
      .toEqual(expect.stringMatching(/^\d+$/));
    const before = (await (await page.request.get(`/api/agents/${agent.id}`)).json()).runs[0] as {
      id: string;
      turnId: string;
      threadId: string;
    };
    expect(before.turnId).toMatch(/^\d+$/);
    await send(page, 'DSH 忙碌追加消息');
    await expect(
      page.locator('[data-sender="user"]').filter({ hasText: 'DSH 忙碌追加消息' }),
    ).toContainText('投递中');
    await expect(page.locator('[data-sender="agent"]').last()).toContainText(
      'DSH MCP 回复：DSH 忙碌追加消息',
    );
    await expect
      .poll(async () => (await (await page.request.get(`/api/agents/${agent.id}`)).json()).runs)
      .toMatchObject([
        { id: before.id, turnId: before.turnId, threadId: before.threadId, status: 'completed' },
      ]);
    const detail = await (await page.request.get(`/api/agents/${agent.id}`)).json();
    expect(detail.runs).toHaveLength(1);
    expect(
      detail.runs[0].inputs.flatMap((input: { messageSeqs: number[] }) => input.messageSeqs),
    ).toHaveLength(2);
    await page.reload();
    expect(
      (await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent.steerEnabled,
    ).toBe(true);
  } finally {
    await page.request.delete(`/api/agents/${agent.id}`);
  }
});
