<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query';
import { Check, CircleAlert, LoaderCircle, Search, Trash2 } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { deleteAgent, deleteGroup } from '@/api/isles';
import { invalidateAll, useAgents, useChannels } from '@/api/queries';
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

type Item = { id: string; name: string; detail: string };
type Result = Item & { status: 'pending' | 'deleting' | 'success' | 'error'; error?: string };

const props = defineProps<{ kind: 'agent' | 'group' }>();
const open = defineModel<boolean>('open', { required: true });
const queryClient = useQueryClient();
const agents = useAgents();
const channels = useChannels();
const stage = ref<'select' | 'confirm' | 'deleting' | 'result'>('select');
const search = ref('');
const selectedIds = ref(new Set<string>());
const snapshot = ref<Item[]>([]);
const results = ref<Result[]>([]);
const completed = ref(0);
const batchTotal = ref(0);
const refreshError = ref('');
const busy = computed(() => stage.value === 'deleting');
const label = computed(() => (props.kind === 'agent' ? 'Agents' : '群聊'));
const options = computed<Item[]>(() =>
  props.kind === 'agent'
    ? (agents.data.value?.agents ?? [])
        .filter((agent) => agent.status !== 'deleted')
        .map((agent) => ({ id: agent.id, name: agent.name, detail: agent.model }))
    : (channels.data.value?.channels ?? [])
        .filter((channel) => channel.kind === 'group' && !channel.deletedAt)
        .map((channel) => ({
          id: channel.id,
          name: channel.name ?? '群聊',
          detail: `${channel.memberIds.length} 位成员`,
        })),
);
const visible = computed(() => {
  const query = search.value.trim().toLowerCase();
  return options.value.filter((item) =>
    `${item.name} ${item.detail} ${item.id}`.toLowerCase().includes(query),
  );
});
const loading = computed(() =>
  props.kind === 'agent' ? agents.isPending.value : channels.isPending.value,
);
const loadError = computed(() =>
  props.kind === 'agent' ? agents.error.value : channels.error.value,
);
const allVisibleSelected = computed(
  () => visible.value.length > 0 && visible.value.every((item) => selectedIds.value.has(item.id)),
);
const succeeded = computed(() => results.value.filter((item) => item.status === 'success').length);
const failed = computed(() => results.value.filter((item) => item.status === 'error'));

watch(open, (value) => {
  if (!value) return;
  stage.value = 'select';
  search.value = '';
  selectedIds.value = new Set();
  snapshot.value = [];
  results.value = [];
  completed.value = 0;
  batchTotal.value = 0;
  refreshError.value = '';
});
watch([options, stage], ([items, currentStage]) => {
  if (currentStage !== 'select') return;
  const available = new Set(items.map((item) => item.id));
  selectedIds.value = new Set([...selectedIds.value].filter((id) => available.has(id)));
});

