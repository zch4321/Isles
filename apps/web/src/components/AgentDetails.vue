<script setup lang="ts">
import type { Agent, Run } from '@isles/contracts';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { ChartPie, Check, Copy, LoaderCircle, Pencil, SquareTerminal, Trash2 } from '@lucide/vue';
import { computed, onBeforeUnmount, ref } from 'vue';
import { updateAgent } from '@/api/isles';
import { invalidateAll, useChannels, useHarnessName, useHarnessCapability } from '@/api/queries';
import ParticipantAvatar from './ParticipantAvatar.vue';
import RunCard from './RunCard.vue';
import StatusBadge from './StatusBadge.vue';
import EditAgentDialog from './EditAgentDialog.vue';
import DeleteAgentDialog from './DeleteAgentDialog.vue';
import AgentContextDialog from './AgentContextDialog.vue';
import ExecutionAccessSetting from './ExecutionAccessSetting.vue';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { channelTitle, type Directory } from '@/lib/channels';

const props = defineProps<{ agent: Agent; runs: Run[] | undefined; directory: Directory }>();
defineEmits<{ deleted: [] }>();

const queryClient = useQueryClient();
const channels = useChannels();
const harnessName = useHarnessName(() => props.agent.harness);
const supportsSteer = useHarnessCapability(() => props.agent.harness, 'steer');
const editOpen = ref(false);
const deleteOpen = ref(false);
const contextOpen = ref(false);

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
const steering = useMutation({
  mutationFn: (steerEnabled: boolean) => updateAgent(props.agent.id, { steerEnabled }),
  onSettled: () => invalidateAll(queryClient),
});
const steerEnabled = computed({
  get: () => (steering.isPending.value ? steering.variables.value! : props.agent.steerEnabled),
  set: (value: boolean) => steering.mutate(value),
});
const executionAccess = useMutation({
  mutationFn: (dangerFullAccess: boolean) => updateAgent(props.agent.id, { dangerFullAccess }),
  onSettled: () => invalidateAll(queryClient),
});
const dangerFullAccess = computed({
  get: () =>
    executionAccess.isPending.value
      ? executionAccess.variables.value!
      : props.agent.dangerFullAccess,
  set: (value: boolean) => executionAccess.mutate(value),
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
    <section
      class="flex flex-col items-center gap-2 border-b border-line px-4 pt-5 pb-4 text-center"
    >
      <ParticipantAvatar
        :name="agent.name"
        :identity="agent.id"
        :status="agent.status"
        size="lg"
        class="[--avatar-ring:var(--background)]"
      />
      <p class="mt-1 text-lg font-semibold break-words">{{ agent.name }}</p>
      <StatusBadge :status="agent.status" />
      <p class="text-xs break-words text-ink-3">
        {{ harnessName }} · {{ agent.model }} · {{ agent.reasoningEffort }}
      </p>
      <div v-if="agent.status !== 'deleted'" class="mt-1 flex gap-2">
        <Button variant="outline" size="sm" @click="editOpen = true"> <Pencil />编辑 Agent </Button>
        <Button variant="outline" size="sm" class="text-st-error" @click="deleteOpen = true">
          <Trash2 />删除 Agent
        </Button>
      </div>
      <p v-else class="info-box mt-1 text-left text-xs">
        此 Agent 已删除，对话以只读方式保留。聊天历史、工作目录和共享文件已保留。
      </p>
    </section>
    <section class="border-b border-line p-4">
      <h3 class="text-[13px] font-semibold">基本信息</h3>
      <dl
        class="mt-3 grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-3 text-[13px]"
      >
        <dt class="text-ink-3">会话</dt>
        <dd class="flex items-start gap-1">
          <code class="min-w-0 flex-1 font-mono text-xs leading-5 break-all text-ink-2">{{
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
        <dt class="text-ink-3">上下文</dt>
        <dd>
          <Button variant="outline" size="sm" @click="contextOpen = true">
            <ChartPie />查看上下文
          </Button>
        </dd>
        <dt class="text-ink-3">工作目录</dt>
        <dd class="flex items-start gap-1">
          <code class="min-w-0 flex-1 font-mono text-xs leading-5 break-all text-ink-2">{{
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
      <p v-if="copyError" role="alert" class="mt-2 text-xs text-st-error">{{ copyError }}</p>
      <p class="mt-3 text-xs leading-relaxed text-ink-3">
        每个 Agent
        在私聊和所有群中共用一个原生会话，拥有独立的上下文和工作目录。原生配置、插件和长期记忆由
        {{ harnessName }} 管理。
      </p>
    </section>
    <section v-if="agent.status !== 'deleted'" class="border-b border-line p-4">
      <h3 class="text-[13px] font-semibold">执行与协作</h3>
      <ExecutionAccessSetting
        :id="`full-access-${agent.id}`"
        v-model="dangerFullAccess"
        class="mt-3"
        :disabled="executionAccess.isPending.value"
      />
      <p v-if="executionAccess.error.value" role="alert" class="mt-2 text-xs text-st-error">
        {{ executionAccess.error.value.message }}
      </p>
      <div class="mt-3 flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <p :id="`steer-${agent.id}`" class="text-[13px] font-medium">忙碌时实时接收（steer）</p>
          <p class="mt-0.5 text-xs leading-relaxed text-ink-3">
            开启时，新消息追加到当前执行；关闭时，新消息排队。修改立即生效。
          </p>
          <p v-if="!supportsSteer" class="mt-0.5 text-xs text-ink-3">
            实时接收需要 harness 的 steer 支持，当前设置可关闭。
          </p>
        </div>
        <LoaderCircle
          v-if="steering.isPending.value"
          class="mt-0.5 size-4 animate-spin text-ink-3"
        />
        <Switch
          v-model="steerEnabled"
          :aria-labelledby="`steer-${agent.id}`"
          :disabled="steering.isPending.value || (!supportsSteer && !steerEnabled)"
        />
      </div>
      <p v-if="steering.error.value" role="alert" class="mt-2 text-xs text-st-error">
        {{ steering.error.value.message }}
      </p>
      <div class="mt-4 flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <p :id="`groups-${agent.id}`" class="text-[13px] font-medium">允许拉群</p>
          <p class="mt-0.5 text-xs leading-relaxed text-ink-3">
            可以创建群聊并邀请已有 Agent。修改立即生效，Agent 空闲时会重启原生进程以刷新工具列表。
          </p>
        </div>
        <LoaderCircle
          v-if="permission.isPending.value"
          class="mt-0.5 size-4 animate-spin text-ink-3"
        />
        <Switch
          v-model="canCreateGroups"
          :aria-labelledby="`groups-${agent.id}`"
          :disabled="permission.isPending.value"
        />
      </div>
      <p v-if="permission.error.value" role="alert" class="mt-2 text-xs text-st-error">
        {{ permission.error.value.message }}
      </p>
    </section>
    <section class="p-4">
      <div class="flex items-baseline gap-2">
        <h3 class="text-[13px] font-semibold">执行记录</h3>
        <span v-if="runs" class="text-xs text-ink-3 tabular-nums">{{ runs.length }}</span>
      </div>
      <p class="mt-0.5 text-xs text-ink-3">
        查看原生回合、后台子代理和自动唤醒的活动，显示最近 30 次。消息的送达状态独立记录。
      </p>
      <div v-if="!runs" class="mt-4 flex justify-center text-ink-3">
        <LoaderCircle class="size-4 animate-spin" />
      </div>
      <div
        v-else-if="!runs.length"
        class="mt-4 flex flex-col items-center rounded-lg border border-dashed border-line-strong px-4 py-8 text-center"
      >
        <SquareTerminal class="size-5 text-ink-3" aria-hidden="true" />
        <p class="mt-2 text-[13px] font-medium">等待执行</p>
        <p class="mt-0.5 text-xs text-ink-3">收到消息后，可以在这里查看执行过程。</p>
      </div>
      <ol v-else class="mt-3 space-y-2">
        <li v-for="run in runs" :key="run.id"><RunCard :run="run" :inputs="inputs(run)" /></li>
      </ol>
    </section>
    <EditAgentDialog v-if="agent.status !== 'deleted'" v-model:open="editOpen" :agent="agent" />
    <DeleteAgentDialog v-model:open="deleteOpen" :agent="agent" @deleted="$emit('deleted')" />
    <AgentContextDialog v-if="contextOpen" v-model:open="contextOpen" :agent="agent" />
  </div>
</template>
