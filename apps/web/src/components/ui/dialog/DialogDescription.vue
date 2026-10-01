<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { DialogDescription } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: HTMLAttributes['class'] }>();
</script>

<template>
  <DialogDescription
    data-slot="dialog-description"
    :class="cn('text-sm leading-relaxed text-muted-foreground', props.class)"
  >
    <slot />
  </DialogDescription>
</template>
