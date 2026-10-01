<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: HTMLAttributes['class']; disabled?: boolean }>();
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <button
    type="button"
    role="switch"
    data-slot="switch"
    :aria-checked="model"
    :disabled="disabled"
    :class="
      cn(
        'group inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-input shadow-xs transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-checked:bg-primary dark:bg-input/80',
        props.class,
      )
    "
    @click="model = !model"
  >
    <span
      class="pointer-events-none block size-4 translate-x-0.5 rounded-full bg-background shadow-sm transition-transform group-aria-checked:translate-x-[18px]"
    />
  </button>
</template>
