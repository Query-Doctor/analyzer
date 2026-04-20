import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 120_000,
    setupFiles: ["src/test-setup.ts"],
    benchmark: {
      include: ["src/**/*.bench.ts"],
    },
  },
});
