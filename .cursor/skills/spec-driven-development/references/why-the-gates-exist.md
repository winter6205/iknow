# Why the gates exist

Each gate in spec-driven-development prevents a specific failure mode. The gates run because the alternative — omitting them — has a name, and the name is the failure it leaves behind.

## The gates and what each prevents

- **Assumption gate** — silent context drift. An unstated assumption becomes part of the contract without anyone confirming it. Two competent spec authors reading the same ask will name different assumptions; surfacing them lets the human reviewer choose which become the spec.

- **Binary success criteria** — unverifiable "done". "Looks good", "fast", "secure enough", "TBD" can't be measured. Binary criteria map to a command that exits 0, a metric threshold, or a property test. If a criterion can't be reframed, surface as Open Question — the gap is yours to flag, not paper over.

- **`architecture-change-reviewer` verdict** — plan on shaky ground. The 5-line verdict (bounded context, defensive contract, error handling, complexity, minimal change) catches architecture-level issues before they cascade into the plan. A spec without the verdict block is a plan waiting to need rework.

- **Sequence `spec → ACR → plans`** — phase merging. SPECIFY captures the contract; ACR audits the contract; writing-plans decomposes into tracer bullets. ACR sits between the contract and the plan so each phase has one job.

## Spec is ready when

- Assumption list present and human-confirmed (or item removed)
- Success criteria binary (a command, a threshold, or a property test)
- Boundaries filled as Does / Confirms with human / Out of this spec
- Required areas present: Objective, Boundaries, Success Criteria, Open Questions, Inherits/Changes
- Inherits/Changes quotes what this workspace provides that the contract depends on, or the confirmed choices when nothing is there yet
- Spec lives in `specs/<feature>.md`
- ACR 5-line block all `yes` or `N/A with reason`
- Vague intake items either reframed or listed under Open Questions
