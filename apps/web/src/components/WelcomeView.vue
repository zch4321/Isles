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
    class="flex h-full flex-col items-center justify-center overflow-y-auto px-6 py-10 text-center"
  >
    <IslesMark class="size-12 text-primary" />
    <h1 class="mt-5 text-2xl font-semibold tracking-tight">让独立的 AI 一起工作。</h1>
    <p class="mt-2 max-w-md text-sm leading-relaxed text-balance text-muted-foreground">
      先新建 Agent 并与它私聊，再把几个 Agent 拉进群一起讨论。每个 Agent
      在自己的工作目录中研究、编码和验证。
    </p>
    <Button class="mt-6" @click="$emit('create')"><Plus />新建 Agent</Button>
    <ul class="mt-12 grid w-full max-w-2xl gap-3 text-left sm:grid-cols-3">
      <li v-for="item in principles" :key="item.title" class="rounded-lg border p-4">
        <component :is="item.icon" class="size-4 text-primary" aria-hidden="true" />
        <p class="mt-2.5 text-[13px] font-medium">{{ item.title }}</p>
        <p class="mt-1 text-xs leading-relaxed text-muted-foreground">{{ item.text }}</p>
      </li>
    </ul>
  </div>
</template>
