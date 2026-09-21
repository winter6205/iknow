# 0108. In-flight interrupt: keep the frozen prefix, drop the block still growing

Date: 2026-09-19
Status: accepted

## Context

The old reading of **in-flight closeout**: if the model is still in flight, the entire assistant message never enters history. In the implementation, cancelled kept only the user message + `Interrupted by user.`, and the streaming overlay was unloaded after settling. The operator pointed out that this is inconsistent with the established truncation unit: in the realtime process **messages already formed must be kept**, and only the **half-formed block still generating** is cut; the granularity has already been chosen as **streaming block freeze** (pinning the prefix except for the last top-level block). The tool-in-flight path already leaves appended assistant messages behind — it is not reopened by this ADR.

## Decision

When an Esc **foreground interrupt** (cancelled) lands while the model is still in flight:

1. Run the same cut over the accumulated streaming markdown that the live wall runs: `splitStreamingMarkdown`'s `prefixRaw` is written as this round's assistant into the **append-only messages** and committed; `tailRaw` is dropped.
2. No prefix (the whole text sits inside the last block still growing) → no assistant record; keep only the user + **interrupt system message**.
3. A closed `tool_use` block counts as formed and is kept; calls not yet executed follow the existing tool-in-flight closeout (`execution_failed` / `"cancelled"`).
4. The interrupt moment in the TUI, a restart/load, and the prior seen by the next ordinary turn all carry the **same shape**. Freezing the draft on the live wall while the disk lacks it is forbidden.
5. timeout / process-death resume still does not add `Interrupted by user.`; timeout's keep-cut is the same as cancelled's (prefix kept) — the wording rules are unchanged.
6. The **cut module** must be a layer the harness can already import (the existing `src/shared` seam). TUI Markdown becomes a caller. `src/harness` importing `src/tui` is **forbidden**.

## Why not

- **No assistant record for the whole step (the old closeout):** throws away complete blocks that were already pinned as if they were half-formed; on the live wall it looks like the whole turn evaporated. Already vetoed.
- **Keep every streamed token:** half-token granularity is not freeze; the operator chose pinned blocks.
- **Change only the TUI, not the authoritative history:** the interrupt moment and a restart diverge; the next model turn cannot see the complete block the human just saw. Rejected.
- **harness directly importing `src/tui`:** a reverse dependency on the display layer. Rejected.

## Consequences

- The freeze cut is one SSOT shared by the closeout keep and the live wall, not a TUI-private lexer.
- When a single block is still growing with no pinned block ahead of it, an interrupt may leave no assistant body — that is a corollary of the chosen granularity, not a regression to "drop the whole step".
- The existing "cancelled does not append assistant" tests and the old `docs/CONTEXT.md` sentence are voided together, to be re-locked by the follow-up spec/plan.
