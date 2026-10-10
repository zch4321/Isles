<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '@/lib/markdown';
import '@/markdown.css';

const props = defineProps<{ source: string }>();
const html = computed(() => renderMarkdown(props.source));

async function onClick(event: MouseEvent) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]');
  const code = button?.closest('.md-code')?.querySelector('code')?.textContent;
  if (!button || code == null) return;
  try {
    await navigator.clipboard.writeText(code);
    button.textContent = '已复制';
  } catch {
    button.textContent = '复制失败';
  }
  setTimeout(() => {
    button.textContent = '复制';
  }, 1500);
}
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- markdown-it escapes raw HTML and validates link protocols. -->
  <div class="markdown" @click="onClick" v-html="html" />
</template>
