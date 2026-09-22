import { defineConfig, devices } from '@playwright/test';
const port = Number(process.env.PUSH_UI_PORT || 1438);
export default defineConfig({
  testDir: './tests/push-ui', testMatch: '**/*.spec.ts', timeout: 30_000,
  forbidOnly: !!process.env.CI, retries: 0,
  webServer: { command: `pnpm --filter @app/web exec vite build --config ../../tests/push-ui/vite.config.ts && pnpm --filter @app/web exec vite preview --config ../../tests/push-ui/vite.config.ts --host 127.0.0.1 --port ${port}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 120_000, env: { VITE_TRANSPORT: 'mock' } },
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
