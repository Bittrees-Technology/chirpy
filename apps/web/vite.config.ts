import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath, URL } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// https://vite.dev/config/
export default defineConfig(({ command, isPreview }) => {
  // The plugin injects bare shim imports into linked workspace packages. Resolve
  // its ESM exports from this app instead of requiring every package to install it.
  const polyfillRoot = new URL("./node_modules/vite-plugin-node-polyfills/", import.meta.url);
  const shimExports = command === "serve" ? JSON.parse(readFileSync(new URL("package.json", polyfillRoot), "utf8")).exports : {};
  const shims = command === "serve" ? Object.fromEntries(
    ["buffer", "global", "process"].map(name => [
      `vite-plugin-node-polyfills/shims/${name}`,
      fileURLToPath(new URL(shimExports[`./shims/${name}`].import, polyfillRoot)),
    ]),
  ) : {};
  // A server header applies before the document executes and survives reloads.
  // Production builds and ordinary previews retain their existing configuration.
  const nativePreview = command === "serve" && isPreview === true && process.env.CHIRPY_TEST_NATIVE_CSP === "1";
  const policy = nativePreview ? JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8")).app.security.csp : undefined;
  if (nativePreview && (typeof policy !== "string" || !policy.trim())) throw new Error("Native preview requires the canonical CSP.");
  return {
  plugins: [react(), nodePolyfills({ include: ["buffer", "process", "util", "stream", "events"], globals: { Buffer: true, process: true } })],
  define: { "import.meta.env.VITE_NATIVE_PLATFORM": JSON.stringify(process.env.TAURI_ENV_PLATFORM || "") },
  resolve: {
    alias: {
      ...shims,
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
    esbuildOptions: { target: "esnext" },
  },
  preview: { headers: nativePreview ? { "Content-Security-Policy": policy } : undefined },
  worker: { format: "es" },
  build: { target: "esnext", outDir: "dist" },
  };
});
