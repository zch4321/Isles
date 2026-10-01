import { computed, reactive, toValue, type MaybeRefOrGetter } from 'vue';

// Drafts survive switching conversations, but not a page reload.
const drafts = reactive(new Map<string, string>());
const pending = new Map<string, { body: string; clientId: string }>();

export function useDraft(channelId: MaybeRefOrGetter<string>) {
  return computed({
    get: () => drafts.get(toValue(channelId)) ?? '',
    set: (value: string) => void drafts.set(toValue(channelId), value),
  });
}

/** Reuses the client ID while the same body is retried, so the server can deduplicate it. */
export function outgoing(channelId: string, body: string) {
  const current = pending.get(channelId);
  if (current?.body === body) return current;
  const next = { body, clientId: crypto.randomUUID() };
  pending.set(channelId, next);
  return next;
}

export const settle = (channelId: string) => pending.delete(channelId);
