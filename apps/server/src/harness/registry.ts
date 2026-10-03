import { harnessDescriptorSchema } from '@isles/contracts';
import { HttpError } from '../errors.js';
import type { HarnessAdapter } from './types.js';

export class HarnessRegistry {
  private readonly adapters = new Map<string, HarnessAdapter>();
  constructor(adapters: readonly HarnessAdapter[]) {
    for (const adapter of adapters) {
      const descriptor = harnessDescriptorSchema.parse(adapter.descriptor);
      if (this.adapters.has(descriptor.id)) throw new Error(`Harness 重复注册：${descriptor.id}`);
      for (const capability of ['sessionResume', 'mcp', 'workspaceInstructions'] as const)
        if (!descriptor.capabilities[capability])
          throw new Error(`Harness ${descriptor.id} 缺少 Isles 必需能力：${capability}`);
      this.adapters.set(descriptor.id, adapter);
    }
    if (!this.adapters.size) throw new Error('至少需要注册一个 harness adapter');
  }
  list() {
    return [...this.adapters.values()].map((adapter) => adapter.descriptor);
  }
  get(id: string): HarnessAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new HttpError(404, `未注册的 harness：${id}`);
    return adapter;
  }
}
