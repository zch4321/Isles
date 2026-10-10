<script setup lang="ts">
import type { Agent } from '@isles/contracts';
import ParticipantAvatar from './ParticipantAvatar.vue';
import { useHarnesses } from '@/api/queries';

defineProps<{ agents: Agent[] }>();
const selected = defineModel<string[]>({ required: true });
const harnesses = useHarnesses();
const harnessName = (id: string) =>
  harnesses.data.value?.harnesses.find((harness) => harness.id === id)?.displayName ?? id;
</script>

<template>
  <ul class="grid max-h-[330px] gap-0.5 overflow-y-auto rounded-md border border-line p-1">
    <li v-for="agent in agents" :key="agent.id">
      <label
        class="flex cursor-pointer items-center gap-3 rounded-sm px-2 py-[7px] transition-colors hover:bg-surface-hover"
      >
        <input
          v-model="selected"
          type="checkbox"
          :value="agent.id"
          class="size-[15px] shrink-0 accent-primary"
        />
        <ParticipantAvatar :name="agent.name" :identity="agent.id" size="sm" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[13px] font-medium">{{ agent.name }}</span>
          <span class="block truncate text-xs text-ink-3"
            >{{ harnessName(agent.harness) }} · {{ agent.model }}</span
          >
        </span>
      </label>
    </li>
  </ul>
</template>
