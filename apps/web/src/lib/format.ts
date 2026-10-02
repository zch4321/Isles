import type { AgentStatus, DeliveryStatus, RunStatus } from '@isles/contracts';

export const agentStatusLabels: Record<AgentStatus, string> = {
  creating: '创建中',
  recovering: '恢复中',
  ready: '可用',
  running: '执行中',
  stopped: '已停止',
  error: '异常',
};

export const deliveryLabels: Record<DeliveryStatus, string> = {
  queued: '排队中',
  submitting: '提交中',
  accepted: '执行中',
  received: '已通过 MCP 接收',
  completed: '已完成',
  cancelled: '已取消',
  failed: '投递失败',
  uncertain: '待核对',
  skipped: '未读跳过',
};

export const runStatusLabels: Record<RunStatus, string> = {
  starting: '启动中',
  running: '执行中',
  waiting: '等待回答',
  completed: '已完成',
  interrupted: '已中断',
  failed: '失败',
  uncertain: '待核对',
};

/** Background utilities for the status dots on avatars, badges and runs. */
export const agentStatusTone: Record<AgentStatus, string> = {
  creating: 'bg-warning',
  recovering: 'bg-warning',
  ready: 'bg-success',
  running: 'bg-primary',
  stopped: 'bg-muted-foreground/50',
  error: 'bg-destructive',
};

export const runStatusTone: Record<RunStatus, string> = {
  starting: 'bg-primary',
  running: 'bg-primary',
  waiting: 'bg-warning',
  completed: 'bg-success',
  interrupted: 'bg-muted-foreground/50',
  failed: 'bg-destructive',
  uncertain: 'bg-warning',
};

export const isActiveRun = (status: RunStatus) =>
  status === 'starting' || status === 'running' || status === 'waiting';

const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });
const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeStyle: 'short' });

export const formatTime = (value: string) => time.format(new Date(value));
export const formatDateTime = (value: string) => dateTime.format(new Date(value));

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

export function dateLabel(value: string) {
  const date = new Date(value);
  const now = new Date();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return date.toLocaleDateString(
    'zh-CN',
    date.getFullYear() === now.getFullYear()
      ? { month: 'long', day: 'numeric' }
      : { year: 'numeric', month: 'long', day: 'numeric' },
  );
}

/** Time for today, otherwise the day, as chat lists usually show. */
export function listTime(value: string) {
  const label = dateLabel(value);
  return label === '今天' ? formatTime(value) : label;
}

export const sameDay = (a: string, b: string) =>
  startOfDay(new Date(a)) === startOfDay(new Date(b));

export function formatDuration(from: string, to: string) {
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败';
