import { defineConfig, mergeConfig } from '../../apps/web/node_modules/vite';
import base from '../../apps/web/vite.config';
import { fileURLToPath } from 'node:url';
// This alias exists only in the isolated acceptance build, never in the shipped app.
export default defineConfig(env => mergeConfig(base(env), {
  resolve: { alias: { '@pushprotocol/restapi': fileURLToPath(new URL('./sdk.ts', import.meta.url)) } },
  build: { outDir: '../../.push-ui-dist', emptyOutDir: true },
}));
