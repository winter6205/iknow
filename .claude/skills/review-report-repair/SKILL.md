---
name: review-report-repair
description: "Use when an automated or human code review report (JSON/markdown with per-file findings) must be turned into root-cause fixes without patch stacking, after a commit or staged review is delivered."
version: 0.1.0
type: technique
tags: [CodeReview, RootCause, Repair, QualityGate]
---

# Review Report Repair

Process skill for **accepting a review report and repairing code at root cause**.  
Does not prescribe orchestration topology, staffing, or parallelization strategy—only the repair discipline and acceptance gates.

## When to use

- Operator supplies a review artifact path (`live-review*.json`, markdown review, PR comments dump)
- Findings must be fixed with zero regressions and no “if-else stack” patches
- Post-commit or post-stage review follow-up (e.g. after feature merge)

## When not to use

- Greenfield feature design without a review artifact
- Pure documentation rewrites with no code findings
- Disputing severity only (use a re-review request instead)
- Applying the report as a blind checklist of micro-diffs without root-cause clustering

## Definitions

- **Finding**: one report item (file, line range, severity, message)
- **Root-cause cluster**: multiple findings that share one underlying design/contract bug
- **Surface patch**: a local if/else or silent catch that silences a symptom without fixing the contract
- **Repair unit**: one cluster fixed in one logical change set (tests + code)

## Procedure

### 1. Ingest the report

1. Open the report path given by the operator.
2. Parse every finding into: `file`, `line_range`, `severity`, `message`, optional `suggested_fix`.
3. Count by severity and by file. List High first, then Medium. Skip Low unless operator asks.
4. Confirm the report’s `commit` / branch tip matches the working tree (or state the mismatch).

### 2. Skill check (repair context)

1. Confirm product truth docs if findings touch protocol/eval (ADR, tool-schema, eval gates).
2. Confirm verification commands for this repo (typecheck, unit tests, eval suite).
3. Do **not** invent new product requirements under the guise of “review wants it.”

### 3. Cluster by root cause

Group findings into clusters such as:

| Cluster type | Examples |
|--------------|----------|
| Contract drift | schema vs runtime validation, dual sources of truth |
| Error surface | silent catch, wrong error type, unhandled rejection |
| Config precedence | env file order, key not read from dotenv |
| API surface hygiene | test doubles exported from main barrel |
| Concurrency / singleton | shared index races, stale module state |
| Performance (optional) | independent async work left sequential |

For each cluster write one sentence: **root cause → intended contract → fix shape**.

### 4. Design the fix (anti-patch rules)

For each High/Medium cluster:

1. Prefer fixing the **source of truth** (single registry, single env loader, typed errors).
2. Prefer **fail closed** with typed errors over silent degrade—unless product already defines an explicit degrade path (document EXIT condition in comment).
3. Prefer extracting shared helpers over copy-paste branches.
4. Reject nested ternary stacks and “magic string” special cases without JSDoc.
5. Every behavior change needs a test that would fail before the fix.

### 5. Implement by cluster

1. Fix one cluster at a time when possible.
2. Keep diff scope = task scope (no drive-by refactors).
3. Update public exports carefully: do not expand the public API for test-only helpers.
4. Never log or print secret values; env **names** only.

### 6. Verify

1. Run the project’s required commands (at minimum: typecheck + unit tests).
2. If the project has an eval suite that is part of CI, run it.
3. Grep for regressions related to the clusters (e.g. remaining dual truth, bare `catch`).
4. Do not claim “done” without captured exit codes / pass counts.

### 7. Report back

Structure the operator reply as:

1. Report ingest (path, commit, counts)
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
- Mixing unrelated refactors into the repair commit
- Writing secrets into repo files or chat

## Acceptance Criteria

Binary:

- [ ] Report path and commit identity recorded
- [ ] All High findings either fixed or deferred with explicit operator-visible reason
- [ ] Medium findings fixed or deferred with reason (default: fix when same cluster as High)
- [ ] No new public test-only exports on the main barrel
- [ ] Typed errors for config/API contract failures (no silent skip of required keys when mode requires them)
- [ ] Typecheck exit 0
- [ ] Unit tests exit 0 (full suite)
- [ ] Eval suite exit 0 when the project defines one as a gate
- [ ] Reply includes evidence (commands + counts), not narrative-only success

## Verification

```
Skill type: technique
Bar level:  minimum
```

### How to verify this skill is followed

After a repair run, the operator should see:

1. A cluster table (not only a flat comment list)
2. At least one test or typecheck reference per High cluster
3. Explicit deferred list if any High remains open

### RED baseline (why this skill exists)

Without it, agents tend to:

- Patch the cited line only
- Swallow errors to “make CI green”
- Expand public API with test helpers
- Skip re-running full gates

## Red Flags

- Diff only touches comment line numbers with no contract change
- New bare `catch {}` or empty catch without EXIT comment
- `Fake*` or `*ForTests` re-exported from main `index`
- Env key still unreadable from `.env.local` after “fix”
- Success claimed without typecheck/test output
- Commit mixes feature work with review repair without labeling

## Related

- Produce review artifacts: `v-code-review` (`live-review*.json` / `raw_comments[]`)
- Product eval gates: `agent-evaluation-system`
- Lifecycle context: `agent-development-lifecycle`
- Project verification commands: `npm run typecheck`, `npm test`, `npm run eval`
