<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { LoaderCircle, Plus, RefreshCw } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { createAgents, fetchHarnesses, fetchHarnessStatus, fetchModels } from '@/api/isles';
import { invalidateAll } from '@/api/queries';
import HarnessPathSettings from '@/components/HarnessPathSettings.vue';
import ExecutionAccessSetting from './ExecutionAccessSetting.vue';
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
import { cn } from '@/lib/utils';

const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ created: [channelId: string] }>();

const queryClient = useQueryClient();
const harnesses = useQuery({ queryKey: ['harnesses'], queryFn: fetchHarnesses, enabled: open });
const form = ref({
  harness: '',
  name: '',
  model: '',
  reasoningEffort: '',
  canCreateGroups: false,
  steerEnabled: false,
  dangerFullAccess: false,
});
const quantity = ref('1');
const count = computed(() => Number(quantity.value));
const validCount = computed(
  () => Number.isInteger(count.value) && count.value >= 1 && count.value <= 50,
);
const selectedHarness = computed(() =>
  harnesses.data.value?.harnesses.find((harness) => harness.id === form.value.harness),
);
const harnessName = computed(() => selectedHarness.value?.displayName ?? 'Harness');
const supportsSteer = computed(() => Boolean(selectedHarness.value?.capabilities.steer));
watch(supportsSteer, (supported) => {
  if (!supported) form.value.steerEnabled = false;
});
const queryEnabled = computed(() => open.value && Boolean(selectedHarness.value));
const status = useQuery({
  queryKey: computed(() => ['harness-status', form.value.harness]),
  queryFn: () => fetchHarnessStatus(form.value.harness),
  enabled: queryEnabled,
});
const models = useQuery({
  queryKey: computed(() => ['models', form.value.harness]),
  queryFn: () => fetchModels(form.value.harness),
  enabled: queryEnabled,
});
watch(
  harnesses.data,
  (value) => {
    if (!value || value.harnesses.some((harness) => harness.id === form.value.harness)) return;
    form.value.harness = value.harnesses[0]?.id ?? '';
  },
  { immediate: true },
);
watch(
  () => form.value.harness,
  () => {
    form.value.model = '';
    form.value.reasoningEffort = '';
  },
);
const current = computed(() =>
  models.data.value?.models.find((model) => model.model === form.value.model),
);
// Models and efforts come from the native catalog; start from its default.
watch(
  models.data,
  (value) => {
    if (!value || value.models.some((model) => model.model === form.value.model)) return;
    const model = value.models.find((m) => m.isDefault) ?? value.models[0];
    form.value = {
      ...form.value,
      model: model?.model ?? '',
      reasoningEffort: model?.defaultReasoningEffort ?? '',
    };
  },
  { immediate: true },
);
watch(
  () => form.value.model,
  () => {
    form.value.reasoningEffort = current.value?.defaultReasoningEffort ?? '';
  },
);

const checking = computed(
  () => harnesses.isFetching.value || status.isFetching.value || models.isFetching.value,
);
const ready = computed(() => Boolean(selectedHarness.value && status.data.value?.authenticated));
const statusText = computed(() => {
  if (checking.value && !status.data.value) return `正在检测本机 ${harnessName.value}…`;
  if (ready.value) return `${harnessName.value} ${status.data.value?.version ?? ''} 已就绪`;
  return `${harnessName.value} 尚未就绪`;
});
async function recheck() {
  try {
    await queryClient.invalidateQueries({
      queryKey: ['harness-status', form.value.harness],
      refetchType: 'none',
    });
    await queryClient.fetchQuery({
      queryKey: ['harness-status', form.value.harness],
      queryFn: () => fetchHarnessStatus(form.value.harness, true),
    });
    await models.refetch();
  } catch {
    /* The query error is shown below. */
  }
}

const create = useMutation({
  mutationFn: createAgents,
  onSuccess: async ({ agents: created }) => {
    // The new private chat must be listed before it can be selected.
    await invalidateAll(queryClient);
    emit('created', created[0]!.channelId);
    open.value = false;
    form.value.name = '';
    form.value.canCreateGroups = false;
    form.value.steerEnabled = false;
    form.value.dangerFullAccess = false;
    quantity.value = '1';
  },
});
watch(open, (value) => {
  if (value) {
    create.reset();
    quantity.value = '1';
  }
});
const problem = computed(
  () =>
    harnesses.error.value?.message ||
    status.data.value?.error ||
    status.error.value?.message ||
    models.error.value?.message ||
    create.error.value?.message,
);

function focusName(event: Event) {
  event.preventDefault();
  document.getElementById('agent-name')?.focus();
}
function submit() {
  if (!validCount.value || create.isPending.value) return;
  create.mutate({ ...form.value, count: count.value });
}
function updateOpen(value: boolean) {
  if (!create.isPending.value) open.value = value;
}
function preventBusyClose(event: Event) {
  if (create.isPending.value) event.preventDefault();
}
</script>

