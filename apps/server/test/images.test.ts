import { MAX_IMAGE_BYTES } from '@isles/contracts';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_FRAMES, MessageImages } from '../src/runtime/images.js';
import { testConfig } from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'isles-images-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const config = testConfig(directory);
  const app = await buildApp({ config });
  cleanups.push(() => app.close());
  const extra = join(directory, 'extra');
  await mkdir(extra);
  const create = (name: string, workspacePaths: string[] = []) =>
    app.isles.store.createAgent({
      name,
      harness: 'codex',
      model: 'test',
      reasoningEffort: 'high',
      canCreateGroups: false,
      nativeHome: directory,
      workspacePaths,
    });
  const agent = create('Agent', [extra]);
  const other = create('Other');
  await mkdir(agent.workspace, { recursive: true });
  await mkdir(other.workspace, { recursive: true });
  const group = app.isles.store.createGroup('user', '群聊', [agent.id]);
  return { app, directory, config, agent, other, group, extra };
}

async function sample(format: 'png' | 'jpeg' | 'webp' | 'gif') {
  return sharp({ create: { width: 4, height: 3, channels: 3, background: '#123456' } })
    [format]()
    .toBuffer();
}

describe('message images', () => {
  it('uploads original PNG, JPEG, WebP and GIF bytes, with channel-scoped deduplication', async () => {
    const { app, agent, group } = await fixture();
    for (const format of ['png', 'jpeg', 'webp', 'gif'] as const) {
      const bytes = await sample(format);
      const name = `图片.${format}`;
      const url = `/api/channels/${group.id}/images?name=${encodeURIComponent(name)}`;
      const upload = () =>
        app.inject({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/octet-stream' },
          payload: bytes,
        });
      const response = await upload();
      expect(response.statusCode).toBe(201);
      const image = response.json();
      expect(image).toMatchObject({
        channelId: group.id,
        name,
        mimeType: `image/${format}`,
        size: bytes.length,
        width: 4,
        height: 3,
      });
      expect(image.sha256).toBeUndefined();
      expect((await upload()).json().id).toBe(image.id);
      const fetched = await app.inject(`/api/channels/${group.id}/images/${image.id}`);
      expect(fetched.statusCode).toBe(200);
      expect(fetched.headers['content-type']).toBe(`image/${format}`);
      expect(fetched.headers['x-content-type-options']).toBe('nosniff');
      expect(fetched.headers['cache-control']).toBe('no-store');
      expect(fetched.rawPayload).toEqual(bytes);
      expect(
        (await app.inject(`/api/channels/${agent.channelId}/images/${image.id}`)).statusCode,
      ).toBe(404);
      const separate = await app.inject({
        method: 'POST',
        url: `/api/channels/${agent.channelId}/images?name=${encodeURIComponent(name)}`,
        headers: { 'content-type': `image/${format}` },
        payload: bytes,
      });
      expect(separate.json().id).not.toBe(image.id);
    }
  });

  it('validates binary content, filenames, dimensions, frame count and byte limit', async () => {
    const { app, group } = await fixture();
    const url = `/api/channels/${group.id}/images?name=a.png`;
    const post = (payload: Buffer, type = 'image/png') =>
      app.inject({ method: 'POST', url, headers: { 'content-type': type }, payload });
    const png = await sample('png');
    expect((await post(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).statusCode).toBe(
      400,
    );
    expect((await post(png.subarray(0, png.length - 20))).statusCode).toBe(400);
    expect((await post(png.subarray(0, png.length - 1))).statusCode).toBe(400);
    const badCrc = Buffer.from(png);
    badCrc[badCrc.length - 1] = badCrc[badCrc.length - 1]! ^ 1;
    expect((await post(badCrc)).statusCode).toBe(400);
    expect((await post(Buffer.alloc(MAX_IMAGE_BYTES + 1))).statusCode).toBe(413);
    const large = await sharp({
      create: { width: MAX_IMAGE_DIMENSION + 1, height: 1, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    expect((await post(large)).statusCode).toBe(400);
    const frameCount = MAX_IMAGE_FRAMES + 1;
    const pixels = Buffer.alloc(12 * frameCount);
    for (let frame = 0; frame < frameCount; frame++)
      pixels.fill((frame % 2) * 255, 12 * frame, 12 * (frame + 1));
    const animation = await sharp(pixels, {
      raw: { width: 2, height: 2 * (MAX_IMAGE_FRAMES + 1), channels: 3, pageHeight: 2 },
    })
      .gif({ delay: Array(frameCount).fill(100) })
      .toBuffer();
    expect((await post(animation, 'image/gif')).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url, payload: { data: 'invalid' } })).statusCode,
    ).toBe(415);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${url.replace('a.png', '..')}`,
          headers: { 'content-type': 'image/png' },
          payload: png,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/channels/${group.id}/images?name=${encodeURIComponent('../bad.png')}`,
          headers: { 'content-type': 'image/png' },
          payload: png,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('fully validates animated GIF and WebP frames and rejects truncated tails', async () => {
    const { app, group } = await fixture();
    const pixels = Buffer.alloc(24);
    pixels.fill(255, 12);
    for (const format of ['gif', 'webp'] as const) {
      const bytes = await sharp(pixels, {
        raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
      })
        [format]({ delay: [100, 100] })
        .toBuffer();
      const url = `/api/channels/${group.id}/images?name=animated.${format}`;
      const post = (payload: Buffer) =>
        app.inject({
          method: 'POST',
          url,
          headers: { 'content-type': `image/${format}` },
          payload,
        });
      const response = await post(bytes);
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ width: 2, height: 2 });
      for (const cut of [1, 5, 10])
        expect((await post(bytes.subarray(0, bytes.length - cut))).statusCode).toBe(400);
    }
  });

  it('imports only allowed canonical files for members and materializes stable snapshots', async () => {
    const { app, directory, config, agent, other, group, extra } = await fixture();
    const bytes = await sample('png');
    const local = join(agent.workspace, 'local.png');
    const shared = join(config.current.sharedDir, 'shared.png');
    const added = join(extra, 'added.png');
    const outside = join(directory, 'outside');
    await mkdir(outside);
    const external = join(outside, 'external.png');
    for (const file of [local, shared, added, external]) await writeFile(file, bytes);
    const images = app.isles.runtime.images;
    await expect(images.importFiles(other, group.id, [local])).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(images.importFiles(agent, group.id, [external])).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(images.importFiles(agent, group.id, ['relative.png'])).rejects.toMatchObject({
      statusCode: 400,
    });
    const alias = join(agent.workspace, 'outside-link');
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      images.importFiles(agent, group.id, [join(alias, 'external.png')]),
    ).rejects.toMatchObject({ statusCode: 403 });
    const imported = await images.importFiles(agent, group.id, [local, shared, added]);
    expect(imported.map((image) => image.name)).toEqual(['local.png', 'shared.png', 'added.png']);
    expect((await images.importFiles(agent, group.id, [local]))[0]!.id).toBe(imported[0]!.id);
    await writeFile(local, 'changed original');
    expect(Buffer.from((await images.load(imported[0]!)).data, 'base64')).toEqual(bytes);
    const copies = await images.materialize(agent, imported);
    expect(copies.size).toBe(3);
    for (const copy of copies.values()) {
      expect(copy.startsWith(join(agent.workspace, '.isles-images'))).toBe(true);
      expect(await readFile(copy)).toEqual(bytes);
    }
    await expect(images.materialize(other, imported)).rejects.toMatchObject({ statusCode: 403 });
    app.isles.store.updateAgent(agent.id, { dangerFullAccess: true });
    expect((await images.importFiles(agent, group.id, [external]))[0]!.name).toBe('external.png');
  });

  it('cleans failed registrations and preserves historical image reads after deletion', async () => {
    const { app, directory, agent, group } = await fixture();
    const images = app.isles.runtime.images;
    const bytes = await sample('png');
    const privateImage = await images.upload(agent.channelId, bytes, 'private.png');
    const [image, duplicate] = await Promise.all([
      images.upload(group.id, bytes, 'a.png'),
      images.upload(group.id, bytes, 'a.png'),
    ]);
    expect(duplicate.id).toBe(image.id);
    const registration = vi.spyOn(app.isles.store, 'registerImage').mockImplementationOnce(() => {
      throw new Error('registration failed');
    });
    await expect(images.upload(group.id, bytes, 'b.png')).rejects.toThrow('registration failed');
    registration.mockRestore();
    expect(await readdir(join(directory, 'images', group.id))).toHaveLength(1);
    app.isles.store.deleteGroup(group.id);
    await expect(images.upload(group.id, bytes, 'b.png')).rejects.toMatchObject({
      statusCode: 409,
    });
    const response = await app.inject(`/api/channels/${group.id}/images/${image.id}`);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(await readdir(join(directory, 'images', group.id))).toHaveLength(1);
    await writeFile(images.path(image), Buffer.alloc(bytes.length, 0xff));
    expect((await app.inject(`/api/channels/${group.id}/images/${image.id}`)).statusCode).toBe(400);
    await expect(images.load(image)).rejects.toMatchObject({ statusCode: 400 });
    app.isles.store.deleteAgent(agent.id);
    expect(
      (await app.inject(`/api/channels/${agent.channelId}/images/${privateImage.id}`)).statusCode,
    ).toBe(200);
    await expect(images.upload(agent.channelId, bytes, 'new.png')).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('reuses verified per-Agent copies across repeated calls and service restarts', async () => {
    const { app, agent, other, group } = await fixture();
    const images = app.isles.runtime.images;
    const bytes = await sample('png');
    const image = await images.upload(group.id, bytes, 'a.png');
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => images.materialize(agent, [image])),
    );
    const first = concurrent[0]!.get(image.id)!;
    expect(concurrent.every((copy) => copy.get(image.id) === first)).toBe(true);
    for (let repeat = 0; repeat < 100; repeat++)
      expect((await images.materialize(agent, [image])).get(image.id)).toBe(first);
    expect(await readFile(first)).toEqual(bytes);
    expect(await readdir(join(agent.workspace, '.isles-images'))).toHaveLength(1);
    const restarted = new MessageImages(app.isles.store, app.isles.runtime.workspace);
    expect((await restarted.materialize(agent, [image])).get(image.id)).toBe(first);

    app.isles.store.addMembers(group.id, 'user', [other.id]);
    const otherPath = (await images.materialize(other, [image])).get(image.id)!;
    expect(otherPath).not.toBe(first);
    expect(otherPath.startsWith(join(other.workspace, '.isles-images'))).toBe(true);
    expect(await readFile(otherPath)).toEqual(bytes);

    const altered = Buffer.from(bytes);
    altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
    await writeFile(first, altered);
    const replacement = (await images.materialize(agent, [image])).get(image.id)!;
    expect(replacement).not.toBe(first);
    expect(await readFile(first)).toEqual(altered);
    expect(await readFile(replacement)).toEqual(bytes);
    expect(await readFile(otherPath)).toEqual(bytes);
    expect(Buffer.from((await images.load(image)).data, 'base64')).toEqual(bytes);
    expect((await restarted.materialize(agent, [image])).get(image.id)).toBe(replacement);
    expect(await readdir(join(agent.workspace, '.isles-images'))).toHaveLength(2);
    await writeFile(images.path(image), altered);
    await expect(images.materialize(agent, [image])).rejects.toMatchObject({ statusCode: 400 });
  });

  it('replaces a redirected cached path with a new regular workspace copy', async () => {
    const { app, agent, directory, group } = await fixture();
    const images = app.isles.runtime.images;
    const bytes = await sample('png');
    const image = await images.upload(group.id, bytes, 'a.png');
    const first = (await images.materialize(agent, [image])).get(image.id)!;
    const outside = join(directory, 'copy-target');
    await mkdir(outside);
    const sentinel = join(outside, 'sentinel');
    await writeFile(sentinel, 'unchanged');
    await rm(first);
    await symlink(outside, first, process.platform === 'win32' ? 'junction' : 'dir');
    const replacement = (await images.materialize(agent, [image])).get(image.id)!;
    expect(replacement).not.toBe(first);
    expect(await readFile(replacement)).toEqual(bytes);
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
  });

  it('keeps central and workspace image files inside their intended directories', async () => {
    const { app, agent, directory, group } = await fixture();
    const images = app.isles.runtime.images;
    const bytes = await sample('png');
    const image = await images.upload(group.id, bytes, 'a.png');
    const outside = join(directory, 'outside-images');
    await mkdir(outside);
    await symlink(
      outside,
      join(agent.workspace, '.isles-images'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(images.materialize(agent, [image])).rejects.toMatchObject({ statusCode: 400 });
    expect(await readdir(outside)).toEqual([]);

    const channelDirectory = join(directory, 'images', group.id);
    await rename(channelDirectory, `${channelDirectory}-saved`);
    await symlink(outside, channelDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(images.upload(group.id, bytes, 'b.png')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect((await app.inject(`/api/channels/${group.id}/images/${image.id}`)).statusCode).toBe(400);
    expect(await readdir(outside)).toEqual([]);
  });

  it('does not create a channel folder through a redirected image root', async () => {
    const { app, directory, group } = await fixture();
    const outside = join(directory, 'outside-images');
    await mkdir(outside);
    await symlink(
      outside,
      join(directory, 'images'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      app.isles.runtime.images.upload(group.id, await sample('png'), 'a.png'),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await readdir(outside)).toEqual([]);
  });
});
