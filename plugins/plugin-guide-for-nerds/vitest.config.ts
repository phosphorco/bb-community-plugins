import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    name: "plugin-guide-for-nerds", include: ["**/*.test.{ts,tsx,mjs}"],
    exclude: ["node_modules/**", "dist/**"], setupFiles: ["./test/setup.ts"],
  },
});
