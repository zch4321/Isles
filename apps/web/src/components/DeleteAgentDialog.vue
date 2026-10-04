<script setup lang="ts">
import type { Agent } from '@isles/contracts';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { LoaderCircle, Trash2 } from '@lucide/vue';
import { watch } from 'vue';
import { deleteAgent } from '@/api/isles';
import { invalidateAll } from '@/api/queries';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const props = defineProps<{ agent: Agent }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ deleted: [] }>();
const queryClient = useQueryClient();
const remove = useMutation({
  mutationFn: () => deleteAgent(props.agent.id),
  onSuccess: async () => {
    await invalidateAll(queryClient);
    open.value = false;
    emit('deleted');
  },
});
watch(open, (value) => {
  if (value) remove.reset();
});

function focusCancel(event: Event) {
  event.preventDefault();
  document.getElementById('delete-agent-cancel')?.focus();
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
      @open-auto-focus="focusCancel"
    >
      <DialogHeader>
        <DialogTitle>删除 Agent</DialogTitle>
        <DialogDescription class="break-words">
          确认删除“{{ agent.name }}”？Agent
          会停止运行、退出所有群聊并从联系人中移除，私聊保留为只读历史。
        </DialogDescription>
      </DialogHeader>
      <p class="rounded-md border bg-muted/50 px-3 py-2.5 text-[13px] leading-relaxed">
        私聊和群聊历史、个人工作目录及共享文件都会保留。
      </p>
      <p
        v-if="remove.error.value"
        role="alert"
        class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] break-words text-destructive"
      >
        {{ remove.error.value.message }}
      </p>
      <DialogFooter>
        <Button
          id="delete-agent-cancel"
          type="button"
          variant="outline"
          :disabled="remove.isPending.value"
          @click="open = false"
        >
          取消
        </Button>
        <Button
          type="button"
          variant="destructive"
          :disabled="remove.isPending.value"
          @click="remove.mutate()"
        >
          <LoaderCircle v-if="remove.isPending.value" class="animate-spin" /><Trash2
            v-else
          />确认删除
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
