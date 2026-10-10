<script setup lang="ts">
import type { Channel } from '@isles/contracts';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { LoaderCircle, Trash2, UserMinus, UserPlus } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { removeMember, updateChannel } from '@/api/isles';
import { invalidateAll } from '@/api/queries';
import GroupDialog from './GroupDialog.vue';
import DeleteGroupDialog from './DeleteGroupDialog.vue';
import ParticipantAvatar from './ParticipantAvatar.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Directory } from '@/lib/channels';
import { agentStatusLabels, formatDateTime } from '@/lib/format';

const props = defineProps<{ channel: Channel; directory: Directory }>();
defineEmits<{ inspect: [agentId: string] }>();

const queryClient = useQueryClient();
const members = computed(() =>
  props.channel.memberIds.flatMap((id) => props.directory.get(id) ?? []),
);
const creator = computed(() =>
  props.channel.createdBy === 'user'
    ? '你'
    : (props.directory.get(props.channel.createdBy)?.name ?? 'Agent'),
);

const name = ref(props.channel.name ?? '');
watch(
  () => props.channel.name,
  (value) => (name.value = value ?? ''),
);
const rename = useMutation({
  mutationFn: () => updateChannel(props.channel.id, { name: name.value.trim() }),
  onSettled: () => invalidateAll(queryClient),
});
const remove = useMutation({
  mutationFn: (agentId: string) => removeMember(props.channel.id, agentId),
  onSettled: () => invalidateAll(queryClient),
});
const adding = ref(false);
const deleteOpen = ref(false);
watch(
  () => props.channel.deletedAt,
  (deletedAt) => {
    if (deletedAt) {
      adding.value = false;
      deleteOpen.value = false;
    }
  },
);
const error = computed(() => rename.error.value?.message ?? remove.error.value?.message);
</script>

<template>
  <div>
    <section class="grid gap-4 border-b border-line p-4">
      <p v-if="channel.deletedAt" class="info-box">
        此群聊已删除，对话以只读方式保留。聊天历史和工作文件已保留，成员 Agent 保持各自运行状态。
      </p>
      <div v-if="channel.deletedAt" class="grid gap-2">
        <span class="text-sm font-medium">群名</span>
        <p class="text-sm break-words">{{ channel.name }}</p>
      </div>
      <form v-else class="grid gap-2" @submit.prevent="rename.mutate()">
        <label for="group-rename" class="text-sm font-medium">群名</label>
        <div class="flex gap-2">
          <Input id="group-rename" v-model="name" required maxlength="80" autocomplete="off" />
          <Button
            v-if="name.trim() && name.trim() !== channel.name"
            type="submit"
            variant="outline"
            :disabled="rename.isPending.value"
          >
            <LoaderCircle v-if="rename.isPending.value" class="animate-spin" />保存
          </Button>
        </div>
      </form>
      <dl class="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-3 text-sm">
        <dt class="text-ink-3">讨论</dt>
        <dd class="min-w-0">
          {{
            channel.deletedAt
              ? '已删除，历史仅供查看'
              : channel.paused
                ? '已暂停自动投递，仍可主动读取'
                : '进行中'
          }}
        </dd>
        <dt class="text-ink-3">创建</dt>
        <dd class="min-w-0">{{ creator }} · {{ formatDateTime(channel.createdAt) }}</dd>
        <template v-if="channel.deletedAt">
          <dt class="text-ink-3">删除</dt>
          <dd class="min-w-0">{{ formatDateTime(channel.deletedAt) }}</dd>
        </template>
      </dl>
      <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
    </section>

    <section v-if="!channel.deletedAt" class="border-b border-line p-4">
      <h3 class="flex items-center gap-2 text-sm font-semibold">
        成员
        <span class="font-normal text-ink-3 tabular-nums">{{ members.length }}</span>
        <Button variant="outline" size="xs" class="ml-auto" @click="adding = true">
          <UserPlus />添加成员
        </Button>
      </h3>
      <p class="mt-1 text-xs leading-relaxed text-ink-3">
        移出成员时，会取消它在本群的待处理投递。
      </p>
      <ul class="mt-3 grid gap-0.5" aria-label="群成员">
        <li
          v-for="member in members"
          :key="member.id"
          class="group flex items-center rounded-md transition-colors hover:bg-surface-hover focus-within:bg-surface-hover"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1.5 text-left"
            :aria-label="`查看 ${member.name} 的详情`"
            @click="$emit('inspect', member.id)"
          >
            <ParticipantAvatar :name="member.name" :identity="member.id" :status="member.status" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13px] font-medium">{{ member.name }}</span>
              <span class="block truncate text-xs text-ink-3"
                >{{ agentStatusLabels[member.status] }} · {{ member.model }}</span
              >
            </span>
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="mr-1 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:text-destructive focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
            :aria-label="`将 ${member.name} 移出群聊`"
            :title="`将 ${member.name} 移出群聊`"
            :disabled="remove.isPending.value"
            @click="remove.mutate(member.id)"
          >
            <UserMinus />
          </Button>
        </li>
      </ul>
      <p
        v-if="!members.length"
        class="mt-3 rounded-lg border border-dashed border-line px-4 py-6 text-center text-xs text-ink-3"
      >
        添加 Agent，一起开始讨论。
      </p>
    </section>
    <section v-if="!channel.deletedAt" class="p-4">
      <Button
        type="button"
        variant="outline"
        class="w-full text-destructive hover:bg-st-error-soft hover:text-destructive"
        @click="deleteOpen = true"
      >
        <Trash2 />删除群聊
      </Button>
    </section>
    <GroupDialog v-if="!channel.deletedAt" v-model:open="adding" :channel="channel" />
    <DeleteGroupDialog v-model:open="deleteOpen" :channel="channel" />
  </div>
</template>
