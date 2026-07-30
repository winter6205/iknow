# 021 — Archived: Legacy EVAL + agent-loop retired subset

> Archived under GitHub issue #48 (021) "砍旧 EVAL + 退役旧 src/agent-loop/" on 2026-07-30.
> See wayfinder map #44 Decisions-so-far Q1–Q4 for the grilling record.

## What's here

### `src/eval/` (6 files, archived in full)

The 020-predecessor evaluation pipeline. Replaced by harness + i9/i10 smoke scripts. All files moved here:

- `cli.ts` — entry, was `npm run eval`
- `lexicon.ts` — `NOTE` / `ANSWER_RX` / `GATE_ID` / `DEFAULT_MAX_STEPS` / `EVAL_MAX_HOPS`. The `NOTE` constant was inlined into `src/agent-loop/loop.ts` so #51's session-API cutover keeps access.
- `policy-checks.ts`
- `run-suite.ts` — `loadEvalSuite` / `runEvalSuite` / `runSample` / `RELEASE_GATE_TARGETS`
- `score-trajectory.ts` — `scoreTrajectory` / `checkHardConstraints`
- `types.ts` — `EvalSample` etc.

### `docs/iknow-spec/docs/eval/eval-set.draft.json` (32-sample fixture)

The `DRAFT-EVAL-SET` 32-sample input set (18 easy / 8 hard / 6 edge). Moved here from `docs/iknow-spec/docs/eval/`.

## Why archived (not deleted)

Per #48 Resolution Q1: operationally retired under "归档非删除" principle (wayfinder Decisions-so-far). The fixture preserves audit trail for any post-hoc reference to the trajectory suite's last-known state (hard_pass_rate=1.0, mean_trajectory_score≈0.831 per `docs/handoff/2026-07-12-p3-trajectory-closeout.md`).

## Cross-cutting context

- **#47 (020) CLI 路径切到 harness** — closed 2026-07-30. The eval pipeline was already obsolete after the CLI switched to harness; this archive formalises the retirement.
- **#51 (Session API 迁移到 harness)** — blocked by 020 ✓ + 021 (this archive). When #51 closes, `src/agent-loop/{loop,llm-agent,llm-client}.ts` + `priors.ts` + `tool-defs.ts` + `trace.ts` + `session.ts` (entire `src/agent-loop/` directory) and `src/cli/runtime.ts::buildAgent` will be retired as a unit. The inlined `NOTE` constant in `loop.ts` will be retired with `loop.ts` itself.
- **`src/cli/runtime.ts::buildAgent`** is the single live consumer of `src/agent-loop/` and is preserved until #51 closes. `web/dist` (2026-07-27 build) still serves the Session API front-end.

## Out of scope of #51 / #54 follow-ups

- **#54 (raceModel abort)** — engine-timeout HTTP-not-cancelled fix; 019 Q2c followup. Independent of this archive.
- **`src/index.ts` re-exports removed** under #48 Q3 — this archive is independent of public surface; the re-export cleanup is committed in the same PR.

## Pointer for future readers

If you need to resurrect a trajectory-suite check (e.g. for a regression investigation), the inputs are here in `docs/iknow-spec/docs/eval/eval-set.draft.json`. The harness consumer for evaluating trajectory semantics lives in `src/harness/` and is exercised by `scripts/i9-real-anthropic-adapter-smoke.ts` + `scripts/i10-cli-harness-smoke.ts`.
