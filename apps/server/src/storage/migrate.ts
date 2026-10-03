import { ConfigManager } from '@isles/config';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { installationRoot } from '../config.js';
import { openDatabase } from './database.js';
import { acquireDataLock } from './lock.js';

const dataDir = new ConfigManager().current.dataDir;
const releaseDataLock = acquireDataLock(dataDir);
const database = openDatabase(dataDir);

try {
  migrate(database.db, { migrationsFolder: resolve(installationRoot, 'apps/server/migrations') });
  console.info('Database migrations are up to date.');
} finally {
  database.sqlite.close();
  releaseDataLock();
}
