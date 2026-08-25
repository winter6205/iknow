# Plan acceptance (binary)

The plan file is complete when all of the following hold:

- [ ] `plans/<feature>.md` exists (or the commit body _is_ the plan)
- [ ] Each tracer bullet has exactly one tag: `[decision]` or `[implementation]`
- [ ] Each bullet states **Inherits** (quoted contract or "none") and **Acceptance** as an observable yes/no (behaviour / invariant / named structure — not a copied S5 number or an invented literal-count)
- [ ] **Headroom:** a second implementer could use different files/names and still pass Acceptance
- [ ] **Vertical slice:** each bullet touches every layer it crosses (schema / API / UI / tests, as applicable) and is demoable end-to-end
- [ ] Bullets are ordered by dependency; `[parallel]` / `[blocks:]` match that graph
- [ ] ACR 5-verdict block is in the same file
- [ ] Fewer than 3 bullets only when the write-up says why the slice is still a plan — the floor guards under-slicing, never justifies padding (one true bullet beats three invented ones)

Format: `plan-format.md`. Example: `example-plan.md`. ACR sequence: `handoff-acr.md`.
