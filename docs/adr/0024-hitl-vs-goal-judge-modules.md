# 0024. Completion judgment split into two logic modules: HITL and `/goal` auto mode

Date: 2026-08-20
Status: accepted

Product wording: "auto mode" in this document = the **goal feature** (continuation after a slash-pinned mission), not the permission mode `full_auto`. For current behavior read ADR-0032 + CONTEXT entries "auto mode" and "goal feature".

Context: the fields had been split into goal/taskFocus, but verify still used a single `goal ?? query` chain (and earlier taskFocus), wiring HITL chat into a completion-oriented LLM judge; `/goal` also had no independent auto loop.

Decision: one shared read-only judge system, two logic modules. Normal mode (HITL) does not ask the LLM about semantic completion; pinning `/goal` starts an auto loop where `task` is only `goal.text`, success is also judged, and stop tiers are: Impossible clears the goal / spinning-in-place stops the loop without clearing the goal / unrecoverable error clears the goal. No default hard round cap; a command may optionally specify one. taskFocus does not exist inside auto mode (the `session.taskFocus` field was retired by ADR-0026; compact switched to task excerpts, not pasted in auto mode). ADR-0017's checker three-tier flow shape is kept; its "SUFFICIENT never invites the judge / INSUFFICIENT always does" covers completion-oriented invitations only. ADR-0018's field split and zero model writes are kept; its three-segment judging formula is voided. HITL's consumption of a checker CONTRADICTED and the claim-window coordinates are **amended by ADR-0073** (normal sessions are not bounced for broken tests; `claimIndex` ≠ `round`).

Why: mirrors the split between plain chat behavior and Stop-hook-driven `/goal` continuation; a single unified formula mismatched the two responsibilities.

Evidence: the grilling resolution on completion-judge gating.
