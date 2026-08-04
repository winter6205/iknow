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
    // .tsx: TUI 组件冒烟测试（ink renderToString；#146）。
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    pool: "forks",
    reporter: "default",
  },
});
