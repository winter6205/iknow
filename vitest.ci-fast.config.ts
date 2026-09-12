import { mergeConfig, type UserConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";
import { CI_EXCLUDES, CI_FAST_EXCLUDES } from "./vitest.ci-excludes.js";

/**
 * Vitest config for CI — test-fast（PR 级快速门，目标 ~5min 内反馈）。
 *
 * = 本地 vitest.config.ts + CI_EXCLUDES + CI_FAST_EXCLUDES
 * （SSOT: vitest.ci-excludes.ts）。本 job 不装 bubblewrap，因此比
 * test-full 多排 e2e / integration / secret-roundtrip 整目录 —— 这些在
 * 缺 bwrap 时装配期即 throw。逐条理由见 SSOT 模块。
 *
 * 时序 flaky 由 workflow 的 --retry 1 吸收，不在这里表达。
 */
export default mergeConfig(baseConfig as UserConfig, {
  test: {
    exclude: [...CI_EXCLUDES, ...CI_FAST_EXCLUDES],
  },
});
