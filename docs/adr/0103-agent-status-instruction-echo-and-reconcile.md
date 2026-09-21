# 0103. Status-bar recitation upgrade: instruction echo field and pivot reconcile marker

Date: 2026-09-19
Status: accepted

## Context

Measured session (2026-09-18, conversation `ee13c787`, yolo-mode worktree): after the user's pivot instruction (open PRs for the finished work, hand off the unfinished work via a PR) entered, the status bar kept re-emitting the frozen stale todo list in full on every hop (30+ same-shape bars); the instruction itself appeared once and was pushed out of the tail attention window by the bar listings — the model kept working the old tasks for about 8 minutes until the user manually interrupted. Recitation (pinning the current state at the messages tail, exploiting the attention recency effect, sparing the model the compute of self-scanning the history middle) is the status bar's core value (ADR-0028); the pathology this incident exposed is not the injection frequency but **distorted recitation content**: the bar faithfully projected the ledger, but the ledger had not caught up with the instruction, so high-frequency recitation kept amplifying a stale goal.

## Decision

1. Per-hop injection is **kept**; append-only, never replaces older bars (the ADR-0028 injection discipline is untouched).
2. The bar gains an `instruction:` field — a **verbatim echo** of the first line of the latest user instruction, truncated at about 100 characters, computed in pure code; no summarization, no rewriting.
3. **Pivot reconcile marker**: the next bar after a new user message enters carries a one-time marker prompting the model to first align the todo ledger via `todo_write` before continuing; the marker appears only on that hop and does not repeat afterward.
4. The bar still carries only code-computed current state, no policy prose.

## Why not

- **Boundary injection + same-snapshot dedup** (injection points narrowed to run start / after compaction / user entry / ledger change): dedup would tear out the per-hop recency refresh that is recitation's value, and boundary injection loses the high-frequency mid-attention exposure on long tasks; the tokens saved (about 50 per bar) do not offset the attention loss. This option may resurface later under the banner of "noise reduction"; the rejection reason is recorded here.
- **Feeding an LLM summary of the instruction into the bar**: introduces a second distortion source, violating "the bar carries only code-computed current state".

## Consequences

- Revises two half-clauses of ADR-0028 Consequences: "current-state fields are only last_tool + the todo segment" (the field set now also includes the instruction segment and the one-time reconcile marker) and "never copy task excerpts into the bar" (what remains banned is semantic extraction; the instruction echo is a verbatim echo of the user's own first line, computed by code, not a task excerpt). The taskFocus / task-card bans are unchanged; the boundary between "task excerpts" (extracted fresh at compact time, at most 3 sentences) and the instruction echo (every hop, first line, truncated) is kept.
- The reconcile marker text is fixed and byte-stable across turns (it lives in the bar, not in system, so system-prefix stability is not broken).
- Implementation surface: `buildAgentStatusText` field-set extension + the loop-engine injection point taking "the latest user instruction" + one-time marker settlement; the seam's shape is unchanged.

## Evidence pointers

- Session transcript `~/.iknow/projects/iknow-ddcb805367a0/ee13c787-5958-4524-95d3-0e89d520f12a/` (2026-09-18): after instruction e8 entered, 30+ same-shape bars vs 1 instruction bar; at 15:33 the user interrupted with "what is going on, why has opening one PR taken this long".
- The U-shaped distribution of long-context attention (middle retrieval accuracy markedly below head/tail) is an established literature result; per-round recitation of the task list is the mainstream countermeasure for long-horizon agents (the recitation pattern).
