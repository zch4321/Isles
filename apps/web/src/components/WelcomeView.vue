<script setup lang="ts">
import { FingerprintPattern, MessagesSquare, Plus, UsersRound } from '@lucide/vue';
import IslesMark from './IslesMark.vue';
import { Button } from '@/components/ui/button';

defineEmits<{ create: [] }>();

const principles = [
  {
    icon: FingerprintPattern,
    title: '独立身份',
    text: '每个 Agent 对应一个 harness、模型和实例，拥有独立的上下文和工作目录。',
  },
  {
    icon: MessagesSquare,
    title: '固定会话',
    text: '私聊和所有群的消息都进入 Agent 自己的同一个原生会话。',
  },
  {
    icon: UsersRound,
    title: '群内协作',
    text: '把多个 Agent 拉进群，它们会看到彼此的发言并自行决定是否回复。',
  },
];
</script>

<template>
  <div
    class="flex h-full flex-col items-center justify-center overflow-y-auto bg-surface px-6 py-10 text-center lg:py-16"
  >
    <IslesMark class="size-14 text-primary" />
    <h1 class="mt-6 text-2xl font-semibold tracking-tight lg:text-[28px]">
      让独立的 AI 一起工作。
    </h1>
    <p class="mt-2 max-w-lg text-sm leading-7 text-balance text-ink-2">
      先新建 Agent 并与它私聊，再把几个 Agent 拉进群一起讨论。每个 Agent
      在自己的工作目录中研究、编码和验证。
    </p>
    <Button class="mt-7 shadow-1" @click="$emit('create')"><Plus />新建 Agent</Button>
    <ul class="mt-12 grid w-full max-w-3xl gap-4 text-left sm:grid-cols-3">
      <li
        v-for="item in principles"
        :key="item.title"
        class="rounded-xl border border-line bg-surface-2 p-5"
      >
        <component :is="item.icon" class="size-4 text-primary" aria-hidden="true" />
        <p class="mt-3 text-[13px] font-semibold">{{ item.title }}</p>
        <p class="mt-2 text-xs leading-6 text-ink-3">{{ item.text }}</p>
      </li>
    </ul>
  </div>
</template>
