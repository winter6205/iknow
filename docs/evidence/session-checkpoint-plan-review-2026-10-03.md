# Issue: Session-checkpoint A/B/C branches — the storage↔runtime seam is not connected anywhere

- **Date:** 2026-10-03
- **Baselines:** master docs commit `f38894ed2`; Plan A `feat/session-checkpoint-plan-a` @ `6f991fb7d` (43 files, +10593); Plan B `feat/session-checkpoint-plan-b` @ `b3d8b3c91` (4 commits, 23 files, +6721); Plan C `feat/session-checkpoint-plan-c` @ `5b6b753e4` (21 files, +3499). All three worktrees clean.
- **Contract:** [specs/session-checkpoint-architecture.md](../../specs/session-checkpoint-architecture.md) (29 binary criteria) + the three plan docs + ADR-0136.
- **Method:** four read-only review agents (one per plan + one cross-plan integration audit), `dispatched 4, passed 4, failed 0`; the blocking finding below was re-verified by the main agent with direct greps. CI was explicitly out of scope.

## Summary

Each plan individually passes its own isolated checks (three verdicts: PASS WITH FINDINGS; scoped vitest runs green in all three worktrees). The delivery-blocking problem is cross-plan: **Plan A and Plan B each invented a neutral persistence port, and no branch connects them.** After merge, Plan B's runtime/graph/worker publications are silent no-ops and there is no persisted record kind for graph/worker facts at all. The acceptance session must build the join; it cannot merely verify three isolated successes.

## Blocking findings (integration)

### F1 (Critical) — B's `RuntimePersistenceSink` never lands on A's `NativeStatePort`

- A: `src/shared/native-state-port.ts:134` — `publishNativeState(PublishNativeStateRequest)` + `recordFileIntent(...)`; caller must supply `conversationId` + `anchorEventId` (`:90-96`); boundary vocab `"input"|"tool_batch"|"compaction"|"terminal"` (`:30`).
- B: `src/shared/runtime-persistence.ts:221` — `publishSavedState(RuntimeSavedStateRequest<M>)` + `appendOperationFact(...)`; no `anchorEventId` (sink resolved via `RuntimePersistenceBinder.bind(sessionId)` `:235`); boundary vocab `"accepted_input"|"tool_batch_settled"|"compacted"|"terminal_turn"` (`:46`).
- Proof of no connection (main-agent verified): grep of A's port names over B's `src`+`tests` → **0**; grep of B's port names over A's `src`+`tests` → **0**. `createNativeStatePort` (A, `src/session-api/store/native-state-port-host.ts:36`) does not satisfy `RuntimePersistenceSink`.
- Consequence: B's six publication sites (`loop-engine.ts:3050,3554,4171,4273`, `run-graph-tool.ts:548`, `manager.ts:1521,1618` per integration audit) are optional-parameter wires with only test implementors — post-merge they typecheck clean and persist nothing ("Field absent → zero persistence requests", `…-b/src/harness/loop-engine.ts:541`).
- Once naively wired, A and B publish **two different `native_state` records for one accepted input** (A at host `hub.ts:4088` boundary `input`; B at engine `loop-engine.ts:3050` boundary `accepted_input`).
- Fix belongs to the acceptance session: integration adapter (boundary rename map, `anchorEventId` from head read) + a single publishing owner per boundary.

### F2 (Critical) — no persisted record kind for graph/worker facts

A adds exactly two record types (`src/session-api/store/jsonl.ts:314` `native_state`, `:346` `file_intent`); grep `graph_node|worker_progress|GraphNodeFact|WorkerFact` over A's `src` → 0. SC15/SC16/SC17's persisted half is **unimplemented by any branch**, not just unproven. Required: new fact kind + reconcile entry in `recovery-reconcile.ts` (today `reconcileFileIntents` is the sole reconcile entry, zero graph/worker references).

### F3 (High) — nobody calls B's owned-worker stop/sweep on abnormal exit

`stopOwnedWorkers` (`…-b/src/harness/subagent/manager.ts:1640,3185` → `worker-identity-stop.ts:594`) has no production caller in any branch's entry/recovery path; A's `openSessionWithRecovery` (`…-a/src/session-api/recovery-host.ts:117`) never invokes it. Plan B re-scoped this obligation to "the storage/recovery plan" in its own doc (see F5), but Plan A's reconciler is file-only. Orphaned `wait:false` workers survive reopen; the `sweepOwnedWorkers` disk-driven sweep only sees records that were actually written (see F6 for the fail-open hole).

### F4 (High) — merge conflict surface (mechanical, but must be resolved before anything joined runs)

`git merge-tree --write-tree` pairwise (main-agent verified counts via integration audit): exactly 3 conflicted files, order-independent — `CHANGELOG.md` (A+B, both append at same anchor), `src/shared/session-tree-names.ts` (A+C, **identical** `BLOBS_DIR_NAME` addition → semantically aligned), `src/harness/loop-engine.ts` (B+C, 3 adjacent hunks at `:2696,3553,3640`). Remaining ~63 branch files auto-merge. Note `src/harness/aci/tools/` splits silently (A: write/edit/symbol-mutate; B: registry.ts) — auto-merge without conflict signal; verify wiring after merge.

## Per-plan findings (Medium)

