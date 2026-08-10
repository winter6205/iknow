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
    // 4 核机器上默认会 fork min(cores, fileCount) 个并行进程，叠加各
    // 测试文件内的真实定时器/TUI 轮询容易放大偶发失败。限流到 3 个
    // fork，显著降低 CPU 争用导致的 flaky（真失败不受影响）。
    poolOptions: {
      forks: { maxForks: 3, minForks: 1 },
    },
    reporter: "default",
  },
});
