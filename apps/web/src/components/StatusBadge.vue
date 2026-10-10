<script setup lang="ts">
import type { AgentStatus } from '@isles/contracts';
import { agentStatusBadge, agentStatusLabels, agentStatusTone } from '@/lib/format';
import { cn } from '@/lib/utils';

defineProps<{ status: AgentStatus }>();
</script>

<template>
  <span
    :class="
      cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-px text-[11px] leading-4 font-medium',
        agentStatusBadge[status],
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
