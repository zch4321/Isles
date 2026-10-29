import { MAX_IMAGE_BYTES, MAX_READ_IMAGE_BYTES } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/database.js';
import { Store, takeMessagesWithinImageBudget } from '../src/storage/store.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-image-storage-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  let database = openDatabase(data);
  cleanups.push(() => {
    if (database.sqlite.open) database.sqlite.close();
  });
  let store = new Store(database, join(root, 'workspace'));
  const agent = store.createAgent({
    harness: 'codex',
    name: 'Image agent',
    model: 'test-model',
    reasoningEffort: 'high',
    canCreateGroups: false,
    nativeHome: 'test-native-home',
  });
  let nextImage = 0;
  const image = (channelId = agent.channelId, size = MAX_IMAGE_BYTES) => {
    const number = ++nextImage;
    return store.registerImage({
      id: randomUUID(),
      channelId,
      name: `image-${number}.png`,
      mimeType: 'image/png',
      size,
      width: 3,
      height: 2,
      sha256: number.toString(16).padStart(64, '0'),
    });
  };
  const send = (channelId: string, imageIds: string[], clientId: string = randomUUID()) =>
    store.saveMessage(channelId, { type: 'user' }, { body: '', imageIds, clientId });
  const status = (channelId: string, seq: number) =>
    store
      .listMessages(channelId, { after: seq - 1, limit: 1 })[0]!
      .deliveries.find((delivery) => delivery.agentId === agent.id)?.status;
  return {
    get store() {
      return store;
    },
    agent,
    image,
    send,
    status,
    reopen() {
      database.sqlite.close();
      database = openDatabase(data);
      store = new Store(database, join(root, 'workspace'));
    },
  };
}

describe('image storage', () => {
  it('persists ordered images, validates ownership and matches retries by ordered IDs', async () => {
    const f = await fixture();
    const first = f.image();
    const second = f.image();
    const duplicate = f.store.registerImage({ ...first, id: randomUUID() });
    expect(duplicate).toEqual(first);
    expect(f.store.findImage(first.channelId, first.sha256, first.name)).toEqual(first);
    expect(f.store.findImage(first.channelId, first.sha256, 'different.png')).toBeUndefined();
    const foreignChannel = f.store.createGroup('user', 'Other channel', []);
    const foreign = f.image(foreignChannel.id);
    expect(() => f.store.getImage(foreignChannel.id, first.id)).toThrow('图片不存在');
    expect(() => f.send(f.agent.channelId, [foreign.id])).toThrow('请选择当前频道的图片');
    expect(() => f.send(f.agent.channelId, [first.id, first.id])).toThrow('请移除重复图片');
    expect(() => f.send(f.agent.channelId, [])).toThrow('请输入消息或添加图片');
    const tooMany = Array.from({ length: 5 }, () => f.image().id);
    expect(() => f.send(f.agent.channelId, tooMany)).toThrow('每条消息最多添加 4 张图片');
    const sent = f.send(f.agent.channelId, [second.id, first.id], 'retry');
    expect(sent.body).toBe('');
    expect(sent.images.map((image) => image.id)).toEqual([second.id, first.id]);
    expect(sent.images[0]).not.toHaveProperty('sha256');
    expect(f.send(f.agent.channelId, [second.id, first.id], 'retry').seq).toBe(sent.seq);
    expect(() => f.send(f.agent.channelId, [first.id, second.id], 'retry')).toThrow(
      '去重标识已用于不同内容',
    );
    f.reopen();
    expect(f.store.getImage(first.id)).toEqual(first);
    expect(f.store.listMessages(f.agent.channelId)[0]!.images).toEqual(sent.images);
    expect(f.store.chatExportSnapshot(f.agent.channelId).messages[0]!.images).toEqual(sent.images);
  });

  it('keeps image history readable and protects deleted group and private channels', async () => {
    const f = await fixture();
    const group = f.store.createGroup('user', 'Images', [f.agent.id]);
    expect(group.lastMessage?.images).toEqual([]);
    const groupImage = f.image(group.id);
    const sent = f.send(group.id, [groupImage.id]);
    f.store.deleteGroup(group.id);
    expect(
      f.store.listMessages(group.id).find((message) => message.seq === sent.seq)!.images[0],
    ).toMatchObject({ id: groupImage.id });
    expect(() => f.store.registerImage({ ...groupImage, id: randomUUID() })).toThrow('群聊已删除');
    expect(() => f.send(group.id, [groupImage.id])).toThrow('群聊已删除');
    const privateImage = f.image();
    const privateMessage = f.send(f.agent.channelId, [privateImage.id]);
    f.store.deleteAgent(f.agent.id);
    expect(
      f.store.listMessages(f.agent.channelId).find((message) => message.seq === privateMessage.seq)!
        .images[0],
    ).toMatchObject({ id: privateImage.id });
    expect(() => f.store.registerImage({ ...privateImage, id: randomUUID() })).toThrow(
      '该 Agent 已删除',
    );
    expect(() => f.send(f.agent.channelId, [privateImage.id])).toThrow('该 Agent 已删除');
  });

  it('limits receipt pages before recording delivery and reports remaining messages', async () => {
    const f = await fixture();
    const sent = Array.from({ length: 5 }, () => f.send(f.agent.channelId, [f.image().id]));
    const first = f.store.receiveMessages(f.agent.id, { limit: 20 });
    expect(
      first.input.flatMap((channel) => channel.messages).map((message) => message.seq),
    ).toEqual(sent.slice(0, 4).map((message) => message.seq));
    expect(first.hasMore).toBe(true);
    expect(sent.map((message) => f.status(f.agent.channelId, message.seq))).toEqual([
      'received',
      'received',
      'received',
      'received',
      'queued',
    ]);
    const second = f.store.receiveMessages(f.agent.id, { limit: 20 });
    expect(second.hasMore).toBe(false);
    expect(second.input[0]!.messages.map((message) => message.seq)).toEqual([sent[4]!.seq]);
    expect(f.status(f.agent.channelId, sent[4]!.seq)).toBe('received');
  });

  it('limits native turn images while leaving overflow queued and retaining recent trimming', async () => {
    const f = await fixture();
    const group = f.store.createGroup('user', 'Queue', [f.agent.id]);
    const sent = Array.from({ length: 12 }, () => f.send(group.id, [f.image(group.id).id]));
    const run = f.store.startRun(f.agent.id, 'native-thread')!;
    expect(run.input.flatMap((channel) => channel.messages).map((message) => message.seq)).toEqual(
      sent.slice(2, 6).map((message) => message.seq),
    );
    expect(
      run.input[0]!.messages.flatMap((message) => message.images).reduce(
        (n, image) => n + image.size,
        0,
      ),
    ).toBe(MAX_READ_IMAGE_BYTES);
    expect(sent.map((message) => f.status(group.id, message.seq))).toEqual([
      'skipped',
      'skipped',
      'submitting',
      'submitting',
      'submitting',
      'submitting',
      'queued',
      'queued',
      'queued',
      'queued',
      'queued',
      'queued',
    ]);
  });

  it('trims forward and backward history pages at whole-message boundaries', async () => {
    const f = await fixture();
    const sent = Array.from({ length: 5 }, () => f.send(f.agent.channelId, [f.image().id]));
    expect(takeMessagesWithinImageBudget(sent).map((message) => message.seq)).toEqual(
      sent.slice(0, 4).map((message) => message.seq),
    );
    expect(takeMessagesWithinImageBudget(sent, 'end').map((message) => message.seq)).toEqual(
      sent.slice(1).map((message) => message.seq),
    );
  });
});
