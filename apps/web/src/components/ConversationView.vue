<script setup lang="ts">
import { messageKey, type Message, type QuestionAnswer } from '@isles/contracts';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { CircleAlert, Clock3, LoaderCircle, Pause, RefreshCw, X } from '@lucide/vue';
import { computed, ref } from 'vue';
import {
  answerQuestion,
  controlAgent,
  downloadChat,
  fetchOlderMessages,
  sendMessage,
  updateChannel,
} from '@/api/isles';
import { invalidateAll, useAgents, useChannelDetail, useDirectory } from '@/api/queries';
import ConversationHeader from './ConversationHeader.vue';
import MessageComposer from './MessageComposer.vue';
import MessageFeed from './MessageFeed.vue';
import QuestionForm from './QuestionForm.vue';
import { Button } from '@/components/ui/button';
import { outgoing, settle, useDraft } from '@/composables/useDraft';
import { errorMessage } from '@/lib/format';
import { findMentions } from '@/lib/mentions';

const PAGE_SIZE = 100;

const props = defineProps<{ channelId: string; inspectorOpen: boolean }>();
const emit = defineEmits<{ back: []; toggleInspector: []; openInspector: [] }>();

const queryClient = useQueryClient();
const detail = useChannelDetail(() => props.channelId);
const agents = useAgents();
const directory = useDirectory();
const channel = computed(() => detail.data.value?.channel);
const agent = computed(() =>
  channel.value?.kind === 'private' ? directory.value.get(channel.value.agentId ?? '') : undefined,
);
const members = computed(() =>
  (channel.value?.memberIds ?? []).flatMap((id) => directory.value.get(id) ?? []),
);
const ready = computed(() => channel.value && (channel.value.kind === 'group' || agent.value));
const deletedGroup = computed(
  () => channel.value?.kind === 'group' && Boolean(channel.value.deletedAt),
);
const questions = computed(() => detail.data.value?.questions ?? []);
const working = computed(() =>
  members.value.filter(
    (m) => m.status === 'running' && !questions.value.some((q) => q.agentId === m.id),
  ),
);

// The detail snapshot carries the latest page; older pages are merged in on demand.
const older = ref<Message[]>([]);
const olderExhausted = ref(false);
const messages = computed(() => {
  const merged = new Map(
    [...older.value, ...(detail.data.value?.messages ?? [])].map((message) => [
      messageKey(message),
      message,
    ]),
  );
  return [...merged.values()].sort((a, b) => a.seq - b.seq);
});
const hasOlder = computed(() => !olderExhausted.value && (messages.value[0]?.seq ?? 1) > 1);
async function loadOlder() {
  const first = messages.value[0];
  if (!first) return;
  try {
    const page = await fetchOlderMessages(props.channelId, first.seq);
    older.value = [...page.messages, ...older.value];
    olderExhausted.value = page.messages.length < PAGE_SIZE;
  } catch (error) {
    actionError.value = errorMessage(error);
  }
}

const actionError = ref('');
const mutationHandlers = {
  onMutate: () => {
    actionError.value = '';
  },
  onError: (error: unknown) => {
    actionError.value = errorMessage(error);
  },
  onSettled: () => invalidateAll(queryClient),
};
const control = useMutation({
  mutationFn: (action: 'stop' | 'resume') => controlAgent(agent.value!.id, action),
  ...mutationHandlers,
});
const pause = useMutation({
  mutationFn: (paused: boolean) => updateChannel(props.channelId, { paused }),
  ...mutationHandlers,
});
const answer = useMutation({
  mutationFn: (input: { agentId: string; questionId: string; answers: QuestionAnswer }) =>
    answerQuestion(input.agentId, input.questionId, input.answers),
  ...mutationHandlers,
});
const send = useMutation({
  mutationFn: (input: { body: string; clientId: string }) =>
    sendMessage(props.channelId, {
      ...input,
      ...(channel.value?.kind === 'group' && { mentions: findMentions(input.body, members.value) }),
    }),
  ...mutationHandlers,
});
const exporting = useMutation({
  mutationFn: (channelId: string) => downloadChat(channelId),
  onMutate: mutationHandlers.onMutate,
  onError: mutationHandlers.onError,
});

const draft = useDraft(() => props.channelId);
async function submit() {
  if (deletedGroup.value || agent.value?.status === 'deleted') return;
  const body = draft.value.trim();
  if (!body || send.isPending.value) return;
  try {
    await send.mutateAsync(outgoing(props.channelId, body));
  } catch {
    return;
  }
  settle(props.channelId);
  // Keep anything typed while the request was in flight.
  if (draft.value.trim() === body) draft.value = '';
}

