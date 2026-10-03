<script setup lang="ts">
import type { Agent, Run } from '@isles/contracts';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { Check, Copy, LoaderCircle, Pencil, SquareTerminal, Trash2 } from '@lucide/vue';
import { computed, onBeforeUnmount, ref } from 'vue';
import { updateAgent } from '@/api/isles';
import { invalidateAll, useChannels, useHarnessName } from '@/api/queries';
import RunCard from './RunCard.vue';
import StatusBadge from './StatusBadge.vue';
import EditAgentDialog from './EditAgentDialog.vue';
import DeleteAgentDialog from './DeleteAgentDialog.vue';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { channelTitle, type Directory } from '@/lib/channels';

const props = defineProps<{ agent: Agent; runs: Run[] | undefined; directory: Directory }>();
defineEmits<{ deleted: [] }>();

const queryClient = useQueryClient();
const channels = useChannels();
const harnessName = useHarnessName(() => props.agent.harness);
const editOpen = ref(false);
const deleteOpen = ref(false);

const copied = ref('');
const copyError = ref('');
let reset: ReturnType<typeof setTimeout> | undefined;
async function copy(value: string, field: string) {
  try {
    await navigator.clipboard.writeText(value);
    copyError.value = '';
    copied.value = field;
    clearTimeout(reset);
    reset = setTimeout(() => (copied.value = ''), 1500);
  } catch {
    copyError.value = '复制失败，请手动选择文字。';
  }
}
onBeforeUnmount(() => clearTimeout(reset));

const permission = useMutation({
  mutationFn: (canCreateGroups: boolean) => updateAgent(props.agent.id, { canCreateGroups }),
  onSettled: () => invalidateAll(queryClient),
});
const canCreateGroups = computed({
  get: () =>
    permission.isPending.value ? permission.variables.value! : props.agent.canCreateGroups,
  set: (value: boolean) => permission.mutate(value),
});

function inputs(run: Run) {
  const byId = new Map(channels.data.value?.channels.map((c) => [c.id, c]));
  return run.inputs
    .map((input) => {
      const channel = byId.get(input.channelId);
      const name = !channel
        ? '频道'
        : channel.kind === 'private'
          ? '私聊'
          : channelTitle(channel, props.directory);
      return `${name} ${input.messageSeqs.length} 条`;
    })
    .join(' · ');
}
</script>

<template>
  <div>
    <section class="space-y-3 border-b p-4">
      <div v-if="agent.status !== 'deleted'" class="flex gap-2">
        <Button variant="outline" size="sm" class="flex-1" @click="editOpen = true">
          <Pencil />编辑 Agent
        </Button>
        <Button variant="destructive" size="sm" @click="deleteOpen = true">
          <Trash2 />删除 Agent
        </Button>
      </div>
      <p
        v-else
        class="rounded-md border bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
      >
        此 Agent 已删除，无法恢复运行。聊天历史、工作目录和共享文件已保留。
      </p>
      <dl
        class="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2.5 text-[13px]"
      >
        <dt class="text-muted-foreground">状态</dt>
        <dd><StatusBadge :status="agent.status" /></dd>
        <dt class="text-muted-foreground">Harness</dt>
        <dd>{{ harnessName }}</dd>
        <dt class="text-muted-foreground">模型</dt>
        <dd class="break-words">{{ agent.model }} · {{ agent.reasoningEffort }}</dd>
        <dt class="text-muted-foreground">会话</dt>
        <dd class="flex items-start gap-1">
          <code class="min-w-0 flex-1 font-mono text-xs leading-5 break-all">{{
            agent.threadId ?? '尚未建立'
          }}</code>
          <Button
            v-if="agent.threadId"
            variant="ghost"
            size="icon-xs"
            aria-label="复制 thread ID"
            @click="copy(agent.threadId, 'thread')"
          >
            <Check v-if="copied === 'thread'" /><Copy v-else />
          </Button>
        </dd>
        <dt class="text-muted-foreground">工作目录</dt>
        <dd class="flex items-start gap-1">
          <code class="min-w-0 flex-1 font-mono text-xs leading-5 break-all">{{
            agent.workspace
          }}</code>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="复制工作目录"
            @click="copy(agent.workspace, 'workspace')"
          >
            <Check v-if="copied === 'workspace'" /><Copy v-else />
          </Button>
        </dd>
      </dl>
      <p v-if="copyError" role="alert" class="text-xs text-destructive">{{ copyError }}</p>
      <p class="text-xs leading-relaxed text-muted-foreground">
        Agent 在私聊和所有群中始终使用这一个原生会话和工作目录。不同 Agent
        之间不共享对话上下文；原生配置、插件和长期记忆由 {{ harnessName }} 管理。
      </p>
    </section>

    <section v-if="agent.status !== 'deleted'" class="border-b p-4">
      <h3 class="text-[13px] font-semibold">协作权限</h3>
      <div class="mt-2.5 flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <p :id="`groups-${agent.id}`" class="text-[13px] font-medium">允许拉群</p>
          <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            可以创建群聊并邀请已有 Agent。修改立即生效，Agent 空闲时会重启原生进程以刷新工具列表。
          </p>
        </div>
        <LoaderCircle
          v-if="permission.isPending.value"
          class="mt-0.5 size-4 animate-spin text-muted-foreground"
        />
        <Switch
          v-model="canCreateGroups"
          :aria-labelledby="`groups-${agent.id}`"
          :disabled="permission.isPending.value"
        />
      </div>
      <p v-if="permission.error.value" role="alert" class="mt-2 text-xs text-destructive">
        {{ permission.error.value.message }}
      </p>
    </section>

    <section class="p-4">
      <div class="flex items-baseline gap-2">
        <h3 class="text-[13px] font-semibold">执行记录</h3>
        <span v-if="runs" class="text-xs text-muted-foreground tabular-nums">{{
          runs.length
        }}</span>
      </div>
      <p class="mt-0.5 text-xs text-muted-foreground">
        原生输出只在这里展示，不会成为聊天消息。每次执行汇总所有频道的未读消息，显示最近 30 次。
      </p>
      <div v-if="!runs" class="mt-4 flex justify-center text-muted-foreground">
        <LoaderCircle class="size-4 animate-spin" />
      </div>
      <div
        v-else-if="!runs.length"
        class="mt-4 flex flex-col items-center rounded-lg border border-dashed px-4 py-8 text-center"
      >
        <SquareTerminal class="size-5 text-muted-foreground" aria-hidden="true" />
        <p class="mt-2 text-[13px] font-medium">还没有执行记录</p>
        <p class="mt-0.5 text-xs text-muted-foreground">收到消息后，可以在这里查看执行过程。</p>
      </div>
      <ol v-else class="mt-3 space-y-2">
        <li v-for="run in runs" :key="run.id"><RunCard :run="run" :inputs="inputs(run)" /></li>
      </ol>
    </section>
    <EditAgentDialog v-if="agent.status !== 'deleted'" v-model:open="editOpen" :agent="agent" />
    <DeleteAgentDialog v-model:open="deleteOpen" :agent="agent" @deleted="$emit('deleted')" />
  </div>
</template>
