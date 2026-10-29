import { expect, test, type Page } from '@playwright/test';
import type { Agent, Message } from '@isles/contracts';
import { ConfigManager } from '@isles/config';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { deflateSync } from 'node:zlib';

// Build a complete 1×1 PNG so the real image decoder validates every upload.
function png(red: number, width = 1, height = 1) {
  function chunk(type: string, data: Buffer) {
    const name = Buffer.from(type);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([name, data])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4);
    const checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, name, data, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 4) + 1 + x * 4;
      pixels.set([red, (80 + x) % 256, (120 + y) % 256, 255], offset);
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const file = (name: string, red: number) => ({
  name,
  mimeType: 'image/png',
  buffer: png(red),
});
const composer = (page: Page) => page.getByRole('textbox', { name: '消息输入' });
const send = (page: Page) => page.getByRole('button', { name: '发送消息', exact: true });
const picker = (page: Page) => page.getByLabel('选择图片');
const channel = (page: Page, name: string) =>
  page.locator('aside').getByRole('button', { name: new RegExp(name) });
const createdAgents = new Set<string>();

test.afterEach(async ({ request }) => {
  const ids = [...createdAgents];
  createdAgents.clear();
  const responses = await Promise.all(ids.map((id) => request.delete(`/api/agents/${id}`)));
  for (const response of responses) expect(response.ok()).toBe(true);
});

async function createAgent(page: Page, name: string, stop = true) {
  const response = await page.request.post('/api/agents', {
    data: { harness: 'codex', name, model: 'test-model', reasoningEffort: 'high' },
  });
  expect(response.ok()).toBe(true);
  const agent = (await response.json()) as Agent;
  createdAgents.add(agent.id);
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent as Agent).status,
    )
    .toBe('ready');
  if (stop)
    expect((await page.request.post(`/api/agents/${agent.id}/stop`, { data: {} })).ok()).toBe(true);
  return agent;
}

async function open(page: Page, channelId: string) {
  await page.addInitScript((id) => localStorage.setItem('isles.channel', id), channelId);
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
}

async function pasteOrDrop(page: Page, mode: 'paste' | 'drop', name: string, red: number) {
  const data = png(red).toString('base64');
  await composer(page).evaluate(
    (element, { mode, name, data }) => {
      const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type: 'image/png' }));
      if (mode === 'paste')
        element.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }),
        );
      else {
        const form = element.closest('form')!;
        form.dispatchEvent(
          new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }),
        );
        form.dispatchEvent(
          new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
        );
      }
    },
    { mode, name, data },
  );
}

test('sends image-only and text with images, opens originals and keeps history after reload and deletion', async ({
  page,
}, testInfo) => {
  const agent = await createAgent(page, '图片历史 Agent');
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, agent.channelId);
  await expect(page.getByText('PNG/JPEG/WebP/GIF · ≤10 MB/张 · 最多 4 张')).toBeVisible();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: '添加图片', exact: true }).click(),
  ]);
  await chooser.setFiles(file('第一张.png', 10));
  await expect(page.getByText('已上传', { exact: true })).toBeVisible();
  await expect(send(page)).toBeEnabled();
  const [firstResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/channels/${agent.channelId}/messages`) &&
        response.request().method() === 'POST',
    ),
    send(page).click(),
  ]);
  const first = (await firstResponse.json()) as Message;
  expect(first.body).toBe('');
  expect(first.images).toHaveLength(1);
  expect(first.images[0]).toMatchObject({
    name: '第一张.png',
    width: 1,
    height: 1,
    mimeType: 'image/png',
  });
  const firstImage = page.getByRole('button', { name: '查看图片 第一张.png' });
  await expect(firstImage).toBeVisible();
  await firstImage.click();
  const preview = page.getByRole('dialog', { name: '第一张.png' });
  await expect(preview.getByRole('img', { name: '第一张.png' })).toBeVisible();
  const originalUrl = await preview.getByRole('link', { name: '打开原图' }).getAttribute('href');
  expect(originalUrl).toBe(`/api/channels/${agent.channelId}/images/${first.images[0]!.id}`);
  expect(await (await page.request.get(originalUrl!)).body()).toEqual(png(10));
  await preview.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '返回聊天列表', exact: true }).click();
  await expect(channel(page, '图片历史 Agent')).toContainText('你：[图片]');
  await channel(page, '图片历史 Agent').click();

  await composer(page).fill('图片说明');
  await picker(page).setInputFiles(file('第二张.png', 20));
  await expect(page.getByText('已上传', { exact: true })).toBeVisible();
  const [secondResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/channels/${agent.channelId}/messages`) &&
        response.request().method() === 'POST',
    ),
    send(page).click(),
  ]);
  const second = (await secondResponse.json()) as Message;
  expect(second.body).toBe('图片说明');
  expect(second.images).toHaveLength(1);
  expect(
    (
      await page.request.post(`/api/channels/${agent.channelId}/messages`, {
        data: { body: '引用图片', replyTo: first.seq, clientId: 'image-reply' },
      })
    ).ok(),
  ).toBe(true);
  await expect(page.getByText('回复 你：[图片]')).toBeVisible();
  await page.reload();
  await expect(firstImage).toBeVisible();
  await expect(page.getByRole('button', { name: '查看图片 第二张.png' })).toBeVisible();
  await expect(page.getByText('图片说明', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await page.screenshot({ path: testInfo.outputPath('images-mobile.png'), animations: 'disabled' });
  expect((await page.request.delete(`/api/agents/${agent.id}`)).ok()).toBe(true);
  await page.reload();
  await expect(firstImage).toBeVisible();
  expect((await page.request.get(originalUrl!)).ok()).toBe(true);
});

