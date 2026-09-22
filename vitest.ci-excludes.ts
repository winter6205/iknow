/**
 * SSOT (single source of truth) for the CI vitest exclude set.
 *
 * Background: the standard GitHub Actions runner container disallows
 * user-namespace network isolation (bwrap --unshare-net → RTM_NEWADDR:
 * Operation not permitted), while bwrap is a hard runtime dependency
 * (spec security-guardrails.md #123). The requireBwrap() guard throws at
 * assembly time, so bwrap-dependent tests are structurally unrunnable on
 * the runner — CI excludes them; tests are not deleted, full verification
 * happens locally on WSL.
 *
 * Why centralized here: the exclude set used to be a 68-item `--exclude`
 * command-line string scattered across two jobs in
 * `.github/workflows/test.yml`. It caused two incidents: once a comment
 * written inside a `\` line-continuation block silently disabled the whole
 * exclude list (docs/handoff/2026-09-02-trace-mcp-read-side-split-t8-ci-flake.md),
 * once entries pointed at deleted files unnoticed. Now
 * `scripts/ci-check-test-excludes.ts` performs two-way validation
 * (forward: bwrap-dependent files must be listed; backward: every listed
 * entry must match a file that actually exists on disk).
 *
 * Consumers:
 *   - vitest.ci.config.ts      (test-full: installs bwrap, full fallback run)
 *   - vitest.ci-fast.config.ts (test-fast: no bwrap, quick PR gate)
 *   - scripts/ci-check-test-excludes.ts (guard; imports this module instead of grepping the workflow)
 *
 * Note: `tests/tui/**` is driven by bun:test (OpenTUI native FFI is
 * bun-only), and vitest.config.ts already excludes `tests/tui/**`, so
 * vitest never collects that directory. No tests/tui entry may appear
 * here — for vitest that would be dead config that only masks the real
 * collection scope. The guard script errors on that shape directly.
 */

/**
 * Exclude set shared by both CI jobs.
 *
 * Semantics = "structurally unrunnable on a GHA runner", two classes:
 *   1. bwrap physical-execution tests — really spawn bwrap; the runner has
 *      no user-namespace, so they cannot start.
 *   2. bwrap assembly-dependent tests — the test itself does not spawn
 *      bwrap, but the assembly chain goes through createBashTool /
 *      createDefaultAciRegistry / createWorkerDeps / runInSandbox /
 *      buildHarnessEngine → requireBwrap and fail-louds when bwrap is
 *      missing (test-full installs bwrap so assembly works, but physical
 *      execution still does not).
 *
 * The trailing note beside each entry gives its class and why it was
 * added; a new entry must satisfy both "actually exists" and "hits the
 * bwrap dependency chain" (the guard enforces the former, BWRAP_PATTERNS
 * the latter).
 */
