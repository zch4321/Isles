<script setup lang="ts">
import type { Channel } from '@isles/contracts';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { ChevronRight, LoaderCircle, UserMinus, UserPlus } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { removeMember, updateChannel } from '@/api/isles';
import { invalidateAll } from '@/api/queries';
import GroupDialog from './GroupDialog.vue';
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
const error = computed(() => rename.error.value?.message ?? remove.error.value?.message);
</script>

<template>
  <div>
    <section class="space-y-3 border-b p-4">
      <form class="grid gap-2" @submit.prevent="rename.mutate()">
        <label for="group-rename" class="text-[13px] font-semibold">群名</label>
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
      <dl class="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px]">
        <dt class="text-muted-foreground">讨论</dt>
        <dd>{{ channel.paused ? '已暂停自动投递，仍可主动读取' : '进行中' }}</dd>
        <dt class="text-muted-foreground">创建</dt>
        <dd>{{ creator }} · {{ formatDateTime(channel.createdAt) }}</dd>
      </dl>
      <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
    </section>

    <section class="p-4">
      <div class="flex items-center gap-2">
        <h3 class="text-[13px] font-semibold">成员</h3>
        <span class="text-xs text-muted-foreground tabular-nums">{{ members.length }}</span>
        <Button variant="outline" size="xs" class="ml-auto" @click="adding = true">
          <UserPlus />添加成员
        </Button>
      </div>
      <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
        移出成员会取消它在本群尚未投递的消息。只有你可以移出成员。
      </p>
      <ul class="mt-3 space-y-1" aria-label="群成员">
        <li v-for="member in members" :key="member.id" class="flex items-center gap-1">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/70"
            :aria-label="`查看 ${member.name} 的详情`"
            @click="$emit('inspect', member.id)"
          >
            <ParticipantAvatar :name="member.name" :identity="member.id" :status="member.status" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13px] font-medium">{{ member.name }}</span>
              <span class="block truncate text-xs text-muted-foreground"
                >{{ agentStatusLabels[member.status] }} · {{ member.model }}</span
              >
            </span>
            <ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:text-destructive"
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
        class="mt-3 rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground"
      >
        群里还没有 Agent，添加成员后才会有人回复。
      </p>
    </section>
    <GroupDialog v-model:open="adding" :channel="channel" />
  </div>
</template>
