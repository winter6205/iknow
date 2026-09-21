# 0073. Claim window uses the messages index; HITL is not bounced back by a checker CONTRADICTED

Date: 2026-09-09
Status: accepted

## Context

`checkEvidence`'s `claimIndex` was passed by `verify-loop` as the verification `round` (always 1 on the first round), so the checker only looked at `messages[0]` — blind to the evidence prefix of a real multi-turn transcript. At the same time, HITL mapped checker `EVIDENCE_CONTRADICTED` (e.g. `rm`, writing an empty test file) into a bounce-back, punishing legitimate "tidy up the tests" conversations. ADR-0024's module split (HITL does not ask the LLM for the completion vector) still holds; this decision changes only the **window coordinates** and **how HITL consumes CONTRADICTED**.

## Decision

1. `claimIndex` is the claim position = the `messages` index, resolved in the same backward scan as `deriveFinalText` ("the last assistant message with non-empty text"); `round` is bookkeeping only. If that assistant message cannot be found → INSUFFICIENT.
2. In normal (HITL) mode, CONTRADICTED is not treated as a `true-failure`; the **goal feature** still hard-vetoes (wired via the flag `completionMode === "auto"` — that is the goal feature module, not an "automatic mode").
3. Under HITL, when evidence is insufficient and the completion judge is skipped, the human-facing UI must not show "verification passed".

## Consequences

- The checker sees the tests and edits preceding the claim; otherwise CONTRADICTED / SUFFICIENT / stale are all no-ops.
- A human at the keyboard tidying old tests is not a cheating signal, so HITL no longer bounces it back; but showing a green check for "not verified" would be a false pass — hence rule 3: chit-chat gets no green check.
- The goal feature keeps its defense against "delete tests to fake green".
- Evidence: conversation 8ff77b89 — both verification records are `hitl_skip_completion_judge` + `EVIDENCE_INSUFFICIENT` + `passed`.
