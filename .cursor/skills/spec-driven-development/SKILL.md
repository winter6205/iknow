---
name: spec-driven-development
description: Use when the work isn't a spec yet — a one-line ask, multi-file change, ambiguous scope, or architectural decision on the table. Spec-driven-development captures what to build, why, and how to know it's done before any plan or commit. Skip for single-line fixes or bounded bug fixes.
bucket: engineering
disable-model-invocation: true
---

# Spec-Driven Development

A spec is the **contract** between human reviewer and implementation — what to build, why, and how to know it is done. Code without a spec is guessing at requirements; a spec without surfaced assumptions is guessing at context. The shape is fixed (four required areas + Inherits/Changes, binary success criteria, an `architecture-change-reviewer` verdict before plan); the content inside each area is open. Two competent spec authors writing for the same ask can ship different concrete choices — what they share is the shape, the assumption gate, and the binary verdict.

This skill owns the SPECIFY phase of SPECIFY → PLAN → TASKS → IMPLEMENT. PLAN / TASKS / IMPLEMENT live in `writing-plans`. The boundary gate between SPECIFY and PLAN is `architecture-change-reviewer` (5-verdict frame). It runs in whatever workspace it was started in — it discovers that workspace; it does not import another repo's habits.

## When to use

Reach for this skill when the next artifact is a buildable contract:

- Starting a new project, bounded context, or top-level package
- A feature whose requirements exist only as a one-line ask
- A change spanning multiple files, modules, or days
- An architectural decision is on the table (new storage, auth model, bounded context)
- Human reviewer requirements are ambiguous or self-contradicting
- Cross-functional blast radius (frontend + backend + DB + ops)

A one-file obvious fix, a docs-only edit, or a spec that already exists, is already past SPECIFY — write the change, or open `writing-plans` if the next artifact is the plan.

## Context-loop pre-read

Before drafting, ground the contract in **this** workspace:

1. If `docs/CONTEXT.md` or `CONTEXT-MAP.md` exists, quote the domain terms the spec uses (exact copy, not redefinition). If those files are absent, the missing terms are themselves a set of assumptions — list them in the gate.
2. If `docs/adr/` exists, cite in-scope ADRs by number. If it is absent, stack and constraints go through the assumption gate.
3. Spec quotes `docs/CONTEXT.md` (exact copy). It does not invent definitions. A term the spec needs but cannot ground: Open Question or assumption (step 1 gate) — not a new definition in the spec body.
4. New or changed domain terms, and one-way-door ADRs (hard to reverse ∧ surprising w/o ctx ∧ real trade-off), are appended to a **待写入** list on the spec (Inherits/Changes, or a short persist list). Do not invoke `domain-modeling` during pre-read or while drafting. The spec body cites terms and decisions; it does not author CONTEXT.md or ADR files.

## Procedure

1. **Surface assumptions (the gate).** List every implicit assumption as a numbered list — tech stack, auth, deployment, browser matrix, scope boundaries, non-functional targets, dependencies, integration contracts, data model defaults, human-approval gates. Hand to the human. The work that follows assumes every assumption is either confirmed or removed. Format: [`references/spec-template.md`](references/spec-template.md). Completion: human reply (confirmed / corrected / removed) on every item.

2. **Write the spec.** Document lives at `specs/<feature>.md`. Required areas: Objective / Boundaries / Success Criteria / Open Questions, plus Inherits/Changes. Vague asks ("make it faster", "be more secure") reframe to binary in Success Criteria; if unreframeable, surface as Open Question. Template and reframing format: [`references/spec-template.md`](references/spec-template.md). Completion: every required area is present, every Success Criterion maps to a measurable yes/no, and Inherits/Changes only records what this contract depends on or adds.

3. **Hand the spec to `architecture-change-reviewer`.** The skill emits a 5-line verdict — bounded-context-guardian / defensive-contract-validator / error-handling-enforcer / complexity-anti-drift / minimal-change-verifier, each `yes` / `no` / `unclear`. Any `no` or `unclear` means unresolved architecture leaks downstream; return to Step 1 or Step 2. Verdict example: [`references/example.md`](references/example.md). Completion: 5-line block present, all `yes` or `N/A with reason`.

4. **persist.** 待写入清单空则跳过。否则立刻 invoke `domain-modeling`，只写清单上的项。CONTEXT / ADR persist 不另等 human confirm；step 1 仍是非 CONTEXT 假设（tech stack 等）的 gate。Completion: flush 已跑，或因清单为空而 skip。

5. **Hand off to `writing-plans`.** Pass the spec path. The sequence is the gate: `spec-driven-development` → `architecture-change-reviewer` → persist → `writing-plans`. ACR sits between the contract and the plan so each phase has one job; persist flushes CONTEXT/ADR after that verdict, before the plan. Completion: spec path referenced by `writing-plans`.

## Acceptance criteria

A spec is complete when all of the following hold:

- [ ] Assumptions surfaced as a numbered list and confirmed (or removed)
- [ ] Required areas present: Objective, Boundaries, Success Criteria, Open Questions, Inherits/Changes
- [ ] Success criteria are binary — each maps to a command or measurable check
- [ ] Boundaries name **Does** / **Confirms with human** / **Out of this spec**
- [ ] Inherits/Changes quotes what this workspace already provides that the contract depends on, or the confirmed choices when nothing is there yet — not indent, quotes, formatter, or lint taste
- [ ] Spec lives in a committed file at `specs/<feature>.md`
- [ ] `architecture-change-reviewer` block present with 5 lines, all `yes` or `N/A with reason`
- [ ] persist ran (flush or skip)
- [ ] Spec path handed to `writing-plans`

## References

- Worked example (vague ask → spec + 5-verdict block): [`references/example.md`](references/example.md)
- Spec template, assumption-list format, vague-to-binary reframing: [`references/spec-template.md`](references/spec-template.md)
- Why each gate exists (anti-drift, anti-vague, anti-leak): [`references/why-the-gates-exist.md`](references/why-the-gates-exist.md)
- Pressure scenarios and anti-patterns: [`references/pressure-and-antipatterns.md`](references/pressure-and-antipatterns.md)
