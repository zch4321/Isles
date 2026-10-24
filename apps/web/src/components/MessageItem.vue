<script setup lang="ts">
import { messageKey, type DeliveryStatus, type Message } from '@isles/contracts';
import {
  AtSign,
  Ban,
  CircleAlert,
  Check,
  Clock3,
  CornerDownRight,
  LoaderCircle,
  SquareTerminal,
} from '@lucide/vue';
import { computed, type Component } from 'vue';
import MarkdownContent from './MarkdownContent.vue';
import ParticipantAvatar from './ParticipantAvatar.vue';
import { formatDateTime, formatTime } from '@/lib/format';
import { mentionSegments } from '@/lib/mentions';
import { cn } from '@/lib/utils';

const props = defineProps<{
  message: Message;
  senderName: string;
  /** Agent ID for tinting; undefined for the user. */
  senderIdentity: string | undefined;
  /** Continues the previous sender's group, so the avatar and name are omitted. */
  continued: boolean;
  /** Set when the message replies to something other than the message right above it. */
  reply: { label: string; targetId: string | undefined } | undefined;
  /** Names of the Agents this message addresses. */
  mentions: string[];
  /** Delivery state worth showing; undefined once everything is settled. */
  delivery: { status: DeliveryStatus; label: string; detail?: string } | undefined;
  highlighted: boolean;
}>();
defineEmits<{ jump: [id: string]; inspect: [] }>();

const deliveryStyles: Partial<
  Record<DeliveryStatus, { icon: Component; class: string; spin?: boolean; hint?: string }>
> = {
  queued: { icon: Clock3, class: 'text-st-queued' },
  submitting: { icon: LoaderCircle, class: 'text-st-running', spin: true },
  steering: {
    icon: LoaderCircle,
    class: 'text-st-steering',
    spin: true,
    hint: '正在向当前执行追加消息。',
  },
  accepted: { icon: Check, class: 'text-ink-3' },
  cancelled: { icon: Ban, class: 'text-ink-3' },
  failed: { icon: CircleAlert, class: 'text-st-error' },
  uncertain: {
    icon: CircleAlert,
    class: 'text-attention-ink',
    hint: '投递结果待核对，请在执行记录里确认是否已送达。',
  },
};
const style = computed(() => (props.delivery ? deliveryStyles[props.delivery.status] : undefined));
const title = computed(
  () => [props.delivery?.detail, style.value?.hint].filter(Boolean).join('\n') || undefined,
);
// User messages carry their @names in the text; Agents name recipients through the tool.
const segments = computed(() =>
  props.message.sender === 'user' ? mentionSegments(props.message.body, props.mentions) : [],
);
</script>

<template>
  <article
    :id="`message-${messageKey(message)}`"
    :data-sender="message.sender"
    :aria-label="`${senderName}的消息`"
    :class="
      cn(
        'group relative -mx-2 flex gap-3 rounded-lg px-2 transition-colors duration-500',
        message.sender === 'user' ? 'hover:bg-transparent' : 'hover:bg-surface-2/70',
        continued ? 'py-0.5' : 'mt-3 pt-1.5 pb-0.5',
        highlighted && 'bg-primary/10 hover:bg-primary/10',
      )
    "
  >
    <div class="w-8 shrink-0">
      <ParticipantAvatar v-if="!continued" :name="senderName" :identity="senderIdentity" />
      <time
        v-else
        :datetime="message.createdAt"
        class="block pt-[3px] text-right text-[10px] leading-5 text-ink-3 tabular-nums opacity-0 group-hover:opacity-100"
        >{{ formatTime(message.createdAt) }}</time
      >
    </div>
    <div
      :class="
        cn(
          'min-w-0 flex-1',
          // The human's words get a quiet panel; Agent replies stay open text.
          message.sender === 'user' && 'rounded-lg bg-surface-2 px-3 py-2',
        )
      "
    >
      <div v-if="!continued" class="flex items-baseline gap-2">
        <span class="font-semibold">{{ senderName }}</span>
        <time
          :datetime="message.createdAt"
          :title="formatDateTime(message.createdAt)"
          class="text-xs text-ink-3 tabular-nums"
          >{{ formatTime(message.createdAt) }}</time
        >
      </div>
      <button
        v-if="reply"
        type="button"
        class="my-0.5 flex max-w-full items-center gap-1.5 border-l-2 border-(--blue-300) pl-2 text-xs text-ink-3 enabled:hover:text-ink"
        :disabled="!reply.targetId"
        @click="reply.targetId && $emit('jump', reply.targetId)"
      >
        <CornerDownRight class="size-3 shrink-0" aria-hidden="true" />
        <span class="truncate">回复 {{ reply.label }}</span>
      </button>
      <template v-if="message.sender === 'agent'">
        <p v-if="mentions.length" class="mt-0.5 flex flex-wrap items-center gap-1 text-xs">
          <AtSign class="size-3 text-ink-3" aria-label="提及" />
          <span v-for="name in mentions" :key="name" class="mention">@{{ name }}</span>
        </p>
        <MarkdownContent :source="message.body" class="mt-0.5 text-[15px]" />
      </template>
      <p
        v-else
        class="mt-0.5 text-[15px] leading-[1.7] whitespace-pre-wrap [overflow-wrap:anywhere]"
      >
        <template v-for="(segment, index) in segments" :key="index"
          ><span v-if="segment.mention" class="mention">{{ segment.text }}</span
          ><template v-else>{{ segment.text }}</template></template
        >
      </p>
      <div
        v-if="delivery && style"
        :class="cn('mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs', style.class)"
        :title="title"
      >
        <component
          :is="style.icon"
          :class="cn('size-3.5', style.spin && 'animate-spin')"
          aria-hidden="true"
        />{{ delivery.label }}
        <button
          v-if="delivery.status === 'uncertain'"
          type="button"
          class="inline-flex items-center gap-1 rounded-sm border border-line-strong bg-surface px-1.5 py-0.5 font-medium text-ink hover:bg-surface-hover"
          @click="$emit('inspect')"
        >
          <SquareTerminal class="size-3" aria-hidden="true" />查看执行记录
        </button>
      </div>
    </div>
  </article>
</template>
