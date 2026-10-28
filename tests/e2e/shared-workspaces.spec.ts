import { expect, test, type Locator } from '@playwright/test';
import type { Agent, Channel } from '@isles/contracts';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function addPath(container: Locator, label: string, path: string) {
  await container.getByRole('textbox', { name: label, exact: true }).fill(path);
  await container.getByRole('button', { name: `添加${label}`, exact: true }).click();
  await expect(container.getByRole('list', { name: label, exact: true })).toContainText(path);
}

test('edits global, Agent and group directories and preserves inherited Agent paths', async ({
  page,
}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'isles-shared-browser-'));
  const globalPath = join(root, '全局项目');
  const ownPath = join(root, 'Agent 项目');
  const groupPath = join(root, '群聊项目');
  const groupAddedPath = join(root, '群聊新增项目');
  await Promise.all([globalPath, ownPath, groupPath, groupAddedPath].map((path) => mkdir(path)));
  const agents: Agent[] = [];
  let group: Channel | undefined;
  const original = await (await page.request.get('/api/workspaces')).json();
  const detail = async (id: string): Promise<Agent> =>
    (await (await page.request.get(`/api/agents/${id}`)).json()).agent;
  try {
    // Start with an existing Agent to verify global additions reach existing instances.
    const existingResponse = await page.request.post('/api/agents', {
      data: {
        harness: 'codex',
        name: '已有工作目录 Agent',
        model: 'test-model',
        reasoningEffort: 'high',
      },
    });
    expect(existingResponse.ok()).toBe(true);
    const existing = (await existingResponse.json()) as Agent;
    agents.push(existing);
    await page.goto('/');
    await page.getByRole('button', { name: '共享工作目录', exact: true }).click();
    let settings = page.getByRole('dialog', { name: '共享工作目录', exact: true });
    await expect(settings).toContainText(original.defaultSharedDir);
    await addPath(settings, '全局目录', globalPath);
    await page.screenshot({
      path: testInfo.outputPath('shared-workspaces-desktop.png'),
      animations: 'disabled',
    });
    await settings.getByRole('button', { name: '保存目录', exact: true }).click();
    await expect(settings).toBeHidden();
    expect((await detail(existing.id)).workspacePaths).toContain(globalPath);

    await page.getByRole('button', { name: '新建 Agent', exact: true }).first().click();
    const creating = page.getByRole('dialog', { name: '新建 Agent', exact: true });
    await creating.getByLabel('名称', { exact: true }).fill('共享工作目录 Agent');
    await addPath(creating, '额外工作目录', ownPath);
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/agents/batch') && response.request().method() === 'POST',
    );
    await creating.getByRole('button', { name: '创建 Agent', exact: true }).click();
    const created = ((await (await createdResponse).json()).agents as Agent[])[0]!;
    agents.push(created);
    await expect(creating).toBeHidden();
    expect(created.workspacePaths).toEqual(expect.arrayContaining([globalPath, ownPath]));
    await expect.poll(async () => (await detail(created.id)).status).toBe('ready');

    await page.getByRole('button', { name: '新建群聊', exact: true }).click();
    const groupDialog = page.getByRole('dialog', { name: '新建群聊', exact: true });
    await groupDialog.getByLabel('群名', { exact: true }).fill('目录协作群');
    await groupDialog.getByRole('checkbox', { name: new RegExp(created.name) }).check();
    await addPath(groupDialog, '群聊目录', groupPath);
    const groupResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/channels') && response.request().method() === 'POST',
    );
    await groupDialog.getByRole('button', { name: '创建群聊', exact: true }).click();
    group = (await (await groupResponse).json()) as Channel;
    await expect(groupDialog).toBeHidden();
    expect((await detail(created.id)).workspacePaths).toContain(groupPath);
    await page.getByRole('button', { name: '群聊详情', exact: true }).click();
    const inspector = page.getByTestId('inspector');
    await addPath(inspector, '群聊目录', groupAddedPath);
    await page.screenshot({
      path: testInfo.outputPath('group-workspaces-desktop.png'),
      animations: 'disabled',
    });
    await inspector.getByRole('button', { name: '保存群聊目录', exact: true }).click();
    await expect(inspector.getByRole('button', { name: '保存群聊目录', exact: true })).toHaveCount(
      0,
    );
    expect((await detail(created.id)).workspacePaths).toContain(groupAddedPath);
    await inspector.getByRole('button', { name: '添加成员', exact: true }).click();
    const adding = page.getByRole('dialog', { name: '添加成员', exact: true });
    await adding.getByRole('checkbox', { name: new RegExp(existing.name) }).check();
    await adding.getByRole('button', { name: '添加', exact: true }).click();
    await expect(adding).toBeHidden();
    expect((await detail(existing.id)).workspacePaths).toEqual(
      expect.arrayContaining([globalPath, groupPath, groupAddedPath]),
    );

    await inspector.getByRole('button', { name: `移除目录 ${groupPath}`, exact: true }).click();
    await inspector.getByRole('button', { name: '保存群聊目录', exact: true }).click();
    await expect(inspector.getByRole('button', { name: '保存群聊目录', exact: true })).toHaveCount(
      0,
    );
    expect((await detail(created.id)).workspacePaths).toContain(groupPath);
    await inspector.getByRole('button', { name: '关闭详情', exact: true }).click();
    await page.getByRole('button', { name: '共享工作目录', exact: true }).click();
    settings = page.getByRole('dialog', { name: '共享工作目录', exact: true });
    await settings.getByRole('button', { name: `移除目录 ${globalPath}`, exact: true }).click();
    await settings.getByRole('button', { name: '保存目录', exact: true }).click();
    await expect(settings).toBeHidden();
    expect((await detail(created.id)).workspacePaths).toContain(globalPath);

    await page
      .getByRole('navigation', { name: 'Agents', exact: true })
      .getByRole('button', { name: new RegExp(created.name) })
      .click();
    await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
    await expect(
      inspector.getByRole('list', { name: 'Agent 额外工作目录', exact: true }),
    ).toContainText(globalPath);
    await inspector.getByRole('button', { name: '编辑 Agent', exact: true }).click();
    const editing = page.getByRole('dialog', { name: '编辑 Agent', exact: true });
    await editing.getByRole('button', { name: `移除目录 ${globalPath}`, exact: true }).click();
    await editing.getByRole('button', { name: `移除目录 ${groupPath}`, exact: true }).click();
    await editing.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(editing).toBeHidden();
    expect((await detail(created.id)).workspacePaths).toEqual([ownPath, groupAddedPath]);
    await expect(
      inspector.getByRole('list', { name: 'Agent 额外工作目录', exact: true }),
    ).not.toContainText(globalPath);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath('agent-shared-paths-mobile.png'),
      animations: 'disabled',
    });
  } finally {
    await page.request.put('/api/workspaces', {
      data: { workspacePaths: original.workspacePaths },
    });
    if (group) await page.request.delete(`/api/channels/${group.id}`);
    for (const agent of agents) await page.request.delete(`/api/agents/${agent.id}`);
    await rm(root, { recursive: true, force: true });
  }
});

