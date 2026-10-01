<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { X } from '@lucide/vue';
import { DialogClose, DialogContent, DialogOverlay, DialogPortal } from 'reka-ui';
import { cn } from '@/lib/utils';

// The root is the portal, so attributes and listeners such as @open-auto-focus go to the content.
defineOptions({ inheritAttrs: false });

const props = defineProps<{ class?: HTMLAttributes['class'] }>();
</script>

<template>
  <DialogPortal>
    <DialogOverlay
      data-slot="dialog-overlay"
      class="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
    />
    <DialogContent
      data-slot="dialog-content"
      v-bind="$attrs"
      :class="
        cn(
          'fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border bg-background p-6 shadow-lg duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          props.class,
        )
      "
    >
      <slot />
      <DialogClose
        class="absolute top-4 right-4 rounded-sm text-muted-foreground opacity-80 transition-opacity hover:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-4"
        aria-label="关闭"
      >
        <X />
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