<template>
  <Dialog :open="open" @update:open="updateOpen">
    <DialogContent
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
      :class="create.isPending.value && '[&>button]:hidden'"
      @open-auto-focus="focusName"
      @escape-key-down="preventBusyClose"
      @interact-outside="preventBusyClose"
    >
      <DialogHeader>
        <DialogTitle>新建 Agent</DialogTitle>
        <DialogDescription>
          每个 Agent 都有固定的原生会话、独立的上下文和工作目录。
        </DialogDescription>
      </DialogHeader>

      <div
        class="flex items-center gap-2 rounded-md border border-line bg-surface-2 py-1.5 pr-1.5 pl-3 text-[13px]"
      >
        <LoaderCircle
          v-if="checking && !status.data.value"
          class="size-3.5 animate-spin text-ink-3"
        />
        <span v-else :class="cn('size-2 rounded-full', ready ? 'bg-st-idle' : 'bg-st-error')" />
        <span class="min-w-0 flex-1 truncate">{{ statusText }}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          :aria-label="`重新检测 ${harnessName}`"
          title="重新检测"
          :disabled="checking || !selectedHarness"
          @click="recheck"
        >
          <RefreshCw :class="checking && 'animate-spin'" />
        </Button>
      </div>
      <p v-if="problem" role="alert" class="notice notice-error break-words">
        {{ problem }}
      </p>

      <HarnessPathSettings
        v-if="selectedHarness?.configuration"
        :key="form.harness"
        :harness="selectedHarness.id"
        :name="harnessName"
        :failed="Boolean(status.data.value && !status.data.value.available)"
        :binary-path="status.data.value?.binaryPath ?? null"
      />

      <form @submit.prevent="submit">
        <fieldset class="grid gap-4" :disabled="create.isPending.value">
          <div v-if="(harnesses.data.value?.harnesses.length ?? 0) > 1" class="grid gap-2">
            <Label for="agent-harness">Harness</Label>
            <NativeSelect id="agent-harness" v-model="form.harness" required>
              <option
                v-for="harness in harnesses.data.value?.harnesses"
                :key="harness.id"
                :value="harness.id"
              >
                {{ harness.displayName }}
              </option>
            </NativeSelect>
          </div>
          <div class="grid grid-cols-[minmax(0,1fr)_6rem] gap-4">
            <div class="grid gap-2">
              <Label for="agent-name">名称</Label>
              <Input
                id="agent-name"
                v-model="form.name"
                required
                maxlength="80"
                autocomplete="off"
                aria-describedby="agent-naming"
                :placeholder="`例如 ${form.harness || 'agent'}`"
              />
            </div>
            <div class="grid gap-2">
              <Label for="agent-count">创建数量</Label>
              <Input
                id="agent-count"
                v-model="quantity"
                type="number"
                min="1"
                max="50"
                step="1"
                required
                inputmode="numeric"
              />
            </div>
          </div>
          <p id="agent-naming" class="-mt-1 text-xs leading-relaxed text-muted-foreground">
            名称作为前缀，自动添加 -1、-2 等编号。已有同名前缀时接着编号。
          </p>
          <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8.5rem]">
            <div class="grid gap-2">
              <Label for="agent-model">模型</Label>
              <NativeSelect
                id="agent-model"
                v-model="form.model"
                required
                :disabled="!models.data.value"
              >
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
              <Label for="agent-effort">推理等级</Label>
              <NativeSelect
                id="agent-effort"
                v-model="form.reasoningEffort"
                required
                :disabled="!current"
              >
                <option
                  v-for="effort in current?.supportedReasoningEfforts"
                  :key="effort"
                  :value="effort"
                >
                  {{ effort }}
                </option>
              </NativeSelect>
            </div>
          </div>
          <p
            v-if="current?.description"
            class="-mt-1 text-xs leading-relaxed text-muted-foreground"
          >
            {{ current.description }}
          </p>
          <ExecutionAccessSetting
            id="agent-full-access"
            v-model="form.dangerFullAccess"
            class="rounded-md border px-3 py-2.5"
            :disabled="create.isPending.value"
          />
          <div class="flex items-start gap-3 rounded-md border px-3 py-2.5">
            <div class="min-w-0 flex-1">
              <p id="agent-groups" class="text-[13px] font-medium">允许拉群</p>
              <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                可以创建群聊并邀请已有 Agent。之后可以在 Agent 详情中修改。
              </p>
            </div>
            <Switch v-model="form.canCreateGroups" aria-labelledby="agent-groups" />
          </div>
          <div class="flex items-start gap-3 rounded-md border px-3 py-2.5">
            <div class="min-w-0 flex-1">
              <p id="agent-steer" class="text-[13px] font-medium">忙碌时实时接收（steer）</p>
              <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                开启时，新消息追加到当前执行；关闭时，新消息排队。
              </p>
              <p v-if="!supportsSteer" class="mt-0.5 text-xs text-muted-foreground">
                实时接收需要 harness 的 steer 支持。
              </p>
            </div>
            <Switch
              v-model="form.steerEnabled"
              aria-labelledby="agent-steer"
              :disabled="!supportsSteer || create.isPending.value"
            />
          </div>
          <DialogFooter class="pt-1">
            <Button
              type="button"
              variant="outline"
              :disabled="create.isPending.value"
              @click="open = false"
              >取消</Button
            >
            <Button
              type="submit"
              :disabled="
                create.isPending.value ||
                !ready ||
                !form.model ||
                !form.reasoningEffort ||
                !validCount ||
                !form.name.trim()
              "
            >
              <LoaderCircle v-if="create.isPending.value" class="animate-spin" /><Plus v-else />{{
                create.isPending.value
                  ? '正在创建…'
                  : !validCount || count === 1
                    ? '创建 Agent'
                    : `创建 ${count} 个 Agent`
              }}
            </Button>
          </DialogFooter>
        </fieldset>
      </form>
    </DialogContent>
  </Dialog>
</template>
