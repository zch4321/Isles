<script setup lang="ts">
import type { Channel } from '@isles/contracts';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { LoaderCircle, Plus } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { addMembers, createGroup } from '@/api/isles';
import { invalidateAll, useAgents } from '@/api/queries';
import AgentChecklist from './AgentChecklist.vue';
import WorkspacePathEditor from './WorkspacePathEditor.vue';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Creates a group, or adds members to `channel` when it is given. */
const props = defineProps<{ channel?: Channel | undefined }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ done: [channelId: string] }>();

const queryClient = useQueryClient();
const agents = useAgents();
const candidates = computed(() =>
  (agents.data.value?.agents ?? []).filter((a) => !props.channel?.memberIds.includes(a.id)),
);

const name = ref('');
const selected = ref<string[]>([]);
const workspacePaths = ref<string[]>([]);
const save = useMutation({
  mutationFn: () =>
    props.channel
      ? addMembers(props.channel.id, selected.value)
      : createGroup({
          name: name.value,
          memberIds: selected.value,
          workspacePaths: workspacePaths.value,
        }),
  onSuccess: async (channel) => {
    await invalidateAll(queryClient);
    emit('done', channel.id);
    open.value = false;
  },
});
watch(open, (value) => {
  if (!value) return;
  save.reset();
  name.value = '';
  selected.value = [];
  workspacePaths.value = [];
});

function focusFirst(event: Event) {
  if (props.channel) return;
  event.preventDefault();
  document.getElementById('group-name')?.focus();
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
      @open-auto-focus="focusFirst"
    >
      <DialogHeader>
        <DialogTitle>{{ channel ? '添加成员' : '新建群聊' }}</DialogTitle>
        <DialogDescription v-if="channel">
          新成员可以读取群内全部历史消息，并从下一条群消息开始被唤醒。
        </DialogDescription>
        <DialogDescription v-else>
          群内每条消息都对全体成员可见，并在汇总后唤醒其他成员。@ 只标明你特意对谁说。
        </DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="save.mutate()">
        <div v-if="!channel" class="grid gap-2">
          <Label for="group-name">群名</Label>
          <Input
            id="group-name"
            v-model="name"
            required
            maxlength="80"
            autocomplete="off"
            placeholder="例如 方案讨论"
          />
        </div>
        <fieldset class="grid gap-2">
          <legend class="mb-2 text-sm font-medium">成员</legend>
          <AgentChecklist v-if="candidates.length" v-model="selected" :agents="candidates" />
          <p
            v-else
            class="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-ink-3"
          >
            {{ channel ? '所有 Agent 都已在群中。' : '还没有 Agent，请先新建 Agent。' }}
          </p>
        </fieldset>
        <template v-if="!channel">
          <WorkspacePathEditor
            id="group-workspaces"
            v-model="workspacePaths"
            label="群聊目录"
            :disabled="save.isPending.value"
          />
          <p class="-mt-2 text-xs leading-relaxed text-muted-foreground">
            群聊目录会追加到成员 Agent，新成员入群时自动获得这些目录。
          </p>
        </template>
        <p
          v-if="save.error.value"
          role="alert"
          class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] break-words text-destructive"
        >
          {{ save.error.value.message }}
        </p>
        <DialogFooter class="pt-1">
          <Button type="button" variant="outline" @click="open = false">取消</Button>
          <Button
            type="submit"
            :disabled="save.isPending.value || !selected.length || (!channel && !name.trim())"
          >
            <LoaderCircle v-if="save.isPending.value" class="animate-spin" /><Plus v-else />{{
              channel ? '添加' : '创建群聊'
            }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
