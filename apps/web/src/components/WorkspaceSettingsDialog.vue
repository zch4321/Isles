<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { LoaderCircle, Save } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { saveWorkspaceSettings } from '@/api/isles';
import { invalidateAll, useWorkspaceSettings } from '@/api/queries';
import WorkspacePathEditor from './WorkspacePathEditor.vue';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const open = defineModel<boolean>('open', { required: true });
const queryClient = useQueryClient();
const settings = useWorkspaceSettings();
const paths = ref<string[]>([]);
const initialPaths = ref<string[]>([]);
const initialized = ref(false);
const loading = ref(false);
const loadError = ref('');
let loadVersion = 0;
const changed = computed(() => JSON.stringify(paths.value) !== JSON.stringify(initialPaths.value));
const save = useMutation({
  mutationFn: () => saveWorkspaceSettings(paths.value),
  onSuccess: async (value) => {
    queryClient.setQueryData(['workspaces'], value);
    await invalidateAll(queryClient);
    open.value = false;
  },
});
async function loadSettings() {
  const version = ++loadVersion;
  initialized.value = false;
  loading.value = true;
  loadError.value = '';
  const result = await settings.refetch();
  if (!open.value || version !== loadVersion) return;
  loading.value = false;
  if (result.isSuccess) {
    paths.value = [...result.data.workspacePaths];
    initialPaths.value = [...result.data.workspacePaths];
    initialized.value = true;
  } else {
    loadError.value = result.error?.message ?? '工作目录加载失败，请重新加载。';
  }
}
watch(open, (value) => {
  if (value) {
    save.reset();
    void loadSettings();
  } else {
    loadVersion++;
    initialized.value = false;
    loading.value = false;
  }
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>共享工作目录</DialogTitle>
        <DialogDescription>
          新建 Agent 自动获得全局目录。新增目录会追加到现有 Agent；移除目录后，Agent
          保留各自列表，可在编辑 Agent 中移除。当前原生活动结束后应用修改。
        </DialogDescription>
      </DialogHeader>
      <p v-if="loading" class="flex items-center gap-2 text-xs text-ink-3">
        <LoaderCircle class="size-4 animate-spin" />正在加载工作目录…
      </p>
      <form
        v-if="initialized && settings.data.value"
        class="grid gap-4"
        @submit.prevent="save.mutate()"
      >
        <div class="grid gap-1 rounded-md border border-line bg-surface-2 p-3 text-xs">
          <p class="font-medium">内置共享目录 · 所有 Agent 共用</p>
          <code class="leading-5 break-all">{{ settings.data.value.defaultSharedDir }}</code>
        </div>
        <WorkspacePathEditor
          id="global-workspaces"
          v-model="paths"
          label="全局目录"
          :disabled="save.isPending.value"
        />
        <p class="text-xs leading-relaxed break-all text-muted-foreground">
          配置文件：{{ settings.data.value.configFilePath }}
        </p>
        <p v-if="save.error.value" role="alert" class="notice notice-error break-words">
          {{ save.error.value.message }}
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            :disabled="save.isPending.value"
            @click="open = false"
            >取消</Button
          >
          <Button type="submit" :disabled="save.isPending.value || !changed || !initialized">
            <LoaderCircle v-if="save.isPending.value" class="animate-spin" /><Save v-else />保存目录
          </Button>
        </DialogFooter>
      </form>
      <div v-if="loadError" class="grid gap-2">
        <p role="alert" class="notice notice-error">{{ loadError }}</p>
        <Button type="button" variant="outline" @click="loadSettings">重新加载</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
