import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: {
      alias: {
        "~": srcPath,
      },
    },
    test: {
      include: ["src/components/**/*.browser.tsx", "src/lib/**/*.browser.ts?(x)"],
      // Full-app browser suites intentionally exercise process-global stores,
      // the singleton native API transport, MSW, and the shared document. Run
      // files serially so one suite cannot dispose or replace another suite's
      // runtime/DOM while React is still rendering it.
      maxWorkers: 1,
      server: {
        port: process.env.VITEST_BROWSER_PORT ? Number(process.env.VITEST_BROWSER_PORT) : undefined,
        strictPort: false,
      },
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        headless: true,
        api: {
          port: process.env.VITEST_BROWSER_PORT
            ? Number(process.env.VITEST_BROWSER_PORT)
            : undefined,
          strictPort: false,
        },
      },
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
