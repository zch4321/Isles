import { expect, test, type Page } from '@playwright/test';
import type { AgentDetail, Channel, Message } from '@isles/contracts';

const agentId = 'b3b1bbc2-738c-49ea-9bba-202f296a2089';
const channelId = 'd6fc4986-c852-4b3e-af1c-25ce3f595408';
const groupId = '136cfb10-49e0-4a4e-a191-584ce3a77752';
const timestamp = '2026-10-09T06:00:00.000Z';

async function contextFixture(page: Page) {
  const detail: AgentDetail = {
    agent: {
      id: agentId,
      channelId,
      name: '上下文 Agent',
      harness: 'codex',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'high',
      workspace: '/isles/agents/context/workspace',
      threadId: 'session-before',
      canCreateGroups: false,
      steerEnabled: false,
      dangerFullAccess: false,
      desiredState: 'running',
      status: 'ready',
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    contextUsage: {
      sessionId: 'session-before',
      usedTokens: 25_000,
      maxTokens: 100_000,
      estimated: true,
      updatedAt: timestamp,
    },
    pendingMessageCount: 0,
    runs: [],
    questions: [],
    cursor: 0,
  };
  const message = (channelId: string, body: string, seq = 1): Message => ({
    channelId,
    seq,
    sender: 'user',
    senderId: 'user',
    body,
    clientId: `context-${seq}`,
    replyTo: null,
    mentions: [],
    createdAt: timestamp,
    deliveries: [],
  });
  const privateMessages = [message(channelId, '已有私聊记录')];
  const groupMessages = [message(groupId, '已有群聊记录')];
  const channels: Channel[] = [
    {
      id: channelId,
      kind: 'private',
      name: null,
      agentId,
      paused: false,
      deletedAt: null,
      createdBy: 'user',
      memberIds: [agentId],
      lastMessage: privateMessages[0]!,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: groupId,
      kind: 'group',
      name: '上下文群聊',
      agentId: null,
      paused: true,
      deletedAt: null,
      createdBy: 'user',
      memberIds: [agentId],
      lastMessage: groupMessages[0]!,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  const requests: string[] = [];
  let failure = '';
  let hold: Promise<void> | undefined;
  let release = () => {};
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') requests.push(`${request.method()} ${path}`);
      if (path === `/api/agents/${agentId}/new-session`) {
        if (hold) await hold;
        if (failure) return route.fulfill({ status: 409, json: { error: failure } });
        detail.agent.threadId = 'session-after';
        detail.contextUsage = null;
        privateMessages.push({
          ...message(channelId, '已新建会话，后续消息使用新的上下文。', 2),
          sender: 'system',
          senderId: 'system',
        });
        return route.fulfill({ json: detail.agent });
      }
      if (path === '/api/health')
        return route.fulfill({ json: { status: 'ok', service: 'isles', database: 'ready' } });
      if (path === '/api/agents')
        return route.fulfill({ json: { agents: [detail.agent], cursor: 0 } });
      if (path === `/api/agents/${agentId}`) return route.fulfill({ json: detail });
      if (path === '/api/channels') return route.fulfill({ json: { channels, cursor: 0 } });
      const channel = channels.find((channel) => path === `/api/channels/${channel.id}`);
      if (channel)
        return route.fulfill({
          json: {
            channel,
            messages: channel.kind === 'private' ? privateMessages : groupMessages,
            questions: [],
            cursor: 0,
          },
        });
      if (path === '/api/harnesses')
        return route.fulfill({
          json: {
            harnesses: [
              {
                id: 'codex',
                displayName: 'Codex',
                configuration: 'cli-path',
                capabilities: {
                  sessionResume: true,
                  interrupt: true,
                  steer: true,
                  userQuestions: true,
                  nativeSubagents: true,
                  mcp: true,
                  workspaceInstructions: true,
                },
              },
            ],
          },
        });
      if (path.endsWith('/models'))
        return route.fulfill({
          json: {
            models: [
              {
                id: 'same-model',
                model: 'gpt-6.1-sol',
                displayName: 'GPT-6.1 Sol',
                description: '',
                supportedReasoningEfforts: ['high'],
                defaultReasoningEffort: 'high',
                isDefault: true,
              },
            ],
          },
        });
      return route.abort();
    },
  );
  await page.addInitScript((id) => localStorage.setItem('isles.channel', id), channelId);
  return {
    detail,
    requests,
    channels,
    fail: (error: string) => {
      failure = error;
    },
    hold: () => {
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
  };
}

async function openContext(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '上下文', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上下文', exact: true });
  await expect(dialog.getByRole('button', { name: '新建会话', exact: true })).toBeVisible();
  return dialog;
}

test('context shows native usage and percentage independently of the same real model name', async ({
  page,
}, testInfo) => {
  const fixture = await contextFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  let dialog = await openContext(page);
  await expect(dialog.getByText('25,000 / 100,000')).toBeVisible();
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '25%');
  await expect(dialog.getByText(/估算 · 更新于/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await page.screenshot({
    path: testInfo.outputPath('context-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  fixture.detail.contextUsage!.maxTokens = 200_000;
  dialog = await openContext(page);
  await expect(dialog.getByText('25,000 / 200,000')).toBeVisible();
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '12.5%');
  fixture.detail.contextUsage!.maxTokens = null;
  dialog = await openContext(page);
  await expect(dialog.getByText('等待窗口大小更新')).toBeVisible();
  await expect(dialog.getByRole('progressbar')).toHaveCount(0);
  await expect(dialog.getByText('25,000')).toBeVisible();
  fixture.detail.contextUsage = null;
  dialog = await openContext(page);
  await expect(dialog.getByText('等待用量更新')).toBeVisible();
  await expect(dialog.getByRole('progressbar')).toHaveCount(0);
  await expect(dialog.getByText(/tokens/)).toHaveCount(0);
});

for (const state of [
  'creating',
  'recovering',
  'running',
  'deleted',
  'waiting',
  'pending',
] as const) {
  test(`context blocks a new session while ${state}`, async ({ page }) => {
    const fixture = await contextFixture(page);
    if (state === 'pending') fixture.detail.pendingMessageCount = 2;
    else if (state === 'waiting')
      fixture.detail.runs.push({
        id: 'a3b1bbc2-738c-49ea-9bba-202f296a2089',
        agentId,
        threadId: 'session-before',
        turnId: 'turn-1',
        status: 'waiting',
        error: null,
        createdAt: timestamp,
        finishedAt: null,
        inputs: [],
        items: [],
      });
    else fixture.detail.agent.status = state;
    const dialog = await openContext(page);
    await expect(dialog.getByRole('button', { name: '新建会话', exact: true })).toBeDisabled();
    await expect(
      dialog.getByText(
        state === 'pending'
          ? /2 条消息待处理/
          : state === 'waiting' || state === 'running'
            ? /请先停止 Agent/
            : state === 'deleted'
              ? /Agent 已删除/
              : state === 'creating'
                ? /Agent 正在创建/
                : /Agent 正在恢复/,
      ),
    ).toBeVisible();
    expect(fixture.requests).toEqual([]);
  });
}

test('context confirms and creates a session while preserving stopped intent, histories and membership', async ({
  page,
}) => {
  const fixture = await contextFixture(page);
  fixture.detail.agent.status = 'stopped';
  fixture.detail.agent.desiredState = 'stopped';
  fixture.hold();
  const dialog = await openContext(page);
  await expect(dialog.getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '新建会话', exact: true }).click();
  expect(fixture.requests).toEqual([]);
  await expect(
    dialog.getByText('新会话将从新的上下文开始。聊天记录、群成员和工作文件保留。'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(fixture.requests).toEqual([]);
  await dialog.getByRole('button', { name: '新建会话', exact: true }).click();
  await dialog.getByRole('button', { name: '确认新建', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '正在新建…', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  fixture.release();
  await expect(dialog.getByRole('status')).toHaveText('新会话已建立。');
  await expect(dialog.getByText('等待用量更新')).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('[data-sender="user"]')).toContainText('已有私聊记录');
  await expect(page.getByText('已新建会话，后续消息使用新的上下文。')).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复 Agent', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /上下文群聊/ }).click();
  await expect(page.locator('[data-sender="user"]')).toContainText('已有群聊记录');
  await expect(page.getByText('1 位成员')).toBeVisible();
  expect(fixture.detail.agent.workspace).toBe('/isles/agents/context/workspace');
  expect(fixture.channels[1]!.memberIds).toEqual([agentId]);
  expect(fixture.requests).toEqual([`POST /api/agents/${agentId}/new-session`]);
});

test('context reports session creation failure and allows retry from Agent details', async ({
  page,
}) => {
  const fixture = await contextFixture(page);
  fixture.detail.agent.status = 'error';
  fixture.fail('有新消息待处理，请处理完成后重试');
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
  await page.getByRole('button', { name: '查看上下文', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上下文', exact: true });
  await dialog.getByRole('button', { name: '新建会话', exact: true }).click();
  await dialog.getByRole('button', { name: '确认新建', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('有新消息待处理，请处理完成后重试');
  expect(fixture.detail.agent.threadId).toBe('session-before');
  await expect(dialog.getByRole('button', { name: '确认新建', exact: true })).toBeEnabled();
  fixture.fail('');
  await dialog.getByRole('button', { name: '确认新建', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('新会话已建立。');
});
