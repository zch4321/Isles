<script setup lang="ts">
import type { AgentStatus } from '@isles/contracts';
import { agentStatusLabels, agentStatusTone } from '@/lib/format';
import { cn } from '@/lib/utils';

defineProps<{ status: AgentStatus }>();
</script>

<template>
  <span
    :class="
      cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-px text-[11px] leading-4 font-medium text-muted-foreground',
        status === 'running' && 'border-primary/30 text-primary',
        status === 'error' && 'border-destructive/30 text-destructive',
      )
    "
    ><span
      :class="
        cn(
          'size-1.5 rounded-full',
          agentStatusTone[status],
          status === 'running' && 'animate-pulse',
        )
      "
    />{{ agentStatusLabels[status] }}</span
  >
</template>
