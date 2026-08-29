# Plan: TUI tool fold preserves text order

**Goal:** In the idle ChatView, a consecutive tool-use fold appears in transcript order after assistant text that precedes it.
**Approach:** Add pure ordered-activity segmentation for text and consecutive tool-use clusters, then have ChatView render the idle fold at that in-place position. Keep live-tail slots unchanged and cover the helper boundaries plus both text/tool ordering directions in the TUI tests.
**Spec link:** No separate spec; scope and acceptance are inherited from the Slice 1 handoff in this task.
**Tracker:** Local markdown fallback; this is a single scoped TUI slice and no GitHub issue is required.
**待写入:** None.
**ACR:** all-yes (Slice 1; see the 5-verdict block below).
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

```text
bounded-context-guardian: yes — exact four-file change remains within src/tui/, ordering owned by turn-activity.ts, rendering by chat-view.tsx
defensive-contract-validator: yes — empty, negative, overflow, concurrent N/A pure sync, exception
error-handling-enforcer: yes — typed deterministic fallbacks + // EXIT:
complexity-anti-drift: yes — pure segmentation helpers
minimal-change-verifier: yes — one TUI idle-fold task, one commit, Slice 2 deferred
OVERALL: PASS
```

## Tasks (ordered by dependency)

1. **Preserve text/tool order for idle tool folds** — tag: `[implementation]`
   - **Inherits:** Slice 1 scope: ordered segments distinguish text from consecutive `tool_use` clusters; typed deterministic fallbacks retain `// EXIT:` markers; idle folding happens in place after preceding text, never after the query; `liveTailSlots` remains unchanged. Boundary coverage includes empty, negative, overflow, concurrent N/A for pure synchronous helpers, and exception paths.
   - **Surface:** TUI (`src/tui/`) and TUI tests (`tests/tui/`)
   - **Acceptance:** An idle turn with assistant text before a tool renders the collapsed tool fold after that text; a tool before later assistant text renders the fold before the following text; query-only and empty activity do not create an incorrectly positioned fold; live-tail rendering is unchanged. The ordered-segment helpers and both rendering cases are covered by `tests/tui/turn-activity.test.ts` and `tests/tui/chat-view-thinking-tool-fold.test.tsx`, and the relevant Vitest run is green.
   - Status: [ ] pending

## Deferred

- Slice 2, in a later commit: session-api ordered activity DTO plus the Web AgentCard.
