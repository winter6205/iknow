import { mergeConfig, type UserConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";
import { CI_EXCLUDES } from "./vitest.ci-excludes.js";

/**
 * Vitest config for CI — test-full（nightly cron + manual dispatch）。
 *
 * = 本地 vitest.config.ts + CI_EXCLUDES（SSOT: vitest.ci-excludes.ts）。
 * 继承而非复制，保证本地 `npm test` / `test:changed` 语义不变，CI 只是在
 * 其基础上多排一批 runner 上跑不了的文件。
 *
 * Why the extra excludes: GHA runner 无 user-namespace，bwrap 物理执行
 * 起不来；且 requireBwrap() 在 createBashTool / createDefaultAciRegistry /
 * createWorkerDeps / runInSandbox 装配期就 throw。逐条归类与引入缘由见
 * vitest.ci-excludes.ts，本文件不再复述。装了 bwrap 后仍不能物理执行的
 * 那一批依旧要排 —— 装 bwrap 只解决装配期 fail-loud。
 *
 * 本 config 只影响 CI；本地沙箱/ACI 测试继续由 WSL 全量验证。
 */
export default mergeConfig(baseConfig as UserConfig, {
  test: {
    exclude: [...CI_EXCLUDES],
  },
});
