<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: HTMLAttributes['class'] }>();
</script>

<template>
  <label
    data-slot="label"
    :class="
      cn(
        'flex items-center gap-2 text-[13px] leading-none font-medium select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        props.class,
      )
    "
  >
    <slot />
  </label>
</template>
