<script setup lang="ts">
import type { Channel } from '@isles/contracts';
import { useQueryClient } from '@tanstack/vue-query';
import { CircleAlert, LoaderCircle, Plus, RefreshCw, Search, X } from '@lucide/vue';
import { computed, ref } from 'vue';
import { invalidateAll, useAgents, useChannels, useDirectory } from '@/api/queries';
import ChannelListItem from './ChannelListItem.vue';
import ConnectionStatus from './ConnectionStatus.vue';
import IslesMark from './IslesMark.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { byActivity, channelTitle } from '@/lib/channels';

defineProps<{ selectedId: string }>();
defineEmits<{ select: [id: string]; create: [kind: 'agent' | 'group'] }>();

const queryClient = useQueryClient();
const agents = useAgents();
const channels = useChannels();
const directory = useDirectory();

const search = ref('');
function matches(channel: Channel, query: string) {
  if (!query) return true;
  const people = channel.memberIds.map((id) => {
    const agent = directory.value.get(id);
    return agent ? `${agent.name} ${agent.model}` : '';
  });
  return [channelTitle(channel, directory.value), ...people]
    .join(' ')
    .toLowerCase()
    .includes(query);
}
const sections = computed(() => {
  const query = search.value.trim().toLowerCase();
  const all = (channels.data.value?.channels ?? []).toSorted(byActivity);
  const visible = all.filter((channel) => matches(channel, query));
  const deleted = (channel: Channel) =>
    channel.kind === 'group'
      ? Boolean(channel.deletedAt)
      : directory.value.get(channel.agentId ?? '')?.status === 'deleted';
  const history = all.filter(deleted);
  return [
    {
      id: 'groups',
      title: '群聊',
      total: all.filter((c) => c.kind === 'group' && !deleted(c)).length,
      items: visible.filter((c) => c.kind === 'group' && !deleted(c)),
      create: { label: '新建群聊', kind: 'group' as const },
      empty: '把多个 Agent 拉进群，一起讨论。',
    },
    {
      id: 'agents',
      title: 'Agents',
      total: all.filter((c) => c.kind === 'private' && !deleted(c)).length,
      items: visible.filter((c) => c.kind === 'private' && !deleted(c)),
      create: { label: '新建 Agent', kind: 'agent' as const },
      empty: '新建一个 Agent，开始私聊。',
    },
    ...(history.length
      ? [
          {
            id: 'history',
            title: '历史对话',
            total: history.length,
            items: visible.filter(deleted),
            create: undefined,
            empty: '',
          },
        ]
      : []),
  ];
});
const loading = computed(() => agents.isPending.value || channels.isPending.value);
const error = computed(() => agents.error.value ?? channels.error.value);
const nothingFound = computed(
  () => Boolean(search.value.trim()) && sections.value.every((s) => !s.items.length),
);

const refreshing = ref(false);
async function refresh() {
  refreshing.value = true;
  try {
    await invalidateAll(queryClient);
  } finally {
    refreshing.value = false;
  }
}
</script>

<template>
  <aside class="flex h-full flex-col border-r bg-sidebar [--avatar-ring:var(--sidebar)]">
    <header class="flex h-14 shrink-0 items-center gap-2.5 pr-2 pl-4">
      <IslesMark class="size-7 text-primary" />
      <div class="flex items-baseline gap-1.5">
        <span class="text-[15px] font-semibold tracking-tight">Isles</span>
        <span class="text-xs text-muted-foreground">群岛</span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        class="ml-auto"
        aria-label="刷新聊天列表"
        title="刷新"
        :disabled="refreshing"
        @click="refresh"
      >
        <RefreshCw :class="refreshing && 'animate-spin'" />
      </Button>
    </header>

    <div class="px-3 pb-2">
      <div class="relative">
        <Search
          class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          v-model="search"
          aria-label="搜索聊天"
          placeholder="搜索群聊、Agent 或模型"
          autocomplete="off"
          class="h-8 bg-background pr-8 pl-8"
        />
        <button
          v-if="search"
          type="button"
          class="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="清除搜索"
          @click="search = ''"
        >
          <X class="size-3.5" />
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <div
        v-if="error"
        role="alert"
        class="m-1 flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
      >
        <CircleAlert class="size-4 shrink-0" />{{ error.message }}
      </div>
      <div
        v-if="loading"
        class="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"
      >
        <LoaderCircle class="size-4 animate-spin" />正在载入…
      </div>
      <div v-else-if="nothingFound" class="px-4 py-10 text-center">
        <h3 class="text-[13px] font-medium">没有找到相关聊天</h3>
        <p class="mt-1 text-xs text-muted-foreground">试试其他名称或模型。</p>
      </div>
      <template v-else>
        <section
          v-for="section in sections"
          v-show="!search.trim() || section.items.length"
          :key="section.id"
          class="mb-2"
        >
          <div class="flex h-7 items-center gap-1.5 pr-0.5 pl-2 text-xs text-muted-foreground">
            <h2 class="font-medium">{{ section.title }}</h2>
            <span class="tabular-nums">{{ section.total }}</span>
            <Button
              v-if="section.create"
              variant="ghost"
              size="icon-xs"
              class="ml-auto"
              :aria-label="section.create.label"
              :title="section.create.label"
              @click="$emit('create', section.create.kind)"
            >
              <Plus />
            </Button>
          </div>
          <nav :aria-label="section.title" class="space-y-px">
            <ChannelListItem
              v-for="channel in section.items"
              :key="channel.id"
              :channel="channel"
              :directory="directory"
              :selected="channel.id === selectedId"
              @click="$emit('select', channel.id)"
            />
          </nav>
          <p v-if="!section.total" class="px-2 py-1.5 text-xs text-muted-foreground/80">
            {{ section.empty }}
          </p>
        </section>
      </template>
    </div>

    <footer class="border-t px-4 py-2.5">
      <ConnectionStatus />
    </footer>
  </aside>
</template>
