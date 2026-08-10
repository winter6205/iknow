---
name: systematic-debugging
description: Use when debugging a test failure, build break, unexpected runtime error, flaky test, or hanging process. Triggers on phrases like "fix this bug", "getting an error", "failing test", "flaky", "hanging", "halfway through debugging", "this used to work", "intermittent failure", "stack trace shows X", or any case where behavior does not match expectations. Prevents shotgun debugging.
bucket: engineering
---

# Systematic Debugging

## Overview

Random fixes waste time and create new bugs. Quick patches mask underlying issues.

**Core principle:** ALWAYS find root cause before attempting fixes. Symptom fixes are failure.

**Core principle:** Every claim of "fixed" must rest on a green failing test plus the failing command actually working end-to-end, not on hypothesis or pattern-matching.

**Iron law:** No fixes without root cause investigation first. No "fixed" claim without failing test going green. If you cannot articulate the root cause in one sentence, you are not ready to fix.

## When to Use

Use for ANY technical issue: test failures, build breaks, unexpected errors, flaky tests, hanging processes, or behavior that does not match expectations.

**Use this ESPECIALLY when:** under time pressure, "just one quick fix" seems obvious, 3+ fix attempts already tried, previous fix didn't work, or you don't fully understand the issue.

**Don't skip when:** issue seems simple (simple bugs have root causes too), in a hurry (rushing guarantees rework), or user wants it fixed NOW (systematic is faster than thrashing).

For detailed trigger phrases and full exclusion criteria, see `references/when-to-use-detail.md`.

## When NOT to Use

Do not load this skill when:

- Design discussion or trade-off analysis (use `multi-round-self-review` instead)
- Trivial 1-line typo with the fix obviously visible (stack trace points directly at it)
- User explicitly said "skip debugging, just patch it"
- Clearly external infra failure (e.g. GitHub down, network outage) — verify, do not debug

## Procedure

Four ordered phases. Each MUST be completed before the next. Do not skip phases even under external pressure.

1. **REPRODUCE** — capture the failure deterministically.
   1a. Identify the exact failing command or failing test (path, args, env).
   1b. Run it once; capture full stdout, stderr, and exit code.
   1c. Re-run N times; confirm fail rate >= 90% (else add fixture / seed / mock until deterministic).
   1d. Save the captured output as the ground-truth reference for later phases.

   **GATE**: If Q1 (failing test exists) or Q2 (root cause identified) = NO → STOP, return to Phase 1. Do not enter Phase 4.

2. **ISOLATE** — bisect to the offending change, not the symptom location.
   2a. Run `git bisect start` / `git bisect bad` / `git bisect good` (or `git log --oneline -20` + read in reverse).
   2b. Identify the offending commit, line, or config that introduced the failure.
   2c. Trace data backward from the symptom to where the bad value originates — that is the root cause candidate.
3. **INSTRUMENT** — add minimum evidence at the hypothesized root cause.
   3a. State the root-cause hypothesis in one sentence before adding any log.
   3b. Add the smallest possible log / print / debugger break at the hypothesis site (NOT at the symptom site).
   3c. Add one log at each boundary crossing (function entry/exit, API request/response) only if needed.
   3d. Run once, read evidence; confirm hypothesis OR form a new one and repeat.
4. **FIX** — apply minimum change at root cause and verify.
   4a. Make ONE change at the root cause. No bundled refactors, no "while I'm here" tweaks.
   4b. Re-run the original failing test; confirm it goes red-to-green.
   4c. Run the full suite; if new failures appear, the fix is wrong — revert and restart Phase 1.
   4d. Smoke-test related paths for new failure modes (shared code, callers, dependents).

If the same problem persists after 3 fix attempts: STOP, reload this skill, restart from Phase 1.

**Debug-stop rule (3 attempts failed → STOP and restart Phase 1):**

| #   | Trigger                                | Action                                                                        |
| --- | -------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Same problem, 3 fix attempts failed    | STOP, load this skill, restart from Phase 1                                   |
| 2   | 2 max_turns exhausted                  | Split into smaller sub-tasks + load `subagent-driven-development`             |
| 3   | Sub-agent also failed                  | Shrink scope to smallest verifiable unit + load `dispatching-parallel-agents` |
| 4   | Sub-agent single-file edit > 500 lines | STOP, require split into smaller files                                        |

For detailed phase steps and worked example, see `references/four-phases-detail.md`.

## Acceptance Criteria

Before claiming "fixed", every question must answer YES:

