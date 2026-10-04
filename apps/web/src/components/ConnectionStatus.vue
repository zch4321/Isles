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
  online: 'bg-success',
  offline: 'bg-destructive',
  connecting: 'bg-warning animate-pulse',
};

function reconnect() {
  void health.refetch();
  void invalidateAll(queryClient);
}
</script>

<template>
  <div role="status" aria-live="polite" class="flex h-6 items-center gap-2 text-xs">
    <span :class="cn('size-2 rounded-full', tones[state])" />
    <span :class="state === 'offline' ? 'text-destructive' : 'text-muted-foreground'">{{
      labels[state]
    }}</span>
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
    <span v-else class="ml-auto text-muted-foreground/80">本机</span>
  </div>
</template>