const placeholder = computed(() => {
  if (agent.value)
    return agent.value.desiredState === 'stopped'
      ? `给 ${agent.value.name} 留言，恢复后处理…`
      : `给 ${agent.value.name} 发消息…`;
  return channel.value?.paused
    ? '讨论已暂停，消息会先保存…'
    : `在 ${channel.value?.name ?? '群聊'} 中发言，输入 @ 提及成员…`;
});
const notice = computed(() => {
  if (deletedGroup.value)
    return { held: true, text: '群聊已删除，聊天历史和工作文件已保留。当前对话仅供查看。' };
  if (agent.value?.status === 'deleted')
    return { held: true, text: 'Agent 已删除，聊天历史和工作文件已保留。当前对话仅供查看。' };
  if (channel.value?.paused)
    return { held: true, text: '讨论已暂停：新消息会保存，继续后汇总剩余未读。' };
  const current = agent.value;
  if (!current) return undefined;
  const queued = messages.value.filter((m) => m.deliveries[0]?.status === 'queued').length;
  const steering = messages.value.filter((m) => m.deliveries[0]?.status === 'steering').length;
  const count = queued ? `${queued} 条消息排队中。` : '';
  if (current.desiredState === 'stopped')
    return { held: true, text: `Agent 已停止，新消息会排队，恢复后处理。${count}` };
  if (steering)
    return {
      held: false,
      text: `${steering} 条消息正在投递到当前执行。${count}`,
    };
  if (!count) return undefined;
  return {
    held: false,
    text:
      current.status === 'error'
        ? `${count}恢复 Agent 后继续处理。`
        : current.steerEnabled && current.status === 'running'
          ? `${count}已开启实时接收，等待向当前执行追加消息。`
          : `${count}当前执行结束后处理。`,
  };
});
const nameOf = (agentId: string) => directory.value.get(agentId)?.name ?? 'Agent';
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-surface">
    <template v-if="channel && ready">
      <ConversationHeader
        :channel="channel"
        :agent="agent"
        :members="members"
        :inspector-open="inspectorOpen"
        :control-pending="control.isPending.value || pause.isPending.value"
        :export-pending="exporting.isPending.value"
        @back="emit('back')"
        @stop="control.mutate('stop')"
        @resume="control.mutate('resume')"
        @pause="pause.mutate(true)"
        @continue="pause.mutate(false)"
        @toggle-inspector="emit('toggleInspector')"
        @export="exporting.mutate(channelId)"
      />
      <div
        v-if="agent?.error"
        role="alert"
        class="flex items-start gap-2.5 border-b border-st-error/20 bg-st-error-soft px-4 py-3 text-[13px] lg:px-7"
      >
        <CircleAlert class="mt-0.5 size-4 shrink-0 text-st-error" aria-hidden="true" />
        <div class="min-w-0">
          <p class="font-medium text-st-error">Agent 运行异常</p>
          <p class="mt-0.5 break-words text-ink-3">{{ agent.error }}</p>
        </div>
      </div>
      <MessageFeed
        class="flex-1"
        :channel="channel"
        :agent="agent"
        :messages="messages"
        :directory="directory"
        :has-older="hasOlder"
        :load-older="loadOlder"
        :working="working"
        :inspector-open="inspectorOpen"
        @open-inspector="emit('openInspector')"
      />
      <div
        class="mx-auto w-full max-w-[816px] shrink-0 space-y-3 px-3 pt-2 pb-4 sm:px-6 lg:px-7 lg:pb-5"
      >
        <div v-if="actionError" role="alert" class="notice notice-error pr-1.5">
          <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span class="min-w-0 flex-1 break-words">{{ actionError }}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            class="text-st-error hover:text-st-error"
            aria-label="关闭提示"
            @click="actionError = ''"
          >
            <X />
          </Button>
        </div>
        <section
          v-if="questions.length && !deletedGroup"
          aria-label="等待回答的问题"
          class="max-h-[45dvh] space-y-3 overflow-y-auto pr-1"
        >
          <QuestionForm
            v-for="question in questions"
            :key="question.id"
            :question="question"
            :agent-name="nameOf(question.agentId)"
            :pending="answer.isPending.value"
            @submit="
              (answers) =>
                answer.mutate({ agentId: question.agentId, questionId: question.id, answers })
            "
          />
        </section>
        <p
          v-if="notice"
          class="flex items-start gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-ink-2"
        >
          <Pause v-if="notice.held" class="size-3.5 shrink-0" aria-hidden="true" />
          <Clock3 v-else class="size-3.5 shrink-0" aria-hidden="true" />{{ notice.text }}
        </p>
        <MessageComposer
          v-if="!deletedGroup && agent?.status !== 'deleted'"
          v-model="draft"
          :placeholder="placeholder"
          :sending="send.isPending.value"
          :members="channel.kind === 'group' ? members : []"
          @submit="submit"
        />
      </div>
    </template>

    <div
      v-else-if="detail.isError.value || agents.isError.value"
      class="m-auto flex max-w-sm flex-col items-center px-6 py-8 text-center"
    >
      <CircleAlert class="size-6 text-st-error" aria-hidden="true" />
      <h2 class="mt-3 font-medium">对话加载失败</h2>
      <p role="alert" class="mt-1 text-[13px] text-ink-3">
        {{ (detail.error.value ?? agents.error.value)?.message }}
      </p>
      <div class="mt-4 flex gap-2">
        <Button variant="outline" size="sm" class="md:hidden" @click="emit('back')">返回</Button>
        <Button variant="outline" size="sm" @click="invalidateAll(queryClient)"
          ><RefreshCw />重试</Button
        >
      </div>
    </div>

    <div v-else class="m-auto flex items-center gap-2 text-[13px] text-ink-3">
      <LoaderCircle class="size-4 animate-spin" />正在载入对话…
    </div>
  </div>
</template>
