# Pressure scenarios and anti-patterns

Each pressure maps a real-world constraint to the failure mode it tends to produce, and the design choice that pre-empts it. Anti-patterns are named for the recurring shape they leave in the spec or process.

## Pressure → failure mode

| Pressure                          | Failure mode                        | What the gate does                                                          |
| --------------------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| "Just build it, spec is overkill" | Skip SPECIFY                        | A 2-line spec + assumption gate is faster than rework. Escalate if refused. |
| Past-work context feels obvious   | Skip assumption gate                | Past-work context is itself an assumption; surface it.                      |
| Spec feels too long               | Drop Boundaries or Open Questions   | Dropping these drops the contract. Keep the required areas.                 |
| Vague success ("make it fast")    | "Fast" written as a criterion       | Reframe to LCP < 2.5s or surface as Open Question. No binary = no spec.     |
| ACR verdict `unclear`             | Push forward, resolve during PLAN   | Unclear = gate not passed. Return to Step 1 or Step 2.                      |
| "Ship the plan tomorrow"          | Combine SPECIFY + PLAN into one doc | The phases are gated; ACR sits between contract and plan.                   |
| Multiple features in one ask      | One spec covering all features      | One feature per spec. Compound asks split at the gate.                      |

## Anti-patterns

- **Head-spec** — spec lives only in agent memory or chat scrollback. The contract must live in a committed file.
- **Implicit-assumption spec** — assumption list absent or unconfirmed. Gate not run.
- **Vague-criterion spec** — qualitative success criteria. Each must map to a command or measurable check.
- **Gate-skipping handoff** — `writing-plans` invoked without ACR verdict block. Plan built on shaky ground.
- **Phase-merge doc** — SPECIFY and PLAN in one document. The audit is the boundary; merging brings the failure modes back.
- **Living-document drift** — spec updated after code without a new assumption gate. Spec changes are themselves spec work.
- **One-shot spec** — spec written once and never revisited. The spec is a living document; revisit on scope change.
- **Style-in-spec** — indent, quotes, formatter, or lint taste written as contract. Those are not the spec's job.
