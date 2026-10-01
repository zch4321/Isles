<script setup lang="ts">
import { UsersRound } from '@lucide/vue';
import { cn, hueOf } from '@/lib/utils';

withDefaults(defineProps<{ identity: string; size?: 'sm' | 'md' | 'lg' }>(), { size: 'md' });

const sizes = {
  sm: 'size-7 [&_svg]:size-3.5',
  md: 'size-8 [&_svg]:size-4',
  lg: 'size-12 rounded-lg [&_svg]:size-6',
};
</script>

<template>
  <span
    aria-hidden="true"
    :class="
      cn('inline-flex shrink-0 items-center justify-center rounded-md avatar-tint', sizes[size])
    "
    :style="{ '--hue': hueOf(identity) }"
  >
    <UsersRound />
  </span>
</template>
