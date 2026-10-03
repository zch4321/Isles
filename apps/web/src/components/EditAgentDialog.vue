<script setup lang="ts">
import type { Agent, UpdateAgent } from '@isles/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { LoaderCircle, Save } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { fetchModels, updateAgent } from '@/api/isles';
import { invalidateAll } from '@/api/queries';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';

const props = defineProps<{ agent: Agent }>();
const open = defineModel<boolean>('open', { required: true });
const queryClient = useQueryClient();
const models = useQuery({ queryKey: ['models'], queryFn: fetchModels, enabled: open });
const form = ref({ name: '', model: '', reasoningEffort: '', canCreateGroups: false });
const validationError = ref('');
const current = computed(() =>
  models.data.value?.models.find((model) => model.model === form.value.model),
);
const efforts = computed(() => {
  const supported = current.value?.supportedReasoningEfforts ?? [];
  return supported.includes(form.value.reasoningEffort)
    ? supported
    : [form.value.reasoningEffort, ...supported];
});
const changes = computed<UpdateAgent>(() => {
  const result: UpdateAgent = {};
  const name = form.value.name.trim();
  if (name !== props.agent.name) result.name = name;
  if (form.value.model !== props.agent.model) result.model = form.value.model;
  if (form.value.reasoningEffort !== props.agent.reasoningEffort)
    result.reasoningEffort = form.value.reasoningEffort;
  if (form.value.canCreateGroups !== props.agent.canCreateGroups)
    result.canCreateGroups = form.value.canCreateGroups;
  return result;
});
const hasChanges = computed(() => Object.keys(changes.value).length > 0);
const save = useMutation({
  mutationFn: (input: UpdateAgent) => updateAgent(props.agent.id, input),
  onSuccess: async () => {
    await invalidateAll(queryClient);
    open.value = false;
  },
});

watch(
  [open, () => props.agent.id],
  ([isOpen]) => {
    if (!isOpen) return;
    form.value = {
      name: props.agent.name,
      model: props.agent.model,
      reasoningEffort: props.agent.reasoningEffort,
      canCreateGroups: props.agent.canCreateGroups,
    };
    validationError.value = '';
    save.reset();
  },
  { immediate: true },
);

// Only an explicit model selection changes the effort; catalog loading preserves the draft.
function selectModel(model: string | undefined) {
  if (!model || model === form.value.model) return;
  form.value.model = model;
  const selected = current.value;
  if (selected) {
    form.value.reasoningEffort = selected.supportedReasoningEfforts.includes(
      form.value.reasoningEffort,
    )
      ? form.value.reasoningEffort
      : selected.defaultReasoningEffort;
  }
  validationError.value = '';
}

function submit() {
  validationError.value = '';
  if (!form.value.name.trim() || !hasChanges.value) return;
  if (changes.value.model !== undefined || changes.value.reasoningEffort !== undefined) {
    if (!current.value) {
      validationError.value = '请从可用模型列表中选择模型。';
      return;
    }
    if (!current.value.supportedReasoningEfforts.includes(form.value.reasoningEffort)) {
      validationError.value = '请选择该模型支持的推理等级。';
      return;
    }
  }
  save.mutate(changes.value);
}

function focusName(event: Event) {
  event.preventDefault();
  document.getElementById('edit-agent-name')?.focus();
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
      @open-auto-focus="focusName"
    >
      <DialogHeader>
        <DialogTitle>编辑 Agent</DialogTitle>
        <DialogDescription>
          修改模型和推理等级会在下一次执行时生效，会话和工作目录保持不变。
        </DialogDescription>
      </DialogHeader>
      <p
        v-if="validationError || save.error.value"
        role="alert"
        class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] break-words text-destructive"
      >
        {{ validationError || save.error.value?.message }}
      </p>
      <p v-if="models.error.value" class="text-xs leading-relaxed text-muted-foreground">
        暂时无法读取模型列表，仍可修改名称和协作权限。
      </p>
      <form class="grid gap-4" @submit.prevent="submit">
        <div class="grid gap-2">
          <Label for="edit-agent-name">名称</Label>
          <Input
            id="edit-agent-name"
            v-model="form.name"
            required
            maxlength="80"
            autocomplete="off"
            :disabled="save.isPending.value"
          />
        </div>
        <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8.5rem]">
          <div class="grid gap-2">
            <Label for="edit-agent-model">模型</Label>
            <NativeSelect
              id="edit-agent-model"
              :model-value="form.model"
              required
              :disabled="!models.data.value || save.isPending.value"
              @update:model-value="selectModel"
            >
              <option v-if="!current" :value="form.model">{{ form.model }}</option>
              <option
                v-for="model in models.data.value?.models"
                :key="model.id"
                :value="model.model"
              >
                {{ model.displayName }}
              </option>
            </NativeSelect>
          </div>
          <div class="grid gap-2">
            <Label for="edit-agent-effort">推理等级</Label>
            <NativeSelect
              id="edit-agent-effort"
              v-model="form.reasoningEffort"
              required
              :disabled="!current || save.isPending.value"
            >
              <option v-for="effort in efforts" :key="effort" :value="effort">
                {{ effort }}
              </option>
            </NativeSelect>
          </div>
        </div>
        <p v-if="current?.description" class="-mt-1 text-xs leading-relaxed text-muted-foreground">
          {{ current.description }}
        </p>
        <div class="flex items-start gap-3 rounded-md border px-3 py-2.5">
          <div class="min-w-0 flex-1">
            <p id="edit-agent-groups" class="text-[13px] font-medium">允许拉群</p>
            <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              可以创建群聊并邀请已有 Agent。
            </p>
          </div>
          <Switch
            v-model="form.canCreateGroups"
            aria-labelledby="edit-agent-groups"
            :disabled="save.isPending.value"
          />
        </div>
        <DialogFooter class="pt-1">
          <Button
            type="button"
            variant="outline"
            :disabled="save.isPending.value"
            @click="open = false"
          >
            取消
          </Button>
          <Button
            type="submit"
            :disabled="save.isPending.value || !form.name.trim() || !hasChanges"
          >
            <LoaderCircle v-if="save.isPending.value" class="animate-spin" /><Save v-else />保存修改
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
