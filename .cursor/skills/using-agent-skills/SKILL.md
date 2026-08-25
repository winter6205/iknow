---
name: using-agent-skills
description: Use when starting a new session, switching tasks, or unsure which arthurpower skill applies. Routes incoming work to the matching skill via flowchart before invoking. Activates on phrases like "which skill should I use", "skill check", "pre-task skill check", "how to start", "router", "skill routing", or when multiple competing skills could apply. Does not auto-invoke user-invoked authoring skills (skill-authoring, self-evolving-rules).
bucket: engineering
type: discipline
---

# Using Agent Skills

Skill router for the arthurpower collection. It names the **task class** and the **current slot** in any documented sequence, then invokes that one skill. It does not do the downstream work.

User-invoked only (`disable-model-invocation: true` on the target): `skill-authoring`, `self-evolving-rules`. The operator must name them. Other skills, including `dispatching-parallel-agents`, are model-invoked playbooks the current agent may run when their triggers match.

## When to use

- A new session whose first task is unclassified
- The user asks which skill / how to start / skill check / routing
- Several skills could match (ambiguous routing)
- Switching task class mid-session (planning → implementing → verifying)

Skip when the task already maps to one skill, the user already named a skill, the edit is trivial, or the work is outside this graph.

## Procedure

1. **Classify.** Match the task to one branch in [`references/flowchart.md`](references/flowchart.md) (Defining / Planning / Implementing / Verifying / Reviewing / Committing / Meta). Scale (single vs multi-session) selects a **sequence**, not a pile of skills in one turn. Completion: one branch label, and if scale applies, the sequence named.

2. **User-invoked gate.** If the match is `skill-authoring` or `self-evolving-rules` and the user did not name it, stop and ask. Completion: either a different skill, or the user named that skill.

3. **Current slot.** Documented sequences (SPECIFY → `architecture-change-reviewer` → persist → `writing-plans`) are ordered gates. Invoke **this slot only**; do not stack the whole sequence. Competing skills for the same slot (e.g. ACR and `code-review` as "the review") are not a sequence — pick one. Completion: the slot's skill name.

4. **Invoke.** State the routing decision in one sentence, then invoke that skill. CONTEXT / ADR writes go through `domain-modeling` when a persist list exists. Completion: the chosen skill started.

Promoted skill add / rename / remove / flow-placement updates this file and [`references/quick-reference.md`](references/quick-reference.md) in the same change. Details: [`references/router-maintenance.md`](references/router-maintenance.md).

## Registered skills (hook mirror)

`hooks/pre-release-validate.ts` greps this `SKILL.md` for each sibling directory basename. Keep every promoted skill named below. Phase / trigger tables live in [`references/quick-reference.md`](references/quick-reference.md), not here.

- architecture-change-reviewer
- boundary-testing
- bounded-context-guardian
- code-review
- complexity-anti-drift
- defensive-contract-validator
- dispatching-parallel-agents
- domain-modeling
- error-handling-enforcer
- logicsync
- minimal-change-verifier
- self-evolving-rules
- session-handoff
- setup-arthurpower
- skill-authoring
- spec-driven-development
- systematic-debugging
- test-driven-development
- verification-before-completion
- wayfinder
- writing-plans

## Acceptance

- [ ] Flowchart branch chosen before any skill invoke
- [ ] One task class; if a sequence, only the current slot invoked
- [ ] User-invoked authoring skills not auto-started
- [ ] Routing stated in one sentence
- [ ] No catch-all meta skill when a focused skill matches

## References

- [`references/flowchart.md`](references/flowchart.md) — branches including scale sequences
- [`references/quick-reference.md`](references/quick-reference.md) — phase / trigger / user-invoked vs model-invoked
- [`references/router-maintenance.md`](references/router-maintenance.md) — add / rename / remove / flow-placement
- [`references/behaviors.md`](references/behaviors.md) — optional operating habits (not routing)
