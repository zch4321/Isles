import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function acquireDataLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const owner = new Database(join(dataDir, 'runtime-lock.sqlite'));
  try {
    owner.pragma('busy_timeout = 0');
    // This separate empty database only holds an OS-backed ownership lock.
    // It never holds business data/transactions across RPC waits. SQLite releases
    // the lock on normal close and on abrupt process exit; no stale PID cleanup.
    owner.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    owner.close();
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
    ) {
      throw new Error('该数据目录已由另一个 Isles 服务使用；请使用独立数据目录或先停止现有服务。', {
        cause: error,
      });
    }
    throw new Error('无法锁定 Isles 数据目录，请检查文件权限和磁盘状态。', { cause: error });
  }
  return () => owner.close();
}
