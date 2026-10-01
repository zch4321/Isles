import { defineConfig } from 'drizzle-kit';
import { join } from 'node:path';
import { readConfig } from './src/config.js';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/storage/schema.ts',
  out: './migrations',
  dbCredentials: { url: join(readConfig().dataDir, 'isles.sqlite') },
});
