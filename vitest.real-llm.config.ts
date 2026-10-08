import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest config for real-LLM e2e.
 *
 * Why a separate config: real-LLM e2e make ~95s of live LLM calls on this
 * dev shell (when ANTHROPIC_AUTH_TOKEN is set) and historically flake on
 * the model prompt path. They are run on demand via `npm run test:real-llm`,
 * matching scripts/i9-*-smoke.ts pattern (missing key → exit 1).
 *
 * Two halves, and the difference is not cosmetic:
 *   - `real-llm/` is tracked, so the roster claim "this golden set has a
 *     real-model half" is verifiable from a clone. New rounds put their set here.
 *   - `archive/tests-real-llm/` was untracked by phase 1 (`42ae6ee9`) and lives
 *     only on a shell that keeps the sibling iknow-archive checkout, so those
 *     entries are local-only and may legitimately be absent.
 *
 * settings-model-extension (review fix M5): the original real-LLM e2e
 * (bootstrap-real-llm + tui-subagent-wiring-acceptance) referenced the retired
 * `process.env.IKNOW_LLM_MODEL` / `apiKeyEnv: "ANTHROPIC_AUTH_TOKEN"`, which
 * conflicts with settings single-key-bearing semantics, so they were dropped
 * from vitest collection. New real-LLM runs go through
 * `scripts/i135-settings-model-extension-smoke.ts` + `npm run probe:settings-model`.
 */

// soul/usage trace set (ADR-0117 / #1078): structural-question first-tool ∈
// symbol-query surface + bash role-substitution refusal verdict, HAS_KEY guard
// (no key → explicit Not run, never a hidden pass).
const TRACKED_INCLUDE = [
  "real-llm/tool-role-substitution.test.ts",
  // #1089 section B: three inductions over the same runner (no means named in
  // the prompt, verbal bash-grep induction, non-TypeScript arm).
  "real-llm/role-substitution-boundaries-real.test.ts",
  // verify-status-contract (spec SC12): real-model half of the three-value
  // verify-outcome golden set (offline half + fixtures live under
  // tests/harness/verify/), HAS_KEY guard — no key → explicit Not run.
  "real-llm/verify-status-contract.test.ts",
  // lsp-worktree-paths T4: real-model half of the worktree-path trajectory
  // golden set. The model drives actual host worktree create/enter/exit through
  // the production provisioner seams wired by buildHarnessEngine; the fixed
  // cases + literals are shared with the offline half
  // (tests/harness/lsp/worktree-trajectory.test.ts + .fixtures.ts). HAS_KEY
  // guard — no key → explicit Not run.
  "real-llm/worktree-trajectory.test.ts",
];

const LOCAL_ONLY_INCLUDE = [
  // #556 T8: rides settings single-bearing + HAS_KEY guard, compatible with
  // settings-model-extension convergence, so kept in include.
  "archive/tests-real-llm/t8-live-subagent-routing.test.ts",
  // model-prefix-layering B8 (SC9): real-model e2e for this round's
  // LLM-touching changes (B3/B4/B6), same settings single-bearing + HAS_KEY guard.
  "archive/tests-real-llm/model-prefix-layering-e2e.test.ts",
  // web discover vs read: golden-set first-tool trace (with key; skip without).
  "archive/tests-real-llm/web-discover-vs-read.test.ts",
  // graph mode notification: does the text actually steer the model toward
  // run_graph vs spawn_subagent (same set, same guard).
  "archive/tests-real-llm/graph-mode-notification.test.ts",
  // worktree tool names (ADR-0082): create-tree / list first-tool trace.
  "archive/tests-real-llm/worktree-tool-names.test.ts",
  // agent_status pivot reconcile (spec agent-status-instruction-echo T5):
  // golden-set real-model half (first-tool todo_write verdict).
  "archive/tests-real-llm/agent-status-instruction-echo.test.ts",
  // egress real push (ssh-bridge bullet 7): non-LLM surface, same directory
  // discipline — only enabled by IKNOW_EGRESS_REAL_PUSH_E2E=1 (spec assumption 9).
  "archive/tests-real-llm/egress-real-git-push.test.ts",
];

const INCLUDE = [...TRACKED_INCLUDE, ...LOCAL_ONLY_INCLUDE];
const here = fileURLToPath(new URL(".", import.meta.url));
const missing = INCLUDE.filter((entry) => !existsSync(resolve(here, entry)));

if (INCLUDE.length - missing.length === 0) {
  // Without this, vitest collects nothing and exits 0, which reads as a green
  // real-model run to anyone checking a golden set in on the strength of it.
  throw new Error(
    "vitest.real-llm.config.ts: 0 of " +
      INCLUDE.length +
      " include entries exist on disk, so `npm run test:real-llm` would " +
      "collect nothing and report success. Missing:\n" +
      missing.map((entry) => `  - ${entry}`).join("\n") +
      "\nA tracked set under real-llm/ survives cloning; archive/tests-real-llm/ " +
      "entries require the local iknow-archive checkout (phase 1 untracked archive/)."
  );
}
if (missing.length > 0) {
  console.warn(
    `[test:real-llm] ${missing.length} of ${INCLUDE.length} include entries are absent ` +
      `(local-only archive half, not collected):\n${missing.map((e) => `  - ${e}`).join("\n")}`
  );
}

export default defineConfig({
  test: {
    include: INCLUDE,
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
