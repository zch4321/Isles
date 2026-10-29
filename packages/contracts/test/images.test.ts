import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  imageSchema,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_IMAGES,
  MAX_READ_IMAGE_BYTES,
  sendMessageSchema,
} from '../src/index.js';

describe('image message contracts', () => {
  it('accepts text, images, or both and supplies message defaults', () => {
    const imageId = randomUUID();
    expect(sendMessageSchema.parse({ clientId: 'text', body: '  hello  ' })).toMatchObject({
      body: 'hello',
      imageIds: [],
    });
    expect(sendMessageSchema.parse({ clientId: 'image', imageIds: [imageId] })).toMatchObject({
      body: '',
      imageIds: [imageId],
    });
    expect(sendMessageSchema.safeParse({ clientId: 'empty', body: '  ' }).success).toBe(false);
    expect(
      sendMessageSchema.safeParse({ clientId: 'repeat', imageIds: [imageId, imageId] }).success,
    ).toBe(false);
    expect(
      sendMessageSchema.safeParse({
        clientId: 'many',
        imageIds: Array.from({ length: MAX_MESSAGE_IMAGES + 1 }, () => randomUUID()),
      }).success,
    ).toBe(false);
    expect(MAX_READ_IMAGE_BYTES).toBe(MAX_IMAGE_BYTES * MAX_MESSAGE_IMAGES);
  });

  it('validates supported image metadata and ordinary file names', () => {
    const image = {
      id: randomUUID(),
      channelId: randomUUID(),
      name: '截图.png',
      mimeType: 'image/png',
      size: MAX_IMAGE_BYTES,
      width: 3,
      height: 2,
      createdAt: '2026-10-29T00:00:00.000Z',
    };
    expect(imageSchema.parse(image)).toEqual(image);
    for (const name of ['', ' ', '.', '..', 'a/b', 'a\\b', 'a\0b', 'x'.repeat(256)])
      expect(imageSchema.safeParse({ ...image, name }).success).toBe(false);
    for (const invalid of [
      { size: 0 },
      { size: MAX_IMAGE_BYTES + 1 },
      { width: 0 },
      { height: 1.5 },
      { mimeType: 'image/svg+xml' },
    ])
      expect(imageSchema.safeParse({ ...image, ...invalid }).success).toBe(false);
  });
});
