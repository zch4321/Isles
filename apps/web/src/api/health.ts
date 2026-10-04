import { healthResponseSchema } from '@isles/contracts';

export async function fetchHealth() {
  const response = await fetch('/api/health', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('服务连接异常，请检查服务状态后重试');
  return healthResponseSchema.parse(await response.json());
}
