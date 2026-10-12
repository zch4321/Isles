<script setup lang="ts">
import { Switch } from '@/components/ui/switch';

defineProps<{ id: string; disabled?: boolean }>();
const enabled = defineModel<boolean>({ required: true });
</script>

<template>
  <div class="flex items-start gap-3">
    <div class="min-w-0 flex-1">
      <p :id="id" class="text-[13px] font-medium">完整访问</p>
      <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
        开启时允许完整访问；关闭时使用 harness 原生权限。修改在下一次执行时生效。
      </p>
    </div>
    <Switch v-model="enabled" :aria-labelledby="id" :disabled="disabled" />
  </div>
</template>