test('refreshes shared settings and preserves directory drafts during incoming updates', async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'isles-workspace-refresh-browser-'));
  const globalPath = join(root, '另一窗口全局目录');
  const groupPath = join(root, '编辑期间新增群目录');
  await Promise.all([globalPath, groupPath].map((path) => mkdir(path)));
  const original = await (await page.request.get('/api/workspaces')).json();
  let agent: Agent | undefined;
  let group: Channel | undefined;
  let release = () => {};
  try {
    const createdResponse = await page.request.post('/api/agents', {
      data: {
        harness: 'codex',
        name: '目录刷新 Agent',
        model: 'test-model',
        reasoningEffort: 'high',
      },
    });
    expect(createdResponse.ok()).toBe(true);
    agent = (await createdResponse.json()) as Agent;
    await page.goto('/');
    await page.getByRole('button', { name: '共享工作目录', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '共享工作目录', exact: true });
    await expect(settings.getByRole('textbox', { name: '全局目录', exact: true })).toBeVisible();
    await settings.getByRole('button', { name: '取消', exact: true }).click();
    expect(
      (
        await page.request.put('/api/workspaces', {
          data: { workspacePaths: [...original.workspacePaths, globalPath] },
        })
      ).ok(),
    ).toBe(true);
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      '**/api/workspaces',
      async (route) => {
        await gate;
        await route.continue();
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: '共享工作目录', exact: true }).click();
    await expect(settings).toContainText('正在加载工作目录…');
    await expect(settings.getByRole('textbox', { name: '全局目录', exact: true })).toHaveCount(0);
    release();
    await expect(settings.getByRole('list', { name: '全局目录', exact: true })).toContainText(
      globalPath,
    );
    await expect(settings.getByRole('button', { name: '保存目录', exact: true })).toBeDisabled();
    await settings.getByRole('button', { name: '取消', exact: true }).click();

    await page.getByRole('button', { name: 'Agent 详情', exact: true }).click();
    const inspector = page.getByTestId('inspector');
    await expect(
      inspector.getByRole('list', { name: 'Agent 额外工作目录', exact: true }),
    ).toContainText(globalPath);
    await inspector.getByRole('button', { name: '编辑 Agent', exact: true }).click();
    const editing = page.getByRole('dialog', { name: '编辑 Agent', exact: true });
    await editing.getByLabel('名称', { exact: true }).fill('目录刷新后的 Agent');
    const groupResponse = await page.request.post('/api/channels', {
      data: { name: '编辑期间入群', memberIds: [agent.id], workspacePaths: [groupPath] },
    });
    expect(groupResponse.ok()).toBe(true);
    group = (await groupResponse.json()) as Channel;
    // Wait for the incoming Agent update while its editor still contains the opening draft.
    await expect(inspector.locator('ul[aria-label="Agent 额外工作目录"]')).toContainText(groupPath);
    const update = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/agents/${agent!.id}`) &&
        response.request().method() === 'PATCH',
    );
    await editing.getByRole('button', { name: '保存修改', exact: true }).click();
    const response = await update;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toEqual({ name: '目录刷新后的 Agent' });
    expect(((await response.json()) as Agent).workspacePaths).toEqual(
      expect.arrayContaining([globalPath, groupPath]),
    );
    await expect(editing).toBeHidden();

    await inspector.getByRole('button', { name: '关闭详情', exact: true }).click();
    await page
      .getByRole('navigation', { name: '群聊', exact: true })
      .getByRole('button', { name: new RegExp(group.name!) })
      .click();
    await page.getByRole('button', { name: '群聊详情', exact: true }).click();
    await addPath(inspector, '群聊目录', root);
    expect(
      (
        await page.request.patch(`/api/channels/${group.id}`, {
          data: { workspacePaths: [groupPath, globalPath] },
        })
      ).ok(),
    ).toBe(true);
    await expect(inspector.getByRole('status')).toHaveText('群目录已更新，可重新加载后继续编辑。');
    const groupRows = inspector
      .getByRole('list', { name: '群聊目录', exact: true })
      .locator('code');
    await expect(groupRows).toHaveText([groupPath, root]);
    await expect(
      inspector.getByRole('button', { name: '保存群聊目录', exact: true }),
    ).toBeDisabled();
    await inspector.getByRole('button', { name: '重新加载群目录', exact: true }).click();
    await expect(groupRows).toHaveText([groupPath, globalPath]);
    await expect(inspector.getByRole('status')).toHaveCount(0);
    await expect(inspector.getByRole('button', { name: '保存群聊目录', exact: true })).toHaveCount(
      0,
    );
    await addPath(inspector, '群聊目录', root);
    await inspector.getByRole('button', { name: '保存群聊目录', exact: true }).click();
    await expect(inspector.getByRole('button', { name: '保存群聊目录', exact: true })).toHaveCount(
      0,
    );
    expect(
      (await (await page.request.get(`/api/channels/${group.id}`)).json()).channel.workspacePaths,
    ).toEqual([groupPath, globalPath, root]);
  } finally {
    release();
    await page.request.put('/api/workspaces', {
      data: { workspacePaths: original.workspacePaths },
    });
    if (group) await page.request.delete(`/api/channels/${group.id}`);
    if (agent) await page.request.delete(`/api/agents/${agent.id}`);
    await rm(root, { recursive: true, force: true });
  }
});
