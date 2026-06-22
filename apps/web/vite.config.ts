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
  build: { target: "es2022", outDir: "dist" },
});
