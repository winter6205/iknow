import { defineConfig } from "vitest/config";

/**
 * Vitest config for real-LLM e2e.
 *
 * Why a separate config: real-LLM e2e make ~95s of live LLM calls on this
 * dev shell (when ANTHROPIC_AUTH_TOKEN is set) and historically flake on
 * the model prompt path. They are run on demand via `npm run test:real-llm`,
 * matching scripts/i9-*-smoke.ts pattern (missing key → exit 1).
 *
 * settings-model-extension (review fix M5):
 * The original real-LLM e2e (bootstrap-real-llm + tui-subagent-wiring-acceptance)
 * lived under `archive/tests-real-llm/`, but after phase 2 convergence they still
 * referenced the retired `process.env.IKNOW_LLM_MODEL` and
 * `apiKeyEnv: "ANTHROPIC_AUTH_TOKEN"`, which conflicts with settings-model-extension's
 * single-key-bearing semantics, so they were dropped from vitest collection.
 * The directory is kept as a historical snapshot (see README) and is no longer
 * pulled up by `npm run test:real-llm`. New real-LLM runs go through
 * `scripts/i135-settings-model-extension-smoke.ts` + `npm run probe:settings-model`.
 */
export default defineConfig({
  test: {
    // #556 T8: t8-live-subagent-routing rides settings single-bearing + HAS_KEY guard,
    // compatible with settings-model-extension convergence, so kept in include.
    // Other archive/tests-real-llm/ files stay excluded per M5.
    // model-prefix-layering B8 (SC9): real-model e2e for this round's LLM-touching
    // changes (B3/B4/B6), same settings single-bearing + HAS_KEY guard.
    // web discover vs read: golden-set first-tool trace (same set with key; skip without).
    // graph mode notification: same-shape set — does the notification text actually
    // steer the model toward run_graph vs spawn_subagent (same set with key; skip without).
    // worktree tool names (ADR-0082): create-tree / list first-tool trace, same HAS_KEY guard.
    // agent_status pivot reconcile (spec agent-status-instruction-echo T5):
    // <agent_status> golden-set real-model half (first-tool todo_write verdict), same guard.
    // egress real push (ssh-bridge bullet 7): non-LLM surface but same directory discipline —
    // default skip; only enabled explicitly by IKNOW_EGRESS_REAL_PUSH_E2E=1 (spec assumption 9).
    // soul/usage trace set (ADR-0117 / #1078): structural-question first-tool ∈ symbol-query
    // surface + bash role-substitution refusal verdict, same HAS_KEY guard (no key → Not run).
    include: [
      "archive/tests-real-llm/t8-live-subagent-routing.test.ts",
      "archive/tests-real-llm/model-prefix-layering-e2e.test.ts",
      "archive/tests-real-llm/web-discover-vs-read.test.ts",
      "archive/tests-real-llm/graph-mode-notification.test.ts",
      "archive/tests-real-llm/worktree-tool-names.test.ts",
      "archive/tests-real-llm/agent-status-instruction-echo.test.ts",
      "archive/tests-real-llm/egress-real-git-push.test.ts",
      "archive/tests-real-llm/tool-role-substitution.test.ts",
      // #1089 section B: three inductions over the same runner (no means named
      // in prompt, verbal bash-grep induction, non-TypeScript arm).
      "archive/tests-real-llm/role-substitution-boundaries-real.test.ts",
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
