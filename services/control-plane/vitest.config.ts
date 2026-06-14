import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      // The grounding + taint engine is the high-coverage pure-logic core
      // (PROJECT_BIBLE §12 / B.1: >=90% line/branch). The registry + http config
      // surface (§9/§5) is also covered here.
      include: [
        "src/grounding/**/*.ts",
        "src/registry/**/*.ts",
        "src/http/**/*.ts",
        "src/session/**/*.ts",
        "src/backend/**/*.ts",
        "src/preprocessor/**/*.ts",
        "src/gitea/**/*.ts"
      ],
      exclude: [
        "src/grounding/index.ts",
        "src/registry/index.ts",
        "src/session/index.ts",
        "src/session/types.ts",
        "src/backend/index.ts",
        "src/gitea/index.ts",
        "src/gitea/types.ts"
      ],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90
      }
    }
  }
});
