import { expect, test, type Page } from '@playwright/test';
import type { Agent } from '@isles/contracts';
import { randomUUID } from 'node:crypto';

async function openCreation(page: Page) {
  await page.getByRole('button', { name: '新建 Agent', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建 Agent', exact: true });
  await expect(dialog.getByLabel('创建数量')).toHaveValue('1');
  return dialog;
}

test('creates numbered Agent batches with independent sessions and continues past retained names', async ({
  page,
}, testInfo) => {
  const prefix = `sol-${randomUUID().slice(0, 8)}`;
  const created: Agent[] = [];
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    let dialog = await openCreation(page);
    await expect(dialog.getByLabel('名称')).toHaveAttribute('placeholder', '例如 codex');
    await dialog.getByLabel('名称').fill(prefix);
    await dialog.getByLabel('创建数量').fill('3');
    await dialog.getByLabel('模型', { exact: true }).selectOption('test-model');
    await dialog.getByLabel('推理等级').selectOption('max');
    await dialog.getByRole('switch', { name: '允许拉群', exact: true }).click();
    await dialog.getByRole('switch', { name: '忙碌时实时接收（steer）', exact: true }).click();
    await dialog.getByRole('switch', { name: '完整访问', exact: true }).click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath('create-agents-mobile.png'),
      fullPage: true,
      animations: 'disabled',
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/agents/batch', async (route) => {
      await gate;
      return route.continue();
    });
    const pending = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/agents/batch') && response.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: '创建 3 个 Agent', exact: true }).click();
    try {
      await expect(dialog.getByRole('button', { name: '正在创建…', exact: true })).toBeDisabled();
      await expect(dialog.getByLabel('创建数量')).toBeDisabled();
      await expect(dialog.getByLabel('名称')).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
    } finally {
      release();
    }
    const response = await pending;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({ name: prefix, count: 3 });
    const batch = (await response.json()).agents as Agent[];
    created.push(...batch);
    expect(batch.map((agent) => agent.name)).toEqual([`${prefix}-1`, `${prefix}-2`, `${prefix}-3`]);
    for (const agent of batch) {
      await expect
        .poll(
          async () =>
            (await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent.status,
        )
        .toBe('ready');
      const detail = await (await page.request.get(`/api/agents/${agent.id}`)).json();
      expect(detail.agent).toMatchObject({
        model: 'test-model',
        reasoningEffort: 'max',
        canCreateGroups: true,
        steerEnabled: true,
        dangerFullAccess: true,
      });
      agent.threadId = detail.agent.threadId;
      expect(detail.runs).toEqual([]);
    }
    expect(new Set(batch.map((agent) => agent.id)).size).toBe(3);
    expect(new Set(batch.map((agent) => agent.workspace)).size).toBe(3);
    expect(new Set(batch.map((agent) => agent.threadId)).size).toBe(3);
    await expect(page.getByRole('heading', { name: `${prefix}-1`, level: 1 })).toBeVisible();
    // Deletion retains the historical name, so new instances keep increasing.
    expect((await page.request.delete(`/api/agents/${batch[2]!.id}`)).ok()).toBe(true);
    await page.getByRole('button', { name: '返回聊天列表', exact: true }).click();
    dialog = await openCreation(page);
    await dialog.getByLabel('名称').fill(prefix);
    const nextResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/agents/batch') && response.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: '创建 Agent', exact: true }).click();
    const next = (await (await nextResponse).json()).agents as Agent[];
    created.push(...next);
    expect(next.map((agent) => agent.name)).toEqual([`${prefix}-4`]);
    await expect(page.getByRole('heading', { name: `${prefix}-4`, level: 1 })).toBeVisible();
  } finally {
    for (const agent of created) await page.request.delete(`/api/agents/${agent.id}`);
  }
});

test('creation validates quantity and resets it when reopened without creating extra Agents', async ({
  page,
}) => {
  let submissions = 0;
  await page.route('**/api/agents/batch', async (route) => {
    submissions++;
    return route.fulfill({ status: 503, json: { error: '模型暂时不可用，请重试' } });
  });
  await page.goto('/');
  let dialog = await openCreation(page);
  await dialog.getByLabel('名称').fill('sol');
  for (const quantity of ['0', '-1', '1.5', '51', '']) {
    await dialog.getByLabel('创建数量').fill(quantity);
    await expect(dialog.getByRole('button', { name: /^创建.*Agent/ })).toBeDisabled();
  }
  expect(submissions).toBe(0);
  await dialog.getByLabel('创建数量').fill('3');
  await dialog.getByRole('button', { name: '创建 3 个 Agent', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('模型暂时不可用，请重试');
  expect(submissions).toBe(1);
  await expect(dialog.getByLabel('名称')).toHaveValue('sol');
  await expect(dialog.getByLabel('创建数量')).toHaveValue('3');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  dialog = await openCreation(page);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(submissions).toBe(1);
});
