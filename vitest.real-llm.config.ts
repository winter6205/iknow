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
    // #556 T8:t8-live-subagent-routing 走 settings 单承载 + 走 HAS_KEY 守卫,
    // 与 settings-model-extension 收敛兼容,纳入 include。
    // 其他 archive/tests-real-llm/ 文件仍按 M5 不收。
    // model-prefix-layering B8 (SC9):本轮 LLM-touching 改动(B3/B4/B6)的
    // 真实模型 e2e,同走 settings 单承载 + HAS_KEY 守卫。
    // web discover vs read: 黄金集首工具轨迹（有 key 跑同一集；缺 key skip）。
    // worktree tool names (ADR-0082): 建树/列出首工具轨迹，同 HAS_KEY 守卫。
    include: [
      "archive/tests-real-llm/t8-live-subagent-routing.test.ts",
      "archive/tests-real-llm/model-prefix-layering-e2e.test.ts",
      "archive/tests-real-llm/web-discover-vs-read.test.ts",
      "archive/tests-real-llm/worktree-tool-names.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    pool: "forks",
    poolOptions: {
      forks: { maxForks: 1, minForks: 1 },
    },
    reporter: "default",
    testTimeout: 360_000,
    hookTimeout: 360_000,
  },
});
