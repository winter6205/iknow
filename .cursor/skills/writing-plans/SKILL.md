---
name: writing-plans
description: Use when turning a buildable spec into ordered tracer bullets after architecture-change-reviewer. Covers vertical slicing, dependency order, and headroom for the implementer. Triggers on 写计划, 拆任务, 任务分解, 制定方案, 跨文件改动, 计划.
bucket: engineering
disable-model-invocation: true
---

# Writing Plans

A plan is a sequence of **tracer bullets**. Each bullet is a narrow vertical slice — one implementer-window outcome that touches every layer it crosses (schema / API / UI / tests, as applicable), is demoable end-to-end, fits one fresh context window, and carries exactly one tag. The phrase keeps its _Pragmatic Programmer_ meaning (working end-to-end functionality, thin slice, proof the system wires together) — do not rename it: the shared vocabulary is what aligns planner, reviewer, and implementer on slice shape, and it activates the LLM's trained prior for what a coherent plan looks like.

**Headroom** is the test of a bullet's prescription: the bullet fixes the **shape** of the slice, not its implementation. Two competent implementers could ship different diffs — different filenames, helper splits, test layouts — that both satisfy the same acceptance. If only one patch shape can pass, the bullet has already implemented the work.

## When to use

Reach for this skill when a spec is buildable and the next artifact is an ordered list of work:

- 3+ files, a new module, or a cross-context change
- Several outcomes that need a dependency graph
- After `architecture-change-reviewer` returns an all-yes (or N/A-with-reason) verdict

A one-file obvious fix, or a docs-only edit with no behaviour change, is already a single tracer bullet in the user's request — write the change, not a plan file.

**Input**: a spec (`specs/<feature>.md`) plus the ACR verdict it carries, plus `docs/CONTEXT.md` / tagged ADRs as read-side context. Wayfinder maps and working code are not inputs; the plan feeds implementation, it does not reverse-engineer a diff.

**Output**: `plans/<feature>.md` — ordered tracer bullets, dependency-tagged. Spec, ADR, and code stay with their owners (`spec-driven-development`, `domain-modeling`, the implementing agent).

If a planned step contradicts an existing ADR, annotate `> Contradicts ADR-NNNN — worth reopening because <证据>` and record the reopen on the plan's **待写入** list during harvest/slice. Do not invoke `domain-modeling` in the middle of slicing. Quote the contradiction; do not silently override.

## Procedure

During harvest and while writing bullets: if the plan introduces or changes a domain term relative to `docs/CONTEXT.md`, append that delta to **待写入** in the plan header or a persist section. Same for ADR-reopen items from the contradiction rule above. Do not invoke `domain-modeling` in steps 1–6; persist is the last write after the plan file exists.

1. **Harvest settled vs open.** From the spec and ADRs, list outcomes already decided (invariants, EXIT, scope cuts) and choices still open. Term/ADR deltas go on **待写入**, not into a mid-harvest `domain-modeling` call. Completion: every bullet in the spec's contract section is either **inherits** (quoted) or marked open for the implementer.
2. **Slice tracer bullets, not files.** Group work so each bullet is one demoable behaviour that crosses every layer it needs end-to-end and fits one implementer window. Files that must change together for that behaviour belong to the same bullet; unrelated reasons split. If the blast radius is a wide mechanical rename, sequence expand → migrate-in-batches → contract; expand, each migrate batch, and contract are all bullets — see the sketch in [`references/plan-format.md`](references/plan-format.md). Completion: each bullet has a one-sentence outcome a reviewer can demo end-to-end.
3. **Write each bullet as a ticket, not a recipe.** If a bullet introduces or changes a domain term vs `docs/CONTEXT.md`, append it to **待写入**; do not invoke `domain-modeling` here. Fill the fields in [`references/plan-format.md`](references/plan-format.md):
   - **Tag** — exactly one: `[decision]` (resolves a choice / records a verdict before code) or `[implementation]` (changes code or tests after those decisions).
   - **Inherits** — quote the settled contract from the spec or an ADR, or write `none` so the implementer knows the choice is open.
   - **Surface** — an existing bounded context or module, by its spec/context-map name or top-level directory (e.g. `session-api`, not an invented subpath); new filenames, type names, and helper splits wait for implementation unless the spec already froze them.
   - **Acceptance** — an observable property (behaviour, invariant, reversible migration, or a named structural split such as one factory). Cite an existing test command when one already guards that property. Line counts, cyclomatic scores, param caps, clone percents, and invented literal-counts are **gates** owned by [`complexity-anti-drift` thresholds](../complexity-anti-drift/references/thresholds.md); point at that skill, do not copy the numbers into this field. Do not invent a test path to make the bullet look executable.
   - **Completion** — the headroom test holds: a second implementer could use different files/names and still pass Acceptance.
4. **Order by dependency.** A bullet that consumes another's outcome comes after it. Mark true parallelism `[parallel]` and blockers `[blocks: T1]`. Completion: the graph is about outcomes, not directory order.
5. **Cross-check ACR.** Confirm the 5-verdict block still covers the slice. Sequence and conflict rules: [`references/handoff-acr.md`](references/handoff-acr.md). Completion: the plan file contains the verdict block and the bullet list.
6. **Leave the plan in a file.** Write `plans/<feature>.md` (or the commit body if the change is the plan). Chat scrollback is not the artifact. The **待写入** list lives in this file (header or persist section).
7. **persist.** 待写入清单空则跳过。否则立刻 invoke `domain-modeling`，只写清单上的项。 Done when: flushed or skipped. Tracker work below does not replace this step.

## Tracker

Default storage is local markdown: `plans/<feature>.md` is the plan. Acceptance does not require GitHub issues. A GitHub remote or a working `gh` is not a trigger.

Load [`references/tracker.md`](references/tracker.md) only when the operator this run names GitHub issues (「用 issue」「发到 GitHub」). Then publish per that file.

## Neighbours

The implementing agent runs `test-driven-development`, then typecheck/tests, then `verification-before-completion`. Checkpoint commits are allowed; landing grain is the operator's global commit section, not one git commit per bullet. After all bullets of the task land, an end-of-round **code review phase** closes the round (`code-review`; `GATE: BLOCKED` → next slot `review-report-repair`). Per-bullet loop and code review phase both belong to implementation, not to the plan template — name the per-bullet loop once in the plan header and the code review phase once at the end.

Filled example: [`references/example-plan.md`](references/example-plan.md). Done checklist: [`references/acceptance-criteria.md`](references/acceptance-criteria.md).

Do not write "one commit per bullet". Scope of the change is `minimal-change-verifier`; commit count is not.

## Verification

A plan is done when every box on the binary checklist in [`references/acceptance-criteria.md`](references/acceptance-criteria.md) is green. The Completion line under each procedure step tells you where you are; the checklist tells you when to stop.
