<script setup lang="ts">
import type { Agent, Channel } from '@isles/contracts';
import { ArrowLeft, LoaderCircle, PanelRight, Pause, Play, Square } from '@lucide/vue';
import { computed } from 'vue';
import GroupAvatar from './GroupAvatar.vue';
import ParticipantAvatar from './ParticipantAvatar.vue';
import StatusBadge from './StatusBadge.vue';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const props = defineProps<{
  channel: Channel;
  /** The Agent of a private chat. */
  agent: Agent | undefined;
  members: Agent[];
  inspectorOpen: boolean;
  controlPending: boolean;
}>();
defineEmits<{
  back: [];
  stop: [];
  resume: [];
  pause: [];
  continue: [];
  toggleInspector: [];
}>();

const canResume = computed(
  () => props.agent?.desiredState === 'stopped' || props.agent?.status === 'error',
);
const running = computed(() => props.members.filter((m) => m.status === 'running').length);
</script>

<template>
  <header class="flex h-14 shrink-0 items-center gap-2.5 border-b pr-2 pl-2 md:pr-3 md:pl-4">
    <Button
      variant="ghost"
      size="icon-sm"
      class="md:hidden"
      aria-label="返回聊天列表"
      @click="$emit('back')"
    >
      <ArrowLeft />
    </Button>
    <template v-if="agent">
      <ParticipantAvatar :name="agent.name" :identity="agent.id" size="sm" />
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <h1 class="truncate text-[15px] font-semibold">{{ agent.name }}</h1>
          <StatusBadge data-testid="agent-status" :status="agent.status" />
        </div>
        <p class="truncate text-xs text-muted-foreground">
          Codex · {{ agent.model }} · {{ agent.reasoningEffort }}
        </p>
      </div>
      <Button
        v-if="agent.status !== 'deleted' && canResume"
        variant="outline"
        size="sm"
        aria-label="恢复 Agent"
        :disabled="controlPending"
        @click="$emit('resume')"
      >
        <LoaderCircle v-if="controlPending" class="animate-spin" /><Play v-else />恢复
      </Button>
      <Button
        v-else-if="agent.status !== 'deleted'"
        variant="outline"
        size="sm"
        aria-label="停止 Agent"
        :disabled="controlPending"
        @click="$emit('stop')"
      >
        <LoaderCircle v-if="controlPending" class="animate-spin" /><Square v-else />停止
      </Button>
    </template>
    <template v-else>
      <GroupAvatar :identity="channel.id" size="sm" />
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <h1 class="truncate text-[15px] font-semibold">{{ channel.name }}</h1>
          <span
            v-if="channel.paused"
            data-testid="group-status"
            class="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-px text-[11px] leading-4 font-medium text-muted-foreground"
            ><Pause class="size-3" aria-hidden="true" />已暂停</span
          >
        </div>
        <p class="truncate text-xs text-muted-foreground">
          {{ members.length }} 位成员<template v-if="running"> · {{ running }} 位执行中</template>
        </p>
      </div>
      <div class="flex -space-x-1.5 max-sm:hidden">
        <ParticipantAvatar
          v-for="member in members.slice(0, 4)"
          :key="member.id"
          :name="member.name"
          :identity="member.id"
          size="sm"
          class="ring-2 ring-background"
        />
      </div>
      <Button
        v-if="channel.paused"
        variant="outline"
        size="sm"
        aria-label="继续讨论"
        :disabled="controlPending"
        @click="$emit('continue')"
      >
        <LoaderCircle v-if="controlPending" class="animate-spin" /><Play v-else />继续
      </Button>
      <Button
        v-else
        variant="outline"
        size="sm"
        aria-label="暂停讨论"
        title="暂停自动投递，成员仍可主动读取消息"
        :disabled="controlPending"
        @click="$emit('pause')"
      >
        <LoaderCircle v-if="controlPending" class="animate-spin" /><Pause v-else />暂停
      </Button>
    </template>
    <Button
      variant="ghost"
      size="icon-sm"
      :aria-label="agent ? 'Agent 详情' : '群聊详情'"
      :title="agent ? 'Agent 详情' : '群聊详情'"
      :aria-expanded="inspectorOpen"
      :class="cn(inspectorOpen && 'bg-accent text-accent-foreground')"
      @click="$emit('toggleInspector')"
    >
      <PanelRight />
    </Button>
  </header>
</template>
