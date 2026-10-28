<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';
import { useAgents, useChannels, useDirectory } from '@/api/queries';
import AppSidebar from '@/components/AppSidebar.vue';
import BulkDeleteDialog from '@/components/BulkDeleteDialog.vue';
import ConversationView from '@/components/ConversationView.vue';
import CreateAgentDialog from '@/components/CreateAgentDialog.vue';
import GroupDialog from '@/components/GroupDialog.vue';
import InspectorPanel from '@/components/InspectorPanel.vue';
import WelcomeView from '@/components/WelcomeView.vue';
import WorkspaceSettingsDialog from '@/components/WorkspaceSettingsDialog.vue';
import { useEventStream } from '@/composables/useEventStream';
import { byActivity, channelTitle } from '@/lib/channels';
import { cn, readStorage, writeStorage } from '@/lib/utils';

const selected = ref(readStorage('isles.channel') ?? '');
// Narrow screens show one pane at a time.
const pane = ref<'list' | 'chat'>(selected.value ? 'chat' : 'list');
const inspectorOpen = ref(false);
const workspaceSettingsOpen = ref(false);
const creating = ref<'agent' | 'group'>();
const bulkDeleting = ref<'agent' | 'group'>();
const bulkDeleteOpen = computed({
  get: () => Boolean(bulkDeleting.value),
  set: (value: boolean) => {
    if (!value) bulkDeleting.value = undefined;
  },
});

const agents = useAgents();
const channels = useChannels();
const directory = useDirectory();
// Start from the older snapshot so no event between the two is missed.
useEventStream(() => {
  const a = agents.data.value?.cursor;
  const c = channels.data.value?.cursor;
  return a === undefined || c === undefined ? undefined : Math.min(a, c);
});

const current = computed(() => channels.data.value?.channels.find((c) => c.id === selected.value));
watch(channels.data, (data) => {
  if (data && !current.value) selected.value = data.channels.toSorted(byActivity)[0]?.id ?? '';
});
watch(selected, (id) => {
  writeStorage('isles.channel', id);
  if (!id) back();
});
watchEffect(() => {
  const name = current.value && channelTitle(current.value, directory.value);
  document.title = name ? `${name} · Isles` : 'Isles · 群岛';
});

function choose(id: string) {
  selected.value = id;
  pane.value = 'chat';
}
function back() {
  pane.value = 'list';
  inspectorOpen.value = false;
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && inspectorOpen.value && !creating.value && !bulkDeleting.value)
    inspectorOpen.value = false;
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const dialogOpen = (kind: 'agent' | 'group') =>
  computed({
    get: () => creating.value === kind,
    set: (value: boolean) => {
      creating.value = value ? kind : undefined;
    },
  });
const agentDialog = dialogOpen('agent');
const groupDialog = dialogOpen('group');
</script>

<template>
  <div class="flex h-dvh overflow-hidden bg-bg text-sm text-ink">
    <AppSidebar
      :class="cn('w-full shrink-0 md:w-[280px]', pane === 'chat' && 'max-md:hidden')"
      :selected-id="selected"
      @select="choose"
      @create="creating = $event"
      @bulk-delete="bulkDeleting = $event"
      @workspaces="workspaceSettingsOpen = true"
    />
    <main :class="cn('min-h-0 min-w-0 flex-1', pane === 'list' && 'max-md:hidden')">
      <ConversationView
        v-if="current"
        :key="current.id"
        :channel-id="current.id"
        :inspector-open="inspectorOpen"
        @back="back"
        @toggle-inspector="inspectorOpen = !inspectorOpen"
        @open-inspector="inspectorOpen = true"
      />
      <div
        v-else-if="channels.isPending.value"
        class="flex h-full items-center justify-center text-muted-foreground"
      >
        <LoaderCircle class="size-5 animate-spin" />
      </div>
      <WelcomeView v-else @create="creating = 'agent'" />
    </main>
    <InspectorPanel
      v-if="inspectorOpen && current"
      :key="current.id"
      :channel="current"
      @close="inspectorOpen = false"
    />
    <CreateAgentDialog v-model:open="agentDialog" @created="choose" />
    <GroupDialog v-model:open="groupDialog" @done="choose" />
    <BulkDeleteDialog v-model:open="bulkDeleteOpen" :kind="bulkDeleting ?? 'agent'" />
    <WorkspaceSettingsDialog v-model:open="workspaceSettingsOpen" />
  </div>
</template>
