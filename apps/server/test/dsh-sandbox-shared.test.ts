import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const electron = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';

it.skipIf(!existsSync(electron))(
  'confines real installed DSH filesystem and Seatbelt writes to private, shared and native temporary roots without a model',
  async () => {
    const result = await promisify(execFile)(
      electron,
      [fileURLToPath(new URL('./dsh-native-sandbox-check.mjs', import.meta.url))],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20_000 },
    );
    expect(JSON.parse(result.stdout.trim())).toEqual({
      fs: true,
      seatbelt: true,
      linuxProfiles: true,
      windowsGrantContract: true,
      nativeApprovalAudit: true,
    });
  },
  25_000,
);
