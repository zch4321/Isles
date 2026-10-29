<script setup lang="ts">
import type { Agent } from '@isles/contracts';
import { ArrowUp, AtSign, ImagePlus, LoaderCircle, RefreshCw, X } from '@lucide/vue';
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import ParticipantAvatar from './ParticipantAvatar.vue';
import { Button } from '@/components/ui/button';
import type { DraftImage } from '@/composables/useDraft';
import { agentStatusLabels, agentStatusTone } from '@/lib/format';
import { mentionBoundary, mentionQuery } from '@/lib/mentions';
import { cn } from '@/lib/utils';

const props = defineProps<{
  placeholder: string;
  sending: boolean;
  images: DraftImage[];
  feedback: string;
  /** Group members that can be mentioned; empty in a private chat. */
  members: Agent[];
}>();
const emit = defineEmits<{
  submit: [];
  addImages: [files: File[]];
  removeImage: [key: string];
  retryImage: [key: string];
}>();
const model = defineModel<string>({ required: true });

const textarea = ref<HTMLTextAreaElement>();
const imageInput = ref<HTMLInputElement>();
const dragging = ref(false);
function filesSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  emit('addImages', Array.from(input.files ?? []));
  input.value = '';
}
function onPaste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
    file.type.startsWith('image/'),
  );
  if (files.length) emit('addImages', files);
}
function onDragOver(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  dragging.value = true;
}
function onDragLeave(event: DragEvent) {
  if (
    !event.currentTarget ||
    !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)
  )
    dragging.value = false;
}
function onDrop(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragging.value = false;
  emit('addImages', Array.from(event.dataTransfer.files));
}
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
    :class="
      cn(
        'relative rounded-xl border border-line-strong bg-surface shadow-1 transition-[border-color,box-shadow] focus-within:border-(--line-focus) focus-within:ring-3 focus-within:ring-ring/25',
        dragging && 'border-primary ring-3 ring-ring/25',
      )
    "
    @submit.prevent="emit('submit')"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <ul
      v-if="options.length"
      :id="listId"
      role="listbox"
      aria-label="提及成员"
      class="absolute bottom-full left-2 z-10 mb-1.5 w-72 max-w-[calc(100%-1rem)] rounded-xl border border-line bg-popover p-1 text-popover-foreground shadow-3 [--avatar-ring:var(--popover)]"
    >
      <li
        v-for="(member, index) in options"
        :id="`${listId}-${index}`"
        :key="member.id"
        role="option"
        :aria-selected="index === active"
        :class="
          cn(
            'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px]',
            index === active && 'bg-surface-hover',
          )
        "
        @mousedown.prevent="pick(member)"
        @mousemove="active = index"
      >
        <ParticipantAvatar :name="member.name" :identity="member.id" size="sm" />
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium">{{ member.name }}</span>
          <span class="block truncate font-mono text-[11px] text-ink-3">{{ member.model }}</span>
        </span>
        <span class="flex shrink-0 items-center gap-1.5 text-xs text-ink-3">
          <span :class="cn('size-1.5 rounded-full', agentStatusTone[member.status])" />{{
            agentStatusLabels[member.status]
          }}
        </span>
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
      class="block max-h-60 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base leading-relaxed outline-none placeholder:text-ink-4 md:text-[15px]"
      @keydown="onKeydown"
      @input="track"
      @click="track"
      @keyup="track"
      @blur="query = undefined"
      @paste="onPaste"
    />
    <div
      v-if="images.length"
      aria-label="草稿图片"
      aria-live="polite"
      class="flex max-h-[30dvh] flex-wrap gap-2 overflow-y-auto px-3 pt-2"
    >
      <div
        v-for="entry in images"
        :key="entry.key"
        class="relative w-24 overflow-hidden rounded-lg border border-line bg-surface-2"
      >
        <img :src="entry.url" :alt="`预览 ${entry.file.name}`" class="h-20 w-full object-cover" />
        <button
          type="button"
          :aria-label="`移除图片 ${entry.file.name}`"
          class="absolute top-1 right-1 rounded-full bg-black/70 p-1 text-white hover:bg-black"
          @click="emit('removeImage', entry.key)"
        >
          <X class="size-3.5" />
        </button>
        <div class="min-w-0 px-1.5 py-1 text-[10px] leading-4">
          <p class="truncate" :title="entry.file.name">{{ entry.file.name }}</p>
          <p v-if="entry.status === 'uploading'" class="flex items-center gap-1 text-ink-3">
            <LoaderCircle class="size-3 animate-spin" />上传中
          </p>
          <template v-else-if="entry.status === 'error'">
            <p class="break-words text-st-error" role="alert">{{ entry.error }}</p>
            <button
              type="button"
              :aria-label="`重试上传 ${entry.file.name}`"
              class="flex items-center gap-1 font-medium text-primary-ink hover:underline"
              @click="emit('retryImage', entry.key)"
            >
              <RefreshCw class="size-3" />重试
            </button>
          </template>
          <p v-else class="text-ink-3">已上传</p>
        </div>
      </div>
    </div>
    <p v-if="feedback" role="alert" class="px-4 pt-2 text-xs break-words text-st-error">
      {{ feedback }}
    </p>
    <div class="flex items-center gap-2 pr-2 pb-2 pl-2">
      <input
        ref="imageInput"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        class="sr-only"
        aria-label="选择图片"
        tabindex="-1"
        @change="filesSelected"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="添加图片"
        title="添加图片"
        class="text-ink-3"
        @click="imageInput?.click()"
      >
        <ImagePlus />
      </Button>
      <Button
        v-if="members.length"
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="提及成员"
        title="提及成员"
        class="text-ink-3"
        @mousedown.prevent
        @click="startMention"
      >
        <AtSign />
      </Button>
      <span class="pl-1.5 text-[11px] text-ink-3">
        <span class="max-sm:hidden"
          >Enter 发送 · Shift + Enter 换行<template v-if="members.length">
            · 消息对全体成员可见</template
          ><br
        /></span>
        PNG/JPEG/WebP/GIF · ≤10 MB/张 · 最多 4 张
      </span>
      <Button
        type="submit"
        size="icon-sm"
        class="ml-auto"
        :disabled="
          sending ||
          (!model.trim() && !images.length) ||
          images.some((entry) => entry.status !== 'ready')
        "
        aria-label="发送消息"
        title="发送消息"
      >
        <LoaderCircle v-if="sending" class="animate-spin" /><ArrowUp v-else />
      </Button>
    </div>
  </form>
</template>
