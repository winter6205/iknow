---
name: review-report-repair
description: Use when arthurpower:code-review emits "GATE: BLOCKED" or unresolved High, or the operator says "修审查意见" / "fix review findings". Also use when a findings table, JSON, or markdown review report must become root-cause fixes without patch stacking. Skip greenfield design and severity disputes.
bucket: engineering
type: technique
---

# Review Report Repair

Turn a review report into clustered root-cause fixes. This skill does not re-review. `code-review` judges; this skill repairs.

## When to use

- `code-review` just emitted `GATE: BLOCKED` or unresolved High (next slot after that skill)
- Operator supplies a review artifact (`live-review*.json`, markdown review, PR comments dump) or the in-session side-by-side findings table
- Findings must be fixed without if-else stacks that only silence a symptom

## When not to use

- `GATE: PASS` with only Low / no findings — this skill does not fire
- Medium-only with no operator ask to fix now — stay advisory; do not auto-repair
- Greenfield feature design with no review artifact
- Docs-only rewrites with no code findings
- Disputing severity only (re-run `code-review` or ask the operator)
- Applying the report as a blind checklist of micro-diffs without clustering

## Definitions

- **Finding**: one report item (file, line range, severity, message)
- **Root-cause cluster**: multiple findings that share one underlying design/contract bug
- **Surface patch**: a local if/else or silent catch that silences a symptom without fixing the contract
- **Repair unit**: one cluster fixed in one logical change set (tests + code)

## Procedure

### 1. Ingest the report

1. Use the in-session `code-review` aggregation table if present. Otherwise open the path the operator named.
2. Parse every finding into: `file`, `line_range`, `severity`, `message`, optional `suggested_fix`.
3. Count by severity and by file. List High first, then Medium. Skip Low unless the operator asks.
4. Confirm the report’s `commit` / branch tip matches the working tree (or state the mismatch).

Completion: ingest counts recorded; High listed first.

### 2. Skill check (repair context)

1. Confirm product truth docs if findings touch protocol/eval (ADR, tool-schema, eval gates).
2. Confirm verification commands for this repo (typecheck, unit tests, project gates).
3. Do **not** invent new product requirements under the guise of “review wants it.”

Completion: verification commands named; no new requirements invented.

### 3. Cluster by root cause

Group findings into clusters such as:

| Cluster type            | Examples                                               |
| ----------------------- | ------------------------------------------------------ |
| Contract drift          | schema vs runtime validation, dual sources of truth    |
| Error surface           | silent catch, wrong error type, unhandled rejection    |
| Config precedence       | env file order, key not read from the project’s loader |
| API surface hygiene     | test doubles exported from main barrel                 |
| Concurrency / singleton | shared index races, stale module state                 |
| Performance (optional)  | independent async work left sequential                 |

For each cluster write one sentence: **root cause → intended contract → fix shape**.

Completion: every High/Medium finding is in a cluster; each cluster has that sentence.

### 4. Design the fix (anti-patch rules)

For each High/Medium cluster:

1. Prefer fixing the **source of truth** (single registry, single env loader, typed errors).
2. Prefer **fail closed** with typed errors over silent degrade—unless the product already defines an explicit degrade path (document EXIT condition in comment).
3. Prefer extracting shared helpers over copy-paste branches.
4. Reject nested ternary stacks and magic-string special cases without a comment that names the contract.
5. Every behavior change needs a test that would fail before the fix (`test-driven-development` for the implementation slot if the cluster is new behavior).

Completion: each cluster has a contract-level fix shape, not a line-only patch.

### 5. Implement by cluster

1. Fix one cluster at a time when possible.
2. Keep diff scope = task scope (no drive-by refactors). `minimal-change-verifier` if the diff grows a second feature.
3. Update public exports carefully: do not expand the public API for test-only helpers.
4. Never log or print secret values; env **names** only.

Completion: one repair unit per cluster that was in scope.

### 6. Verify

1. Run the project’s required commands (at minimum: typecheck + unit tests).
2. If the project has an eval or CI suite that is part of the landing gate, run it.
3. Grep for regressions related to the clusters (remaining dual truth, bare `catch`).
4. Do not claim “done” here. After repair evidence is captured, the next slot is `verification-before-completion` if the operator is claiming the landing round is finished. Re-run `code-review` only if the operator asks for a second pass on the repair diff.

Completion: commands and exit codes captured; no “done” claim in this skill.

### 7. Report back

Structure the operator reply as:

1. Report ingest (source, commit, counts)
2. Root-cause clusters (table)
3. Changes (files + contract fixed)
4. Validation evidence
5. Deferred findings (with reason)
6. Git status (commit/push only if authorized)

## Anti-patterns (forbidden)

- Applying every comment as a one-line patch without clustering
- Silent `catch` that returns success-shaped data for programming errors
- Re-exporting test fakes from the main package entry
- “Fixed” without re-running typecheck/tests
- Mixing unrelated refactors into the repair change set
- Writing secrets into repo files or chat
- Patching inside `code-review` instead of opening this skill
- Claiming the landing round done without `verification-before-completion`

## Acceptance Criteria

- [ ] Report source and commit identity recorded
- [ ] All High findings either fixed or deferred with an operator-visible reason
- [ ] Medium findings fixed or deferred with reason (default: fix when same cluster as High)
- [ ] No new public test-only exports on the main barrel
- [ ] Typed errors for config/API contract failures (no silent skip of required keys when the mode requires them)
- [ ] Typecheck exit 0
- [ ] Unit tests exit 0 (full suite, or the repo’s documented subset)
- [ ] Project eval/CI gate exit 0 when the project defines one as a landing gate
- [ ] Reply includes evidence (commands + counts), not narrative-only success

## Related

- Judge the diff: `code-review` (this skill is the next slot when that gate is BLOCKED)
- Landing claim: `verification-before-completion`
- New behavior in a cluster: `test-driven-development`
- Diff grew a second feature: `minimal-change-verifier`
