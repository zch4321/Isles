import type { RunItem } from '@isles/contracts';

/** Keep stream fragments off the storage/event path until an output boundary. */
export class RunOutputBuffer {
  private readonly items = new Map<string, RunItem>();
  private readonly pending = new Set<string>();
  private readonly sealed = new Set<string>();
  private readonly appendOrigin = new Map<string, boolean>();

  update(item: RunItem, append: boolean, streaming: boolean): RunItem {
    const previous = this.items.get(item.id);
    if (streaming && this.sealed.has(item.id)) return previous!;
    const next = {
      ...item,
      type: append ? (previous?.type ?? item.type) : item.type,
      text: ((append ? (previous?.text ?? '') : '') + item.text).slice(-128_000),
    };
    this.items.set(item.id, next);
    if (!this.appendOrigin.has(item.id) || !append) this.appendOrigin.set(item.id, append);
    if (streaming) this.pending.add(item.id);
    else {
      this.pending.delete(item.id);
      if (['completed', 'failed', 'interrupted'].includes(item.status)) this.sealed.add(item.id);
    }
    return next;
  }

  /** Adopt only the native turn that the submission/start actually confirmed. */
  adopt(buffer: RunOutputBuffer) {
    for (const item of buffer.items.values())
      this.update(item, buffer.appendOrigin.get(item.id) ?? false, buffer.pending.has(item.id));
  }

  flush(status: 'completed' | 'interrupted' | 'failed'): RunItem[] {
    const unsettled = new Set([
      ...this.pending,
      ...[...this.items.values()]
        .filter((item) => item.status === 'running')
        .map((item) => item.id),
    ]);
    const items = [...unsettled].map((id) => {
      const item = this.items.get(id)!;
      const settled = { ...item, status: item.status === 'running' ? status : item.status };
      this.items.set(id, settled);
      this.sealed.add(id);
      return settled;
    });
    this.pending.clear();
    return items;
  }
}
