<script setup lang="ts">
import type { Run } from '@isles/contracts';
import {
  Brain,
  ChevronRight,
  CircleDot,
  FilePen,
  Globe,
  Inbox,
  ListChecks,
  MessageSquareText,
  SquareTerminal,
  Workflow,
  Wrench,
} from '@lucide/vue';
import { computed, ref, type Component } from 'vue';
import {
  formatDuration,
  formatTime,
  isActiveRun,
  runStatusLabels,
  runStatusTone,
} from '@/lib/format';
import { cn } from '@/lib/utils';

const props = defineProps<{
  run: Run;
  /** Where the merged input came from, e.g. "私聊 1 条 · 讨论组 3 条". */
  inputs: string;
}>();

// Runs still in progress start expanded so their activity is visible.
const open = ref(isActiveRun(props.run.status));
const duration = computed(() =>
  props.run.finishedAt ? formatDuration(props.run.createdAt, props.run.finishedAt) : undefined,
);

const itemKinds: Record<string, { label: string; icon: Component }> = {
  agentMessage: { label: '原生回复', icon: MessageSquareText },
  commandExecution: { label: '命令执行', icon: SquareTerminal },
  mcpToolCall: { label: '工具调用', icon: Wrench },
  fileChange: { label: '文件修改', icon: FilePen },
  userMessage: { label: '输入消息', icon: Inbox },
  reasoning: { label: '推理', icon: Brain },
  webSearch: { label: '网页搜索', icon: Globe },
  plan: { label: '计划', icon: ListChecks },
  collabAgentToolCall: { label: '子代理调用', icon: Workflow },
  subAgentActivity: { label: '子代理活动', icon: Workflow },
};
const kindOf = (type: string) => itemKinds[type] ?? { label: type, icon: CircleDot };
</script>

<template>
  <details
    data-run
    :open="open"
    class="group rounded-lg border bg-card"
    @toggle="open = ($event.target as HTMLDetailsElement).open"
  >
    <summary
      class="flex list-none items-center gap-2 rounded-lg px-3 py-2 text-[13px] hover:bg-muted/50 [&::-webkit-details-marker]:hidden"
    >
      <span
        :class="
          cn(
            'size-2 shrink-0 rounded-full',
            runStatusTone[run.status],
            isActiveRun(run.status) && 'animate-pulse',
          )
        "
      />
      <span class="font-medium">{{ runStatusLabels[run.status] }}</span>
      <time :datetime="run.createdAt" class="text-muted-foreground tabular-nums">{{
        formatTime(run.createdAt)
      }}</time>
      <span v-if="duration" class="truncate text-muted-foreground">· {{ duration }}</span>
      <span class="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
        >{{ run.items.length }} 项</span
      >
      <ChevronRight
        class="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        aria-hidden="true"
      />
    </summary>
    <div class="space-y-3 border-t px-3 py-3">
      <p v-if="inputs" class="text-xs text-muted-foreground">输入：{{ inputs }}</p>
      <p class="font-mono text-[11px] break-all text-muted-foreground">
        turn {{ run.turnId ?? '等待原生接受' }}
      </p>
      <p
        v-if="run.error"
        class="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs break-words text-destructive"
      >
        {{ run.error }}
      </p>
      <ol v-if="run.items.length" class="space-y-3">
        <li v-for="item in run.items" :key="item.id" class="flex gap-2">
          <component
            :is="kindOf(item.type).icon"
            class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-xs">
              <span class="font-medium">{{ kindOf(item.type).label }}</span>
              <span v-if="item.status !== 'completed'" class="ml-auto text-primary">进行中</span>
            </div>
            <pre
              class="mt-1 max-h-64 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap"
              >{{ item.text || '暂无文本输出' }}</pre>
          </div>
        </li>
      </ol>
      <p v-else class="text-xs text-muted-foreground">暂无活动记录</p>
    </div>
  </details>
</template>
