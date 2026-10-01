<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { LoaderCircle, Plus, RefreshCw } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { createAgent, fetchCodex, fetchModels } from '@/api/isles';
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
import { cn } from '@/lib/utils';

const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ created: [channelId: string] }>();

const queryClient = useQueryClient();
const codex = useQuery({ queryKey: ['codex'], queryFn: fetchCodex, enabled: open });
const models = useQuery({ queryKey: ['models'], queryFn: fetchModels, enabled: open });

const form = ref({ name: '', model: '', reasoningEffort: '', canCreateGroups: false });
const current = computed(() =>
  models.data.value?.models.find((model) => model.model === form.value.model),
);
// Models and efforts come from the native catalog; start from its default.
watch(
  models.data,
  (value) => {
    if (form.value.model || !value) return;
    const model = value.models.find((m) => m.isDefault) ?? value.models[0];
    if (model)
      form.value = {
        ...form.value,
        model: model.model,
        reasoningEffort: model.defaultReasoningEffort,
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

const checking = computed(() => codex.isFetching.value || models.isFetching.value);
const ready = computed(() => Boolean(codex.data.value?.authenticated));
const statusText = computed(() => {
  if (checking.value && !codex.data.value) return '正在检测本机 Codex…';
  if (ready.value) return `Codex ${codex.data.value?.version ?? ''} 已就绪`;
  return 'Codex 尚未就绪';
});
function recheck() {
  void codex.refetch();
  void models.refetch();
}

const create = useMutation({
  mutationFn: createAgent,
  onSuccess: async (created) => {
    // The new private chat must be listed before it can be selected.
    await invalidateAll(queryClient);
    emit('created', created.channelId);
    open.value = false;
    form.value.name = '';
    form.value.canCreateGroups = false;
  },
});
watch(open, (value) => {
  if (value) create.reset();
});
const problem = computed(
  () =>
    codex.data.value?.error ||
    codex.error.value?.message ||
    models.error.value?.message ||
    create.error.value?.message,
);

function focusName(event: Event) {
  event.preventDefault();
  document.getElementById('agent-name')?.focus();
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md" @open-auto-focus="focusName">
      <DialogHeader>
        <DialogTitle>新建 Codex Agent</DialogTitle>
        <DialogDescription>
          每个 Agent 都有固定的原生会话和独立的工作目录。即使配置相同，不同 Agent
          之间也不共享上下文。
        </DialogDescription>
      </DialogHeader>

      <div
        class="flex items-center gap-2 rounded-md border bg-muted/50 py-1.5 pr-1.5 pl-3 text-[13px]"
      >
        <LoaderCircle
          v-if="checking && !codex.data.value"
          class="size-3.5 animate-spin text-muted-foreground"
        />
        <span v-else :class="cn('size-2 rounded-full', ready ? 'bg-success' : 'bg-destructive')" />
        <span class="min-w-0 flex-1 truncate">{{ statusText }}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="重新检测 Codex"
          title="重新检测"
          :disabled="checking"
          @click="recheck"
        >
          <RefreshCw :class="checking && 'animate-spin'" />
        </Button>
      </div>
      <p
        v-if="problem"
        role="alert"
        class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] break-words text-destructive"
      >
        {{ problem }}
      </p>

      <form class="grid gap-4" @submit.prevent="create.mutate(form)">
        <div class="grid gap-2">
          <Label for="agent-name">名称</Label>
          <Input
            id="agent-name"
            v-model="form.name"
            required
            maxlength="80"
            autocomplete="off"
            placeholder="例如 codex-astra-1"
          />
        </div>
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
        <p v-if="current?.description" class="-mt-1 text-xs leading-relaxed text-muted-foreground">
          {{ current.description }}
        </p>
        <div class="flex items-start gap-3 rounded-md border px-3 py-2.5">
          <div class="min-w-0 flex-1">
            <p id="agent-groups" class="text-[13px] font-medium">允许拉群</p>
            <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              可以创建群聊并邀请已有 Agent。之后可以在 Agent 详情中修改。
            </p>
          </div>
          <Switch v-model="form.canCreateGroups" aria-labelledby="agent-groups" />
        </div>
        <DialogFooter class="pt-1">
          <Button type="button" variant="outline" @click="open = false">取消</Button>
          <Button
            type="submit"
            :disabled="create.isPending.value || !ready || !form.model || !form.reasoningEffort"
          >
            <LoaderCircle v-if="create.isPending.value" class="animate-spin" /><Plus v-else />创建
            Agent
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
