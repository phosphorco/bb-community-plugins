import { defineConfig } from "vitest/config";

/**
 * Bounded component evidence only. The @bb alias is the plugin source alias;
 * tests resolve it to the installed public SDK export so the same runtime
 * module is shared with @get-bb/plugin-sdk/testing/app.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: "@bb/plugin-sdk/app", replacement: "@get-bb/plugin-sdk/app" },
      { find: "@bb/plugin-sdk", replacement: "@get-bb/plugin-sdk" },
    ],
  },
  css: {
    transformer: "postcss",
  },
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: { pretendToBeVisual: true },
    },
    include: ["test/architecture/browser/ui/execution-backed-ui.test.tsx"],
    setupFiles: ["test/architecture/browser/ui/setup.ts"],
    fileParallelism: false,
  },
});
