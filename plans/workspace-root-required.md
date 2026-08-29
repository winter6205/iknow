# Plan: workspace-root-required

**Goal:** Every new session is created with an explicit `workspaceRoot`; every session-backed execute path rejects an unbound or legacy-invalid session before engine execution; and a successful rebind is persisted through a Hub-owned dirty-root protocol.
**Approach:** First record the reopened serve decision and vocabulary, then make root binding mandatory at creation and fail-fast at execution. Finish with a Hub dirty flag that bridges the existing harness isolation provision seam to conditional session save, preserving the dirty root when save fails. No cwd backfill, silent migration, or harness isolation contract change is in scope.
**Spec link:** `specs/serve-workspace.md` plus the operator-locked decisions in this task; this plan extends the existing serve-only wording to all session-backed surfaces.
**Tracker:** Local plan fallback; no tracker edge is added by this planner.
**ACR:** BLOCKED draft — the separate `architecture-change-reviewer` must replace every placeholder in the verdict block below. This plan does not self-certify ACR.
**Per-ticket loop (all implementation bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## Ownership and invariants

- **`session-api`:** owns the `SessionFile` contract, Hub create/bind, the per-`conversationId` dirty map, execute fail-fast, and missing-root archive/invalid classification.
- **`cli` / `tui`:** resolve a root before calling Hub bind/create; they must not bootstrap or write a session file through a parallel path that lacks a root. TUI provisioning goes through the Hub-visible seam.
- **Harness isolation gate:** its existing provision contract is unchanged. Hub wraps provision only to observe a different returned root and mark that conversation dirty.
- **Docs:** reopen ADR-0023 and update the `CONTEXT.md` terms so serve's current `~/.iknow/default` auto-bind is described as an explicit default bind, never as “unbound”.
- **No cwd backfill:** an absent root is never replaced with `process.cwd()` or any other inferred directory.
- **Legacy policy:** load/list may detect a missing root and classify the session as archived/invalid, but no legacy session may run the engine. The user receives a clear recreate/bind error.

## ACR — placeholders for the separate reviewer

```text
bounded-context-guardian: [TO BE FILLED BY ACR] — verify session-api owns SessionFile/Hub/dirty/archive behavior; cli/tui only resolve and pass roots; harness provision contract remains unchanged; docs own ADR/CONTEXT updates.
defensive-contract-validator: [TO BE FILLED BY ACR] — verify the named empty/negative/overflow/concurrent/exception cases cover create, execute, dirty-save, and legacy-reject without a cwd fallback.
error-handling-enforcer: [TO BE FILLED BY ACR] — verify typed errors and EXIT comments exist for create-unbound, execute-unbound, legacy-invalid, provision-fail, and save-fail with dirty retention.
complexity-anti-drift: [TO BE FILLED BY ACR] — verify requireBoundRoot, markWorktreeRootDirty, and consumeDirtyRootOnSave keep validation, dirty bookkeeping, and persistence separate; no god persist function.
minimal-change-verifier: [TO BE FILLED BY ACR] — verify T0–T3 are four logical commits, with no product-code or scope changes outside the listed surfaces.
OVERALL: [TO BE FILLED BY ACR] — implementation is blocked until the separate ACR returns all yes or N/A-with-reason.
```

## Boundary coverage required before implementation is considered complete

- **Empty:** creating/binding with `workspaceRoot=""` or whitespace rejects before a `SessionFile` is written; executing a session with no root rejects; dirty-save with no dirty root is a no-op; a legacy file with the root field absent is classified archived/invalid and never executes.
- **Negative:** the existing schema path-limit validator rejects a negative lower-bound/length fixture without coercion or cwd fallback; the same rejection applies at create/bind and legacy classification.
- **Overflow:** a root exceeding the existing schema path limit rejects at create/bind and cannot enter the engine or dirty map; an oversized legacy root is invalid and remains non-executable.
- **Concurrent:** two first-mutate/provision calls for one `conversationId` race with conditional save; the first successful different root is not lost, an unchanged-root provision does not dirty the map, and save does not clear a dirty root before persistence succeeds.
- **Exception:** provision failure returns its typed error and exits without changing the session root; save failure returns its typed error, emits the save EXIT path, and retains the dirty root for a later retry. These cases must be exercised through the Hub/TUI-visible provision seam, not only a private helper.

## Typed error and EXIT contract

- **Create unbound:** typed `ValidationError` with the `workspaceRoot` field; `// EXIT: reject-create-before-session-file`.
- **Execute unbound:** typed `ValidationError` with the `workspaceRoot` field on every session-backed surface; `// EXIT: reject-execute-before-engine`.
- **Legacy invalid:** typed validation/archive classification with a clear recreate-or-bind message; `// EXIT: archive-invalid-session-no-engine`.
- **Provision failure:** typed provision error, with no root mutation or silent fallback; `// EXIT: reject-mutate-and-retain-current-root`.
- **Save failure:** typed save error; `// EXIT: report-save-failure-and-retain-dirty-root`.

## Tasks (ordered by dependency)

1. **T0 — Reopen workspace binding decisions and record the ACR verdict** — tag: `[decision]`
   - **Inherits:** Operator decisions 1–5: create requires `workspaceRoot`; unbound execute is a typed validation failure on all session-backed surfaces; legacy unbound sessions reject execute and are archived/invalid; rebind persistence is a Hub dirty flag keyed by `conversationId`; serve unbound is not a normal product state.
   - **Surface:** `docs/adr/0023-serve-workspace-explicit.md`, `docs/CONTEXT.md`, and this plan's ACR block.
   - **Acceptance:** ADR-0023 explicitly reopens the serve exception and states that the current `~/.iknow/default` auto-bind is an explicit default bind, not unbound; CONTEXT defines the required-root, legacy-invalid/archive, and dirty-root terms; the plan contains the separate reviewer's completed five-line verdict block. This decision commit does not implement product code.
   - **Completion:** The reopened decision and vocabulary are reviewable without inferring policy from implementation details, and the plan is unblocked only by a separate ACR pass.
   - Status: [ ] pending

2. **T1 — Require a root when creating sessions** — tag: `[implementation]`
   - **Inherits:** T0; new sessions on `cli chat`, `tui`, and `serve` must have `workspaceRoot` at create; no silent cwd-as-bind and no parallel rootless session-file bootstrap.
   - **Surface:** `session-api` SessionFile/Hub create-bind path plus `cli` and `tui` root-resolution seams and their contract tests.
   - **Acceptance:** each of the three entry surfaces resolves/validates a root before Hub create/bind; a missing, empty, negative-bound, or overflow root returns the typed create error before disk write; a created session file contains the validated root; no create path can infer cwd.
   - **Completion:** A fresh session can be traced from each entry surface to one Hub-owned create/bind operation with a root present, while implementers retain freedom over exact file/helper placement.
   - [blocks: T0]
   - Status: [ ] pending

3. **T2 — Fail fast on execute and reject legacy unbound sessions** — tag: `[implementation]`
   - **Inherits:** T0–T1; unbound execute is invalid on all session-backed surfaces; missing-root legacy sessions are not happy-path compatible and must not run the engine.
   - **Surface:** `session-api` Hub execute/load/list classification, with `cli`, `tui`, and `serve` call paths covered at the Hub boundary and in bypass-prevention tests.
   - **Acceptance:** `requireBoundRoot` runs before engine construction or `postMessage`; unbound current sessions return typed `ValidationError` with the execute EXIT path; load/list can expose an archived/invalid classification for missing or malformed roots; such sessions return a clear recreate/bind error and never call the engine; no surface silently migrates or backfills cwd.
   - **Completion:** All session-backed execute callers share one observable fail-fast contract, and legacy handling is an explicit reject/archive path rather than an implicit migration.
   - [blocks: T1]
   - Status: [ ] pending

4. **T3 — Persist rebinds through Hub dirty-root conditional save** — tag: `[implementation]`
   - **Inherits:** T0–T2; the harness isolation gate's provision contract is unchanged; Hub marks `conversationId → newRoot` only when provision returns a different root; conditional save applies the dirty root and clears it only after success.
   - **Surface:** `session-api` Hub dirty bookkeeping and save path, the TUI Hub-visible provision seam, existing harness isolation integration seam, and focused boundary/integration tests.
   - **Acceptance:** `markWorktreeRootDirty` records only a changed provision result; `consumeDirtyRootOnSave` supplies that root to conditional save and clears it only after a successful write; unchanged provision does not dirty; provision failure leaves the current root unchanged; save failure emits its typed EXIT path and retains the dirty root; TUI provisioning exercises the same Hub-visible seam; no reload-if-defined design or god persist function is introduced.
   - **Completion:** A successful rebind survives reload through one conditional save path, concurrent first mutation cannot lose the dirty root, and failure leaves enough state for a safe retry.
   - [blocks: T2]
   - Status: [ ] pending

## Required decomposition

The implementation must keep these responsibilities as separate helpers or equivalent single-purpose units:

- `requireBoundRoot`: validate the session root and produce the typed execute/create boundary error before engine work.
- `markWorktreeRootDirty`: observe a provision result and record only a different root for one `conversationId`.
- `consumeDirtyRootOnSave`: atomically coordinate conditional save input and post-success dirty-state clearing.

The plan explicitly forbids combining root validation, provision, engine execution, dirty bookkeeping, and persistence into one god persist function.

## 待写入

- Reopen `docs/adr/0023-serve-workspace-explicit.md`: required bind at session creation across `cli chat`, `tui`, and `serve`; serve unbound is invalid rather than normal; `~/.iknow/default` auto-bind is an explicit default bind; legacy missing-root sessions reject execute and follow archive/invalid classification; no cwd backfill.
- Update `docs/CONTEXT.md`: add or revise the terms for required `workspaceRoot`, legacy archived/invalid session, Hub dirty root, and the Hub-visible provision seam; preserve the distinction between product workspace binding and harness isolation.
- Record the completed separate ACR five-verdict block in this plan before T0 is treated as unblocked.
