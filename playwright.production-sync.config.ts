import {defineConfig, devices} from '@playwright/test';

// Explicit operator invocation only: this writes synthetic encrypted settings to production.
if (process.env.CHAT_PRODUCTION_SYNC_ACCEPTANCE !== '1' || !/^[a-f0-9]{40}$/.test(process.env.CHAT_EXPECTED_SHA ?? '')) {
  throw new Error('Set CHAT_PRODUCTION_SYNC_ACCEPTANCE=1 and CHAT_EXPECTED_SHA to the reviewed deployed commit.');
}
export default defineConfig({
  testDir: './tests/production-sync', fullyParallel: false, workers: 1, retries: 0,
  timeout: 180000, expect: {timeout: 15000}, reporter: 'list',
  outputDir: 'test-results/production-sync',
  use: {...devices['Desktop Chrome'], trace: 'off', video: 'off', screenshot: 'off'},
});
