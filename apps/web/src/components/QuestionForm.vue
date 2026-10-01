<script setup lang="ts">
import type { QuestionAnswer, UserQuestion } from '@isles/contracts';
import { LoaderCircle, MessageCircleQuestionMark } from '@lucide/vue';
import { reactive } from 'vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const props = defineProps<{ question: UserQuestion; agentName: string; pending: boolean }>();
const emit = defineEmits<{ submit: [answers: QuestionAnswer] }>();

// Choosing OTHER switches a question with options to a free-text answer.
const OTHER = Symbol('other');
const choices = reactive<Record<string, string | typeof OTHER>>({});
const typed = reactive<Record<string, string>>({});

function submit() {
  const answers: QuestionAnswer['answers'] = {};
  for (const q of props.question.questions) {
    const choice = choices[q.id];
    const value = q.options && choice !== OTHER ? choice : typed[q.id]?.trim();
    answers[q.id] = { answers: [value ?? ''] };
  }
  emit('submit', { answers });
}
</script>

<template>
  <form class="rounded-lg border border-primary/25 bg-primary-soft p-4" @submit.prevent="submit">
    <div class="flex items-center gap-2">
      <MessageCircleQuestionMark class="size-4 text-primary" aria-hidden="true" />
      <h2 class="text-sm font-semibold">{{ agentName }} 需要你的回答</h2>
    </div>
    <p class="mt-1 text-xs text-muted-foreground">当前执行在等待回答，提交后继续。</p>

    <fieldset v-for="q in question.questions" :key="q.id" class="mt-3">
      <legend class="text-[13px] font-medium">
        <span
          v-if="q.header"
          class="mr-1.5 rounded border bg-background px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground"
          >{{ q.header }}</span
        >{{ q.question }}
      </legend>
      <div v-if="q.options" class="mt-2 grid gap-1.5 sm:grid-cols-2">
        <label
          v-for="option in q.options"
          :key="option.label"
          class="flex cursor-pointer items-start gap-2.5 rounded-md border bg-background px-3 py-2 transition-colors hover:border-ring/60 has-checked:border-primary has-checked:ring-1 has-checked:ring-primary/30"
        >
          <input
            v-model="choices[q.id]"
            type="radio"
            :name="`${question.id}:${q.id}`"
            :value="option.label"
            required
            class="mt-[3px] accent-primary"
          />
          <span class="min-w-0">
            <span class="block text-[13px] font-medium">{{ option.label }}</span>
            <span v-if="option.description" class="block text-xs text-muted-foreground">{{
              option.description
            }}</span>
          </span>
        </label>
        <label
          v-if="q.isOther"
          class="flex cursor-pointer items-start gap-2.5 rounded-md border bg-background px-3 py-2 transition-colors hover:border-ring/60 has-checked:border-primary has-checked:ring-1 has-checked:ring-primary/30"
        >
          <input
            v-model="choices[q.id]"
            type="radio"
            :name="`${question.id}:${q.id}`"
            :value="OTHER"
            required
            class="mt-[3px] accent-primary"
          />
          <span class="text-[13px] font-medium">其他回答</span>
        </label>
      </div>
      <Input
        v-if="!q.options || choices[q.id] === OTHER"
        v-model="typed[q.id]"
        :type="q.isSecret ? 'password' : 'text'"
        required
        maxlength="8000"
        autocomplete="off"
        :aria-label="q.question"
        placeholder="输入你的回答"
        class="mt-2 bg-background"
      />
    </fieldset>

    <div class="mt-4 flex justify-end">
      <Button type="submit" size="sm" :disabled="pending">
        <LoaderCircle v-if="pending" class="animate-spin" />提交回答
      </Button>
    </div>
  </form>
</template>
