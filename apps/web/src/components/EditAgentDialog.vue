<script setup lang="ts">
import type { Agent, UpdateAgent } from '@isles/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { LoaderCircle, Save } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { fetchModels, updateAgent } from '@/api/isles';
import { invalidateAll, useHarnessCapability } from '@/api/queries';
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
import ExecutionAccessSetting from './ExecutionAccessSetting.vue';
import WorkspacePathEditor from './WorkspacePathEditor.vue';

const props = defineProps<{ agent: Agent }>();
const open = defineModel<boolean>('open', { required: true });
const queryClient = useQueryClient();
const supportsSteer = useHarnessCapability(() => props.agent.harness, 'steer');
const models = useQuery({
  queryKey: computed(() => ['models', props.agent.harness]),
  queryFn: () => fetchModels(props.agent.harness),
  enabled: open,
});
const form = ref({
  name: '',
  model: '',
  reasoningEffort: '',
  canCreateGroups: false,
  steerEnabled: false,
  dangerFullAccess: false,
  workspacePaths: [] as string[],
});
const validationError = ref('');
const initialWorkspacePaths = ref<string[]>([]);
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
  if (form.value.steerEnabled !== props.agent.steerEnabled)
    result.steerEnabled = form.value.steerEnabled;
  if (form.value.dangerFullAccess !== props.agent.dangerFullAccess)
    result.dangerFullAccess = form.value.dangerFullAccess;
  if (JSON.stringify(form.value.workspacePaths) !== JSON.stringify(initialWorkspacePaths.value))
    result.workspacePaths = form.value.workspacePaths;
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
      steerEnabled: props.agent.steerEnabled,
      dangerFullAccess: props.agent.dangerFullAccess,
      workspacePaths: [...props.agent.workspacePaths],
    };
    initialWorkspacePaths.value = [...props.agent.workspacePaths];
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
  if (changes.value.steerEnabled && !supportsSteer.value) {
    validationError.value = '请选择排队收信，当前 harness 采用该方式接收消息。';
    return;
  }
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
          模型和推理等级在下一次执行时生效，继续使用原有会话和工作目录。
        </DialogDescription>
      </DialogHeader>
      <p
        v-if="validationError || save.error.value"
        role="alert"
        class="notice notice-error break-words"
      >
        {{ validationError || save.error.value?.message }}
      </p>
      <p v-if="models.error.value" class="text-xs leading-relaxed text-muted-foreground">
        模型列表加载失败，可以继续修改名称、协作权限和收信设置。
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
        <ExecutionAccessSetting
          id="edit-agent-full-access"
          v-model="form.dangerFullAccess"
          class="rounded-md border px-3 py-2.5"
          :disabled="save.isPending.value"
        />
        <WorkspacePathEditor
          id="edit-agent-workspaces"
          v-model="form.workspacePaths"
          label="额外工作目录"
          :disabled="save.isPending.value"
        />
        <p class="-mt-2 text-xs leading-relaxed text-muted-foreground">
          这里是此 Agent 的完整额外目录列表，可直接增删。当前原生活动结束后应用修改。
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
        <div class="flex items-start gap-3 rounded-md border px-3 py-2.5">
          <div class="min-w-0 flex-1">
            <p id="edit-agent-steer" class="text-[13px] font-medium">忙碌时实时接收（steer）</p>
            <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              开启时，新消息追加到当前执行；关闭时，新消息排队。修改立即生效。
            </p>
            <p v-if="!supportsSteer" class="mt-0.5 text-xs text-muted-foreground">
              实时接收需要 harness 的 steer 支持，当前设置可关闭。
            </p>
          </div>
          <Switch
            v-model="form.steerEnabled"
            aria-labelledby="edit-agent-steer"
            :disabled="save.isPending.value || (!supportsSteer && !form.steerEnabled)"
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
