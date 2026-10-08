# Plan: Persist the latest successful worktree rebind (#1227)

**Status:** Architecture review passed; all implementation tickets pending.
**Goal:** When a session creates or enters a worktree and then exits it in the same run, the next run uses the main checkout because the live root and the root persisted by the conditional save agree.
**Approach:** First settle the ordering rule for successful and failed rebinds across the live-root writer and Hub persistence. Then implement that rule through the existing rebind and conditional-save path, and verify it with isolated SessionHub/SessionStore coverage and the reported real-PTY flow. Keep the change within worktree rebind and session-root persistence; #1228 is separate.
**Spec link:** No feature spec is approved for this incident. Basis: [issue #1227](https://github.com/winner6205build/iknow/issues/1227), accepted [ADR-0037](../docs/adr/0037-worktree-isolation-on-mutate.md), and the existing `taskRoot` contract in [CONTEXT.md](../docs/CONTEXT.md).
**ACR:** All five verdicts are yes; reviewed for the planned implementation scope. This is not a claim that the repair has been implemented.
**Per-ticket loop (all implementation bullets):** TDD (RED first) → focused typecheck/tests → verification-before-completion. After all implementation bullets, run code-review → if GATE BLOCKED, review-report-repair → verification-before-completion → commit. Push requires explicit authorization.
**Persist:** None — this plan introduces no domain term or ADR change; operation revisions are implementation bookkeeping.

## Completed diagnosis

- The issue's real-PTY reproduction reports successful `create-worktree` then `exit-worktree`, followed by `bash pwd` still resolving inside the worktree; a second exit corrects it.
- A real `SessionHub` + `SessionStore` probe with an isolated temporary Git repository reproduced the persistence defect: exit returned the main checkout, but one conditional save persisted the earlier worktree root (`matchesExitReturn: false`). LSP tracing separately confirmed that the harness wrapper writes the live root after a successful seam return; the probe was not a complete TUI interaction or a concurrency experiment.
- `SessionHub.markWorktreeRootDirty` at `src/session-api/hub.ts:1880` retains the first pending root. `consumeDirtyRootOnSave` at `src/session-api/hub.ts:4526` saves that value and clears it only if it still matches. The first-wins guard came from pre-existing commit `fe2b0662` (`fix: persist worktree rebinds through hub saves`) to protect a retryable root from a competing provision.
- Existing lower-level concurrent-provision coverage does not exercise the same-run create-then-exit path. Implementation and its regression coverage remain pending.

## Architecture gate

```text
bounded-context-guardian: yes — T1/T2 keep live-root writes at the ADR-0037 harness seam and persistence in the Hub.
input-contract-tests: yes — T2 covers empty/invalid identity, unusable roots, concurrency, failures, and numeric overflow applicability.
error-handling-enforcer: yes — T2 preserves typed, nonempty errors, requires EXIT comments for new fallback exits, and forbids false success receipts.
complexity-anti-drift: yes — ordering, persistence, and PTY verification are separate tasks without prescribing a god-function or god-module.
minimal-change-verifier: yes — scope stays with #1227 rebind and persistence, excluding a side-store writer and #1228 work.
```

## Tasks (ordered by dependency)

1. **Choose the rebind ordering and persistence linearization rule** — tag: `[decision]`
   - **Inherits:** ADR-0037 §7.1: “The single write entry = the harness assembly layer's wrapper around the host `provision` / `enter` / `exit` seams (writing only when a seam resolves successfully).” It also states: “Hub / CLI-side semantics are unchanged — they only observe the returned root for dirty-root persistence.” ADR-0037 §7.4 says a successful rebind changes the live `taskRoot` immediately and applies at the next tool-call wave. Issue #1227's suggested direction is explicitly proposed, not yet settled: “The first-wins guard should protect against a concurrent competing provision, not suppress a later, sequential rebind.”
   - **Surface:** Existing harness live `taskRoot` seam and session-api rebind persistence.
   - **Acceptance:** Record one explicit linearization rule before code. It must order provisioner binding, the live-root write, pending dirty-root publication, and save ownership as one conversation-scoped transition. It must define that a newer successful rebind supersedes an older successful one; a failed newer attempt leaves the last retryable successful root intact; stale completion cannot overwrite a newer accepted root; and a save only clears the exact pending version it persisted. Decide whether serialization or revisioned intents enforce these rules. Do not use completion-order “last writer wins” by itself.
   - **Status:** [ ] pending
   - **Completion/headroom:** Serialization or a revision protocol may satisfy the contract; the choice must explain failure and concurrent-save behavior before implementation.
   - **[blocks: T2]**

2. **Persist the latest successful rebind without losing retry state** — tag: `[implementation]`
   - **Inherits:** Issue #1227 acceptance: “`create-worktree` → `exit-worktree` in one turn leaves the session on the main checkout” and “the existing concurrent-provision protection still holds.” ADR-0037 §7.1 keeps the Hub on the returned-root persistence seam; CONTEXT defines `taskRoot` as the live root used by writes and tool cwd.
   - **Surface:** Existing harness worktree provision/rebind seam, session-api dirty-root tracking and conditional save, and their tests.
   - **Acceptance:** For a same-run create-then-exit, one conditional save writes the main checkout as `workspaceRoot`, and a fresh `SessionStore` reload observes that root while the worktree remains present. A failed later operation preserves the last successful pending root for retry. A stale provision completion cannot replace a newer successful exit. A save failure retains the pending root, and a newer root arriving during a save remains pending after the older save completes. Cover repeat/ABA transitions so equality of path strings cannot clear a newer pending version. Empty/missing or invalid conversation identity and unusable root inputs keep their existing rejection contract and cannot publish dirty state; retain or extend the existing boundary tests wherever the changed seam handles them. Negative numeric input is not applicable to this no-parameter tool/string-root seam; any internally introduced counter must have a documented safe overflow strategy, or use an opaque revision identity without numeric overflow. Provision, exit and save failures preserve the existing typed, nonempty error carrier; document new fallback exits with `// EXIT:` and never turn failure into a success receipt. Use a real SessionHub, real SessionStore, real isolated temporary Git repository, fresh conversation IDs, and no repository `data/` or user session directory. Keep session serialization as the only save path; do not add a side-store writer.
   - **Status:** [ ] pending
   - **Completion/headroom:** Helper names, state representation, and test layout remain open if observable roots, durable reloads, race ordering, and retry behavior satisfy these invariants.
   - **Depends on:** T1
   - **[blocks: T3]**

3. **Prove the user-visible exit and next-run root agree** — tag: `[implementation]`
   - **Inherits:** Issue #1227 acceptance: “The receipt reflects the root that was actually persisted” and “Real PTY session: after a single `exit-worktree`, the next turn's relative-path query and `pwd` resolve to the main checkout.” ADR-0037 §7.4 requires rebind to take effect within the same run at the next tool-call wave.
   - **Surface:** TUI worktree tool receipt, session-api save result, and the configured terminal PTY path.
   - **Acceptance:** In a real TUI PTY session, create a worktree, exit once, let that run finish, then on the next run verify `bash pwd` and a relative-path query resolve under the main checkout. Capture the exit receipt and persisted session root; after a successful run save they identify the same root, while the receipt does not claim durability before the save succeeds. Preserve the tree. Run `npm test`. Use the configured `mcp__terminalcp__terminalcp` interaction (`start` → tool calls/`stdin` → `stdout` or `stream` → `stop`) with `npm run dev:tui`, and record the observable receipt and next-run output. If receipt text or other model-visible assembly changes, follow `docs/guides/prompt-development.md`, update/use the existing LSP worktree trajectory set (`tests/harness/lsp/worktree-trajectory.fixtures.ts` and offline `tests/harness/lsp/worktree-trajectory.test.ts`), and run its real-model half with `npm run test:real-llm`; report a missing credential as Not run. Do not use `process.chdir` or push changes.
   - **Status:** [ ] pending
   - **Completion/headroom:** PTY keystrokes and fixture layout remain open; the observed next-run root and durable receipt agreement are the acceptance surface.
   - **Depends on:** T2

## Implementation verification and handoff

Start in a fresh session by reading this plan, issue #1227, AGENTS.md, the linked ADR/context, and the current source through LSP. Reproduce before changing code; line references describe the investigated revision and may move. Preserve existing concurrent-provision coalescing. All three tickets are pending, and the design alternatives above are not already approved patches.

Run these existing commands after adding meaningful regression coverage:

```bash
npm run typecheck
npm run typecheck:tests
npx vitest run tests/session-api/hub-worktree-isolation.test.ts tests/session-api/worktree-rebind.test.ts tests/harness/isolation/worktree-gate.test.ts
npm test
```

Also run the new race/reload regressions and T3's real PTY scenario. If the existing worktree trajectory set is changed, run its offline half and `npm run test:real-llm -- real-llm/worktree-trajectory.test.ts`. Keep required cases pending if a server, model credential, or PTY environment is unavailable; record the command, reason, and blocker as Not run. Stop every started TUI/test server and language-server pool in cleanup. These are future implementation checks, not tests run while writing this plan.
