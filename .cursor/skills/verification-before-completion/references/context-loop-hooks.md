# Context-Loop Hooks

Project-specific governance rules that fire only when the diff touches context-loop artifacts (`docs/CONTEXT.md`, `docs/CONTEXT-MAP.md`, `docs/adr/`) or proposes a new ADR. Run alongside the standard verification procedure (§Procedure in `SKILL.md`).

## 1. CONTEXT.md / ADR schema

If the change writes to `docs/CONTEXT.md`, `docs/CONTEXT-MAP.md`, or `docs/adr/NNNN-*.md`, run `pre-context-write-guard.cjs` validation manually and confirm exit 0 (or assert the hook already exited 0 in the session log). Schema violations are an automatic FAIL.

## 2. Write authority

Confirm any CONTEXT.md or ADR edit was made by `domain-modeling` (or routed through it). Direct Edit by other skills = router violation = FAIL.

## 3. Read-side freshness

Confirm the change does not contradict an existing ADR (`docs/adr/`). If it does, the change carries the annotation `> Contradicts ADR-NNNN — but worth reopening because <证据>`. Missing annotation on a contradicted ADR = automatic FAIL.

## 4. ADR three-condition gate

If a new ADR was proposed in this change, verify all three conditions (Hard to reverse ∧ Surprising w/o ctx ∧ Real trade-off) were checked. Missing one = automatic FAIL.
