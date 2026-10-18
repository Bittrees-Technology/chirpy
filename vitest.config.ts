import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const alias = {
  "@app/core": r("./packages/core/src/index.ts"),
  "@app/transport": r("./packages/transport/src/index.ts"),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "api",
          environment: "node",
          include: ["server/test/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "core",
          environment: "node",
          include: ["packages/core/test/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "transport",
          environment: "node",
          include: ["packages/transport/test/**/*.test.ts"],
        },
      },
      {
        // Shared canonical UI lives outside apps/web; resolve its React imports
        // through the web package so clean pnpm installs use one React instance.
        resolve: { alias: { ...alias, react: r("./apps/web/node_modules/react"), "react-dom": r("./apps/web/node_modules/react-dom") } },
        test: {
          name: "web",
          setupFiles: [r("./apps/web/test/locksSetup.ts")],
          environment: "jsdom",
          include: ["apps/web/test/**/*.test.ts"],
        },
      },
    ],
  },
});
