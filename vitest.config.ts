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
        resolve: { alias },
        test: {
          name: "web",
          environment: "jsdom",
          include: ["apps/web/test/**/*.test.ts"],
        },
      },
    ],
  },
});
