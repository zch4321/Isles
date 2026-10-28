import type { Agent, HarnessCapabilities } from '@isles/contracts';
import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { fetchHealth } from './health';
import {
  fetchAgentDetail,
  fetchAgents,
  fetchChannelDetail,
  fetchChannels,
  fetchHarnesses,
  fetchWorkspaceSettings,
} from './isles';

export const useHarnesses = () => useQuery({ queryKey: ['harnesses'], queryFn: fetchHarnesses });
export const useWorkspaceSettings = () =>
  useQuery({ queryKey: ['workspaces'], queryFn: fetchWorkspaceSettings });

export function useHarnessName(id: MaybeRefOrGetter<string>) {
  const harnesses = useHarnesses();
  return computed(
    () =>
      harnesses.data.value?.harnesses.find((harness) => harness.id === toValue(id))?.displayName ??
      toValue(id),
  );
}

export function useHarnessCapability(
  id: MaybeRefOrGetter<string>,
  capability: keyof HarnessCapabilities,
) {
  const harnesses = useHarnesses();
  return computed(() =>
    Boolean(
      harnesses.data.value?.harnesses.find((harness) => harness.id === toValue(id))?.capabilities[
        capability
      ],
    ),
  );
}

// SSE drives most refreshes; the intervals are a fallback when the stream is down.
export const useHealth = () =>
  useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 15_000 });

export const useAgents = () =>
  useQuery({ queryKey: ['agents'], queryFn: () => fetchAgents(), refetchInterval: 10_000 });

/** Agents by ID, for sender names, members and mentions. */
export function useDirectory() {
  const agents = useQuery({
    queryKey: ['agents', 'directory'],
    queryFn: () => fetchAgents(true),
    refetchInterval: 10_000,
  });
  return computed(() => new Map<string, Agent>(agents.data.value?.agents.map((a) => [a.id, a])));
}

export const useChannels = () =>
  useQuery({ queryKey: ['channels'], queryFn: () => fetchChannels(true), refetchInterval: 10_000 });

export function useChannelDetail(id: MaybeRefOrGetter<string>) {
  return useQuery({
    queryKey: computed(() => ['channel', toValue(id)]),
    queryFn: () => fetchChannelDetail(toValue(id)),
    enabled: computed(() => Boolean(toValue(id))),
    refetchInterval: 5_000,
  });
}

export function useAgentDetail(id: MaybeRefOrGetter<string | null>) {
  return useQuery({
    queryKey: computed(() => ['agent', toValue(id)]),
    queryFn: () => fetchAgentDetail(toValue(id)!),
    enabled: computed(() => Boolean(toValue(id))),
    refetchInterval: 5_000,
  });
}

export const invalidateAll = (client: QueryClient) =>
  Promise.all(
    ['agents', 'channels', 'channel', 'agent'].map((key) =>
      client.invalidateQueries({ queryKey: [key] }),
    ),
  );
