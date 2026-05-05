import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 120_000,
    benchmark: {
      include: ["src/**/*.bench.ts"],
    },
  },
});
