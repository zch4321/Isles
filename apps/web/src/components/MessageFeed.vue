<script setup lang="ts">
import { messageKey, type Agent, type Channel, type Message } from '@isles/contracts';
import { ArrowDown, LoaderCircle } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import GroupAvatar from './GroupAvatar.vue';
import MessageItem from './MessageItem.vue';
import ParticipantAvatar from './ParticipantAvatar.vue';
import { Button } from '@/components/ui/button';
import { senderName, type Directory } from '@/lib/channels';
import { dateLabel, deliveryLabels, formatTime, sameDay } from '@/lib/format';

const props = defineProps<{
  channel: Channel;
  /** The Agent of a private chat. */
  agent: Agent | undefined;
  messages: Message[];
  directory: Directory;
  hasOlder: boolean;
  loadOlder: () => Promise<void>;
  /** Members currently in a turn. */
  working: Agent[];
  inspectorOpen: boolean;
}>();
const emit = defineEmits<{ openInspector: [] }>();

const GROUP_WINDOW = 5 * 60_000;

const nameOf = (message: Message) => senderName(message, props.directory);
const excerpt = (message: Message) =>
  message.body.replace(/\s+/g, ' ').trim().slice(0, 80) || (message.images.length ? '[图片]' : '');

// Worst state first; a group message settles once no member is still waiting for it.
const pending = ['uncertain', 'failed', 'queued', 'submitting', 'steering'] as const;
const groupLabels = {
  uncertain: '待核对',
  failed: '部分投递失败',
  queued: '等待投递',
  submitting: '处理中',
  steering: '投递中',
};
function deliveryOf(message: Message) {
  if (message.sender !== 'user' || !message.deliveries.length) return undefined;
  if (props.channel.kind === 'private') {
    const status = message.deliveries[0]!.status;
    return { status, label: deliveryLabels[status] };
  }
  const status = pending.find((s) => message.deliveries.some((d) => d.status === s));
  if (!status)
    return message.deliveries.every((delivery) =>
      ['accepted', 'received'].includes(delivery.status),
    )
      ? { status: 'accepted' as const, label: '已送达' }
      : undefined;
  const detail = message.deliveries
    .map((d) => `${props.directory.get(d.agentId)?.name ?? 'Agent'}：${deliveryLabels[d.status]}`)
    .join('\n');
  return { status, label: groupLabels[status], detail };
}

type Entry =
  | { kind: 'date'; key: string; label: string }
  | { kind: 'system'; key: string; message: Message }
  | {
      kind: 'message';
      key: string;
      message: Message;
      continued: boolean;
      reply: { label: string; targetId: string | undefined } | undefined;
    };

const entries = computed(() => {
  const bySeq = new Map(props.messages.map((message) => [message.seq, message]));
  const list: Entry[] = [];
  let previous: Message | undefined;
  for (const message of props.messages) {
    const newDay = !previous || !sameDay(previous.createdAt, message.createdAt);
    if (newDay)
      list.push({
        kind: 'date',
        key: `date-${messageKey(message)}`,
        label: dateLabel(message.createdAt),
      });
    if (message.sender === 'system') {
      list.push({ kind: 'system', key: messageKey(message), message });
      previous = message;
      continue;
    }
    const target = message.replyTo ? bySeq.get(message.replyTo) : undefined;
    list.push({
      kind: 'message',
      key: messageKey(message),
      message,
      continued:
        !newDay &&
        previous?.sender === message.sender &&
        previous.senderId === message.senderId &&
        Date.parse(message.createdAt) - Date.parse(previous.createdAt) < GROUP_WINDOW,
      // A reply to the message right above it is clear from position alone.
      reply:
        message.replyTo && message.replyTo !== previous?.seq
          ? {
              label: target ? `${nameOf(target)}：${excerpt(target)}` : '更早的消息',
              targetId: target ? messageKey(target) : undefined,
            }
          : undefined,
    });
    previous = message;
  }
  return list;
});
const mentionNames = (message: Message) =>
  message.mentions.flatMap((id) => props.directory.get(id)?.name ?? []);

const scroller = ref<HTMLElement>();
const content = ref<HTMLElement>();
const atBottom = ref(true);
function onScroll() {
  const element = scroller.value;
  if (element)
    atBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}
function scrollToBottom() {
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}
// Stay pinned to the latest message while content or viewport size changes
// (new replies, the working indicator, a rotated phone); otherwise just re-measure.
const resizes = new ResizeObserver(() => (atBottom.value ? scrollToBottom() : onScroll()));
onMounted(() => {
  scrollToBottom();
  for (const element of [scroller.value, content.value]) if (element) resizes.observe(element);
});
onBeforeUnmount(() => resizes.disconnect());
// A message the user just sent is always brought into view.
watch(
  () => props.messages.at(-1),
  async (last, previous) => {
    if (!last || (previous && messageKey(last) === messageKey(previous)) || last.sender !== 'user')
      return;
    await nextTick();
    scrollToBottom();
  },
);

