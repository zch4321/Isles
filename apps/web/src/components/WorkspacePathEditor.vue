<script setup lang="ts">
import { Plus, X } from '@lucide/vue';
import { ref } from 'vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const props = defineProps<{ id: string; label: string; disabled?: boolean }>();
const paths = defineModel<string[]>({ required: true });
const draft = ref('');
function add() {
  const path = draft.value.trim();
  if (!path || props.disabled) return;
  if (!paths.value.includes(path)) paths.value = [...paths.value, path];
  draft.value = '';
}
</script>

<template>
  <div class="grid min-w-0 gap-2">
    <Label :for="`${id}-path`">{{ label }}</Label>
    <p :id="`${id}-hint`" class="text-xs leading-relaxed text-muted-foreground">
      填写 Isles 服务所在机器上已存在目录的绝对路径，点击添加。
    </p>
    <ul v-if="paths.length" :aria-label="label" class="grid gap-2">
      <li
        v-for="(path, index) in paths"
        :key="`${index}-${path}`"
        class="flex min-w-0 items-start gap-2 rounded-md border border-line bg-surface-2 px-3 py-2"
      >
        <code class="min-w-0 flex-1 text-xs leading-5 break-all">{{ path }}</code>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          :aria-label="`移除目录 ${path}`"
          :disabled="disabled"
          @click="paths = paths.filter((_, i) => i !== index)"
          ><X
        /></Button>
      </li>
    </ul>
    <div class="flex gap-2">
      <Input
        :id="`${id}-path`"
        v-model="draft"
        :aria-describedby="`${id}-hint`"
        :disabled="disabled"
        autocomplete="off"
        placeholder="输入目录绝对路径"
        @keydown.enter.prevent="add"
      />
      <Button
        type="button"
        variant="outline"
        :aria-label="`添加${label}`"
        :disabled="disabled || !draft.trim()"
        @click="add"
        ><Plus />添加</Button
      >
    </div>
  </div>
</template>
