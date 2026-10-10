<script setup lang="ts">
import type { Agent, Channel } from '@isles/contracts';
import {
  ArrowLeft,
  ChartPie,
  Download,
  Ellipsis,
  LoaderCircle,
  PanelRight,
  Pause,
  Play,
  Square,
} from '@lucide/vue';
import { computed, ref } from 'vue';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui';
import { useHarnessName } from '@/api/queries';
import GroupAvatar from './GroupAvatar.vue';
import ParticipantAvatar from './ParticipantAvatar.vue';
import StatusBadge from './StatusBadge.vue';
import AgentContextDialog from './AgentContextDialog.vue';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const props = defineProps<{
  channel: Channel;
  /** The Agent of a private chat. */
  agent: Agent | undefined;
  members: Agent[];
  inspectorOpen: boolean;
  controlPending: boolean;
  exportPending: boolean;
}>();
defineEmits<{
  back: [];
  stop: [];
  resume: [];
  pause: [];
  continue: [];
  toggleInspector: [];
  export: [];
}>();

const canResume = computed(
  () => props.agent?.desiredState === 'stopped' || props.agent?.status === 'error',
);
const running = computed(() => props.members.filter((m) => m.status === 'running').length);
const harnessName = useHarnessName(() => props.agent?.harness ?? '');
const contextOpen = ref(false);
</script>

<template>
  <header
    class="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 lg:h-20 lg:px-6"
  >
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
      <ParticipantAvatar :name="agent.name" :identity="agent.id" size="md" />
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <h1 class="truncate text-base font-semibold tracking-tight lg:text-[17px]">
            {{ agent.name }}
          </h1>
          <StatusBadge data-testid="agent-status" :status="agent.status" />
        </div>
        <p class="mt-1 truncate font-mono text-[11px] text-ink-3">
          {{ harnessName }} · {{ agent.model }} · {{ agent.reasoningEffort }}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="上下文"
        title="上下文"
        @click="contextOpen = true"
      >
        <ChartPie />
      </Button>
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
      <GroupAvatar :identity="channel.id" size="md" />
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <h1 class="truncate text-base font-semibold tracking-tight lg:text-[17px]">
            {{ channel.name }}
          </h1>
          <span
            v-if="channel.deletedAt"
            data-testid="group-status"
            class="inline-flex shrink-0 items-center rounded-full bg-st-paused-soft px-2 py-0.5 text-[11px] leading-4 font-medium text-ink-2"
            >已删除</span
          >
          <span
            v-else-if="channel.paused"
            data-testid="group-status"
            class="inline-flex shrink-0 items-center gap-1 rounded-full bg-st-paused-soft px-2 py-0.5 text-[11px] leading-4 font-medium text-ink-2"
            ><Pause class="size-3" aria-hidden="true" />已暂停</span
          >
        </div>
        <p class="mt-1 flex items-center gap-1.5 truncate text-xs text-ink-3">
          <template v-if="channel.deletedAt">聊天历史仅供查看</template>
          <template v-else
            ><span
              v-if="!channel.paused"
              aria-hidden="true"
              class="size-1.5 shrink-0 rounded-full bg-st-idle"
            />{{ members.length }} 位成员<template v-if="running">
              · {{ running }} 位执行中</template
            ></template
          >
        </p>
      </div>
      <div class="flex -space-x-1.5 max-lg:hidden">
        <ParticipantAvatar
          v-for="member in members.slice(0, 4)"
          :key="member.id"
          :name="member.name"
          :identity="member.id"
          size="sm"
          class="ring-2 ring-surface"
        />
      </div>
      <Button
        v-if="!channel.deletedAt && channel.paused"
        variant="outline"
        size="sm"
        aria-label="继续讨论"
        :disabled="controlPending"
        @click="$emit('continue')"
      >
        <LoaderCircle v-if="controlPending" class="animate-spin" /><Play v-else />继续
      </Button>
      <Button
        v-else-if="!channel.deletedAt"
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
      :class="cn(inspectorOpen && 'bg-primary-soft text-primary-ink')"
      @click="$emit('toggleInspector')"
    >
      <PanelRight />
    </Button>
    <DropdownMenuRoot>
      <DropdownMenuTrigger as-child>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="聊天操作"
          title="聊天操作"
          :disabled="exportPending"
        >
          <LoaderCircle v-if="exportPending" class="animate-spin" /><Ellipsis v-else />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent
          align="end"
          :side-offset="6"
          class="z-50 min-w-44 rounded-lg border border-line bg-popover p-1.5 text-popover-foreground shadow-3"
        >
          <DropdownMenuItem
            class="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] outline-none data-highlighted:bg-surface-hover data-highlighted:text-ink"
            @select="$emit('export')"
          >
            <Download class="size-4" />导出聊天记录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </header>
  <AgentContextDialog v-if="agent && contextOpen" v-model:open="contextOpen" :agent="agent" />
</template>