const loadingOlder = ref(false);
async function older() {
  const element = scroller.value;
  if (!element || loadingOlder.value) return;
  loadingOlder.value = true;
  const fromBottom = element.scrollHeight - element.scrollTop;
  try {
    await props.loadOlder();
    await nextTick();
    element.scrollTop = element.scrollHeight - fromBottom;
  } finally {
    loadingOlder.value = false;
  }
}

const highlighted = ref('');
let highlightTimer: ReturnType<typeof setTimeout> | undefined;
function jumpTo(id: string) {
  document.getElementById(`message-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  highlighted.value = id;
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => (highlighted.value = ''), 1600);
}
onBeforeUnmount(() => clearTimeout(highlightTimer));

const workingNames = computed(() => props.working.map((a) => a.name).join('、'));
</script>

<template>
  <div class="relative min-h-0">
    <div
      ref="scroller"
      role="log"
      :aria-label="channel.kind === 'group' ? '群聊消息' : '私聊消息'"
      class="h-full overflow-y-auto overscroll-contain"
      @scroll="onScroll"
    >
      <div ref="content" class="mx-auto flex min-h-full max-w-4xl flex-col px-3 pt-3 pb-4 md:px-6">
        <div v-if="hasOlder" class="flex justify-center pb-1">
          <Button
            variant="ghost"
            size="xs"
            class="text-ink-3"
            :disabled="loadingOlder"
            @click="older"
          >
            <LoaderCircle v-if="loadingOlder" class="animate-spin" />加载更早消息
          </Button>
        </div>

        <div
          v-if="agent && !messages.length"
          class="m-auto flex max-w-sm flex-col items-center py-12 text-center"
        >
          <ParticipantAvatar :name="agent.name" :identity="agent.id" size="lg" />
          <h2 class="mt-4 text-base font-semibold">与 {{ agent.name }} 开始对话</h2>
          <p class="mt-1.5 text-[13px] leading-relaxed text-ink-3">
            {{ agent.name }}
            拥有固定的原生会话、独立的上下文和工作目录。正式回复显示在这里，执行过程可以在 Agent
            详情中查看。
          </p>
        </div>
        <div
          v-else-if="!agent && !hasOlder"
          class="flex flex-col items-center pt-8 pb-4 text-center"
        >
          <GroupAvatar :identity="channel.id" size="lg" />
          <h2 class="mt-4 text-base font-semibold">{{ channel.name }}</h2>
          <p class="mt-1.5 max-w-md text-[13px] leading-relaxed text-ink-3">
            群里的每条消息都对全体成员可见，并唤醒其他成员参与讨论。用 @ 标明你特意对谁说，与单个
            Agent 的交流可以通过私聊进行。
          </p>
        </div>

        <template v-for="entry in entries" :key="entry.key">
          <div
            v-if="entry.kind === 'date'"
            class="mt-5 mb-2 flex items-center gap-3 text-xs text-ink-3"
          >
            <span class="h-px flex-1 bg-line" />{{ entry.label
            }}<span class="h-px flex-1 bg-line" />
          </div>
          <p
            v-else-if="entry.kind === 'system'"
            :id="`message-${messageKey(entry.message)}`"
            data-sender="system"
            class="mx-auto my-2 max-w-md text-center text-xs leading-relaxed text-balance text-ink-3"
          >
            {{ entry.message.body }}
            <time :datetime="entry.message.createdAt" class="ml-1 tabular-nums opacity-70">{{
              formatTime(entry.message.createdAt)
            }}</time>
          </p>
          <MessageItem
            v-else
            :message="entry.message"
            :sender-name="nameOf(entry.message)"
            :sender-identity="entry.message.sender === 'agent' ? entry.message.senderId : undefined"
            :continued="entry.continued"
            :reply="entry.reply"
            :mentions="mentionNames(entry.message)"
            :delivery="deliveryOf(entry.message)"
            :highlighted="highlighted === messageKey(entry.message)"
            @jump="jumpTo"
            @inspect="emit('openInspector')"
          />
        </template>

        <div
          v-if="working.length"
          class="mt-3 flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2"
          aria-live="polite"
        >
          <div class="flex -space-x-2">
            <ParticipantAvatar
              v-for="member in working.slice(0, 3)"
              :key="member.id"
              :name="member.name"
              :identity="member.id"
              size="sm"
              class="ring-2 ring-surface-2"
            />
          </div>
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-[13px] text-ink-2">
            <span class="font-medium text-ink">{{ workingNames }}</span>
            <span class="inline-flex items-center gap-1.5 text-st-running"
              >正在处理<span class="typing-dots" aria-hidden="true"><i /><i /><i /></span
            ></span>
          </div>
          <button
            v-if="!inspectorOpen"
            type="button"
            class="shrink-0 text-[13px] text-primary-ink hover:underline"
            @click="$emit('openInspector')"
          >
            查看执行过程
          </button>
        </div>
      </div>
    </div>
    <Button
      v-if="!atBottom"
      variant="outline"
      size="icon-sm"
      class="absolute right-4 bottom-3 rounded-full bg-surface shadow-2"
      aria-label="滚动到最新消息"
      @click="scrollToBottom"
    >
      <ArrowDown />
    </Button>
  </div>
</template>
