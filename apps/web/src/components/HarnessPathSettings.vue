<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { LoaderCircle, Settings2 } from '@lucide/vue';
import { ref, watch } from 'vue';
import { fetchHarnessConfiguration, saveHarnessConfiguration } from '@/api/isles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const props = defineProps<{
  harness: 'codex' | 'claude';
  name: string;
  failed: boolean;
  binaryPath: string | null;
}>();
const queryClient = useQueryClient();
const expanded = ref(false);
const path = ref('');
const configuration = useQuery({
  queryKey: ['harness-configuration', props.harness],
  queryFn: () => fetchHarnessConfiguration(props.harness),
});
watch(configuration.data, (value) => {
  if (value) path.value = value.binaryPath ?? '';
});
watch(
  () => props.failed,
  (failed) => {
    if (failed) expanded.value = true;
  },
  { immediate: true },
);
const save = useMutation({
  mutationFn: () => saveHarnessConfiguration(props.harness, path.value.trim() || null),
  onSuccess: async (value) => {
    queryClient.setQueryData(['harness-configuration', props.harness], value);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['harness-status', props.harness] }),
      queryClient.invalidateQueries({ queryKey: ['models', props.harness] }),
    ]);
  },
});
</script>

<template>
  <div class="grid gap-2">
    <Button
      type="button"
      variant="ghost"
      size="sm"
      class="justify-self-start"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <Settings2 />{{ name }} 路径设置
    </Button>
    <div v-if="expanded" class="grid gap-3 rounded-md border bg-muted/30 p-3">
      <div class="grid gap-2">
        <Label :for="`${harness}-binary-path`">{{ name }} 可执行文件路径</Label>
        <Input
          :id="`${harness}-binary-path`"
          v-model="path"
          autocomplete="off"
          placeholder="留空自动发现，或填写完整路径"
          :disabled="configuration.isPending.value || save.isPending.value"
        />
        <p class="text-xs leading-relaxed text-muted-foreground">
          此设置供本机所有 {{ name }} Agent 使用，保存后重新检测。留空恢复自动发现。
        </p>
        <p
          v-if="configuration.data.value"
          class="text-xs leading-relaxed break-all text-muted-foreground"
        >
          配置文件：{{ configuration.data.value.configFilePath }}。保存会重新生成
          TOML，保留其他配置值；文件中的其他修改重启后生效。
        </p>
      </div>
      <p v-if="binaryPath" class="text-xs leading-relaxed break-all text-muted-foreground">
        当前使用：{{ binaryPath }}
      </p>
      <p
        v-if="configuration.data.value?.environmentBinaryPath"
        class="text-xs leading-relaxed break-all text-muted-foreground"
      >
        启动环境已指定路径，优先于此处保存的设置：{{
          configuration.data.value.environmentBinaryPath
        }}
      </p>
      <p
        v-if="save.error.value || configuration.error.value"
        role="alert"
        class="text-xs text-destructive"
      >
        {{ save.error.value?.message || configuration.error.value?.message }}
      </p>
      <div class="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          :disabled="save.isPending.value || configuration.isPending.value"
          @click="save.mutate()"
        >
          <LoaderCircle v-if="save.isPending.value" class="animate-spin" />保存并检测
        </Button>
        <span v-if="save.isSuccess.value" role="status" class="text-xs text-muted-foreground"
          >路径设置已保存</span
        >
      </div>
    </div>
  </div>
</template>
