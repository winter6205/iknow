---
name: verification-before-completion
description: Use when about to claim 完成 / done / fixed / passing / ready to ship / 跑过 / 真值, before git commit or push, when a subagent reports success, or before marking a TaskList task complete. Enforces evidence before assertions — actual output captured in full, not remembered or paraphrased.
bucket: engineering
---

# Verification Before Completion

## Context-Loop Verification Hooks

When the success criterion touches context-loop artifacts, this skill MUST additionally verify:

1. **CONTEXT.md / ADR schema**: If the change writes to `docs/CONTEXT.md`, `docs/CONTEXT-MAP.md`, or `docs/adr/NNNN-*.md`, run `pre-context-write-guard.cjs` validation manually and confirm exit 0 (or assert the hook already exited 0 in the session log). Schema violations are an automatic FAIL.
2. **Write authority**: Confirm any CONTEXT.md or ADR edit was made by `domain-modeling` (or routed through it). Direct Edit by other skills = router violation = FAIL.
3. **Read-side freshness**: Confirm the change does not contradict an existing ADR (`docs/adr/`). If it does, the change MUST carry the annotation `> Contradicts ADR-NNNN — but worth reopening because <证据>`. Missing annotation on contradicted ADR = automatic FAIL.
4. **ADR three-condition gate**: If a new ADR was proposed in this change, verify all three conditions (Hard to reverse ∧ Surprising w/o ctx ∧ Real trade-off) were checked. Missing one = automatic FAIL.

These checks run alongside the standard verification procedure (§Procedure below).

## When to use

- About to claim "完成" / "done" / "fixed" / "passing" / "ready to ship" in chat or report
- Marking a task complete in TaskList / todo
- Before `git commit` (even amend) or `git push`
- Before declaring success in any user-facing message
- After subagent returns "success" — verify independently before trusting

## When not to use

- Trivial edits (typo fix in comment, single-line rename with no logic change) — user waived verification by context
- Design discussion / brainstorming before any implementation exists
- User explicitly says "skip verification" / "先这样, 不用验" — record the waiver, still produce evidence if asked later

## Procedure

1. **Identify the success criterion** — what does "done" mean? Write it as a binary, observable predicate (e.g., "pytest tests/test_x.py exits 0", "build artifact present at path", "user reproduces the fix manually").
2. **Run the actual test** — execute the real command (`pytest -v`, `pnpm test`, `curl localhost:8765/health`, `git diff --stat`). Fresh run, not a cached / summarized / remembered result.
3. **Capture the actual output** — paste it in full into your report (or save to file). Don't paraphrase "it works". 实测输出 > 主观描述.
4. **Compare output against the criterion** — does the captured output match the binary predicate from step 1? If yes, evidence = present. If no, claim = forbidden.
5. **If mismatch: stop, fix, re-run** — do not rationalize ("应该可以", "看起来对"). Re-run from step 2 with corrected code.
6. **Report with the success format**: `PASS = <criterion> <actual evidence>` (一行, 表格 + 行号 + 实测值). 不写 "完成" without 实测输出.
7. **Offer rule distillation (task-end, ask-only)** — after the PASS report, ask in prose whether this task produced a durable lesson worth persisting (a correction, a repeated mistake, a new convention). If yes, tell the operator to run `/self-evolving-rules` themselves. **Ask only — never invoke it**: `self-evolving-rules` is user-invoked (`disable-model-invocation: true`), so the model must not fire it; the operator types the command. Skip the offer for trivial edits, or when the operator has already declined this session.

## Acceptance Criteria

- [ ] Test ran in this session, not skipped, not remembered from prior run
- [ ] Actual output captured (paste / file), not summarized or paraphrased
- [ ] Output matches the success criterion (binary check)
- [ ] If mismatch surfaced, code was fixed and re-run, not rationalized
- [ ] Report contains `PASS = ...` 一行 with concrete evidence (exit code, line count, screenshot path)
- [ ] After PASS, the rule-distillation offer was made in prose (or skipped for cause); `/self-evolving-rules` was NOT auto-invoked

A worked example covering the 6 core verification steps is in [`references/example.md`](references/example.md).

## Verification

```
Skill type: discipline
Bar level:  discipline
```

**Verification commands** (runnable):

```bash
# 1. Test exit code
pytest -v 2>&1 | tail -20; echo "EXIT=$?"

# 2. Build / lint
pnpm test 2>&1 | tail -30; echo "EXIT=$?"

# 3. Diff scope matches task (no creep)
git diff --stat HEAD~1

# 4. Report line check (must contain PASS = ...)
grep -E "^PASS =" reports/latest.md
```

## Rationalization Table

| Excuse                          | Reality                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| "It works on my machine"        | Test in the runtime user uses. User on Windows → test on Windows. Cross-platform handwave ≠ verification. |
| "I'm confident"                 | Confidence is not evidence. Run the command.                                                              |
| "Tests are slow, skip"          | Slow tests still pass or fail. Skip = no signal = can't claim done.                                       |
| "I manually tested"             | Manual is not automated, not reproducible. 实测输出 = the only ground truth.                              |
| "The change is trivial"         | Trivial changes still have bugs. 30-second test catches them.                                             |
| "I'll add tests in next commit" | Next commit ≠ this commit. Don't split verification across commits.                                       |
| "Agent said success"            | Agent report ≠ user verification. Re-run independently.                                                   |

## Red Flags — STOP

- Claiming "完成" / "fixed" / "passing" / "应该可以" / "看起来对" without captured output
- Reporting 禁用词: "应该" / "看起来" / "估计" / "大概" / "似乎" (严词规范, 写错抓)
- Skipping the test for "speed" / "the task is small"
- Paraphrasing actual output instead of pasting it
- Reporting 1-file change when `git diff --stat` shows 3 (scope drift)
- "I'll verify in the next session" — verification is now, not later
- Trusting subagent "success" without independent re-run
- Auto-invoking `/self-evolving-rules` at task end — it is user-invoked; ask in prose and let the operator type the command

## Required Baseline

**Zero tolerance**: no "should" / "probably" / "looks good" / "应该" / "看起来" in completion reports. Either you have evidence (exit code, output, screenshot) or you don't claim done.

## References

- Worked example covering the 6 core verification steps — see [`references/example.md`](references/example.md).
- Project-level or workspace-level governance rules (commit discipline, vocabulary norms, review subagent) live in the project's own CLAUDE.md / rules/ files and are not duplicated in this canonical skill.
