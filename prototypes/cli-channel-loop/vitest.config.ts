import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // the e2e test spawns the built channel server and polls its HTTP port
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
