---
name: architecture-change-reviewer
description: Use before multi-file changes (>3 files) or cross-module work — emits a 5-line verdict (bounded-context-guardian / defensive-contract-validator / error-handling-enforcer / complexity-anti-drift / minimal-change-verifier) and blocks on no / unclear. Triggers on multi-file change, new module, cross-module refactor, plan before implementation.
bucket: engineering
disable-model-invocation: false
---

# Architecture Change Reviewer

## Overview

Multi-file changes are reviewed **before code lands**, by mapping each affected Core Skill to a one-line verdict. If any verdict is "no" or "unclear", the plan is incomplete — fix it, don't ship it. Cross-skill conflicts (e.g. "split the bounded context" vs "one task") resolve by sequencing, not merging.
Tracer-bullet tickets and the [decision] / [implementation] tags live in writing-plans, not here. ACR stops at the all-yes verdict.

## When to use

- Planning a change that touches 3+ files
- Adding a new module / subsystem / bounded context
- Refactoring across module boundaries
- A task where 2 or more Core Skills plausibly apply
- Before implementation begins, on a change with cross-file blast radius

## When not to use

- Single-file typo fix
- Single-file bugfix with a clear single Core Skill in scope
- Pure documentation or comment changes
- Trivial rename inside one file
- Decomposing a feature into ordered vertical-slice tickets — that is writing-plans (one outcome per tracer bullet, one tag).

## Procedure

1. Enumerate the planned files. Stop if fewer than 3.
2. For each Core Skill, write a one-line verdict:
   - bounded-context-guardian: are module boundaries respected?
   - defensive-contract-validator: is the change covered by tests for the 5 boundary classes?
   - error-handling-enforcer: is every failure path typed, non-empty, EXIT-documented?
   - complexity-anti-drift: does the plan's declared structure keep one abstraction level per function/module (no god-function / god-file intent, no planned deep nesting or duplication)? Smell thresholds guide, line counts never decide.
   - minimal-change-verifier: is this one task? Will the diff stay in that scope?
3. If any verdict is "no" or "unclear" — stop, go back to the responsible Core Skill and fix the plan.
4. If 2 Core Skills conflict (e.g. bounded context says split, minimal change says one task) — split the work into separate tasks. Don't merge scopes.
5. If no Core Skill applies — the change is too small to need this reviewer. Proceed without.
6. **Hand off.** writing-plans consumes the all-yes verdict block and writes the ordered tracer-bullet task list to `plans/<feature>.md` (see writing-plans/references/handoff-acr.md).

## Rationalization Table

| Excuse                                           | Reality                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| "Just 4 files, I can eyeball the verdict"        | 4 files × 5 Core Skills = 20 checks. Eyeballing skips 18.                                   |
| "It's obviously a small change, skip the review" | "Obviously small" is the rationalization that ships shotgun surgery. Enumerate anyway.      |
| "Two Core Skills conflict, just pick one"        | Conflict means both apply. Sequence them, don't drop one.                                   |
| "Plan is in my head, no need to write it down"   | Head-plan ≠ reviewable plan. The 5-line verdict block lives in `plans/<feature>.md` (SSOT). |
| "Cross-skill review is bureaucratic overhead"    | Cross-skill review catches the diff that slips past every individual Core Skill.            |
| "Just decompose tasks, skip the verdict"         | Task decomposition is writing-plans' job. ACR without verdicts is no gate.                  |

## Red Flags - Stop and Start Over

- Plan description does not list affected files
- Any of the 5 Core Skills has no written verdict
- Verdict uses "probably" / "should" / "looks good" instead of yes/no/unclear
- 2+ Core Skills in conflict and the plan does not sequence them
- Implementation has begun before the 5-line verdict is committed to `plans/<feature>.md`
- "I'll review during PR" — review is pre-implementation, not post-hoc

## Required Baseline

**Zero tolerance**: no multi-file change proceeds without all 5 Core Skill verdicts written as yes/no/unclear. Any "no" or "unclear" verdict blocks implementation. Conflicts are sequenced, never merged.

## Acceptance Criteria

- [ ] Plan has >= 3 affected files
- [ ] Each Core Skill has a written verdict (one line)
- [ ] All 5 verdicts are "yes", "N/A with reason", or trigger "no"/"unclear" → block. "no" or "unclear" = mandatory block, no override. (no "probably", no "should")
- [ ] No Core Skill conflict unresolved
- [ ] Implementation does not begin before this review is satisfied
- [ ] Architecture review verdict is committed in plans/<feature>.md (the SSOT)
- [ ] complexity-anti-drift verdict is grounded in declared structure, not in line-count estimates of code that does not exist yet

## Verification

- `grep -c "bounded-context-guardian:" plans/<feature>.md` ≥ 1 (verdict block present)
- `grep -c "minimal-change-verifier:" plans/<feature>.md` ≥ 1 (all 5 verdicts in plans/<feature>.md)
- `diff <(grep -E "^\s*affects:" plans/<feature>.md | awk '{print $2}' | sort -u) <(git diff --name-only | sort -u)` produces no output (planned file list == actual diff scope, no scope creep)
- Each of the 5 verdict lines is present in plans/<feature>.md

## Example

See [references/example-verdict-block.md](references/example-verdict-block.md) for a complete 5-verdict example showing how to use this skill to review a multi-file change before implementation.
See [references/dimension-semantics.md](references/dimension-semantics.md) for the pre-impl vs post-impl split of each dimension.
