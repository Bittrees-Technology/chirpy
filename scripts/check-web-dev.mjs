// Exercise workspace transforms without opening a browser, client or network port.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const app = fileURLToPath(new URL('../apps/web/', import.meta.url));
process.chdir(app);
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createServer, normalizePath } = await import(require.resolve('vite'));
const watchdog = setTimeout(() => { console.error('Workspace development imports timed out.'); process.exit(1); }, 30_000);
let server;
try {
  // This probe checks module resolution, not the unrelated HTML dependency crawl.
  server = await createServer({ root: app, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  for (const source of ['packages/core/src/index.ts', 'packages/transport/src/xmtp.ts']) {
    const file = fileURLToPath(new URL(source, new URL('../', import.meta.url)));
    const result = await server.transformRequest('/@fs/' + normalizePath(file).replace(/^\//, ''));
    if (!result?.code) throw new Error('Workspace module did not transform.');
  }
} finally {
  if (server) await server.close();
  clearTimeout(watchdog);
}
// Vite can retain optimizer handles after close; this one-shot probe owns the process.
// Exceptions above still exit nonzero before reaching this success path.
console.log(JSON.stringify({ workspaceDevelopmentImportsPassed: true, transformedModules: 2, browserOrClientOpened: false }));
process.exit(0);
