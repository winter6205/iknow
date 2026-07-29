import { defineConfig } from "vitest/config";

/**
 * Vitest config for graphrag-memory.
 *
 * Mirrors the root project's test layout: tests live outside `tsconfig.json`'s
 * `include` (which is scoped to src/ for the dist build), so vitest gets its
 * own TS-aware include here. ESM is honored via the package's `"type": "module"`.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    reporter: "default",
  },
});
