import type { HarnessStatus, Model } from '@isles/contracts';
import type { HarnessCatalog } from './types.js';

export interface CatalogSnapshot {
  status: HarnessStatus;
  models: Model[];
}

/** Reuses a native catalog read for 30 seconds; invalidation discards reads already in flight. */
export abstract class CachedCatalog implements HarnessCatalog {
  private cache: (CatalogSnapshot & { time: number }) | undefined;
  private fetching: Promise<CatalogSnapshot> | undefined;
  private revision = 0;
  protected abstract fetch(): Promise<CatalogSnapshot>;
  invalidate() {
    this.cache = undefined;
    this.fetching = undefined;
    this.revision++;
  }
  async status() {
    return (await this.read()).status;
  }
  async models() {
    return (await this.read()).models;
  }
  private async read() {
    if (this.cache && Date.now() - this.cache.time < 30_000) return this.cache;
    if (this.fetching) return this.fetching;
    const revision = this.revision;
    const fetching = this.fetch();
    this.fetching = fetching;
    try {
      const value = await fetching;
      if (revision === this.revision) this.cache = { ...value, time: Date.now() };
      return value;
    } finally {
      if (this.fetching === fetching) this.fetching = undefined;
    }
  }
}
