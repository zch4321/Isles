import type { Agent, Message, MessageImage } from '@isles/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { agentRoot } from '../src/runtime/workspace.js';
import { MockClient, MockHarness, codexAdapters, testCatalog, testConfig } from './helpers.js';

type App = Awaited<ReturnType<typeof buildApp>>;
type Block = { type: string; text?: string; data?: string; mimeType?: string };
const cleanups: (() => unknown | Promise<unknown>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  cleanups.push(() => resolve());
  return { promise, resolve };
}

async function fixture(catalog = testCatalog) {
  const root = await mkdtemp(join(tmpdir(), 'isles-image-runtime-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const harness = new MockHarness();
  const config = testConfig(root);
  const open = async () => {
    const app = await buildApp({
      config,
      adapterFactory: codexAdapters(catalog, harness.factory),
    });
    harness.useStore(app.isles.store);
    await app.listen({ host: '127.0.0.1', port: 0 });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await app.close();
    };
    cleanups.push(close);
    return { app, close };
  };
  const { app, close } = await open();
  const create = async (name: string, steerEnabled = false) => {
    const agent = await app.isles.runtime.createAgent({
      harness: 'codex',
      name,
      model: 'test-model',
      reasoningEffort: 'high',
      steerEnabled,
    });
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    return app.isles.store.publicAgent(agent.id);
  };
  return { app, close, open, create, harness, root };
}

async function connect(app: App, agent: Agent) {
  const token = await app.isles.runtime.workspace.token(
    agentRoot(app.isles.runtime.workspace.dataDir, app.isles.store.getAgent(agent.id)),
  );
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  const client = new Client({ name: 'image-runtime-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/${agent.id}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as Transport,
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
  };
  cleanups.push(close);
  return { client, close };
}

async function sample(color = '#123456') {
  return sharp({ create: { width: 4, height: 3, channels: 3, background: color } })
    .png()
    .toBuffer();
}

async function upload(
  app: App,
  channelId: string,
  bytes: Buffer,
  name: string,
): Promise<MessageImage> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/channels/${channelId}/images?name=${encodeURIComponent(name)}`,
    headers: { 'content-type': 'image/png' },
    payload: bytes,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as MessageImage;
}

async function send(app: App, channelId: string, input: { body?: string; imageIds?: string[] }) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/channels/${channelId}/messages`,
    payload: { ...input, clientId: randomUUID() },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Message;
}

function status(app: App, agent: Agent, message: Message) {
  return app.isles.store
    .listMessages(message.channelId, { after: message.seq - 1, limit: 1 })[0]!
    .deliveries.find((delivery) => delivery.agentId === agent.id)?.status;
}

function blocks(result: unknown): Block[] {
  return (result as { content: Block[] }).content;
}

function imageBlock(result: unknown, index = 0) {
  return blocks(result).filter((block) => block.type === 'image')[index]!;
}

async function begin(app: App, harness: MockHarness, agent: Agent) {
  const initial = await send(app, agent.channelId, { body: 'Active turn' });
  await expect.poll(() => status(app, agent, initial)).toBe('accepted');
  return harness.latest(agent.id);
}

describe('image messaging runtime', () => {
  it('sends a human image-only message as a native image with its label and copied bytes', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    const bytes = await sample();
    const image = await upload(app, agent.channelId, bytes, '示例.png');
    const message = await send(app, agent.channelId, { imageIds: [image.id] });
    expect(message.body).toBe('');
    await expect.poll(() => status(app, agent, message)).toBe('accepted');
    const call = harness.latest(agent.id).calls.find((item) => item.method === 'turn/start')!;
    const input = call.params.input as { type: string; text?: string; path?: string }[];
    expect(input.map((item) => item.type)).toEqual(['text', 'text', 'localImage']);
    expect(input[1]!.text).toContain(`seq: ${message.seq}`);
    expect(input[1]!.text).toContain(`id: "${image.id}"`);
    expect(input[1]!.text).toContain('name: "示例.png"');
    expect(input[2]!.path!.startsWith(join(agent.workspace, '.isles-images'))).toBe(true);
    expect(await readFile(input[2]!.path!)).toEqual(bytes);
    expect(input[0]!.text).not.toContain(bytes.toString('base64'));
  });

  it('keeps an image queued after a model rejects images and submits it after changing models', async () => {
    const models = await testCatalog.models();
    const catalog = {
      ...testCatalog,
      models: async () => [
        ...models,
        { ...models[0]!, id: 'image-model', model: 'image-model', displayName: 'Image model' },
      ],
    };
    const { app, create, harness } = await fixture(catalog);
    const agent = await create('Reader');
    const request = MockClient.prototype.request;
    vi.spyOn(MockClient.prototype, 'request').mockImplementation(async function <T = unknown>(
      this: MockClient,
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> {
      if (method === 'model/list')
        return {
          data: [
            { model: 'test-model', inputModalities: ['text'] },
            { model: 'image-model', inputModalities: ['text', 'image'] },
          ],
          nextCursor: null,
        } as T;
      return (await request.call(this, method, params)) as T;
    });
    const bytes = await sample();
    const image = await upload(app, agent.channelId, bytes, 'model.png');
    const message = await send(app, agent.channelId, { imageIds: [image.id] });
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('error');
    expect(status(app, agent, message)).toBe('queued');
    const firstRun = app.isles.store.agentDetail(agent.id).runs[0]!;
    expect(firstRun.inputs).toContainEqual({
      channelId: agent.channelId,
      messageSeqs: [message.seq],
    });
    expect(
      harness.latest(agent.id).calls.filter((call) => call.method === 'turn/start'),
    ).toHaveLength(0);
    await app.isles.runtime.updateAgent(agent.id, { model: 'image-model' });
    await app.isles.runtime.resume(agent.id);
    await expect.poll(() => status(app, agent, message)).toBe('accepted');
    const turn = harness.latest(agent.id).calls.find((call) => call.method === 'turn/start')!;
    expect(turn.params.model).toBe('image-model');
    const nativeImage = (turn.params.input as { type: string; path?: string }[]).find(
      (item) => item.type === 'localImage',
    );
    expect(await readFile(nativeImage!.path!)).toEqual(bytes);
    expect(app.isles.store.getRun(firstRun.id).inputs).toEqual(firstRun.inputs);
  });

  it('keeps a normal-turn image queued when the Agent stops before native submission', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    const native = harness.latest(agent.id);
    const image = await upload(app, agent.channelId, await sample(), 'stop-initial.png');
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.materialize.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'materialize').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const message = await send(app, agent.channelId, { imageIds: [image.id] });
    await entered.promise;
    expect(status(app, agent, message)).toBe('submitting');
    await app.isles.runtime.stop(agent.id);
    gate.resolve();
    await expect.poll(() => status(app, agent, message)).toBe('queued');
    expect(native.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
    await app.isles.runtime.resume(agent.id);
    await expect.poll(() => status(app, agent, message)).toBe('accepted');
    const submitted = harness.latest(agent.id).calls.find((call) => call.method === 'turn/start')!;
    expect(
      (submitted.params.input as { type: string }[]).some((item) => item.type === 'localImage'),
    ).toBe(true);
  });

  it('requeues an image when stopped during Codex model preflight and submits it after resume', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    const native = harness.latest(agent.id);
    const entered = deferred();
    const gate = deferred();
    let firstLookup = true;
    const request = MockClient.prototype.request;
    vi.spyOn(MockClient.prototype, 'request').mockImplementation(async function <T = unknown>(
      this: MockClient,
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> {
      if (method === 'model/list') {
        if (firstLookup) {
          firstLookup = false;
          entered.resolve();
          await gate.promise;
        }
        return {
          data: [{ model: 'test-model', inputModalities: ['text', 'image'] }],
          nextCursor: null,
        } as T;
      }
      return (await request.call(this, method, params)) as T;
    });
    const bytes = await sample();
    const image = await upload(app, agent.channelId, bytes, 'preflight-stop.png');
    const message = await send(app, agent.channelId, { imageIds: [image.id] });
    await entered.promise;
    expect(status(app, agent, message)).toBe('submitting');
    await app.isles.runtime.stop(agent.id);
    expect(status(app, agent, message)).toBe('queued');
    expect(native.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
    gate.resolve();
    await app.isles.runtime.resume(agent.id);
    await expect.poll(() => status(app, agent, message)).toBe('accepted');
    const turn = harness.latest(agent.id).calls.find((call) => call.method === 'turn/start')!;
    const nativeImage = (turn.params.input as { type: string; path?: string }[]).find(
      (item) => item.type === 'localImage',
    );
    expect(await readFile(nativeImage!.path!)).toEqual(bytes);
  });

  it('cancels an image if group membership changes during Codex model preflight', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    const native = harness.latest(agent.id);
    const room = app.isles.runtime.createGroup('user', { name: 'Review', memberIds: [agent.id] });
    const entered = deferred();
    const gate = deferred();
    const request = MockClient.prototype.request;
    vi.spyOn(MockClient.prototype, 'request').mockImplementation(async function <T = unknown>(
      this: MockClient,
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> {
      if (method === 'model/list') {
        entered.resolve();
        await gate.promise;
        return {
          data: [{ model: 'test-model', inputModalities: ['text', 'image'] }],
          nextCursor: null,
        } as T;
      }
      return (await request.call(this, method, params)) as T;
    });
    const image = await upload(app, room.id, await sample(), 'preflight-group.png');
    const message = await send(app, room.id, { imageIds: [image.id] });
    await entered.promise;
    expect(status(app, agent, message)).toBe('submitting');
    app.isles.runtime.removeMember(room.id, agent.id);
    app.isles.runtime.addMembers(room.id, 'user', [agent.id]);
    expect(status(app, agent, message)).toBe('cancelled');
    gate.resolve();
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    expect(status(app, agent, message)).toBe('cancelled');
    expect(native.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
  });

  it('cancels a group image when membership ends and returns during preparation', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    const native = harness.latest(agent.id);
    const room = app.isles.runtime.createGroup('user', { name: 'Review', memberIds: [agent.id] });
    const image = await upload(app, room.id, await sample(), 'removed.png');
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.load.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'load').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const message = await send(app, room.id, { imageIds: [image.id] });
    await entered.promise;
    expect(status(app, agent, message)).toBe('submitting');
    app.isles.runtime.removeMember(room.id, agent.id);
    expect(status(app, agent, message)).toBe('cancelled');
    app.isles.runtime.addMembers(room.id, 'user', [agent.id]);
    gate.resolve();
    await expect.poll(() => status(app, agent, message)).toBe('cancelled');
    expect(native.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
  });

  it('steers a busy turn with a local image path and never an image block', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader', true);
    const native = await begin(app, harness, agent);
    const bytes = await sample();
    const image = await upload(app, agent.channelId, bytes, 'steer.png');
    const message = await send(app, agent.channelId, { imageIds: [image.id] });
    await expect.poll(() => status(app, agent, message)).toBe('accepted');
    const call = native.calls.find((item) => item.method === 'turn/steer')!;
    const input = call.params.input as { type: string; text: string }[];
    expect(input).toHaveLength(1);
    expect(input[0]!.type).toBe('text');
    expect(input[0]!.text).toContain('image_paths:');
    expect(input[0]!.text).not.toContain(bytes.toString('base64'));
    const pathString = /image_paths: ("(?:[^"\\]|\\.)*")/.exec(input[0]!.text)?.[1];
    expect(pathString).toBeDefined();
    const imagePath = JSON.parse(pathString!) as string;
    expect(imagePath.startsWith(join(agent.workspace, '.isles-images'))).toBe(true);
    expect(await readFile(imagePath)).toEqual(bytes);
  });

  it('does not steer a completed turn after image materialization resumes', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader', true);
    const native = await begin(app, harness, agent);
    const image = await upload(app, agent.channelId, await sample(), 'late.png');
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.materialize.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'materialize').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const message = await send(app, agent.channelId, { imageIds: [image.id] });
    await entered.promise;
    expect(status(app, agent, message)).toBe('steering');
    native.complete();
    gate.resolve();
    await expect
      .poll(
        () => harness.latest(agent.id).calls.filter((item) => item.method === 'turn/start').length,
      )
      .toBe(2);
    expect(native.calls.filter((item) => item.method === 'turn/steer')).toHaveLength(0);
    const next = native.calls.filter((item) => item.method === 'turn/start')[1]!;
    expect(
      (next.params.input as { type: string }[]).some((item) => item.type === 'localImage'),
    ).toBe(true);
    await expect.poll(() => status(app, agent, message)).toBe('accepted');
  });

  it('keeps an unsent image queued when the Agent stops during materialization', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader', true);
    const native = await begin(app, harness, agent);
    const image = await upload(app, agent.channelId, await sample(), 'stop.png');
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.materialize.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'materialize').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const message = await send(app, agent.channelId, { imageIds: [image.id] });
    await entered.promise;
    expect(status(app, agent, message)).toBe('steering');
    await app.isles.runtime.stop(agent.id);
    gate.resolve();
    await expect.poll(() => status(app, agent, message)).toBe('queued');
    expect(native.calls.filter((item) => item.method === 'turn/steer')).toHaveLength(0);
    expect(app.isles.store.publicAgent(agent.id).status).toBe('stopped');
  });

  it('returns paired image labels and content, paginates, and confirms only returned messages', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    await begin(app, harness, agent);
    const bytes = [
      await sample('#112233'),
      await sample('#445566'),
      await sample('#778899'),
      await sample('#aabbcc'),
    ];
    const images = await Promise.all(
      bytes.map((data, index) => upload(app, agent.channelId, data, `photo-${index}.png`)),
    );
    const messages = [
      await send(app, agent.channelId, { imageIds: [images[0]!.id, images[1]!.id] }),
      await send(app, agent.channelId, { imageIds: [images[2]!.id] }),
      await send(app, agent.channelId, { imageIds: [images[3]!.id] }),
    ];
    const { client } = await connect(app, agent);
    const first = await client.callTool({
      name: 'receive_messages',
      arguments: { channelId: 'private', limit: 1 },
    });
    expect(first.isError).not.toBe(true);
    expect(blocks(first).map((block) => block.type)).toEqual([
      'text',
      'text',
      'image',
      'text',
      'image',
    ]);
    expect(blocks(first)[0]!.text).toContain('[has_more: true]');
    expect(blocks(first)[1]!.text).toContain(`seq: ${messages[0]!.seq}`);
    expect(blocks(first)[1]!.text).toContain('photo-0.png');
    expect(imageBlock(first)).toMatchObject({
      mimeType: 'image/png',
      data: bytes[0]!.toString('base64'),
    });
    expect(blocks(first)[3]!.text).toContain(`seq: ${messages[0]!.seq}`);
    expect(blocks(first)[3]!.text).toContain('image: 2');
    expect(blocks(first)[3]!.text).toContain('photo-1.png');
    expect(imageBlock(first, 1).data).toBe(bytes[1]!.toString('base64'));
    expect(messages.map((message) => status(app, agent, message))).toEqual([
      'received',
      'queued',
      'queued',
    ]);
    const history = await client.callTool({
      name: 'read_messages',
      arguments: { channelId: 'private', after: messages[0]!.seq, limit: 1 },
    });
    expect(history.isError).not.toBe(true);
    expect(blocks(history)[0]!.text).toContain(`next_after: ${messages[1]!.seq}`);
    expect(blocks(history)[1]!.text).toContain('photo-2.png');
    expect(imageBlock(history).data).toBe(bytes[2]!.toString('base64'));
    expect(messages.map((message) => status(app, agent, message))).toEqual([
      'received',
      'received',
      'queued',
    ]);
    const last = await client.callTool({
      name: 'receive_messages',
      arguments: { channelId: 'private' },
    });
    expect(last.isError).not.toBe(true);
    expect(imageBlock(last).data).toBe(bytes[3]!.toString('base64'));
    expect(status(app, agent, messages[2]!)).toBe('received');
  });

  it.each(['receive_messages', 'read_messages'])(
    'keeps unread delivery queued when %s fails to read an image',
    async (name) => {
      const { app, create, harness } = await fixture();
      const agent = await create('Reader');
      await begin(app, harness, agent);
      const bytes = await sample();
      const image = await upload(app, agent.channelId, bytes, 'retry.png');
      const message = await send(app, agent.channelId, { imageIds: [image.id] });
      const { client } = await connect(app, agent);
      const load = vi
        .spyOn(app.isles.runtime.images, 'load')
        .mockRejectedValueOnce(new Error('image read failed'));
      const args =
        name === 'read_messages' ? { channelId: 'private', after: 0 } : { channelId: 'private' };
      const failed = await client.callTool({ name, arguments: args });
      expect(failed.isError).toBe(true);
      expect(status(app, agent, message)).toBe('queued');
      load.mockRestore();
      const retried = await client.callTool({ name, arguments: args });
      expect(retried.isError).not.toBe(true);
      expect(imageBlock(retried).data).toBe(bytes.toString('base64'));
      expect(status(app, agent, message)).toBe('received');
    },
  );

  it('does not acknowledge history when the Agent stops during image loading', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    await begin(app, harness, agent);
    const image = await upload(app, agent.channelId, await sample(), 'history-stop.png');
    const message = await send(app, agent.channelId, { imageIds: [image.id] });
    const { client } = await connect(app, agent);
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.load.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'load').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const pending = client.callTool({
      name: 'read_messages',
      arguments: { channelId: 'private', after: message.seq - 1 },
    });
    await entered.promise;
    await app.isles.runtime.stop(agent.id);
    gate.resolve();
    const response = await pending;
    expect(response.isError).toBe(true);
    expect(status(app, agent, message)).toBe('queued');
  });

  it('does not start a duplicate turn while a history image is loading', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    const native = await begin(app, harness, agent);
    const image = await upload(app, agent.channelId, await sample(), 'history-race.png');
    const message = await send(app, agent.channelId, { imageIds: [image.id] });
    const { client } = await connect(app, agent);
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.load.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'load').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const pending = client.callTool({
      name: 'read_messages',
      arguments: { channelId: 'private', after: message.seq - 1 },
    });
    await entered.promise;
    native.complete();
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    const whileLoading = status(app, agent, message);
    gate.resolve();
    const response = await pending;
    expect(whileLoading).toBe('queued');
    expect(response.isError).not.toBe(true);
    expect(imageBlock(response).mimeType).toBe('image/png');
    expect(status(app, agent, message)).toBe('received');
    expect(native.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });

  it('returns different pages to concurrent MCP inbox readers', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    await begin(app, harness, agent);
    const bytes = [await sample('#112233'), await sample('#aabbcc')];
    const images = await Promise.all(
      bytes.map((data, index) => upload(app, agent.channelId, data, `parallel-${index}.png`)),
    );
    const messages: Message[] = [];
    for (const image of images)
      messages.push(await send(app, agent.channelId, { imageIds: [image.id] }));
    const { client } = await connect(app, agent);
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.load.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'load').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const first = client.callTool({
      name: 'receive_messages',
      arguments: { channelId: 'private', limit: 1 },
    });
    await entered.promise;
    const second = client.callTool({
      name: 'receive_messages',
      arguments: { channelId: 'private', limit: 1 },
    });
    gate.resolve();
    const responses = await Promise.all([first, second]);
    expect(responses.every((result) => !result.isError)).toBe(true);
    expect(
      responses.map((result) => blocks(result).filter((block) => block.type === 'image').length),
    ).toEqual([1, 1]);
    expect(responses.map((result) => imageBlock(result).data)).toEqual(
      bytes.map((value) => value.toString('base64')),
    );
    expect(messages.map((message) => status(app, agent, message))).toEqual([
      'received',
      'received',
    ]);
  });

  it('reserves the next concurrent inbox page if the active turn ends during image loading', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    const native = await begin(app, harness, agent);
    const bytes = [await sample('#112233'), await sample('#aabbcc')];
    const images = await Promise.all(
      bytes.map((data, index) => upload(app, agent.channelId, data, `waiting-${index}.png`)),
    );
    const firstMessage = await send(app, agent.channelId, { imageIds: [images[0]!.id] });
    const secondMessage = await send(app, agent.channelId, { imageIds: [images[1]!.id] });
    const { client } = await connect(app, agent);
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.load.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'load').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const receive = vi.spyOn(app.isles.runtime, 'receiveWithContent');
    const first = client.callTool({
      name: 'receive_messages',
      arguments: { channelId: 'private', limit: 1 },
    });
    await entered.promise;
    const second = client.callTool({
      name: 'receive_messages',
      arguments: { channelId: 'private', limit: 1 },
    });
    await expect.poll(() => receive.mock.calls.length).toBe(2);
    native.complete();
    gate.resolve();
    const responses = await Promise.all([first, second]);
    expect(responses.every((result) => !result.isError)).toBe(true);
    expect(
      responses.map((result) => blocks(result).filter((block) => block.type === 'image').length),
    ).toEqual([1, 1]);
    expect(responses.map((result) => imageBlock(result).data)).toEqual(
      bytes.map((value) => value.toString('base64')),
    );
    expect(status(app, agent, firstMessage)).toBe('received');
    expect(status(app, agent, secondMessage)).toBe('received');
    expect(native.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });

  it('keeps concurrent inbox pages queued if the Agent stops while an image is loading', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    await begin(app, harness, agent);
    const images = await Promise.all(
      [await sample('#112233'), await sample('#aabbcc')].map((data, index) =>
        upload(app, agent.channelId, data, `stop-read-${index}.png`),
      ),
    );
    const firstMessage = await send(app, agent.channelId, { imageIds: [images[0]!.id] });
    const secondMessage = await send(app, agent.channelId, { imageIds: [images[1]!.id] });
    const { client } = await connect(app, agent);
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.load.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'load').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const first = client.callTool({
      name: 'receive_messages',
      arguments: { channelId: 'private', limit: 1 },
    });
    await entered.promise;
    const second = client.callTool({
      name: 'receive_messages',
      arguments: { channelId: 'private', limit: 1 },
    });
    await app.isles.runtime.stop(agent.id);
    gate.resolve();
    const responses = await Promise.all([first, second]);
    expect(responses.every((result) => result.isError)).toBe(true);
    expect(status(app, agent, firstMessage)).toBe('queued');
    expect(status(app, agent, secondMessage)).toBe('queued');
    await app.isles.runtime.resume(agent.id);
    await expect.poll(() => status(app, agent, firstMessage)).toBe('accepted');
    await expect.poll(() => status(app, agent, secondMessage)).toBe('accepted');
    const turn = harness.latest(agent.id).calls.find((call) => call.method === 'turn/start')!;
    expect(
      (turn.params.input as { type: string }[]).filter((item) => item.type === 'localImage'),
    ).toHaveLength(2);
  });

  it('does not revive an old inbox read when the Agent stops and resumes during image loading', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    await begin(app, harness, agent);
    const bytes = await sample();
    const image = await upload(app, agent.channelId, bytes, 'revision.png');
    const secondImage = await upload(app, agent.channelId, bytes, 'next-revision.png');
    const message = await send(app, agent.channelId, { imageIds: [image.id] });
    const secondMessage = await send(app, agent.channelId, { imageIds: [secondImage.id] });
    const { client } = await connect(app, agent);
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.load.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'load').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const receive = vi.spyOn(app.isles.runtime, 'receiveWithContent');
    const pending = client.callTool({
      name: 'receive_messages',
      arguments: { channelId: 'private', limit: 1 },
    });
    await entered.promise;
    const waiting = client.callTool({
      name: 'receive_messages',
      arguments: { channelId: 'private', limit: 1 },
    });
    await expect.poll(() => receive.mock.calls.length).toBe(2);
    await app.isles.runtime.stop(agent.id);
    await app.isles.runtime.resume(agent.id);
    expect(status(app, agent, message)).toBe('queued');
    expect(status(app, agent, secondMessage)).toBe('queued');
    gate.resolve();
    expect((await Promise.all([pending, waiting])).every((response) => response.isError)).toBe(
      true,
    );
    await expect.poll(() => status(app, agent, message)).toBe('accepted');
    await expect.poll(() => status(app, agent, secondMessage)).toBe('accepted');
    const turn = harness.latest(agent.id).calls.find((call) => call.method === 'turn/start')!;
    const imageItems = (turn.params.input as { type: string; path?: string }[]).filter(
      (item) => item.type === 'localImage',
    );
    expect(imageItems).toHaveLength(2);
    for (const imageItem of imageItems) expect(await readFile(imageItem.path!)).toEqual(bytes);
  });

  it('waits without rescheduling while an inbox image loads, then runs new input', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    const native = await begin(app, harness, agent);
    const image = await upload(app, agent.channelId, await sample(), 'pending-read.png');
    const message = await send(app, agent.channelId, { imageIds: [image.id] });
    const { client } = await connect(app, agent);
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.load.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'load').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const pending = client.callTool({
      name: 'receive_messages',
      arguments: { channelId: 'private', limit: 1 },
    });
    await entered.promise;
    native.complete();
    const next = await send(app, agent.channelId, { body: 'Arrived during image read' });
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    expect(native.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    expect(status(app, agent, message)).toBe('queued');
    expect(status(app, agent, next)).toBe('queued');
    gate.resolve();
    const response = await pending;
    expect(response.isError).not.toBe(true);
    expect(imageBlock(response).mimeType).toBe('image/png');
    expect(status(app, agent, message)).toBe('received');
    await expect.poll(() => status(app, agent, next)).toBe('accepted');
    const starts = native.calls.filter((call) => call.method === 'turn/start');
    expect(starts).toHaveLength(2);
    expect((starts[1]!.params.input as { text?: string }[])[0]!.text).toContain(
      'Arrived during image read',
    );
  });

  it('does not claim inbox input after a reconnect finishes during image loading', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    await app.isles.runtime.stop(agent.id);
    const image = await upload(app, agent.channelId, await sample(), 'reconnect-read.png');
    const message = await send(app, agent.channelId, { imageIds: [image.id] });
    const { client } = await connect(app, agent);
    const reconnectEntered = deferred();
    const reconnectGate = deferred();
    const reconnected = deferred();
    const request = MockClient.prototype.request;
    vi.spyOn(MockClient.prototype, 'request').mockImplementation(async function <T = unknown>(
      this: MockClient,
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> {
      if (method === 'thread/resume') {
        reconnectEntered.resolve();
        await reconnectGate.promise;
        const value = (await request.call(this, method, params)) as T;
        reconnected.resolve();
        return value;
      }
      return (await request.call(this, method, params)) as T;
    });
    await app.isles.runtime.resume(agent.id);
    await reconnectEntered.promise;
    const loadEntered = deferred();
    const loadGate = deferred();
    const load = app.isles.runtime.images.load.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'load').mockImplementationOnce(async (...args) => {
      loadEntered.resolve();
      await loadGate.promise;
      return load(...args);
    });
    const pending = client.callTool({
      name: 'receive_messages',
      arguments: { channelId: 'private' },
    });
    await loadEntered.promise;
    reconnectGate.resolve();
    await reconnected.promise;
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    const whileLoading = status(app, agent, message);
    const startsWhileLoading = harness
      .latest(agent.id)
      .calls.filter((call) => call.method === 'turn/start');
    loadGate.resolve();
    const response = await pending;
    expect(whileLoading).toBe('queued');
    expect(startsWhileLoading).toHaveLength(0);
    expect(response.isError).not.toBe(true);
    expect(status(app, agent, message)).toBe('received');
  });

  it('keeps session replacement unavailable while an inbox image is loading', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    const native = await begin(app, harness, agent);
    const image = await upload(app, agent.channelId, await sample(), 'session-read.png');
    const message = await send(app, agent.channelId, { imageIds: [image.id] });
    const { client } = await connect(app, agent);
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.load.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'load').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const pending = client.callTool({
      name: 'receive_messages',
      arguments: { channelId: 'private' },
    });
    await entered.promise;
    native.complete();
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    expect(app.isles.store.hasActiveRun(agent.id)).toBe(false);
    await expect(app.isles.runtime.newSession(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(status(app, agent, message)).toBe('queued');
    gate.resolve();
    expect((await pending).isError).not.toBe(true);
    expect(status(app, agent, message)).toBe('received');
  });

  it('holds a new steer until an MCP image read completes', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader', true);
    const native = await begin(app, harness, agent);
    const room = app.isles.runtime.createGroup('user', { name: 'Paused', memberIds: [agent.id] });
    app.isles.runtime.updateChannel(room.id, { paused: true });
    const image = await upload(app, room.id, await sample(), 'held.png');
    const queued = await send(app, room.id, { imageIds: [image.id] });
    const { client } = await connect(app, agent);
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.load.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'load').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const pending = client.callTool({
      name: 'receive_messages',
      arguments: { channelId: room.id },
    });
    await entered.promise;
    const next = await send(app, agent.channelId, { body: 'Steer after image read' });
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    expect(native.calls.filter((call) => call.method === 'turn/steer')).toHaveLength(0);
    expect(status(app, agent, next)).toBe('queued');
    gate.resolve();
    expect((await pending).isError).not.toBe(true);
    expect(status(app, agent, queued)).toBe('received');
    await expect.poll(() => status(app, agent, next)).toBe('accepted');
    const steer = native.calls.find((call) => call.method === 'turn/steer')!;
    expect((steer.params.input as { text: string }[])[0]!.text).toContain('Steer after image read');
  });

  it('retries a steer whose image preparation overlaps an MCP image read', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader', true);
    const native = await begin(app, harness, agent);
    const room = app.isles.runtime.createGroup('user', { name: 'Paused', memberIds: [agent.id] });
    app.isles.runtime.updateChannel(room.id, { paused: true });
    const inboxImage = await upload(app, room.id, await sample('#123456'), 'inbox.png');
    await send(app, room.id, { imageIds: [inboxImage.id] });
    const steerImage = await upload(app, agent.channelId, await sample('#654321'), 'steer.png');
    const materializeEntered = deferred();
    const materializeGate = deferred();
    const materialize = app.isles.runtime.images.materialize.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'materialize').mockImplementationOnce(async (...args) => {
      materializeEntered.resolve();
      await materializeGate.promise;
      return materialize(...args);
    });
    const message = await send(app, agent.channelId, { imageIds: [steerImage.id] });
    await materializeEntered.promise;
    expect(status(app, agent, message)).toBe('steering');
    const { client } = await connect(app, agent);
    const loadEntered = deferred();
    const loadGate = deferred();
    const load = app.isles.runtime.images.load.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'load').mockImplementationOnce(async (...args) => {
      loadEntered.resolve();
      await loadGate.promise;
      return load(...args);
    });
    const pending = client.callTool({
      name: 'receive_messages',
      arguments: { channelId: room.id },
    });
    await loadEntered.promise;
    materializeGate.resolve();
    await expect.poll(() => status(app, agent, message)).toBe('queued');
    expect(native.calls.filter((call) => call.method === 'turn/steer')).toHaveLength(0);
    loadGate.resolve();
    expect((await pending).isError).not.toBe(true);
    await expect.poll(() => status(app, agent, message)).toBe('accepted');
    expect(native.calls.filter((call) => call.method === 'turn/steer')).toHaveLength(1);
  });

  it('rejects a group inbox read if membership is removed during image loading', async () => {
    const { app, create, harness } = await fixture();
    const agent = await create('Reader');
    await begin(app, harness, agent);
    const room = app.isles.runtime.createGroup('user', { name: 'Review', memberIds: [agent.id] });
    const image = await upload(app, room.id, await sample(), 'protected.png');
    const message = await send(app, room.id, { imageIds: [image.id] });
    const { client } = await connect(app, agent);
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.load.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'load').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const pending = client.callTool({
      name: 'receive_messages',
      arguments: { channelId: room.id },
    });
    await entered.promise;
    app.isles.runtime.removeMember(room.id, agent.id);
    gate.resolve();
    expect((await pending).isError).toBe(true);
    expect(status(app, agent, message)).toBe('cancelled');
  });

  it('publishes immutable local snapshots with stable retries to another Agent', async () => {
    const { app, create, harness, root } = await fixture();
    const author = await create('Author');
    const reader = await create('Reader');
    const room = app.isles.runtime.createGroup('user', {
      name: 'Review',
      memberIds: [author.id, reader.id],
    });
    const bytes = await sample();
    const file = join(author.workspace, 'diagram.png');
    await writeFile(file, bytes);
    const { client } = await connect(app, author);
    const args = { channelId: room.id, imagePaths: [file], clientId: 'same-image-message' };
    const sent = await client.callTool({ name: 'send_message', arguments: args });
    expect(sent.isError).not.toBe(true);
    const seq = (JSON.parse(blocks(sent)[0]!.text!) as { seq: number }).seq;
    const message = app.isles.store.listMessages(room.id).find((entry) => entry.seq === seq)!;
    expect(message).toMatchObject({
      sender: 'agent',
      senderId: author.id,
      body: '',
      images: [{ name: 'diagram.png' }],
    });
    const retry = await client.callTool({ name: 'send_message', arguments: args });
    expect(retry.isError).not.toBe(true);
    expect(JSON.parse(blocks(retry)[0]!.text!)).toEqual({ seq });
    await expect.poll(() => status(app, reader, message)).toBe('accepted');
    const turn = harness.latest(reader.id).calls.find((item) => item.method === 'turn/start')!;
    const input = turn.params.input as { type: string; text?: string; path?: string }[];
    const native = input.find((item) => item.type === 'localImage')!;
    expect(await readFile(native.path!)).toEqual(bytes);
    expect(
      input.some((item) => item.text?.includes('diagram.png') && item.text.includes(`seq: ${seq}`)),
    ).toBe(true);
    await writeFile(file, await sample('#ff0000'));
    const changedRetry = await client.callTool({ name: 'send_message', arguments: args });
    expect(changedRetry.isError).toBe(true);
    const original = await app.inject(`/api/channels/${room.id}/images/${message.images[0]!.id}`);
    expect(original.rawPayload).toEqual(bytes);
    const outside = join(root, 'outside.png');
    await writeFile(outside, bytes);
    expect(
      (
        await client.callTool({
          name: 'send_message',
          arguments: { channelId: room.id, imagePaths: [outside] },
        })
      ).isError,
    ).toBe(true);
    expect(
      (await client.callTool({ name: 'read_messages', arguments: { channelId: reader.channelId } }))
        .isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: 'send_message',
          arguments: { channelId: reader.channelId, imagePaths: [file] },
        })
      ).isError,
    ).toBe(true);
    expect(
      app.isles.store.listMessages(room.id).filter((entry) => entry.sender === 'agent'),
    ).toHaveLength(1);
  });

  it('does not publish after membership changes while an image import is in progress', async () => {
    const { app, create } = await fixture();
    const author = await create('Author');
    const reader = await create('Reader');
    const room = app.isles.runtime.createGroup('user', {
      name: 'Review',
      memberIds: [author.id, reader.id],
    });
    const file = join(author.workspace, 'pending.png');
    await writeFile(file, await sample());
    const { client } = await connect(app, author);
    const entered = deferred();
    const gate = deferred();
    const original = app.isles.runtime.images.importFiles.bind(app.isles.runtime.images);
    vi.spyOn(app.isles.runtime.images, 'importFiles').mockImplementationOnce(async (...args) => {
      const imported = await original(...args);
      entered.resolve();
      await gate.promise;
      return imported;
    });
    const pending = client.callTool({
      name: 'send_message',
      arguments: { channelId: room.id, imagePaths: [file] },
    });
    await entered.promise;
    app.isles.runtime.removeMember(room.id, author.id);
    gate.resolve();
    expect((await pending).isError).toBe(true);
    expect(
      app.isles.store.listMessages(room.id).filter((entry) => entry.sender === 'agent'),
    ).toEqual([]);
  });

  it('preserves image history and original bytes after reopening the app', async () => {
    const { app, close, open, create, harness } = await fixture();
    const agent = await create('Reader');
    const bytes = await sample();
    const image = await upload(app, agent.channelId, bytes, 'history.png');
    const message = await send(app, agent.channelId, { imageIds: [image.id] });
    await expect.poll(() => status(app, agent, message)).toBe('accepted');
    harness.latest(agent.id).complete();
    await expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
    await close();
    const reopened = await open();
    await expect.poll(() => reopened.app.isles.store.publicAgent(agent.id).status).toBe('ready');
    const saved = reopened.app.isles.store
      .listMessages(agent.channelId)
      .find((entry) => entry.seq === message.seq)!;
    expect(saved.images).toEqual(message.images);
    const imageResponse = await reopened.app.inject(
      `/api/channels/${agent.channelId}/images/${image.id}`,
    );
    expect(imageResponse.rawPayload).toEqual(bytes);
    const { client } = await connect(reopened.app, agent);
    const history = await client.callTool({
      name: 'read_messages',
      arguments: { channelId: 'private' },
    });
    expect(history.isError).not.toBe(true);
    expect(blocks(history)[1]!.text).toContain('history.png');
    expect(imageBlock(history).data).toBe(bytes.toString('base64'));
  });
});
