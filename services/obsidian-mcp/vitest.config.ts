import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      // The vault core (path-safety + list/read/search/write) is the pure,
      // high-coverage security-critical logic (PROJECT_BIBLE §12 / B.1: >=90%).
      // The MCP transport wiring (server.ts) is a thin shell, excluded.
      include: ["src/vault.ts"],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90
      }
    }
  }
});
