<script setup lang="ts">
import type { Channel, ChannelDetail } from '@isles/contracts';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { LoaderCircle, Trash2 } from '@lucide/vue';
import { watch } from 'vue';
import { deleteGroup } from '@/api/isles';
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

const props = defineProps<{ channel: Channel }>();
const open = defineModel<boolean>('open', { required: true });
const queryClient = useQueryClient();
const remove = useMutation({
  mutationFn: () => deleteGroup(props.channel.id),
  onSuccess: async (channel) => {
    // The response is authoritative even if a subsequent list refresh fails.
    await Promise.all([
      queryClient.cancelQueries({ queryKey: ['channels'] }),
      queryClient.cancelQueries({ queryKey: ['channel', channel.id] }),
    ]);
    queryClient.setQueryData<{ channels: Channel[]; cursor: number }>(['channels'], (current) =>
      current
        ? {
            ...current,
            channels: current.channels.map((item) => (item.id === channel.id ? channel : item)),
          }
        : current,
    );
    queryClient.setQueryData<ChannelDetail>(['channel', channel.id], (current) =>
      current ? { ...current, channel } : current,
    );
    open.value = false;
    void invalidateAll(queryClient);
  },
});
watch(open, (value) => {
  if (value) remove.reset();
});

function focusCancel(event: Event) {
  event.preventDefault();
  document.getElementById('delete-group-cancel')?.focus();
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
      @open-auto-focus="focusCancel"
    >
      <DialogHeader>
        <DialogTitle>删除群聊</DialogTitle>
        <DialogDescription class="break-words">
          确认删除“{{
            channel.name
          }}”？群聊会移至历史对话，移出所有成员并停止本群的消息投递和访问，聊天历史以只读方式保留。
        </DialogDescription>
      </DialogHeader>
      <p class="info-box">
        群聊历史、个人工作目录及共享文件都会保留。成员 Agent
        保持各自运行状态，可继续在私聊和其他群聊中工作。
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
          id="delete-group-cancel"
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
