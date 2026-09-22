import { defineConfig, devices } from '@playwright/test';
const port = Number(process.env.PUSH_TEST_PORT || 1429);
export default defineConfig({
  testDir: './tests/push-runtime', testMatch: '**/*.spec.ts', timeout: 45_000,
  forbidOnly: !!process.env.CI, retries: process.env.CI ? 1 : 0,
  webServer: { command: `pnpm --filter @app/web exec vite build --config ../../tests/push-runtime/vite.config.ts && pnpm --filter @app/web exec vite preview --config ../../tests/push-runtime/vite.config.ts --host 127.0.0.1 --port ${port}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 120_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
