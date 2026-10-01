import { eventSchema } from '@isles/contracts';
import { useQueryClient } from '@tanstack/vue-query';
import { onBeforeUnmount, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { invalidateAll } from '@/api/queries';

/**
 * Follows the durable event log over SSE and refreshes the affected queries.
 * The stream starts at the snapshot cursor so it only replays newer events; after a
 * disconnect the browser resumes from Last-Event-ID.
 */
export function useEventStream(cursor: MaybeRefOrGetter<number | undefined>) {
  const queryClient = useQueryClient();
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Events arrive in bursts (a turn streams many items), so refreshes are batched.
  const scheduleRefresh = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      void invalidateAll(queryClient);
    }, 150);
  };

  watch(
    () => toValue(cursor),
    (after) => {
      if (after === undefined || source) return;
      source = new EventSource(`/api/events?after=${after}`);
      source.onmessage = (message) => {
        let event;
        try {
          event = eventSchema.safeParse(JSON.parse(message.data));
        } catch {
          return;
        }
        if (event.success) scheduleRefresh();
      };
      source.onopen = () => {
        void invalidateAll(queryClient);
        void queryClient.invalidateQueries({ queryKey: ['health'] });
      };
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    source?.close();
    if (timer) clearTimeout(timer);
  });
}
