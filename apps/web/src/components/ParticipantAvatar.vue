<script setup lang="ts">
import type { AgentStatus } from '@isles/contracts';
import { computed } from 'vue';
import { agentStatusTone } from '@/lib/format';
import { cn, hueOf } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    name: string;
    /** Stable ID that picks the tint; omitted for the human user. */
    identity?: string | undefined;
    status?: AgentStatus | undefined;
    size?: 'sm' | 'md' | 'lg';
  }>(),
  { identity: undefined, status: undefined, size: 'md' },
);

const hue = computed(() => (props.identity ? hueOf(props.identity) : undefined));
// Names usually start with the harness ("codex-astra-1"), which would give every Agent the same letter.
const initial = computed(() => {
  const base = props.name.replace(/^(codex|kimi(code)?|claude(code)?)[-_\s]+/i, '') || props.name;
  return ([...base][0] ?? '?').toUpperCase();
});
const sizes = { sm: 'size-7 text-xs', md: 'size-8 text-[13px]', lg: 'size-12 rounded-lg text-lg' };
</script>

<template>
  <span
    aria-hidden="true"
    :class="
      cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-md font-semibold select-none',
        sizes[size],
        hue === undefined ? 'bg-muted text-muted-foreground' : 'avatar-tint',
      )
    "
    :style="hue === undefined ? undefined : { '--hue': hue }"
  >
    {{ initial }}
    <span
      v-if="status"
      :class="
        cn(
          'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-(--avatar-ring)',
          agentStatusTone[status],
          status === 'running' && 'animate-pulse',
        )
      "
    />
  </span>
</template>
