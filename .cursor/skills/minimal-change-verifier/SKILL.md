---
name: minimal-change-verifier
description: Use when a diff may include a second feature or drive-by, a new dependency appears without justification, or pre-commit tests are skipped.
bucket: engineering
---

# Minimal Change Verifier

S6 checks **scope**: every hunk belongs to the stated task. Drive-by edits, a second feature, and unexplained deps are out. How many git commits to land is not this skill — that lives in the operator's global commit section.

## When to use

- A diff may include files outside the stated task
- A new dependency is added
- Pre-commit tests are about to be skipped
- A drive-by lint or unrelated fix is sitting in the same working tree

## When NOT to use

- Single-character typo fix (no scope)
- Pure comment / doc fix with no code change
- Pure formatting handled by a configured formatter
- Deciding how to split or squash commits

## Dispatch

This step is handled by `arthurpower:minimal-change-verifier-agent`. When the diff may be over scope, a new dep appears, or pre-commit is about to be skipped, dispatch with `subagent_type: "arthurpower:minimal-change-verifier-agent"` instead of running it on the main thread. Pass: diff scope + this skill's criteria + evidence shape (file:line + PASS/FAIL). Soft trigger: should dispatch, not must; an occasional main-thread run is an acceptable fallback.

## Procedure

1. Run `git status` + `git diff --stat`. Confirm scope matches the task description. Completion: every path is in-scope or explicitly foreign.
2. Read every hunk: is every change required by the task? Unstage foreign hunks. Completion: no drive-by remains in the landing diff.
3. If a new dep appears, confirm YAGNI justification is in the PR body (handoff to defensive-contract-validator). Completion: PR body has the note, or no dep changed.
4. Confirm the change includes the tests that prove it. Completion: no "tests later" in the diff.
5. Run pre-commit tests. If skipped, the change does NOT land. Completion: exit 0; no `--no-verify`.
6. Confirm lockfile is updated iff a dep changed. Completion: both sides match, or neither changed.

## Rationalization Table

| Excuse                                                    | Reality                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| "I'll fix the unrelated typo in this change too"          | Foreign edit = second task. Leave it out.                           |
| "Tests are slow, skip them just this time"                | Pre-commit exists to catch breakage. Skipping = unverified landing. |
| "Lockfile updated even though no dep changed, regenerate" | Lockfile drift = false dep signal. Separate chore.                  |
| "New dep is tiny, no YAGNI doc needed"                    | Tiny deps rot too. YAGNI in the PR body is the record.              |
| "Drive-by lint fix is harmless"                           | Drive-by lint is not this task. Unstage it.                         |

## Red Flags - STOP list

- `git status` shows files unrelated to the task in the diff
- `package.json` / `requirements.txt` changed with no corresponding dep entry in PR body
- Pre-commit hook bypassed with `--no-verify`
- Lockfile diff without dep diff, or dep diff without lockfile diff
- Tests marked `.skip` / `#[ignore]` without an issue link
- "Will land tests later" comment in code

## Acceptance Criteria

- [ ] Diff scope matches the task description (no unrelated files)
- [ ] Pre-commit tests run and exit 0 (no `--no-verify`, no `.skip` added in this change)
- [ ] New dep has YAGNI justification in PR body
- [ ] Lockfile diff iff dep diff
- [ ] Tests for this task are in the same change

## Verification

- `git diff --stat` shows only task-relevant files
- `npm test` / `pytest` exit 0
- Lockfile diff iff dep change

Scope examples: [`references/scope-example.md`](references/scope-example.md). Binary list: [`references/criteria.md`](references/criteria.md).
