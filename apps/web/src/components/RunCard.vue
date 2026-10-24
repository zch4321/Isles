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
  LoaderCircle,
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
  toolCall: { label: '工具调用', icon: Wrench },
  status: { label: '状态', icon: CircleDot },
};
const kindOf = (type: string) => itemKinds[type] ?? { label: type, icon: CircleDot };
const itemRunning = (status: string) =>
  ['starting', 'running', 'inProgress', 'pending', 'waiting'].includes(status);
const itemStatus = (status: string) =>
  status === 'failed'
    ? '失败'
    : status === 'interrupted'
      ? '已中断'
      : itemRunning(status)
        ? '进行中'
        : '';
</script>

<template>
  <details
    data-run
    :open="open"
    class="group rounded-lg border border-line bg-surface open:border-line-strong open:shadow-1"
    @toggle="open = ($event.target as HTMLDetailsElement).open"
  >
    <summary
      class="flex list-none items-center gap-2 rounded-lg px-3 py-2 text-[13px] hover:bg-surface-hover [&::-webkit-details-marker]:hidden"
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
      <time :datetime="run.createdAt" class="text-ink-3 tabular-nums">{{
        formatTime(run.createdAt)
      }}</time>
      <span v-if="duration" class="truncate text-ink-3">· {{ duration }}</span>
      <span class="ml-auto shrink-0 text-xs text-ink-3 tabular-nums"
        >{{ run.items.length }} 项</span
      >
      <ChevronRight
        class="size-4 shrink-0 text-ink-3 transition-transform group-open:rotate-90"
        aria-hidden="true"
      />
    </summary>
    <div class="space-y-3 border-t border-line px-3 py-3">
      <p v-if="inputs" class="text-xs text-ink-3">输入：{{ inputs }}</p>
      <p v-else class="text-xs text-ink-3">原生活动</p>
      <p class="font-mono text-[11px] break-all text-ink-4">
        turn {{ run.turnId ?? '等待原生接受' }}
      </p>
      <p
        v-if="run.error"
        class="rounded-md bg-st-error-soft px-2.5 py-1.5 text-xs break-words text-st-error"
      >
        {{ run.error }}
      </p>
      <ol
        v-if="run.items.length"
        class="relative space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[11px] before:w-px before:bg-line"
      >
        <li v-for="item in run.items" :key="item.id" class="relative flex gap-3">
          <span
            :class="
              cn(
                'z-10 grid size-[23px] shrink-0 place-items-center rounded-full border',
                itemRunning(item.status)
                  ? 'border-transparent bg-st-running-soft text-st-running'
                  : 'border-line bg-surface-2 text-ink-2',
              )
            "
          >
            <LoaderCircle
              v-if="itemRunning(item.status)"
              class="size-3.5 animate-spin"
              aria-hidden="true"
            />
            <component :is="kindOf(item.type).icon" v-else class="size-3.5" aria-hidden="true" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex min-h-[23px] items-center gap-2 text-xs">
              <span class="font-medium">{{ kindOf(item.type).label }}</span>
              <span v-if="itemStatus(item.status)" class="ml-auto text-ink-3">{{
                itemStatus(item.status)
              }}</span>
            </div>
            <pre
              class="mt-0.5 max-h-64 overflow-auto rounded-md border border-line bg-surface-2 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-ink-2"
              >{{ item.text || '暂无文本输出' }}</pre>
          </div>
        </li>
      </ol>
      <p v-else class="text-xs text-ink-3">暂无活动记录</p>
    </div>
  </details>
</template>
