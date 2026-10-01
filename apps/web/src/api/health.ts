import { healthResponseSchema } from '@isles/contracts';

export async function fetchHealth() {
  const response = await fetch('/api/health', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('服务暂时无法连接');
  return healthResponseSchema.parse(await response.json());
}
