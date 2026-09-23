import {defineConfig,devices} from '@playwright/test';
import {recoverySources} from './tests/production-recovery/sources';
recoverySources();
export default defineConfig({testDir:'./tests/production-recovery',fullyParallel:false,workers:1,retries:0,timeout:120000,expect:{timeout:10000},outputDir:'test-results/production-recovery',use:{...devices['Desktop Chrome'],actionTimeout:10000,trace:'off',video:'off',screenshot:'off'},reporter:'list'});
