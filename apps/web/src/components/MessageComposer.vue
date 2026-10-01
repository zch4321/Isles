<script setup lang="ts">
import type { Agent } from '@isles/contracts';
import { ArrowUp, AtSign, LoaderCircle } from '@lucide/vue';
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import ParticipantAvatar from './ParticipantAvatar.vue';
import { Button } from '@/components/ui/button';
import { mentionBoundary, mentionQuery } from '@/lib/mentions';
import { cn } from '@/lib/utils';

const props = defineProps<{
  placeholder: string;
  sending: boolean;
  /** Group members that can be mentioned; empty in a private chat. */
  members: Agent[];
}>();
const emit = defineEmits<{ submit: [] }>();
const model = defineModel<string>({ required: true });

const textarea = ref<HTMLTextAreaElement>();
function resize() {
  const element = textarea.value;
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
}
watch(model, () => nextTick(resize));
onMounted(() => {
  resize();
  // Skip on touch devices, where focusing would pop up the keyboard.
  if (matchMedia('(pointer: fine)').matches) textarea.value?.focus();
});

// The `@query` being typed selects from the members.
const listId = useId();
const query = ref<{ start: number; query: string }>();
const active = ref(0);
const options = computed(() => {
  const typed = query.value?.query.toLowerCase();
  if (typed === undefined) return [];
  return props.members.filter((m) => m.name.toLowerCase().includes(typed)).slice(0, 8);
});
function track() {
  const element = textarea.value;
  const next =
    element && props.members.length
      ? mentionQuery(element.value, element.selectionStart ?? element.value.length)
      : undefined;
  if (next?.start !== query.value?.start || next?.query !== query.value?.query) active.value = 0;
  query.value = next;
}
function pick(member: Agent) {
  const element = textarea.value;
  const current = query.value;
  if (!element || !current) return;
  const before = model.value.slice(0, current.start);
  const insert = `@${member.name} `;
  model.value = before + insert + model.value.slice(element.selectionStart ?? model.value.length);
  query.value = undefined;
  void nextTick(() => {
    element.focus();
    element.setSelectionRange(before.length + insert.length, before.length + insert.length);
  });
}
// For touch keyboards where "@" is hard to reach.
function startMention() {
  const element = textarea.value;
  if (!element) return;
  const caret = element.selectionStart ?? model.value.length;
  const spacer = mentionBoundary.test(model.value[caret - 1] ?? '') ? ' ' : '';
  model.value = `${model.value.slice(0, caret)}${spacer}@${model.value.slice(caret)}`;
  void nextTick(() => {
    element.focus();
    element.setSelectionRange(caret + spacer.length + 1, caret + spacer.length + 1);
    track();
  });
}

function onKeydown(event: KeyboardEvent) {
  // keyCode 229 covers IME composition in browsers that do not set isComposing.
  if (event.isComposing || event.keyCode === 229) return;
  if (options.value.length) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active.value = (active.value + step + options.value.length) % options.value.length;
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      pick(options.value[active.value]!);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      query.value = undefined;
      return;
    }
  }
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  emit('submit');
}
</script>

<template>
  <form
    class="relative rounded-lg border border-input bg-background shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20 dark:bg-input/20"
    @submit.prevent="emit('submit')"
  >
    <ul
      v-if="options.length"
      :id="listId"
      role="listbox"
      aria-label="提及成员"
      class="absolute bottom-full left-2 z-10 mb-1.5 w-64 max-w-[calc(100%-1rem)] rounded-md border bg-popover p-1 text-popover-foreground shadow-md [--avatar-ring:var(--popover)]"
    >
      <li
        v-for="(member, index) in options"
        :id="`${listId}-${index}`"
        :key="member.id"
        role="option"
        :aria-selected="index === active"
        :class="
          cn(
            'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[13px]',
            index === active && 'bg-accent text-accent-foreground',
          )
        "
        @mousedown.prevent="pick(member)"
        @mousemove="active = index"
      >
        <ParticipantAvatar :name="member.name" :identity="member.id" size="sm" />
        <span class="min-w-0 flex-1 truncate font-medium">{{ member.name }}</span>
        <span class="shrink-0 truncate text-xs text-muted-foreground">{{ member.model }}</span>
      </li>
    </ul>
    <textarea
      ref="textarea"
      v-model="model"
      rows="1"
      maxlength="32000"
      aria-label="消息输入"
      :aria-autocomplete="members.length ? 'list' : undefined"
      :aria-controls="options.length ? listId : undefined"
      :aria-activedescendant="options.length ? `${listId}-${active}` : undefined"
      :placeholder="placeholder"
      class="block max-h-60 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-base leading-relaxed outline-none placeholder:text-muted-foreground md:text-sm"
      @keydown="onKeydown"
      @input="track"
      @click="track"
      @keyup="track"
      @blur="query = undefined"
    />
    <div class="flex items-center gap-2 pr-2 pb-2 pl-2">
      <Button
        v-if="members.length"
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="提及成员"
        title="提及成员"
        class="text-muted-foreground"
        @mousedown.prevent
        @click="startMention"
      >
        <AtSign />
      </Button>
      <span class="pl-1.5 text-[11px] text-muted-foreground max-sm:hidden"
        >Enter 发送 · Shift + Enter 换行</span
      >
      <Button
        type="submit"
        size="icon-sm"
        class="ml-auto"
        :disabled="sending || !model.trim()"
        aria-label="发送消息"
        title="发送消息"
      >
        <LoaderCircle v-if="sending" class="animate-spin" /><ArrowUp v-else />
      </Button>
    </div>
  </form>
</template>
