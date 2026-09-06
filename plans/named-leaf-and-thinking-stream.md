# named worktree leaf + thinking stream placement

Worktree: `.iknow/worktrees/fix-named-leaf-thinking`  
Branch: `fix/named-leaf-thinking-stream`

Operator: after news HTML, follow-up looked idle (104s llm_call, 0 tools, cancelled). Two product bugs: labeled task worktree leaf still encodes `--<conversationId>`; live thinking stays in a fixed panel above live drafts.

## 5-line ACR verdict

Two logical tasks, sequenced (minimal-change conflict if merged). Each task all-yes on its own file set.

### Task 1 — name-only labeled leaf

affects: `src/harness/isolation/worktree-gate.ts` `src/session-api/worktree-rebind.ts` `src/harness/build-engine.ts` `src/harness/aci/tools/read-file.ts` `src/harness/aci/tools/grep.ts` `src/harness/aci/tools/glob.ts` `src/tui/environment-pane.tsx` `specs/task-worktree-lifecycle.md` matching tests

bounded-context-guardian: yes — naming SSOT stays in isolation/worktree-gate; session-api consumes it; no reverse import.
defensive-contract-validator: yes — empty/invalid name still UUID-only; duplicate name → worktree_exists; legacy `--` leaf still inverts; sidecar unreadable EXIT; concurrent same-session provision still coalesces.
error-handling-enforcer: yes — duplicate path keeps typed worktree_exists; sidecar IO failure is EXIT-documented and does not silent-pass writes.
complexity-anti-drift: yes — split shape (`isTaskWorktreePath`) from identity (`taskWorktreeOwnerOf`); no god-function plan.
minimal-change-verifier: yes — 1 commit: labeled leaf is the name; identity is not in the folder name.

### Task 2 — thinking stream under last returned text

affects: `src/cli/stream-draft.ts` `src/tui/chat-view.tsx` `tests/tui/streaming-thinking-close-on-tool-call.test.tsx` `tests/tui/thinking-live-after-draft.test.tsx`

bounded-context-guardian: yes — stream-draft remains the thinking-draft SSOT; ChatView only moves the live panel relative to tailSlots.
defensive-contract-validator: yes — thinking→text clears buffer; thinking after sealed draft renders below; empty thinking still hidden; tool_call_start close stays.
error-handling-enforcer: yes — no new failure paths; listener flush already swallows observer throw (D3).
complexity-anti-drift: yes — no new abstraction layer; reuse tailSlots + existing panel.
minimal-change-verifier: yes — 1 commit: live thinking appears after already-returned live text.

## Tracer bullets

T1 [implementation] Name-only labeled task worktree leaf; duplicate name fails closed.
T2 [implementation] Live thinking panel after live tail drafts; close thinking on text_delta.

## 待写入

- CONTEXT `task worktree label`: 叶子改为 `<slug>`，身份不进文件夹名。
- spec `task-worktree-lifecycle.md` 条款 1 / 成功标准 1。
