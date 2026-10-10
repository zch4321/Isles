<script setup lang="ts">
import type { Channel } from '@isles/contracts';
import { ArrowLeft, X } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { useAgentDetail, useDirectory } from '@/api/queries';
import AgentDetails from './AgentDetails.vue';
import GroupDetails from './GroupDetails.vue';
import { Button } from '@/components/ui/button';

const props = defineProps<{ channel: Channel }>();
defineEmits<{ close: [] }>();

const directory = useDirectory();
// In a group, a member can be opened for its own details and execution records.
const member = ref<string | null>(null);
watch(
  () => props.channel.deletedAt,
  (deletedAt) => {
    if (deletedAt) member.value = null;
  },
);
const agentId = computed(() =>
  props.channel.kind === 'private' ? props.channel.agentId : member.value,
);
const agent = computed(() => (agentId.value ? directory.value.get(agentId.value) : undefined));
const detail = useAgentDetail(agentId);
const title = computed(() =>
  props.channel.kind === 'private' ? 'Agent 详情' : member.value ? agent.value?.name : '群聊详情',
);
</script>

<template>
  <div class="contents">
    <!-- Below xl the panel floats over the conversation. -->
    <div
      class="fixed inset-0 z-30 bg-[var(--overlay)] backdrop-blur-[2px] animate-in fade-in-0 xl:hidden"
      aria-hidden="true"
      @click="$emit('close')"
    />
    <aside
      data-testid="inspector"
      :aria-label="title"
      class="fixed inset-y-0 right-0 z-40 flex w-full shrink-0 flex-col border-l border-line bg-sidebar shadow-3 animate-in slide-in-from-right-8 fade-in-0 sm:w-80 xl:static xl:z-auto xl:w-80 xl:shadow-none xl:animate-none"
    >
      <header
        class="flex h-16 shrink-0 items-center gap-2 border-b border-line px-4 lg:h-20 lg:px-5"
      >
        <Button
          v-if="channel.kind === 'group' && member"
          variant="ghost"
          size="icon-sm"
          class="-ml-2"
          aria-label="返回群聊详情"
          @click="member = null"
        >
          <ArrowLeft />
        </Button>
        <div class="min-w-0">
          <h2 class="truncate text-[13px] font-semibold">{{ title }}</h2>
          <p
            v-if="channel.kind === 'group' && !member && !channel.deletedAt"
            class="mt-1 text-[11px] text-ink-3"
          >
            成员与执行
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          class="ml-auto"
          aria-label="关闭详情"
          @click="$emit('close')"
        >
          <X />
        </Button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto [--avatar-ring:var(--sidebar)]">
        <AgentDetails
          v-if="agent"
          :key="agent.id"
          :agent="agent"
          :runs="detail.data.value?.runs"
          :directory="directory"
          @deleted="member = null"
        />
        <GroupDetails
          v-else-if="channel.kind === 'group'"
          :channel="channel"
          :directory="directory"
          @inspect="member = $event"
        />
      </div>
    </aside>
  </div>
</template>
