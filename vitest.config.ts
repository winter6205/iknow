import { defineConfig } from "vitest/config";

/**
 * Vitest config for iknow.
 *
 * Why a separate config: tests/ live outside tsconfig.json's `include` (which
 * is scoped to src/ for the dist build), so we give vitest its own TS-aware
 * include here. ESM is honored via the project's `"type": "module"`.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    reporter: "default",
  },
});