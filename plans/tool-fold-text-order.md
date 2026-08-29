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
   - Status: [x] done

## Deferred

- Slice 2, in a later commit: session-api ordered activity DTO plus the Web AgentCard.

## Slice 2

**Goal:** Add a session-api `activity` projection that preserves native content-block order, then have the Web `AgentCard` render that order without changing the legacy layout or existing `finalText` / `thinking` / `toolCalls` projections.

**Approach:** Carry one additive ordered-activity DTO from the session-api projector through the existing response path and mirror its shape in the Web API types. The AgentCard consumes the ordered field when present and keeps the legacy layout as the compatibility fallback; the projector and UI tests prove the EXIT contract and both text/tool ordering directions.
**Spec link:** No separate spec; scope and acceptance are inherited from the Slice 2 ACR handoff (`bc-e209574f`).
**Tracker:** Local markdown fallback; this is a single scoped session-api/Web slice and no GitHub issue is required.
**待写入:** None.
**ACR:** all-yes (Slice 2; `bc-e209574f`).

## ACR

```text
bounded-context-guardian: yes — the additive DTO stays within the existing session-api contract/projection and Web AgentCard boundary
defensive-contract-validator: yes — empty, malformed, unknown, unpaired, duplicate, pending-result, and non-throwing paths have explicit EXIT behavior
error-handling-enforcer: yes — malformed activity is skipped or ignored deterministically and projector failure returns an ActivityItem[] without swallowing an undefined outcome
complexity-anti-drift: yes — one ordered projector and one compatibility render path keep the slice narrow
minimal-change-verifier: yes — one additive ordered-activity task, exact scoped files, one commit, legacy projections preserved
OVERALL: PASS
```

**Affected files (exact):**

1. `src/session-api/contract.ts`
2. `src/session-api/turn-projection.ts`
3. `src/session-api/hub.ts` (only if wire plumbing is required)
4. `web/src/api/types.ts`
5. `web/src/components/AgentCard.tsx`
6. `tests/session-api/turn-projection.test.ts`
7. `tests/web/agent-card-activity-order.test.tsx`

## Tasks (ordered by dependency)

1. **Expose and render ordered session activity with legacy compatibility** — tag: `[implementation]`
   - **Inherits:** Slice 2 ACR EXIT contract: empty → `[]`; malformed `tool_use` → skip; unknown block → skip; unpaired `tool_result` → ignore; duplicate `tool_result` → first wins; `tool_use` without a result → still emit; projector never throws; absent/empty `activity` with legacy fields → legacy layout. `activity` is additive, and existing `finalText` / `thinking` / `toolCalls` masking and truncation remain unchanged.
   - **Surface:** Existing session-api contract/projection/response boundary and Web AgentCard; the exact allowed files are listed above.
   - **Acceptance:** The session-api exposes an ordered `activity` DTO without replacing legacy projections; native text and tool order, tool-result pairing, and all EXIT cases are observable in `tests/session-api/turn-projection.test.ts`; the Web AgentCard renders non-empty activity in text → tool and tool → text order, while absent/empty activity retains the legacy thinking → body → tools layout in `tests/web/agent-card-activity-order.test.tsx`; the relevant test/typecheck commands pass.
   - **Completion:** A second implementer can choose different helper names or internal splits while preserving the additive wire shape, EXIT outcomes, ordering behavior, compatibility fallback, and exact file scope.
   - Status: [x] done

**Projector EXIT contract:**

| Case | Behavior | EXIT |
| --- | --- | --- |
| empty messages / empty `content[]` | return `[]`; legacy `finalText` / `thinking` / `toolCalls` remain unchanged | `// EXIT: empty activity` |
| content block missing required fields | skip that block and continue | `// EXIT: skip malformed tool_use` |
| unknown/unexpected block type | skip and continue | `// EXIT: skip unknown block` |
| `tool_result` without matching `tool_use` id | ignore for pairing; do not invent a tool item | `// EXIT: unpaired tool_result ignored` |
| duplicate `tool_result` for one id | first result wins; later results are ignored | `// EXIT: duplicate tool_result ignored` |
| `tool_use` without a result | emit pending/empty result fields allowed by `ToolCallView` | `// EXIT: tool without result still emitted` |
| bad session data causing any projector path | never throw; return `ActivityItem[]` as documented in helper JSDoc | `// EXIT: projector returns activity items` |

**Compatibility acceptance:** `activity` is emitted only as an additive wire field; legacy fields and their masking/truncation behavior remain unchanged. One logical ordered-activity task, one commit.
