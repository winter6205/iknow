# Example: 5-Verdict Block

Complete 5-verdict example showing how to use the architecture-change-reviewer skill to review a multi-file change before implementation.

**Note**: Each section corresponds to a real failure mode (RED baseline verified).

```markdown
# PR Title: Add order placement API endpoint

## 1. Summary

Add POST /api/orders endpoint that accepts an order, validates stock, creates the order, and returns a confirmation. Touches 4 files: api routes, order service, stock validator, order schema.

## 2. 5-line verdict block

bounded-context-guardian: yes — orders/ bounded context exists, new code lives in orders/api/, no cross-context import (uses stock-validator via injected interface).
defensive-contract-validator: yes — place_order() covers empty cart (raise), negative quantity (raise), long cart (1000 items, pagination), concurrent (lock + retry), exception (DB failure → typed OrderPlacementError).
error-handling-enforcer: yes — typed exception OrderPlacementError with code: INSUFFICIENT_STOCK, no empty catch, // EXIT: stock not reserved, return error to caller comment on early-return.
complexity-anti-drift: yes — plan keeps one abstraction level per function: place_order() composes 3 extracted helpers (validate_cart / reserve_stock / persist_order) instead of inlining the flow; no god-file or cross-cutting handler planned.
minimal-change-verifier: yes — 1 logical task (add order endpoint), 1 commit, no refactor mixed with feature.
minimal-change-verifier: no — diff scope touches 3 unrelated files; tracer-bullet split required → block implementation, return to writing-plans for re-decomposition.

## 3. Task Decomposition → see writing-plans

Tracer-bullet tickets and `[decision]` / `[implementation]` tags are owned by writing-plans. After the verdict block (Section 2) is all-yes, hand off to writing-plans, which writes the ordered task list into `plans/<feature>.md`.
See `writing-plans/references/handoff-acr.md`.
```

**Annotation**: The example above shows how to land when all 5 verdicts are yes — each verdict is one line plus a one-sentence reason. On failure (any verdict = no), that verdict is a mandatory block: go back to §Procedure Step 3 and do not hand off to writing-plans.
