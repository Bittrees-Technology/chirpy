import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@app/core": r("../../packages/core/src/index.ts"),
      "@app/transport": r("../../packages/transport/src/index.ts"),
    },
  },
  server: {
    port: 1420,        // Tauri's expected dev port
    strictPort: false,
    host: true,
    fs: { allow: [r("../..")] },  // serve from the monorepo root (workspace packages)
  },
  // XMTP browser SDK runs WASM bindings in a Web Worker with an OPFS SQLite store.
  // Keep it out of dep prebundling and target esnext for the SDK glue's top-level
  // await. The SDK is dynamically imported by the transport, so mock mode stays
  // on the small default bundle.
  optimizeDeps: {
    exclude: ["@xmtp/browser-sdk", "@xmtp/wasm-bindings"],
    include: ["@xmtp/proto"],
    esbuildOptions: { target: "esnext" },
  },
  worker: { format: "es" },
  build: { target: "esnext", outDir: "dist" },
});
