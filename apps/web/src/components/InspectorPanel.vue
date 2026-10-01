<script setup lang="ts">
import type { Channel } from '@isles/contracts';
import { ArrowLeft, X } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useAgentDetail, useDirectory } from '@/api/queries';
import AgentDetails from './AgentDetails.vue';
import GroupDetails from './GroupDetails.vue';
import { Button } from '@/components/ui/button';

const props = defineProps<{ channel: Channel }>();
defineEmits<{ close: [] }>();

const directory = useDirectory();
// In a group, a member can be opened for its own details and execution records.
const member = ref<string | null>(null);
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
      class="fixed inset-0 z-30 bg-black/40 animate-in fade-in-0 xl:hidden"
      aria-hidden="true"
      @click="$emit('close')"
    />
    <aside
      data-testid="inspector"
      :aria-label="title"
      class="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l bg-background shadow-xl animate-in slide-in-from-right-8 fade-in-0 sm:w-[26rem] xl:static xl:z-auto xl:w-[24rem] xl:shadow-none xl:animate-none"
    >
      <header class="flex h-14 shrink-0 items-center gap-1 border-b pr-2 pl-4">
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
        <h2 class="truncate text-[15px] font-semibold">{{ title }}</h2>
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
      <div class="min-h-0 flex-1 overflow-y-auto">
        <AgentDetails
          v-if="agent"
          :key="agent.id"
          :agent="agent"
          :runs="detail.data.value?.runs"
          :directory="directory"
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
