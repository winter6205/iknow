---
name: minimal-change-verifier
description: Use when preparing a commit, splitting a commit, adding a dependency, a commit message starts with refactor, a commit touches files outside task scope, a new dependency appears without justification, pre-commit tests are skipped, or a commit mixes refactor with feature/fix.
bucket: engineering
---

# Minimal Change Verifier

A commit is **one logical task**: one feature, one fix, one refactor. Mixing them breaks rollback, breaks bisect, breaks blame. Pre-commit is the gate — every test must run, every lockfile diff must correspond to a dep diff, every file in the diff must serve the stated task.

## When to use

- Right before `git commit`
- A commit message starts with `refactor:`
- A diff touches files outside the stated task scope
- A new dependency is added
- Pre-commit tests are about to be skipped
- A single commit is mixing `refactor:` with `feat:` / `fix:` / `perf:`

## When NOT to use

- Single-character typo fix (no scope)
- Pure comment / doc fix with no code change
- Pure formatting handled by a configured formatter

## Dispatch

本环节由 `arthurpower:minimal-change-verifier-agent` 承接。识别到准备 / 拆分 commit、新增依赖、commit 触及任务范围外文件、或 refactor 混入 feature 等验证时机时，用 Agent 工具以 `subagent_type: "arthurpower:minimal-change-verifier-agent"` 派发，而非在主线程自跑。派发时传：diff 范围 + 本 skill 判据 + 证据格式（file:line + PASS/FAIL）。软触发：应当派，非必须派；偶发主线程自跑属可接受降级，不视为违规。

## Procedure

1. Run `git status` + `git diff --stat`. Confirm scope matches the task description.
2. Read every hunk: is every change required by the task? Reject drive-by refactors.
3. If `refactor:` appears in the commit message, the commit must NOT also contain `feat:` / `fix:` / `perf:`. If it does, split.
4. If a new dep appears, confirm YAGNI justification is in the PR body (handoff to defensive-contract-validator).
5. Run pre-commit tests. If skipped, the commit does NOT land.
6. Confirm lockfile is updated iff a dep changed. Confirm no lockfile update without a dep change.

## Rationalization Table

| Excuse                                                    | Reality                                                                            |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| "Refactor and feat in same commit, it's all related"      | Related is not the same task. Split. Bisect and rollback break otherwise.          |
| "I'll fix the typo in this commit too"                    | Drive-by fix = drive-by risk. Use a separate commit for unrelated edits.           |
| "Tests are slow, skip them just this time"                | Pre-commit exists to catch breakage. Skipping = unverified commit.                 |
| "Lockfile updated even though no dep changed, regenerate" | Lockfile drift = false dep signal. Regenerate as a separate chore commit.          |
| "It's a small refactor, doesn't need its own commit"      | Refactor + feat mixed = bad bisect. Split into two commits even if one is 3 lines. |
| "New dep is tiny, no YAGNI doc needed"                    | Tiny deps rot too. YAGNI doc in PR body = 1 minute.                                |
| "Drive-by lint fix is harmless"                           | Drive-by lint fix muddies `git blame` and `git bisect`. Separate commit.           |

## Red Flags - STOP list

- `git status` shows files unrelated to the task in the diff
- Commit message has `refactor:` plus `feat:` / `fix:` / `perf:` in the same commit
- `package.json` / `requirements.txt` changed with no corresponding dep entry in PR body
- Pre-commit hook bypassed with `--no-verify`
- Lockfile diff without dep diff, or dep diff without lockfile diff
- Tests marked `.skip` / `#[ignore]` without an issue link
- "Will land tests in next commit" comment in code

## Acceptance Criteria

- [ ] Commit message does not mix `refactor:` with `feat:` / `fix:` / `perf:`
- [ ] Diff scope matches the task description (no unrelated files)
- [ ] Pre-commit tests run and exit 0 (no `--no-verify`, no `.skip` added in this commit)
- [ ] New dep has YAGNI justification in PR body
- [ ] Lockfile diff iff dep diff
- [ ] No "I'll add the test in the next commit" — test is in this commit or doesn't land

## Required Baseline

**Zero tolerance**: `refactor:` mixed with `feat:`/`fix:`/`perf:` in one commit. One commit = one logical task, full stop.

## Verification

- `git log -1 --pretty=%B` shows single-purpose message
- `git diff --stat HEAD~1` shows only task-relevant files
- `npm test` / `pytest` exit 0
- `git diff --stat HEAD~1 -- '*lock*' '*.lock' package-lock.json` iff dep change
- `git log -1 --pretty=%B | grep -E "^(refactor|feat|fix|perf):"` returns exactly one conventional prefix
