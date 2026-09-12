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
    // .tsx：TUI 组件测试；#343 T0 后 ink TUI 测试已归档到 archive/tui-ink/
    // （在 tests/ 之外，本 include 不收集）。
    // real-LLM e2e（bootstrap-real-llm / tui-subagent-wiring-acceptance）已归档到
    // archive/tests-real-llm/ —— 与 tui-ink 同原则：在 tests/ 之外，include 不收集，
    // 由 package.json "test:real-llm"（vitest.real-llm.config.ts）显式触发。
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // D2 裁决：tests/tui 由 bun:test 驱动（OpenTUI 原生 FFI 仅 bun 可用，
    // Node/vitest 下 createTestRenderer 报 "native FFI is not available"）。
    // 聚合入口见 package.json "test" script。
    // archive/** 防御性排除：归档目录永不进默认收集（与 tui-ink 同注释原则）。
    exclude: ["tests/tui/**", "archive/**", "**/node_modules/**"],
    pool: "forks",
    // 4 核机器上默认会 fork min(cores, fileCount) 个并行进程，叠加各
    // 测试文件内的真实定时器/TUI 轮询容易放大偶发失败。限流到 3 个
    // fork，显著降低 CPU 争用导致的 flaky（真失败不受影响）。
    poolOptions: {
      forks: { maxForks: 3, minForks: 1 },
    },
    // vitest 默认 testTimeout = 5_000ms。本仓库大量用例真装配引擎
    // （buildHarnessEngine / runChatSession / createWorkerDeps）、真起
    // 子进程、真读 git —— 这些是 IO/装配预算，不是被测契约：满负载下
    // 同一用例墙钟可涨到数倍，撞 5s 就被记成超时红。放宽到 30s 让超时
    // 重新成为「真挂死」的信号；跑得更慢的用例另行单独收窄。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporter: "default",
  },
});