| #   | Plan | Finding                                                                                                                                                                                                                        | Evidence                                                                                                                  | Mode               |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| M1  | A    | Commit `6f991fb7d`: 10 diff files fail `npx prettier --check` → pre-commit/lint-staged likely skipped                                                                                                                          | `npx prettier --check` exit 1 on changed-file list (e.g. `src/cli/chat-session.ts:2826`)                                  | ran command        |
| M2  | A    | SC2 "kills the host before/during first model request" proven via publication-failure injection + counting stub adapter, not a real killed host; only the file-publish seam has real SIGKILL child tests                       | `tests/session-api/hub-input-checkpoint.test.ts:64-80`                                                                    | tests + inspection |
| M3  | B    | Spawn-time worker identity-record write failure is **fail-open** (`catch` → `console.warn`, worker keeps running; sweep is disk-record-driven → orphan invisible) — contradicts port's own "required writes fail visibly" rule | `…-b/src/harness/subagent/manager.ts:1473-1485`; `worker-identity-stop.ts:598`; port doc `runtime-persistence.ts:209-219` | inspection         |
| M4  | B    | Branch rewrote its own plan doc (+81 lines) re-scoping fresh-process kill/reopen halves to "Plan A" — the partition assumption that F1/F3 show A did not actually fulfil                                                       | in-branch `docs/implementation-plans/session-checkpoint-runtime-workers.md` diff                                          | inspection         |
| M5  | C    | SC22 shared-pool discrimination vs A's real `blobs/native/` bodies proven only against a stand-in fixture; joined discrimination needs A's non-trace tags + joined test (deferred by plan design)                              | `…-c/src/harness/trace/trace-body.ts:1-30`; plan Integration-constraints                                                  | inspection         |

## Per-plan findings (Low)

- **A:** store does not interpret `runtimeFacts` (credential/handle/grant exclusion enforced only by producer) `native-state-port.ts:80-88`; SC7 re-anchoring-after-rewind case untested `jsonl.ts:712-737`; TUI open omits `dirtyRoot` → post-rebind intents classify `root_identity_mismatch` fail-toward-visible, untested `recovery-host.ts:33-41`; helper `firstInvalidOptionalField` still complexity 14 vs limit 10 `schema.ts:266`.
- **B:** `typecheck:tests` adds exactly +2 errors (unused `NEXT`, dead `agentType` fixture) `tests/subagent/subagent-continue-refusal-text.test.ts:47,49`; two unregistered model-visible error strings `run-graph-tool.ts:592,601` (SC26 roster); identity record uses plain `writeFileSync` (torn → fail-closed, verdict rewrite race surfaces as `unrecorded`) `worker-identity-record.ts:295`.
- **C:** no dedicated compaction-context fixture for Task 2 acceptance (mitigated: evidence read off final `params` at dispatch `anthropic-adapter.ts:987`; inspection-only); committed plan-doc status text self-contradictory ("no commit yet" inside the commit) `5b6b753e4` diff.

## 29-criteria joined classification

Per integration audit (rows are its table; counts re-derived from rows):

- **Covered by A alone (13):** SC1, SC1a, SC6(+inert B duplicate), SC7, SC9, SC9a, SC10, SC11, SC12, SC13, SC14, SC23, SC27(in-process; second-open leg depends on B's sweep F3)
- **B alone (1, partial):** SC18 (runtime portion; live post-recovery chain needs joined host)
- **C alone (3):** SC19, SC20, SC22(local contract; joined half M5)
- **Requires joined runtime, currently unproven (9):** SC2, SC3, SC4, SC5, SC8, SC16, SC17, SC21, SC26
- **Not covered by any branch (3):** SC15 (F2), SC24 (no PTY evidence anywhere), SC25 (the central matrix itself)

## What the acceptance session must run (joined checks, none isolated-provable)

1. Resolve F4 conflicts (A→B→C assumed order), then full `npm test` + `typecheck` + `typecheck:tests` on merged tree.
2. Build F1 adapter + single-owner publication per boundary; add F2 fact kind + reconcile; wire F3 sweep into `openSessionWithRecovery`.
3. Fresh-process crash suite: real forked host, SIGKILL at input-checkpoint and mid-batch, reopen in a second process (SC1/2/5/27); torn trailing line + corrupt body + invalid head in fresh process (SC1a); two-file kill/reopen/re-reopen idempotence (SC10/11/27); real graph settle+fail kill+reopen, no respawn (SC15); host-driven worker sweep with pid+starttime, reused-PID never signalled (SC16/17); allow-once grant not replayed after reopen (SC18).
4. SC24 PTY run via `mcp__terminalcp__terminalcp` under ordinary permission posture (not `--yolo`).
5. C's trace reader against A's **real** `blobs/native/` writer output (SC20/21/22); final-wire oracle on merged `loop-engine.ts` (SC19/21).
6. SC26 joined diff review incl. B's `resumeRefusalMessage` + prompt-guide Gap row; run real-model half if the merged trajectory touches a golden set.
7. M1: re-run prettier gate before merge; re-run `s5-complexity` on merged tree.

## Explicitly not validated here

Full `npm test`, merged-tree anything, real PTY, real-model runs — no agent executed these; CI ignored per operator direction. Source-inspection-only claims are marked as such above.

_Local ignored note: file created for the acceptance session under `docs/evidence/`; no credentials included._
