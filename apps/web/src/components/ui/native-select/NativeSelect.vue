<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { ChevronDown } from '@lucide/vue';
import { cn } from '@/lib/utils';

// Attributes such as id, required and disabled belong on the <select>, not the wrapper.
defineOptions({ inheritAttrs: false });

const props = defineProps<{ class?: HTMLAttributes['class'] }>();
const model = defineModel<string | undefined>();
</script>

<template>
  <div data-slot="native-select-wrapper" :class="cn('relative', props.class)">
    <select
      v-model="model"
      data-slot="native-select"
      v-bind="$attrs"
      class="h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent py-1 pr-8 pl-3 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
    >
      <slot />
    </select>
    <ChevronDown
      class="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      aria-hidden="true"
    />
  </div>
</template>
