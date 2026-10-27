import { defineConfig, mergeConfig } from '../../apps/web/node_modules/vite';
import base from '../../apps/web/vite.config';
import { fileURLToPath } from 'node:url';
export default defineConfig(env => mergeConfig(base(env), { root: fileURLToPath(new URL('.', import.meta.url)), build: { outDir: '../../.push-runtime-dist', emptyOutDir: true } }));
