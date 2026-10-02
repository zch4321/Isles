import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:55173',
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
      url: 'http://127.0.0.1:54310/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ISLES_SERVER_PORT: '54310' },
    },
    {
      command: 'pnpm --filter @isles/web dev',
      url: 'http://127.0.0.1:55173',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ISLES_SERVER_PORT: '54310',
        ISLES_WEB_PORT: '55173',
      },
    },
  ],
});
