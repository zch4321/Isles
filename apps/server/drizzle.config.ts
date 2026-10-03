import { ConfigManager } from '@isles/config';
import { defineConfig } from 'drizzle-kit';
import { join } from 'node:path';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/storage/schema.ts',
  out: './migrations',
  dbCredentials: { url: join(new ConfigManager().current.dataDir, 'isles.sqlite') },
});
