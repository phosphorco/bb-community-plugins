import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { pretendToBeVisual: true } },
    include: ["test/skills/browser/ui/**/*.test.tsx"],
    fileParallelism: false,
  },
});
