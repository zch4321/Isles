import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const browserConfigFile = join(mkdtempSync(join(tmpdir(), 'isles-vite-test-')), 'config.toml');
function testPort(value: string | undefined, fallback: number) {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Browser test port must be between 1 and 65535');
  return port;
}
const serverPort = testPort(process.env.ISLES_TEST_SERVER_PORT, 54310);
const webPort = testPort(process.env.ISLES_TEST_WEB_PORT, 55173);
writeFileSync(browserConfigFile, `[server]\nport = ${serverPort}\n[dev]\nport = ${webPort}\n`);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
    ...(process.env.ISLES_TEST_BROWSER_CHANNEL
      ? { channel: process.env.ISLES_TEST_BROWSER_CHANNEL }
      : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command:
        'pnpm --filter @isles/contracts build && pnpm --filter @isles/server exec tsx ../../tests/e2e/server.ts',
      url: `http://127.0.0.1:${serverPort}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ISLES_SERVER_PORT: String(serverPort), ISLES_CONFIG_FILE: browserConfigFile },
    },
    {
      command: 'pnpm --filter @isles/web dev',
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ISLES_SERVER_PORT: String(serverPort),
        ISLES_WEB_PORT: String(webPort),
        ISLES_CONFIG_FILE: browserConfigFile,
      },
    },
  ],
});
