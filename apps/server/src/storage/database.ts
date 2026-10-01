import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema } from './schema.js';

export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(join(dataDir, 'isles.sqlite'));

  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    // M2 replaced the M1 baseline instead of migrating it; M1 data is not kept.
    if (
      sqlite.prepare("select 1 from sqlite_master where type = 'table' and name = 'objects'").get()
    )
      throw new Error(
        `数据目录 ${dataDir} 是 M1 格式，M2 不兼容也不迁移。请停止 Isles 并删除该目录后重试。`,
      );
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: fileURLToPath(new URL('../../migrations/', import.meta.url)) });
    return { db, sqlite };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export type IslesDatabase = ReturnType<typeof openDatabase>;
