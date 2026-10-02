<script setup lang="ts">
import { messageKey, type DeliveryStatus, type Message } from '@isles/contracts';
import { AtSign, Ban, CircleAlert, Clock3, CornerDownRight, LoaderCircle } from '@lucide/vue';
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
defineEmits<{ jump: [id: string] }>();

const deliveryStyles: Partial<
  Record<DeliveryStatus, { icon: Component; class: string; spin?: boolean; hint?: string }>
> = {
  queued: { icon: Clock3, class: 'text-muted-foreground' },
  submitting: { icon: LoaderCircle, class: 'text-primary', spin: true },
  accepted: { icon: LoaderCircle, class: 'text-primary', spin: true },
  cancelled: { icon: Ban, class: 'text-muted-foreground' },
  failed: { icon: CircleAlert, class: 'text-destructive' },
  uncertain: {
    icon: CircleAlert,
    class: 'text-warning-strong',
    hint: '无法确认原生会话是否已接收这条消息，Isles 不会自动重发。可在 Agent 详情中核对后决定是否重新发送。',
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
        'group relative -mx-2 flex gap-3 rounded-md px-2 transition-colors duration-500 hover:bg-muted/60',
        continued ? 'py-0.5' : 'mt-2 pt-1.5 pb-0.5',
        highlighted && 'bg-primary/10 hover:bg-primary/10',
      )
    "
  >
    <div class="w-8 shrink-0">
      <ParticipantAvatar v-if="!continued" :name="senderName" :identity="senderIdentity" />
      <time
        v-else
        :datetime="message.createdAt"
        class="block pt-[3px] text-right text-[10px] leading-5 text-muted-foreground tabular-nums opacity-0 group-hover:opacity-100"
        >{{ formatTime(message.createdAt) }}</time
      >
    </div>
    <div class="min-w-0 flex-1">
      <div v-if="!continued" class="flex items-baseline gap-2">
        <span class="font-semibold">{{ senderName }}</span>
        <time
          :datetime="message.createdAt"
          :title="formatDateTime(message.createdAt)"
          class="text-xs text-muted-foreground tabular-nums"
          >{{ formatTime(message.createdAt) }}</time
        >
      </div>
      <button
        v-if="reply"
        type="button"
        class="mt-0.5 flex max-w-full items-center gap-1 text-xs text-muted-foreground enabled:hover:text-foreground"
        :disabled="!reply.targetId"
        @click="reply.targetId && $emit('jump', reply.targetId)"
      >
        <CornerDownRight class="size-3 shrink-0" aria-hidden="true" />
        <span class="truncate">回复 {{ reply.label }}</span>
      </button>
      <template v-if="message.sender === 'agent'">
        <p v-if="mentions.length" class="mt-0.5 flex flex-wrap items-center gap-1 text-xs">
          <AtSign class="size-3 text-muted-foreground" aria-label="提及" />
          <span v-for="name in mentions" :key="name" class="mention">@{{ name }}</span>
        </p>
        <MarkdownContent :source="message.body" class="mt-0.5" />
      </template>
      <p v-else class="mt-0.5 leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
        <template v-for="(segment, index) in segments" :key="index"
          ><span v-if="segment.mention" class="mention">{{ segment.text }}</span
          ><template v-else>{{ segment.text }}</template></template
        >
      </p>
      <p
        v-if="delivery && style"
        :class="cn('mt-1 flex items-center gap-1 text-xs', style.class)"
        :title="title"
      >
        <component
          :is="style.icon"
          :class="cn('size-3.5', style.spin && 'animate-spin')"
          aria-hidden="true"
        />{{ delivery.label }}
      </p>
    </div>
  </article>
</template>