test('keeps uploads and text per conversation while accepting pasted and dropped images', async ({
  page,
}) => {
  const first = await createAgent(page, '图片草稿甲');
  await createAgent(page, '图片草稿乙');
  await open(page, first.channelId);
  let releaseUpload = () => {};
  const heldUpload = new Promise<void>((resolve) => (releaseUpload = resolve));
  await page.route(`**/api/channels/${first.channelId}/images?*`, async (route) => {
    await heldUpload;
    await route.continue();
  });
  await composer(page).fill('甲的草稿');
  await picker(page).setInputFiles(file('甲.png', 30));
  await expect(page.getByText('上传中', { exact: true })).toBeVisible();
  await expect(send(page)).toBeDisabled();
  await channel(page, '图片草稿乙').click();
  await expect(composer(page)).toHaveValue('');
  await composer(page).fill('乙的草稿');
  await pasteOrDrop(page, 'paste', '粘贴.png', 40);
  await pasteOrDrop(page, 'drop', '拖放.png', 50);
  await expect(page.getByText('已上传', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('img', { name: '预览 粘贴.png' })).toBeVisible();
  await expect(page.getByRole('img', { name: '预览 拖放.png' })).toBeVisible();
  await channel(page, '图片草稿甲').click();
  await expect(composer(page)).toHaveValue('甲的草稿');
  await expect(page.getByText('上传中', { exact: true })).toBeVisible();
  releaseUpload();
  await expect(page.getByText('已上传', { exact: true })).toBeVisible();
  await channel(page, '图片草稿乙').click();
  await expect(composer(page)).toHaveValue('乙的草稿');
  await expect(page.getByText('已上传', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: '移除图片 拖放.png' }).click();
  await expect(page.getByRole('img', { name: '预览 拖放.png' })).toHaveCount(0);
});

test('shows Agent images sent through MCP and retains the captured bytes in history', async ({
  page,
}, testInfo) => {
  const agent = await createAgent(page, 'Agent 图片回复', false);
  await open(page, agent.channelId);
  const settings = (await (await page.request.get('/api/workspaces')).json()) as {
    configFilePath: string;
  };
  const configFile = resolve(settings.configFilePath);
  const root = dirname(configFile);
  if (
    dirname(root).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
    !basename(root).startsWith('isles-') ||
    basename(configFile) !== 'config.toml'
  )
    throw new Error('Image browser tests require an isolated temporary Isles configuration');
  const config = new ConfigManager({ configFilePath: configFile, homeDir: root, environment: {} })
    .current;
  const inside = (path: string) => {
    const name = relative(root, resolve(path));
    return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
  };
  if (!inside(config.dataDir) || !inside(agent.workspace))
    throw new Error('Image browser tests require temporary data and Agent workspaces');
  const token = await readFile(join(config.dataDir, 'agents', agent.id, 'isles-mcp-token'), 'utf8');
  const imagePath = join(agent.workspace, 'agent-image.png');
  await writeFile(imagePath, png(75, 320, 200));
  const response = await fetch(`http://127.0.0.1:${config.port}/mcp/${agent.id}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'send_message',
        arguments: { channelId: 'private', imagePaths: [imagePath], clientId: 'agent-image' },
      },
    }),
  });
  expect(response.ok).toBe(true);
  const rpc = (await response.json()) as { result: { isError?: boolean } };
  expect(rpc.result.isError).not.toBe(true);
  const article = page.getByRole('article', { name: 'Agent 图片回复的消息' });
  await expect(article.getByRole('button', { name: '查看图片 agent-image.png' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('images-desktop.png'),
    animations: 'disabled',
  });
  await expect(channel(page, 'Agent 图片回复')).toContainText('[图片]');
  const detail = await (await page.request.get(`/api/channels/${agent.channelId}`)).json();
  const message = (detail.messages as Message[]).find((item) => item.sender === 'agent')!;
  expect(message.body).toBe('');
  expect(message.images).toHaveLength(1);
  const url = `/api/channels/${agent.channelId}/images/${message.images[0]!.id}`;
  await writeFile(imagePath, png(76, 320, 200));
  expect(await (await page.request.get(url)).body()).toEqual(png(75, 320, 200));
  await page.reload();
  await expect(article.getByRole('button', { name: '查看图片 agent-image.png' })).toBeVisible();
  await article.getByRole('button', { name: '查看图片 agent-image.png' }).click();
  const preview = page.getByRole('dialog', { name: 'agent-image.png' });
  await expect(preview.getByRole('link', { name: '打开原图' })).toHaveAttribute('href', url);
  await page.screenshot({ path: testInfo.outputPath('image-preview.png'), animations: 'disabled' });
});

test('reports image validation and upload failures, then preserves the send snapshot during navigation and retry', async ({
  page,
}) => {
  const first = await createAgent(page, '图片重试甲');
  await createAgent(page, '图片重试乙');
  await open(page, first.channelId);
  await picker(page).setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('text'),
  });
  await expect(page.getByRole('alert')).toContainText('请选择 PNG、JPEG、WebP 或 GIF 图片');
  await picker(page).setInputFiles({
    name: '大图.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  await expect(page.getByRole('alert')).toContainText('图片大小需在 1 字节至 10 MB 之间');
  await picker(page).setInputFiles({
    name: '损坏.png',
    mimeType: 'image/png',
    buffer: Buffer.from('not an image'),
  });
  await expect(page.getByRole('alert')).toContainText('请选择 PNG、JPEG、WebP 或 GIF 图片');
  await page.getByRole('button', { name: '移除图片 损坏.png' }).click();

  let failUpload = true;
  await page.route(`**/api/channels/${first.channelId}/images?*`, async (route) => {
    if (failUpload) {
      failUpload = false;
      await route.fulfill({ status: 503, json: { error: '图片上传暂时失败，请重试' } });
    } else await route.continue();
  });
  await picker(page).setInputFiles(file('重试.png', 60));
  await expect(page.getByRole('alert')).toContainText('图片上传暂时失败，请重试');
  await expect(send(page)).toBeDisabled();
  await page.getByRole('button', { name: '重试上传 重试.png' }).click();
  await expect(page.getByText('已上传', { exact: true })).toBeVisible();
  await composer(page).fill('发送失败保留');
  let failSend = true;
  const clientIds: string[] = [];
  let shouldHoldSend = false;
  let releaseSend = () => {};
  const heldSend = new Promise<void>((resolve) => (releaseSend = resolve));
  await page.route(`**/api/channels/${first.channelId}/messages`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    clientIds.push(route.request().postDataJSON().clientId as string);
    if (failSend) {
      failSend = false;
      await route.fulfill({ status: 503, json: { error: '消息发送暂时失败，请重试' } });
    } else {
      if (shouldHoldSend) await heldSend;
      await route.continue();
    }
  });
  await send(page).click();
  await expect(page.getByRole('alert')).toContainText('消息发送暂时失败，请重试');
  await channel(page, '图片重试乙').click();
  await channel(page, '图片重试甲').click();
  await expect(composer(page)).toHaveValue('发送失败保留');
  await expect(page.getByRole('img', { name: '预览 重试.png' })).toBeVisible();
  await send(page).click();
  await expect(page.getByRole('button', { name: '查看图片 重试.png' })).toBeVisible();
  expect(clientIds).toHaveLength(2);
  expect(clientIds[1]).toBe(clientIds[0]);

  await picker(page).setInputFiles([file('重复.png', 8), file('重复.png', 8)]);
  await expect(page.getByRole('alert')).toContainText('重复.png 已添加，请选择其他图片');
  await expect(page.getByText('已上传', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '移除图片 重复.png' }).click();
  await picker(page).setInputFiles([
    file('一.png', 1),
    file('二.png', 2),
    file('三.png', 3),
    file('四.png', 4),
    file('五.png', 5),
  ]);
  await expect(page.getByRole('alert')).toContainText('每条消息最多添加 4 张图片');
  await expect(page.getByText('已上传', { exact: true })).toHaveCount(4);
  shouldHoldSend = true;
  await composer(page).fill('本次发送');
  await send(page).click();
  await expect(send(page)).toBeDisabled();
  await composer(page).fill('下一条草稿');
  await page.getByRole('button', { name: '移除图片 一.png' }).click();
  await picker(page).setInputFiles(file('新图片.png', 90));
  await expect(page.getByText('已上传', { exact: true })).toHaveCount(4);
  await channel(page, '图片重试乙').click();
  await channel(page, '图片重试甲').click();
  await expect(send(page)).toBeDisabled();
  releaseSend();
  await expect(page.getByRole('button', { name: '查看图片 四.png' })).toBeVisible();
  await expect(composer(page)).toHaveValue('下一条草稿');
  await expect(page.getByText('已上传', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('img', { name: '预览 新图片.png' })).toBeVisible();
});
