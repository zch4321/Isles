<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query';
import { RefreshCw } from '@lucide/vue';
import { computed } from 'vue';
import { invalidateAll, useHealth } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const queryClient = useQueryClient();
const health = useHealth();
const state = computed(() =>
  health.isSuccess.value ? 'online' : health.isError.value ? 'offline' : 'connecting',
);
const labels = { online: '服务已连接', offline: '服务连接异常', connecting: '正在连接服务' };
const tones = {
  online: 'bg-st-idle',
  offline: 'bg-st-error',
  connecting: 'bg-st-queued animate-pulse',
};

function reconnect() {
  void health.refetch();
  void invalidateAll(queryClient);
}
</script>

<template>
  <div role="status" aria-live="polite" class="flex min-h-6 w-full items-center gap-2 text-[11px]">
    <span :class="cn('size-1.5 shrink-0 rounded-full', tones[state])" />
    <span :class="state === 'offline' ? 'text-st-error' : 'text-ink-3'">{{ labels[state] }}</span>
    <Button
      v-if="state === 'offline'"
      variant="ghost"
      size="icon-xs"
      class="ml-auto"
      aria-label="重新连接服务"
      title="重新连接"
      @click="reconnect"
    >
      <RefreshCw />
    </Button>
    <span v-else class="ml-auto text-[10px] tracking-wider text-ink-3">本机</span>
  </div>
</template>
