import { defineConfig } from "vitest/config";

/**
 * Vitest config for real-LLM e2e.
 *
 * Why a separate config: real-LLM e2e make ~95s of live LLM calls on this
 * dev shell (when ANTHROPIC_AUTH_TOKEN is set) and historically flake on
 * the model prompt path. They are run on demand via `npm run test:real-llm`,
 * matching scripts/i9-*-smoke.ts pattern (缺 key 退出 1).
 *
 * settings-model-extension (review fix M5)：
 * 真实 LLM e2e（bootstrap-real-llm + tui-subagent-wiring-acceptance）原本
 * 收在 `archive/tests-real-llm/`，因 phase 2 收敛后仍引用退役变量
 * `process.env.IKNOW_LLM_MODEL` 和 `apiKeyEnv: "ANTHROPIC_AUTH_TOKEN"`,
 * 与 settings-model-extension 的 key 单承载语义不符，移出 vitest 收集。
 * 该目录作为历史快照保留（README 说明），不再被 `npm run test:real-llm`
 * 拉起。新 real-LLM 走 `scripts/i135-settings-model-extension-smoke.ts` +
 * `npm run probe:settings-model`。
 */
export default defineConfig({
  test: {
    // M5：archive/tests-real-llm/ 已从 include 移除（含 IKNOW_LLM_MODEL /
    // apiKeyEnv 退役变量引用，与 settings 单承载语义不符）。
    include: [],
    exclude: ["**/node_modules/**"],
    pool: "forks",
    poolOptions: {
      forks: { maxForks: 1, minForks: 1 },
    },
    reporter: "default",
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