export const CI_EXCLUDES: readonly string[] = [
  // ---- bwrap physical-execution class (really spawns bwrap; runner has no user-namespace) ----
  "tests/harness/aci/bash-sandbox.test.ts",
  "tests/harness/aci/bash-background.test.ts",
  "tests/harness/aci/bash-output-stop.test.ts",
  "tests/harness/aci/bash-service-loop.e2e.test.ts",
  "tests/harness/aci/demo.test.ts",
  "tests/harness/aci/interrupt-routing.test.ts",
  "tests/harness/aci/tools/bash.test.ts",
  "tests/harness/aci/tools/bash-readonly.test.ts",
  // ADR-0084 last-read ledger uses the real bash tool: createBashTool
  // requireBwraps at assembly time, and every case really spawns bwrap to run
  // cat / grep / sed / rg before asserting the ledger entries — on a runner
  // without user-namespace it throws already at assembly time.
  "tests/harness/aci/tools/bash-last-read.test.ts",
  "tests/harness/aci/tools/grep.test.ts",
  "tests/harness/aci/tools/query-trace.test.ts",
  "tests/harness/aci/tools/list-sessions.test.ts",
  "tests/harness/aci/tools/get-record.test.ts",
  "tests/harness/aci/bash-live-task-root.test.ts",
  // ADR-0092 Round 2 SC11/SC12: real bwrap behavior certification of the
  // workspace-tier fence (home read OK / home write EROFS / two whitelisted
  // writable spots + S2 five out-of-bounds write classes).
  "tests/harness/aci/bash-workspace-mode-fence.test.ts",
  // ADR-0109: physical ro-bind fence for the unbound main checkout (really spawns bwrap).
  "tests/harness/aci/bash-unbound-fence.test.ts",
  // ADR-0092 (global tier): the closed-world read-root test was archived; the
  // same-family invariant is now certified by this file.
  "tests/harness/aci/bash-global-mode-visibility.test.ts",
  "tests/harness/aci/bash-main-session-fence-tmp.test.ts",
  "tests/harness/verify/sandbox-run.test.ts",
  // egress-ssh-bridge T6: private-key readability across the two fs tiers really
  // spawns bwrap (createBwrapFence → spawnSync), mirroring
  // bash-workspace-mode-fence.test.ts. The file header already defers to "the CI
  // exclusion set handled separately"; it was never registered, so on test-full
  // (bwrap installed but the container disallows user-namespace → `--unshare-net`
  // → RTM_NEWADDR) all three cases turned red. Registered here; local WSL keeps
  // full verification.
  "tests/harness/sandbox/ssh-key-fs-modes.test.ts",
  // ADR-0092 SC11/SC12: workspace-tier real bwrap behavior certification on
  // the **verify command surface** (`$TMPDIR` = session tmp nested under home,
  // home write EROFS, home read OK). Parallel to
  // bash-workspace-mode-fence.test.ts: that one pins the bash-tool surface,
  // this one the verify closed-loop default executor (same
  // `it.skipIf(!hasBwrap())` shape; physical execution cannot start on a
  // runner lacking user-namespace).
  "tests/harness/verify/workspace-mode-fence.test.ts",
  "tests/harness/isolation/worktree-gate-live-taskroot-e2e.test.ts",
  "tests/harness/mcp/zero-linkage-guard.test.ts",
  "tests/harness/sandbox/runner.test.ts",
  "tests/harness/sandbox/server.test.ts",
  "tests/harness/aci/tools/skill-output-cap.test.ts",
  // #349 first-run failure set: real child-process MCP stdio chain (spawn
  // fixture server → createMcpManager → AciRegistry.registerExternal →
  // tool_search discover → real invocation); cannot start on a runner
  // without user-namespace.
  "tests/integration/mcp-chain.test.ts",
  // #440 T13 resources twin of mcp-chain: spawns the resources fixture with
  // `spawn(process.execPath, ["…/server.ts"])`. The runner pins Node 20, which
  // cannot execute a bare `.ts` entry (ERR_UNKNOWN_FILE_EXTENSION) — the child
  // exits before the stdio handshake, so createMcpManager marks every real
  // fixture server "failed: Connection closed" and waitForConnected throws.
  // Structurally unrunnable on CI (same class as mcp-chain, not a bwrap-anchor
  // file); the resources-channel invariant stays certified on WSL (Node 22
  // type-stripping): all 21 cases green via `npx vitest run <this file>`.
  "tests/integration/mcp-resources-fixture.test.ts",
  // #337 T11 E2E A: buildHarnessEngine → createDefaultAciRegistry →
  // createBashTool → requireBwrap, fail-loud at assembly time on the runner
  // (added after #349 was rebased onto master).
  "tests/e2e/skill-mcp-acceptance.test.ts",
  // Introduced before #467: the build-engine series really runs the ACI tool loop.
  "tests/harness/build-engine.test.ts",
  "tests/harness/build-engine-mcp-roots.test.ts",
  "tests/harness/build-engine-tool-overflow.test.ts",
  "tests/harness/build-engine-auto-memory.test.ts",
  // Locked sentence 5: assembly must not warm up — the acceptance surface is
  // exactly "zero spawns after a real buildHarnessEngine / createWorkerDeps
  // assembly", and the assembly chain goes → createBashTool → requireBwrap,
  // so it fail-louds at assembly time on the runner. Full verification runs
  // locally on WSL.
  "tests/harness/lsp/lazy-warmup.test.ts",
  "tests/harness/graph/run-graph-assembly.test.ts",
  "tests/harness/prefix-stability/assertion2-matrix.test.ts",
  "tests/harness/disclosure-index-align/sc7-index-demotion.test.ts",

  // ---- bwrap assembly-dependency class (requireBwrap fail-loud, throws at assembly time) ----
  // ACI registry assembly → createBashTool → requireBwrap
  "tests/harness/aci/permission.test.ts",
  // ADR-0097 egress seam: the three bash-surface arms (approval gate / typed
  // failure / proxy wiring) plus the build-engine assembly source-of-truth
  // wiring test all go through createBashTool → requireBwrap.
  "tests/harness/aci/bash-egress-approval.test.ts",
  "tests/harness/aci/bash-egress-inner-bridge.test.ts",
  "tests/harness/aci/bash-egress-typed-failure.test.ts",
  "tests/harness/aci/bash-egress.test.ts",
  "tests/harness/build-engine-egress-wiring.test.ts",
  // ADR-0105 sentinel: entry wiring at the three assembly points goes through fence assembly → requireBwrap.
  "tests/harness/egress-entry-wiring.test.ts",
  // ADR-0107 ssh bridge: three-form lifecycle wiring goes through fence assembly → requireBwrap.
  "tests/harness/egress-three-form-lifecycle.test.ts",
  // ADR-0104 preset T3: the three arms with the approval gate in service go through fence assembly → requireBwrap.
  "tests/harness/sandbox/egress-approval-clean-assembly.test.ts",
  "tests/harness/aci/registry-workspace-root.test.ts",
  "tests/harness/aci/tools/d9-description-guard.test.ts",
  "tests/harness/aci/tools/registry.test.ts",
  "tests/harness/agent-status-bar.test.ts",
  "tests/harness/identity/agent-status-read-rule.test.ts",
  "tests/harness/identity/system-injection.test.ts",
  // ADR-0092: installRoot read-root retired (global tier has no per-root read
  // whitelist); the file was archived and the same-family assembly surface is
  // now certified by bash-wiring.
  "tests/harness/build-engine-bash-wiring.test.ts",
  "tests/harness/build-engine-hooks.test.ts",
  "tests/harness/build-engine-subagent-trace.test.ts",
  // ADR-0088 T2: real buildHarnessEngine assembly resolves tasksDir (two
  // shapes: host-injected / default pool root) → createDefaultAciRegistry →
  // createBashTool → requireBwrap.
  "tests/harness/build-engine-tasks-dir.test.ts",
  // ADR-0099: real buildHarnessEngine assembly resolves memoryDir → createBashTool → requireBwrap.
  "tests/harness/build-engine-memory-dir.test.ts",
  // ADR-0084 Slice B SC5: real buildHarnessEngine assembly reads project permissions
  // → createDefaultAciRegistry → createBashTool → requireBwrap.
  "tests/harness/build-engine-permission-project.test.ts",
  "tests/harness/mcp/build-engine-mcp-overview.test.ts",
  "tests/harness/mcp/build-engine-mcp-startwire.test.ts",
  // ADR-0098 T5/T7: incremental injection / worker snapshot go through real
  // buildHarnessEngine assembly (ACI registry → createBashTool → requireBwrap),
  // throwing at assembly time.
  "tests/harness/skill-index-delta-inject.test.ts",
  "tests/harness/skill-index-snapshot-wiring.test.ts",
  "tests/subagent/worker-skill-index-snapshot.test.ts",
  "tests/build-engine-hooks.test.ts",
  // session-api path → real store + ACI assembly
  "tests/session-api/max-turns-serve.test.ts",
  "tests/session-api/workspace-bind.test.ts",
  "tests/session-api/ensure-deps-aci-tools.test.ts",
  // ADR-0098 SC8: root-bound hub goes buildProductionEngine → buildHarnessEngine
  // → requireBwrap (transitive chain; the test file itself does not hit the guard pattern).
  "tests/session-api/skills-hot.test.ts",
  // ADR-0037 / #814 evidenced: hub executor really mutates → runInSandbox → requireBwrap
  "tests/session-api/hub-worktree-isolation.test.ts",
  // Subagent worker assembly → createWorkerDeps → createBashTool → requireBwrap
  // ADR-0092 Round 2 SC11: fs-tier cross-process propagation (parent spawn env
  // → worker holder) goes through the createWorkerDeps /
  // createDefaultAciRegistry assembly chain and fail-louds at assembly time on
  // the runner (both the spawn exit and bwrap are blocked inside the test, but
  // the anchor is hit).
  "tests/subagent/fs-mode-propagation.test.ts",
  "tests/subagent/worker-identity-root.test.ts",
  "tests/subagent/worker-session-layout.test.ts",
  "tests/subagent/worker-tool-surface.test.ts",
  "tests/subagent/worker.test.ts",
  // ADR-0084 last-read: createWorkerDeps → createDefaultAciRegistry →
  // createBashTool → requireBwrap (throws at assembly time; test-fast does not install bwrap).
  "tests/subagent/worker-last-read-ledger.test.ts",
  // #1071: the untrusted-addendum contract goes through the same createWorkerDeps assembly chain → requireBwrap
  "tests/subagent/worker-addendum-untrusted.test.ts",
  // ADR-0121: worker preimage port threads through createWorkerDeps → requireBwrap
  "tests/subagent/worker-preimage-port.test.ts",
  // settings.subagent.model route probes createWorkerDeps → requireBwrap
  "tests/subagent/worker-model-route.test.ts",
  // #562: subagent contract tests go through the same createWorkerDeps assembly chain
  "tests/subagent/envelope-role.test.ts",
  "tests/subagent/tool-constraints.test.ts",
  "tests/subagent/bash-mode-channel.test.ts",
  "tests/subagent/git-work-discipline.test.ts",
  "tests/subagent/user-agents-wiring.test.ts",
  "tests/subagent/envelope-freeze.test.ts",
  // ADR-0084 Slice B SC5: real createWorkerDeps assembly reads project permissions
  // → createDefaultAciRegistry → createBashTool → requireBwrap.
  "tests/subagent/worker-project-permission.test.ts",
  // CLI-side harness / subagent trace assembly
  "tests/cli/tui-deps-subagent-trace-factory.test.ts",
  "tests/cli/chat-subagent-trace.test.ts",
  // #406: chat × roundtrip cases have createBashTool really spawn echo to restore placeholders
  // (full excludes only e2e.test.ts; fast excludes the whole directory, see CI_FAST_EXCLUDES).
  "tests/harness/secret-roundtrip/e2e.test.ts",
  // ADR-0119 / specs/yolo-mode.md: yolo four-route consistency + holder
  // assembly-chain acceptance. All four go through the bash factory / registry /
  // worker assembly chain → requireBwrap (throws at assembly time; test-fast
  // installs no bwrap); yolo-four-routes calls createBashTool directly.
  // Listed one-by-one rather than by directory: pure-logic cases in the same
  // directories (argv projections etc.) do not depend on physical bwrap
  // execution and stay runnable.
  "tests/harness/aci/yolo-four-routes.test.ts",
  "tests/harness/verify/yolo-build-engine-threading.test.ts",
  "tests/harness/verify/yolo-holder-wiring.test.ts",
  "tests/subagent/yolo-env-wire.test.ts",
  // ADR-0119 background handler-hop: the guard anchor is call-shape, so the
  // createBashTool call here counts as bwrap-dependent even though every
  // construction uses a yolo-ON holder (the assembly probe is skipped by
  // design). Excluded to keep test-fast green; local WSL runs it in full.
  "tests/harness/background/yolo-background-fence.test.ts",
  // ADR-0119 contrast arm for the yolo probe parity: really spawns bwrap
  // (same `it.skipIf(!hasBwrap())` shape as ssh-key-fs-modes.test.ts). The
  // test-full runner installs bwrap but disallows user namespaces, so the
  // physical spawn would turn red there; local WSL keeps full verification.
  "tests/harness/sandbox/yolo-fence-contrast.test.ts",
];

/**
 * Whole directories that test-fast (quick PR gate, no bwrap installed)
 * additionally excludes on top of CI_EXCLUDES.
 *
 * Semantics = "without bwrap installed the whole directory fails / is a slow
 * path", so fast excludes entire directories while full (with bwrap installed)
 * excludes only the physically-executing part inside them (e.g.
 * secret-roundtrip excludes only e2e.test.ts; the three pure-logic cases under
 * patterns/recognize/registry still run).
 */
export const CI_FAST_EXCLUDES: readonly string[] = [
  // End-to-end assembly acceptance: every case starts a real engine; without bwrap installed assembly throws.
  "tests/e2e/**",
  // Cross-module integration: mcp-chain etc. go through ACI assembly.
  "tests/integration/**",
  // Without bwrap installed the whole directory is pointless (full excludes only the single e2e.test.ts).
  "tests/harness/secret-roundtrip/**",
];
