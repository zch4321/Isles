import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));

const environmentSchema = z.object({
  ISLES_SERVER_PORT: z.coerce.number().int().min(1).max(65_535).default(4310),
  ISLES_DATA_DIR: z.string().min(1).default('.isles'),
  ISLES_GROUP_QUIET_MS: z.coerce.number().int().min(0).default(10_000),
  ISLES_GROUP_MAX_WAIT_MS: z.coerce.number().int().min(0).default(30_000),
});

export function readConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.parse(environment);

  return {
    host: '127.0.0.1',
    port: parsed.ISLES_SERVER_PORT,
    dataDir: resolve(workspaceRoot, parsed.ISLES_DATA_DIR),
    webRoot: resolve(workspaceRoot, 'apps/web/dist'),
    schedule: {
      groupQuietMs: parsed.ISLES_GROUP_QUIET_MS,
      groupMaxWaitMs: parsed.ISLES_GROUP_MAX_WAIT_MS,
    },
  } as const;
}