function toggle(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}
function selectVisible() {
  selectedIds.value = new Set([...selectedIds.value, ...visible.value.map((item) => item.id)]);
}
function preview() {
  snapshot.value = options.value
    .filter((item) => selectedIds.value.has(item.id))
    .map((item) => ({ ...item }));
  if (snapshot.value.length) stage.value = 'confirm';
}
function updateOpen(value: boolean) {
  if (!busy.value) open.value = value;
}
function preventBusyClose(event: Event) {
  if (busy.value) event.preventDefault();
}
async function execute(retry = false) {
  if (busy.value || (retry ? stage.value !== 'result' : stage.value !== 'confirm')) return;
  if (!retry) results.value = snapshot.value.map((item) => ({ ...item, status: 'pending' }));
  const batch = results.value.filter((item) => item.status === (retry ? 'error' : 'pending'));
  if (!batch.length) return;
  const remove = props.kind === 'agent' ? deleteAgent : deleteGroup;
  stage.value = 'deleting';
  completed.value = 0;
  batchTotal.value = batch.length;
  refreshError.value = '';
  for (const item of batch) {
    item.status = 'pending';
    delete item.error;
  }
  for (const item of batch) {
    item.status = 'deleting';
    try {
      await remove(item.id);
      item.status = 'success';
    } catch (error) {
      item.status = 'error';
      item.error = error instanceof Error ? error.message : '删除失败，请重试';
    }
    completed.value += 1;
  }
  try {
    await invalidateAll(queryClient);
  } catch (error) {
    refreshError.value = error instanceof Error ? error.message : '列表刷新失败，请刷新聊天列表';
  } finally {
    stage.value = 'result';
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="updateOpen">
    <DialogContent
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:max-w-lg sm:p-6"
      :class="busy && '[&>button]:hidden'"
      @escape-key-down="preventBusyClose"
      @interact-outside="preventBusyClose"
    >
      <DialogHeader class="pr-5">
        <DialogTitle>批量删除{{ kind === 'agent' ? ' Agents' : '群聊' }}</DialogTitle>
        <DialogDescription v-if="stage === 'select'"
          >选择要删除的{{ label }}，下一步确认名单。</DialogDescription
        >
        <DialogDescription v-else-if="stage === 'confirm'"
          >确认删除以下 {{ snapshot.length }} 个{{ label }}。</DialogDescription
        >
        <DialogDescription v-else-if="busy">正在逐项删除，请等待操作完成。</DialogDescription>
        <DialogDescription v-else>删除操作已结束，请查看下方结果。</DialogDescription>
      </DialogHeader>

      <template v-if="stage === 'select'">
        <div class="relative">
          <Search
            class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3"
            aria-hidden="true"
          />
          <Input
            v-model="search"
            :aria-label="`搜索${label}`"
            :placeholder="`搜索${label}`"
            class="pl-9"
            autocomplete="off"
          />
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <Button
            type="button"
            variant="outline"
            size="sm"
            :disabled="!visible.length || allVisibleSelected"
            @click="selectVisible"
            >全选当前搜索结果</Button
          >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            :disabled="!selectedIds.size"
            @click="selectedIds = new Set()"
            >清空选择</Button
          >
          <span class="ml-auto text-ink-3 tabular-nums"
            >已选 {{ selectedIds.size }} / {{ options.length }}</span
          >
        </div>
        <p v-if="loadError" role="alert" class="notice notice-error break-words">
          {{ loadError.message }}
        </p>
        <div v-if="loading" class="flex items-center justify-center gap-2 py-10 text-xs text-ink-3">
          <LoaderCircle class="size-4 animate-spin" />正在载入…
        </div>
        <div v-else class="max-h-[22rem] overflow-y-auto rounded-lg border border-line">
          <label
            v-for="item in visible"
            :key="item.id"
            class="flex min-h-12 cursor-pointer items-center gap-3 border-b border-line px-3 py-2 last:border-b-0 hover:bg-surface-hover has-checked:bg-primary-soft"
          >
            <input
              type="checkbox"
              :aria-label="`选择 ${item.name}`"
              :checked="selectedIds.has(item.id)"
              class="size-4 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-ring/50"
              @change="toggle(item.id)"
            />
            <span class="min-w-0 flex-1">
              <span class="block text-[13px] font-medium break-words">{{ item.name }}</span>
              <span class="mt-0.5 block truncate text-[11px] text-ink-3" :title="item.id"
                >{{ item.detail }} · {{ item.id.slice(0, 8) }}</span
              >
            </span>
          </label>
          <p v-if="!visible.length" class="px-3 py-8 text-center text-xs text-ink-3">
            {{ options.length ? '没有找到匹配项，试试其他名称。' : `当前没有可删除的${label}。` }}
          </p>
        </div>
      </template>

      <template v-else>
        <div
          v-if="stage === 'confirm'"
          class="max-h-72 overflow-y-auto rounded-lg border border-line"
        >
          <div
            v-for="item in snapshot"
            :key="item.id"
            class="border-b border-line px-3 py-2.5 last:border-b-0"
          >
            <p class="text-[13px] font-medium break-words">{{ item.name }}</p>
            <p class="mt-0.5 truncate text-[11px] text-ink-3" :title="item.id">
              {{ item.detail }} · {{ item.id.slice(0, 8) }}
            </p>
          </div>
        </div>
        <template v-else>
          <p
            v-if="busy"
            role="status"
            aria-live="polite"
            class="flex items-center gap-2 text-[13px] text-ink-2"
          >
            <LoaderCircle class="size-4 shrink-0 animate-spin" />已处理 {{ completed }} /
            {{ batchTotal }} 项
          </p>
          <p v-else role="status" class="text-[13px] text-ink-2">
            已删除 {{ succeeded }} 项<span v-if="failed.length"
              >，{{ failed.length }} 项失败，可重试失败项</span
            >。
          </p>
          <div class="max-h-72 overflow-y-auto rounded-lg border border-line" aria-label="删除结果">
            <div
              v-for="item in results"
              :key="item.id"
              class="flex items-start gap-2.5 border-b border-line px-3 py-2.5 last:border-b-0"
            >
              <Check
                v-if="item.status === 'success'"
                class="mt-0.5 size-4 shrink-0 text-st-idle"
                aria-hidden="true"
              />
              <CircleAlert
                v-else-if="item.status === 'error'"
                class="mt-0.5 size-4 shrink-0 text-st-error"
                aria-hidden="true"
              />
              <LoaderCircle
                v-else-if="item.status === 'deleting'"
                class="mt-0.5 size-4 shrink-0 animate-spin text-ink-3"
                aria-hidden="true"
              />
              <span
                v-else
                class="mt-1.5 size-2 shrink-0 rounded-full bg-ink-3"
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1">
                <p class="text-[13px] font-medium break-words">{{ item.name }}</p>
                <p class="mt-0.5 text-[11px] text-ink-3" :title="item.id">
                  {{ item.id.slice(0, 8) }}
                </p>
                <p
                  class="mt-0.5 text-xs break-words"
                  :class="item.status === 'error' ? 'text-st-error' : 'text-ink-3'"
                >
                  {{
                    item.status === 'success'
                      ? '已删除'
                      : item.status === 'error'
                        ? item.error
                        : item.status === 'deleting'
                          ? '正在删除…'
                          : '等待删除'
                  }}
                </p>
              </div>
            </div>
          </div>
          <p v-if="refreshError" role="alert" class="notice notice-error break-words">
            {{ refreshError }}。请刷新聊天列表。
          </p>
        </template>
        <p class="info-box break-words">
          <template v-if="kind === 'agent'"
            >Agent
            会停止运行并退出所有群聊，私聊移至只读历史。私聊和群聊历史、个人工作目录及共享文件保留。</template
          >
          <template v-else
            >群聊会移至只读历史、移出所有成员并停止本群投递与访问。历史及文件保留，成员 Agent
            保持各自运行状态。</template
          >
        </p>
      </template>

      <DialogFooter>
        <template v-if="stage === 'select'">
          <Button type="button" variant="outline" @click="open = false">取消</Button>
          <Button
            type="button"
            variant="destructive"
            :disabled="!selectedIds.size || loading || Boolean(loadError)"
            @click="preview"
            ><Trash2 />删除已选（{{ selectedIds.size }}）</Button
          >
        </template>
        <template v-else-if="stage === 'confirm'">
          <Button type="button" variant="outline" @click="stage = 'select'">返回选择</Button>
          <Button type="button" variant="destructive" @click="execute()"><Trash2 />确认删除</Button>
        </template>
        <Button v-else-if="busy" type="button" variant="destructive" disabled
          ><LoaderCircle class="animate-spin" />正在删除（{{ completed }}/{{ batchTotal }}）</Button
        >
        <template v-else>
          <Button v-if="failed.length" type="button" variant="outline" @click="execute(true)"
            >重试失败项</Button
          >
          <Button type="button" @click="open = false">完成</Button>
        </template>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
