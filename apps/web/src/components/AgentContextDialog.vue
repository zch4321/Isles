<script setup lang="ts">
import type { Agent } from '@isles/contracts';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { LoaderCircle, RefreshCw } from '@lucide/vue';
import { computed, ref } from 'vue';
import { newAgentSession } from '@/api/isles';
import { invalidateAll, useAgentDetail } from '@/api/queries';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDateTime, isActiveRun } from '@/lib/format';

const props = defineProps<{ agent: Agent }>();
const open = defineModel<boolean>('open', { required: true });
const queryClient = useQueryClient();
const detail = useAgentDetail(() => props.agent.id);
const confirming = ref(false);
const completed = ref(false);
const current = computed(() => detail.data.value?.agent ?? props.agent);
const usage = computed(() => detail.data.value?.contextUsage);
const percentage = computed(() =>
  usage.value?.maxTokens == null
    ? null
    : Math.round((usage.value.usedTokens / usage.value.maxTokens) * 1000) / 10,
);
const number = (value: number) => value.toLocaleString('zh-CN');
const unavailable = computed(() => {
  if (!detail.data.value)
    return detail.isError.value ? '加载上下文后可新建会话。' : '正在加载上下文…';
  if (current.value.status === 'deleted') return 'Agent 已删除，聊天记录和工作文件已保留。';
  if (current.value.status === 'creating') return 'Agent 正在创建，完成后可新建会话。';
  if (current.value.status === 'recovering') return 'Agent 正在恢复，完成后可新建会话。';
  if (
    current.value.status === 'running' ||
    detail.data.value.runs.some((run) => isActiveRun(run.status))
  )
    return 'Agent 正在执行或等待回答，请先停止 Agent，或等待执行完成。';
  if (detail.data.value.pendingMessageCount > 0)
    return `有 ${detail.data.value.pendingMessageCount} 条消息待处理，处理完成后可新建会话。`;
  return '';
});
const create = useMutation({
  mutationFn: () => newAgentSession(props.agent.id),
  onSuccess: async () => {
    await Promise.all([
      invalidateAll(queryClient),
      queryClient.invalidateQueries({ queryKey: ['models', props.agent.harness] }),
    ]);
    confirming.value = false;
    completed.value = true;
  },
});
function confirm() {
  if (unavailable.value || create.isPending.value) return;
  create.mutate();
}
function startConfirmation() {
  create.reset();
  completed.value = false;
  confirming.value = true;
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
      <DialogHeader>
        <DialogTitle>上下文</DialogTitle>
        <DialogDescription class="break-words">
          {{ agent.name }} 的私聊和所有群聊共用此上下文。
        </DialogDescription>
      </DialogHeader>
      <div v-if="detail.isPending.value" class="flex items-center gap-2 text-muted-foreground">
        <LoaderCircle class="size-4 animate-spin" />正在加载上下文…
      </div>
      <div v-else-if="detail.isError.value" class="space-y-2">
        <p role="alert" class="text-[13px] break-words text-destructive">
          {{ detail.error.value?.message }}
        </p>
        <Button variant="outline" size="sm" @click="detail.refetch()"><RefreshCw />重试</Button>
      </div>
      <section v-else class="space-y-3" aria-label="当前上下文用量">
        <template v-if="usage">
          <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p class="text-lg font-semibold tabular-nums">
              {{ number(usage.usedTokens)
              }}<template v-if="usage.maxTokens !== null">
                / {{ number(usage.maxTokens) }}</template
              >
              <span class="text-xs font-normal text-muted-foreground"> tokens</span>
            </p>
            <p v-if="percentage !== null" class="text-sm tabular-nums">{{ percentage }}%</p>
          </div>
          <div
            v-if="percentage !== null"
            role="progressbar"
            aria-label="上下文占用"
            :aria-valuenow="usage.usedTokens"
            :aria-valuemin="0"
            :aria-valuemax="usage.maxTokens!"
            :aria-valuetext="`${percentage}%`"
            class="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div
              class="h-full rounded-full bg-primary"
              :style="{ width: `${Math.min(percentage, 100)}%` }"
            />
          </div>
          <p v-else class="text-xs text-muted-foreground">等待窗口大小更新</p>
          <p class="text-xs text-muted-foreground">
            <span v-if="usage.estimated">估算 · </span>更新于 {{ formatDateTime(usage.updatedAt) }}
          </p>
        </template>
        <p v-else class="rounded-md border bg-muted/50 px-3 py-3 text-[13px] text-muted-foreground">
          等待用量更新
        </p>
      </section>
      <section v-if="confirming" class="space-y-2 rounded-md border bg-muted/50 px-3 py-3">
        <h3 class="text-[13px] font-semibold">新建会话</h3>
        <p class="text-[13px] leading-relaxed">
          新会话将从新的上下文开始。聊天记录、群成员和工作文件保留。
        </p>
      </section>
      <p v-else class="text-xs leading-relaxed text-muted-foreground">
        新建会话可重新开始上下文，保留聊天记录、群成员和工作文件。
      </p>
      <p v-if="unavailable" class="text-xs leading-relaxed text-muted-foreground">
        {{ unavailable }}
      </p>
      <p v-if="completed" role="status" class="text-[13px]">新会话已建立。</p>
      <p v-if="create.error.value" role="alert" class="text-[13px] break-words text-destructive">
        {{ create.error.value.message }}
      </p>
      <DialogFooter>
        <Button
          v-if="confirming"
          variant="outline"
          :disabled="create.isPending.value"
          @click="confirming = false"
          >取消</Button
        >
        <Button
          v-if="confirming"
          :disabled="Boolean(unavailable) || create.isPending.value"
          @click="confirm"
        >
          <LoaderCircle v-if="create.isPending.value" class="animate-spin" />{{
            create.isPending.value ? '正在新建…' : '确认新建'
          }}
        </Button>
        <Button
          v-else
          :disabled="Boolean(unavailable) || create.isPending.value"
          @click="startConfirmation"
          >新建会话</Button
        >
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
