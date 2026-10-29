import { MAX_IMAGE_BYTES, MAX_MESSAGE_IMAGES, type MessageImage } from '@isles/contracts';
import { computed, markRaw, reactive, toValue, type MaybeRefOrGetter } from 'vue';
import { uploadImage } from '@/api/isles';
import { errorMessage } from '@/lib/format';

export type DraftImage = {
  key: string;
  file: File;
  url: string;
  status: 'uploading' | 'ready' | 'error';
  image?: MessageImage;
  error?: string;
};
type Draft = {
  body: string;
  images: DraftImage[];
  feedback: string;
  sendError: string;
  sending: boolean;
};

// Drafts and in-flight uploads survive switching conversations, but not a page reload.
const drafts = reactive(new Map<string, Draft>());
const pending = new Map<string, { body: string; imageIds: string[]; clientId: string }>();
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function draftFor(channelId: string) {
  if (!drafts.has(channelId))
    drafts.set(channelId, { body: '', images: [], feedback: '', sendError: '', sending: false });
  return drafts.get(channelId)!;
}

export function useDraft(channelId: MaybeRefOrGetter<string>) {
  return computed(() => draftFor(toValue(channelId)));
}

async function upload(channelId: string, entry: DraftImage) {
  entry.status = 'uploading';
  delete entry.error;
  try {
    const image = await uploadImage(channelId, entry.file);
    const draft = draftFor(channelId);
    if (!draft.images.some((item) => item.key === entry.key)) return;
    if (draft.images.some((item) => item.key !== entry.key && item.image?.id === image.id)) {
      removeImage(channelId, entry.key);
      draft.feedback = `${entry.file.name} 已添加，请选择其他图片`;
      return;
    }
    entry.image = image;
    entry.status = 'ready';
  } catch (error) {
    entry.error = errorMessage(error);
    entry.status = 'error';
  }
}

export function addImages(channelId: string, files: File[]) {
  const draft = draftFor(channelId);
  const errors: string[] = [];
  draft.feedback = '';
  for (const file of files) {
    if (draft.images.length >= MAX_MESSAGE_IMAGES) {
      errors.push(`每条消息最多添加 ${MAX_MESSAGE_IMAGES} 张图片`);
      break;
    }
    if (file.type && file.type !== 'application/octet-stream' && !imageTypes.has(file.type)) {
      errors.push(`${file.name}：请选择 PNG、JPEG、WebP 或 GIF 图片`);
      continue;
    }
    if (!file.size || file.size > MAX_IMAGE_BYTES) {
      errors.push(`${file.name}：图片大小需在 1 字节至 10 MB 之间`);
      continue;
    }
    const entry: DraftImage = {
      key: crypto.randomUUID(),
      file: markRaw(file),
      url: URL.createObjectURL(file),
      status: 'uploading',
    };
    draft.images.push(entry);
    void upload(channelId, draft.images[draft.images.length - 1]!);
  }
  draft.feedback = errors.join('；');
}

function releaseImage(draft: Draft, key: string) {
  const index = draft.images.findIndex((entry) => entry.key === key);
  if (index < 0) return;
  const [entry] = draft.images.splice(index, 1);
  URL.revokeObjectURL(entry!.url);
}

export function removeImage(channelId: string, key: string) {
  const draft = draftFor(channelId);
  releaseImage(draft, key);
  draft.feedback = '';
}

export function retryImage(channelId: string, key: string) {
  const entry = draftFor(channelId).images.find((image) => image.key === key);
  if (entry?.status === 'error') void upload(channelId, entry);
}

/** Reuses the client ID while the same text and images are retried. */
export function outgoing(channelId: string, body: string, imageIds: string[]) {
  const current = pending.get(channelId);
  if (
    current?.body === body &&
    current.imageIds.length === imageIds.length &&
    current.imageIds.every((id, index) => id === imageIds[index])
  )
    return current;
  const next = { body, imageIds, clientId: crypto.randomUUID() };
  pending.set(channelId, next);
  return next;
}

export function settle(channelId: string, clientId: string) {
  if (pending.get(channelId)?.clientId === clientId) pending.delete(channelId);
}

export function clearSubmitted(channelId: string, body: string, keys: string[]) {
  const draft = draftFor(channelId);
  if (draft.body.trim() === body) draft.body = '';
  for (const key of keys) releaseImage(draft, key);
}
