---
name: verification-before-completion
description: This skill should be used when claiming "完成" / "done" / "fixed" / "passing" / "ready to ship", before trusting a subagent success report, or when checking "对照计划" / "对照 spec" — whether this run's delivery matches its basis.
bucket: engineering
type: technique
---

# Verification Before Completion

**Done** means this run matches its **basis**, with **实测** for each line. The basis is whatever this run actually followed: a plan, a spec, a ticket, an issue, or the user's written ask. Name that path or quote it.

## When to use

- Claiming "完成" / "done" / "fixed" / "passing" / "ready to ship"
- Before `git commit` / `git push`, or marking a task complete
- After a subagent reports "success"
- Checking "对照计划" / "对照 spec"

Skip: typo / single-line rename with no logic change; design talk before implementation; user said "skip verification" / "先这样, 不用验".

Only when the diff touches `docs/CONTEXT.md`, `docs/CONTEXT-MAP.md`, `docs/adr/`, or proposes a new ADR — load [`references/context-loop-hooks.md`](references/context-loop-hooks.md) and run those four checks. Otherwise skip.

## Procedure

1. **Name the basis.** (1) the path the user named; (2) the plan / spec / ticket / issue opened this run; (3) a quote of the user's written ask. Completion: one named path or quote.

2. **Copy the lines.** Read the basis. Copy every Acceptance / Success Criterion / listed outcome for this work item. If those headings are absent, the user's stated outcome is the single line. Completion: the list matches the basis; unimplemented lines stay on the list.

3. **Check each line.** `delivered` (paste command output, or cite the file/hunk) / `missing` / `deferred` (only if the basis deferred it). Name extras. Any `missing` → not done. Completion: every line classified; extras named.

4. **Report.** Zero `missing`, or the claim names what remains open. `PASS = <basis> <line> <evidence>`. Completion: that line exists and names the basis.

After PASS, ask in prose whether this task produced a durable lesson worth persisting. If yes, tell the operator to run `/self-evolving-rules` themselves. Ask only — never invoke it: `self-evolving-rules` is user-invoked. Skip for trivial edits, or when the operator has already declined this session.

## Acceptance Criteria

- [ ] Basis named as a path or a quote of the user's ask
- [ ] Every in-scope line from the basis is on the list
- [ ] Each line has evidence, or is `missing` / `deferred`
- [ ] Zero `missing`, or the claim is narrowed
- [ ] Report is `PASS = ...` and names the basis
- [ ] After PASS, the rule-distillation offer was made in prose (or skipped for cause); `/self-evolving-rules` was NOT auto-invoked

## Verification

```
Skill type: technique
Bar level: minimum
```

## References

- [`references/example.md`](references/example.md)
- [`references/context-loop-hooks.md`](references/context-loop-hooks.md)
