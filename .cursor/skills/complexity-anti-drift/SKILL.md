---
name: complexity-anti-drift
type: discipline
description: Use when a function exceeds 60 lines (soft REVIEW) or 10 branches, takes more than 4 parameters (soft REVIEW), nesting hits 4+, a file exceeds 500 lines (soft REVIEW), clone rate is above 3%, or CI reports a complexity gate failure. Triggers on refactor, split a function, extract a helper, or ESLint complexity violations.
bucket: engineering
---

# Complexity Anti-Drift

Complexity drifts by accretion: one branch, one nested `if`, one more parameter. Each addition is locally defensible and globally fatal. The fix is extraction along the **responsibility line**, not along "where the code happens to be". Helpers extract; comments do not.

This skill owns the extract/split on a complexity offender. Hard FAIL vs soft REVIEW gates live in [`references/thresholds.md`](references/thresholds.md). Measurement is `arthurpower:complexity-anti-drift-agent`.

## When to use

Reach for this skill when the next move is to stop complexity accretion:

- CI reports a complexity gate failure (ESLint `complexity` / `max-depth` / `max-params` / `max-lines-per-function` / `max-lines`, or `jscpd`)
- A request to refactor, split a function, reduce complexity, extract a helper, or fix an ESLint complexity violation
- A PR that "just adds one more case" repeatedly
- A function, file, nesting, params, or clone report in the diff has crossed the gates in [`references/thresholds.md`](references/thresholds.md)

A one-line getter or setter, a test fixture kept complex for clarity, generated or vendored code, or a declarative config / type-only file is out of scope.

## Procedure

1. **Measure the diff.** Hand the diff range to `arthurpower:complexity-anti-drift-agent` with `subagent_type: "arthurpower:complexity-anti-drift-agent"`. Pass: diff scope + gates in [`references/thresholds.md`](references/thresholds.md) + evidence shape (file:line + PASS/FAIL/REVIEW/NOTE). Prefer the agent over measuring in the current thread. 软触发：应当派，非必须派；偶发主线程自跑属可接受降级，不视为违规. Completion: a per-metric table with file:line evidence, or equivalent linter/`jscpd` capture if the agent was skipped.

2. **Extract along the responsibility line.** For each new offender — extract a helper, not a comment. The function stays at one abstraction level. If extraction reveals two responsibilities, split along the responsibility line, not along "what code happens to be there". Clone offenders: extract the shared logic into a function, not a duplicated-string collapse. Nesting offenders: early-return / guard-clause, not collapsing one branch. Chained ternaries, `// just this once` / `// temporary`, duplicate blocks, and comment-instead-of-extract: [`references/pressure-and-antipatterns.md`](references/pressure-and-antipatterns.md). Completion: every new hard-gate offender is extracted or split; every new soft-trigger is extracted, split, guarded, or left as explicit REVIEW.

3. **Re-measure.** Re-run the agent (or the linter/`jscpd`). Completion: all hard gates pass; no new unreviewed soft-trigger; `git diff --stat` shows extracted helpers of reasonable size.

## Acceptance criteria

A complexity pass is complete when all of the following hold:

- [ ] Diff measured against [`references/thresholds.md`](references/thresholds.md) (agent table, or in-thread linter/`jscpd` capture)
- [ ] Every new hard-gate offender extracted or split along the responsibility line
- [ ] Every new soft-trigger is extracted, or left as REVIEW — not FAIL
- [ ] Parameter counts exclude `self`/`this`
- [ ] No chained ternary; no `// just this once` / `// temporary` beside a complex block ([`references/pressure-and-antipatterns.md`](references/pressure-and-antipatterns.md))
- [ ] Re-measure is green on hard gates (linter exit 0 on touched files)

## References

- Hard FAIL / soft REVIEW gates and tools: [`references/thresholds.md`](references/thresholds.md)
- Extract Function worked example (4-responsibility function → 4-line caller + single-responsibility helpers): [`references/extract-function-example.md`](references/extract-function-example.md)
- Rationalizations, stop-and-start-over smells, verify commands: [`references/pressure-and-antipatterns.md`](references/pressure-and-antipatterns.md)