- Q1: Does a failing test exist that reproduces the bug? [Y/N]
- Q2: Is the root cause identified in plain language (not symptom location)? [Y/N]
- Q3: Is the fix the minimum change with no scope creep or bundled refactor? [Y/N]
- Q4: Did the original failing test go green? [Y/N]
- Q5: Is the full test suite still green with no new failures? [Y/N]
- Q6: Were related paths smoke-tested for new failure modes? [Y/N]

## Verification

5 runnable commands. ALL must exit 0 / green before reporting "fixed":

1. `pytest tests/test_<failing>.py -v` — exit 0 (Python projects)
2. `pnpm test` (or `npm test` / `vitest run`) — exit 0
3. `git diff --stat` matches fix scope (no creep into unrelated files)
4. `git status` clean or only expected fix files staged
5. Report states both: root cause identified AND fix verified end-to-end

**Always-run:** re-run failing command and confirm pass; run full suite; show failing test going red-to-green.

**Conditional:** `git bisect log` saved into commit body (when bisect used); smoke test of related paths (when fix touches shared code).

End-to-end verification is the only ground truth.

## Rationalization Table

Reject these rationalizations before applying any fix. Each row maps the excuse to why it sounds right, the counter-evidence, and the correct action.

| Rationalization                        | Why it sounds right                              | Counter-evidence                                        | Correct action                                                                    |
| -------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| "It's obviously X, just fix it"        | Stack trace or symptom location is staring at us | Obvious is the rationalization that ships the wrong fix | Instrument first; prove the hypothesis with evidence                              |
| "I'll just try this and see"           | Cheap experiment, may unblock fast               | Trying without hypothesis is shotgun-debugging          | State the hypothesis in one sentence, then test it                                |
| "Authority says it's a simple bug"     | Senior / docs / chat said so                     | Authoritative claim does not eliminate root cause       | Run one repro phase — wasted fixes cost more than 10 min of evidence              |
| "It's flaky, can't reproduce"          | Saw it pass once, saw it fail once               | Flaky = not yet understood                              | Add deterministic reproduction (seed / fixture / mock); fail rate >= 90% required |
| "Fix one thing, break another, normal" | New failure looks unrelated to the fix           | Fix-then-break = wrong fix                              | Bisect; rerun full suite; new failure means revert and restart Phase 1            |
| "I already fixed it"                   | Code change is in place and reads correctly      | Without the failing test going green, nothing is fixed  | Run the original failing test; report only when it goes red-to-green              |
| "This is the 4th try, ship any fix"    | Time pressure, user wants progress               | 4th try = 3+ failures = STOP per debug-stop rule        | Reload this skill, restart from Phase 1, shrink scope                             |

For extended pressure scenarios, see `references/rationalization-and-redflags.md`.

## Red Flags — STOP

If you catch yourself thinking or doing any of these, STOP and return to Phase 1:

- Patching code without the failing test in hand
- Patching code without identifying root cause (only saw symptom location)
- Adding a `try/except` without understanding WHY it fails (violates `error-handling-enforcer`)
- 3+ fix attempts in one session without reloading this skill
- Reporting "fixed" without the failing test going green
- Logging the symptom location but not the cause (instrumentation without hypothesis)
- Claiming "works in dev, fails in prod" without reproducing the prod environment first
- Adding `// FIXME` or `# TODO` instead of fixing (deferral = failure)
- Inventing a "pattern" from a single occurrence (1 occurrence is not a pattern; N>=3 required)

For the extended red-flag list and worked examples, see `references/rationalization-and-redflags.md`.

## Required Baseline

**Rule (zero tolerance):** No fix is applied without (a) a failing test in hand and (b) the root cause stated in plain language. Compliance is measured by two artifacts: a failing test exists that reproduces the bug, and the root cause is written in one sentence (not a stack-trace location, not a symptom description). The gate that enforces this: Q1 and Q2 in the Acceptance Criteria section below must both answer YES before any code change in Phase 4. If either is NO, return to Phase 1.

## Related Skills

Immediate neighbors in the debugging flow (full roles in `references/when-to-use-detail.md`):

- `subagent-driven-development` — when the debugging task is too large for one session and must be delegated while preserving context.
- `dispatching-parallel-agents` — when a single fix attempt fails and you need to fan out multiple hypotheses to sub-agents in parallel.
- `multi-round-self-review` — when the root-cause investigation surfaces multiple competing hypotheses that need structured critique.
- `error-handling-enforcer` — enforces S3 (no empty catch, no silent swallow) when the proposed fix touches error-handling paths.
- `verification-before-completion` — gates the final "fixed" claim on end-to-end verification, not on code-reading.

## Cross-references

L1 rules this skill depends on: zero-tolerance failing-test gate, no-scope-creep on commits, root-cause-before-fix discipline. See `references/when-to-use-detail.md` for the full mapping.
