<script setup lang="ts">
import { Hash } from '@lucide/vue';
import { cn } from '@/lib/utils';

// Groups share one neutral channel mark; the name next to it is what identifies them.
withDefaults(defineProps<{ identity: string; size?: 'sm' | 'md' | 'lg' }>(), { size: 'md' });

const sizes = {
  sm: 'size-7 [&_svg]:size-3.5',
  md: 'size-8 [&_svg]:size-4',
  lg: 'size-12 rounded-xl [&_svg]:size-6',
};
</script>

<template>
  <span
    aria-hidden="true"
    :class="
      cn(
        'inline-flex shrink-0 items-center justify-center rounded-[30%] bg-surface-2 text-ink-2 ring-1 ring-line ring-inset',
        sizes[size],
      )
    "
  >
    <Hash :stroke-width="1.8" />
  </span>
</template>
