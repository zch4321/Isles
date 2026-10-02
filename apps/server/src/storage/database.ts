import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { schema } from './schema.js';

export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(join(dataDir, 'isles.sqlite'));
  let migrationBackup: string | undefined;

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
    const legacyMessages = (sqlite.pragma('table_info(messages)') as { name: string }[]).some(
      (column) => column.name === 'id',
    );
    if (legacyMessages) {
      const backupPath = join(dataDir, `isles-before-channel-seq-${randomUUID()}.sqlite`);
      // A consistent SQLite snapshot includes WAL contents; it does not copy a live DB file.
      sqlite.prepare('VACUUM INTO ?').run(backupPath);
      migrationBackup = backupPath;
    }
    migrate(db, { migrationsFolder: fileURLToPath(new URL('../../migrations/', import.meta.url)) });
    return { db, sqlite, migrationBackup };
  } catch (error) {
    sqlite.close();
    if (migrationBackup)
      throw new Error(`消息序号迁移失败，原事务已回滚；迁移前备份：${migrationBackup}`, {
        cause: error,
      });
    throw error;
  }
}

export type IslesDatabase = ReturnType<typeof openDatabase>;
