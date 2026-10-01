import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { readConfig, workspaceRoot } from '../config.js';
import { openDatabase } from './database.js';
import { acquireDataLock } from './lock.js';

const dataDir = readConfig().dataDir;
const releaseDataLock = acquireDataLock(dataDir);
const database = openDatabase(dataDir);

try {
  migrate(database.db, { migrationsFolder: resolve(workspaceRoot, 'apps/server/migrations') });
  console.info('Database migrations are up to date.');
} finally {
  database.sqlite.close();
  releaseDataLock();
}
