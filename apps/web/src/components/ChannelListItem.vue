<script setup lang="ts">
import type { Channel } from '@isles/contracts';
import { CircleAlert, Pause } from '@lucide/vue';
import { computed } from 'vue';
import GroupAvatar from './GroupAvatar.vue';
import ParticipantAvatar from './ParticipantAvatar.vue';
import { channelTitle, lastActivity, preview, type Directory } from '@/lib/channels';
import { listTime } from '@/lib/format';

const props = defineProps<{ channel: Channel; directory: Directory; selected: boolean }>();

const agent = computed(() =>
  props.channel.kind === 'private' ? props.directory.get(props.channel.agentId ?? '') : undefined,
);
const members = computed(() =>
  props.channel.memberIds.flatMap((id) => props.directory.get(id) ?? []),
);
const title = computed(() => channelTitle(props.channel, props.directory));
const summary = computed(() => {
  if (agent.value?.status === 'running') return { text: '正在处理…', active: true };
  const running = members.value.filter((m) => m.status === 'running').length;
  if (props.channel.kind === 'group' && running && !props.channel.paused)
    return { text: `${running} 位成员正在处理…`, active: true };
  return {
    text:
      preview(props.channel, props.directory) ??
      (agent.value ? agent.value.model : `${members.value.length} 位成员`),
    active: false,
  };
});
// Paused groups and stopped Agents both hold new messages until resumed.
const held = computed(() =>
  agent.value
    ? agent.value.status !== 'deleted' && agent.value.desiredState === 'stopped'
    : props.channel.paused,
);
</script>

<template>
  <button
    type="button"
    :aria-current="selected || undefined"
    class="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none aria-[current=true]:bg-accent aria-[current=true]:[--avatar-ring:var(--accent)]"
  >
    <ParticipantAvatar
      v-if="agent"
      :name="agent.name"
      :identity="agent.id"
      :status="agent.status"
    />
    <GroupAvatar v-else :identity="channel.id" />
    <span class="min-w-0 flex-1">
      <span class="flex items-baseline gap-2">
        <span class="truncate text-[13.5px] font-medium">{{ title }}</span>
        <time class="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">{{
          listTime(lastActivity(channel))
        }}</time>
      </span>
      <span class="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span :class="['truncate', summary.active && 'text-primary']">{{ summary.text }}</span>
        <span v-if="agent?.status === 'deleted'" class="ml-auto shrink-0 text-[11px]">已删除</span>
        <template v-if="held">
          <Pause class="ml-auto size-3.5 shrink-0" aria-hidden="true" /><span class="sr-only">{{
            agent ? '已停止' : '已暂停'
          }}</span>
        </template>
        <template v-else-if="agent?.status === 'error'">
          <CircleAlert class="ml-auto size-3.5 shrink-0 text-destructive" aria-hidden="true" /><span
            class="sr-only"
            >异常</span
          >
        </template>
      </span>
    </span>
  </button>
</template>
