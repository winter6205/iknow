# Plan: LSP Worktree Path Resolution

**Goal:** After a live task-root rebind, every LSP operation resolves and uses paths from the active worktree, with regressions that prove reads, writes, lifecycle transitions, and model trajectories stay on that tree.
**Approach:** First pin a per-call live-root/path snapshot across symbol reads and file-less workspace queries, then carry that same resolved path through all symbol mutations. Exercise actual host worktree transitions and real language servers before adding a tracked offline/real-model golden set and a real TUI path.
**Spec links:** [specs/251-lsp-tool.md](../specs/251-lsp-tool.md), [specs/host-read-policy.md](../specs/host-read-policy.md), [docs/CONTEXT.md](../docs/CONTEXT.md)
**ACR:** all yes; verdict copied below.
**Per-ticket loop:** TDD (RED first) → typecheck + focused tests → verification-before-completion. After all bullets: code-review → if `GATE: BLOCKED`, review-report-repair → verification-before-completion → commit. No push.
**Persist:** none — this plan introduces no domain term or ADR decision.

## Approved incident contract

> “At each LSP entry, read the current live `taskRoot` once. Resolve a relative file path to an absolute path under that snapshot; use the resulting path for root finding, read-policy checks, document open, request URI, mutation writes, preimage capture, and notifier invalidation. A workspace query without a file uses the active root.”
>
> “Do not call `process.chdir`; preserve existing permission/read-policy/write containment, client rebind sweeping, and no-anchor hierarchy sentinel semantics. Do not expand the fix to pre-switch null results without reproduction evidence.”

This is the approved incident contract for this plan, not a new feature spec. Relevant settled context is in the linked LSP and host-read-policy specs and the `taskRoot` / rebind entries in `docs/CONTEXT.md`.

## Evidence and current state

- Latest trace `f7a19a4a-b635-4cdd-b1c8-e54b77a61f92` (`2026-10-07T17:50Z`) shows worktree creation becoming ready, followed by a relative `src/shared/schema.ts` request returning `no-root`.
- Current source inspection finds the live root read and stale-client sweep in `src/harness/lsp/client.ts:548`; `src/harness/lsp/server.ts:48` resolves `path.dirname(file)` against the host process working directory. `symbol.ts` passes the incoming file through document open and request URI creation, while the file-less workspace helper in `lsp.ts` samples frozen `ctx.directory`.
- The inspected source is current working-tree evidence; it does not prove that these exact source bytes were running in the trace above.
- Current suites cover mocked client/root switching and tool contracts. They do not yet prove that a real language-server request after host worktree rebind uses the correct file URI and filesystem tree.

## Candidate touchpoints

These are existing surfaces to inspect during implementation, not a required patch shape.

| Surface | Candidate touchpoints | Responsibility |
| --- | --- | --- |
| ACI symbol tools | `src/harness/aci/tools/{symbol,symbol-mutate,symbol-resolver,lsp}.ts` | Resolve one active-root path and preserve the existing read, sentinel, and mutation contracts. |
| LSP client and server | `src/harness/lsp/{client,server,notifier}.ts` | Root lookup, client rebind sweep, document lifecycle, request URIs, and invalidation. |
| Harness assembly | `src/harness/build-engine.ts`, `src/harness/aci/tools/registry.ts` | Change only if reproduction shows the live-root cell is not available at the necessary entry point. |
| Existing regression surfaces | `tests/harness/aci/`, `tests/harness/lsp/`, `tests/session-api/worktree-rebind.test.ts` | Extend the existing tool, client, and host lifecycle coverage. |
| Golden set and interactive path | `real-llm/`, `vitest.real-llm.config.ts`, `docs/guides/prompt-development.md`, plus the relevant existing harness tests | Keep offline and real-model halves beside the behavior and register the real-model case in the tracked set roster. |

No dependency, lockfile, settings, permission-policy, or read-policy change is in scope. Preserve the existing policy and containment boundaries while fixing path identity.

## Shared regression and failure contract

- Input cases include empty and whitespace paths, invalid types (`file: -1`, `symbol_path: -1`), negative legacy coordinates (`line: -1`, `column: -1`), and overlong inputs. Existing schema and policy decisions remain authoritative.
- Path cases include `../` escapes, absolute paths outside the active project, ordinary and escaping symlinks, dangling links, symlink loops, missing files/markers, and synthetic protected-path fixtures containing no real credentials. Refusals must precede document opening or writes; ordinary permitted symlinks remain permitted.
- Lifecycle cases include disabled servers, spawn failures, cancellation, timeouts, repeated calls, overlapping document opens, and a rebind racing a request. Root lookup, authorization, request URI, write containment, and preimage identity cannot mix snapshots within an operation. Follow the existing request/wave dispatch contract rather than introducing new switching semantics.
- Every new failure or fallback branch preserves typed, nonempty failure identity and cause, with `// EXIT:` documenting its exit condition. Do not swallow exceptions or turn failures into `null`/`[]`. Preserve the existing distinction between a missing project anchor, an unsupported capability, a genuine empty query result, and an execution failure.
- Multi-file edit validation rejects an unsafe batch before writes. Preserve existing persisted write-progress behavior for later filesystem failures; this plan does not promise transactional rollback for arbitrary I/O failures.

## Tasks (ordered by dependency)

1. **Resolve read and workspace-query paths from one active-root snapshot** — `[implementation]`
   - **Inherits:** “At each LSP entry, read the current live `taskRoot` once. Resolve a relative file path to an absolute path under that snapshot.” Preserve the existing upper-bound and failure contracts in [specs/251-lsp-tool.md](../specs/251-lsp-tool.md) and [specs/host-read-policy.md](../specs/host-read-policy.md).
   - **Surface:** Existing ACI symbol tools and LSP client/server surfaces.
   - **Acceptance:** A reproduced post-rebind relative-path query resolves beneath the active worktree, and the resolved path is used consistently for root finding, read-policy evaluation, document open, and request URI. A file-less workspace query selects the active root and returns a known unique symbol from that worktree. A correct hover or call-hierarchy query against a known symbol returns a meaningful result. Existing no-anchor hierarchy behavior remains the documented sentinel. Relative and absolute inputs, empty/non-string paths, negative coordinates in the legacy LSP surface, overflow, unsafe traversal, missing markers/files, and resolution exceptions have explicit existing-contract outcomes; no error is hidden as an empty success.
   - **Verification:** Extend the existing LSP and symbol-tool tests; run focused LSP tests and `npm run probe:lsp -- --lang typescript` plus `npm run probe:lsp -- --lang python`. The probe writes git-ignored `.iknow/probe-lsp`; remove that generated directory after the probe. A real-file regression must prove the returned symbol or URI belongs to the active tree; fake-client green alone does not satisfy this acceptance.
   - **Status:** [ ] pending
   - **Depends on:** none.
   - **Completion/headroom:** Any implementation may choose its own helper and test layout if one entry snapshot drives every listed path use and the observable queries identify the active tree.

2. **Keep all symbol mutations on the resolved worktree paths** — `[implementation]`
   - **Inherits:** “Use the resulting path for … mutation writes, preimage capture, and notifier invalidation.” Preserve the live-`taskRoot` write containment and the existing whole-batch `WorkspaceEdit` failure contract in [specs/host-read-policy.md](../specs/host-read-policy.md) and the LSP lifecycle contract in [specs/251-lsp-tool.md](../specs/251-lsp-tool.md).
   - **Surface:** Existing ACI symbol mutation tools, LSP client/notifier, and their harness tests.
   - **Acceptance:** Exercise `rename_symbol`, `replace_symbol_body`, `insert_before_symbol`, `insert_after_symbol`, and `safe_delete_symbol` against same-path fixtures in the main checkout and a worktree. Successful writes and every file in a returned `WorkspaceEdit` stay within the active task root; the main-checkout bytes remain unchanged. Preimages and notifier invalidation identify the same resolved files that were written. A protected, escaping, symlink-escaping, dangling, looping, or otherwise invalid target causes a typed, nonempty failure before any part of a multi-file edit is written. Existing containment and no-anchor sentinel behavior remain intact.
   - **Verification:** Extend the existing mutation and preimage tests with real temporary files and unsafe returned edit targets; verify actual file bytes and notifier/preimage observations, not only mock call counts.
   - **Status:** [ ] pending
   - **Depends on:** T1.
   - **Completion/headroom:** Implementers may organize resolution and write plumbing differently if all five mutation outcomes, whole-batch validation, preimages, notification paths, and containment are observable as stated.

3. **Prove host rebinds and repeated switches with real servers** — `[implementation]`
   - **Inherits:** “A workspace query without a file uses the active root.” “Preserve … client rebind sweeping.” Keep the per-request document open/close and failure-stage behavior specified in [specs/251-lsp-tool.md](../specs/251-lsp-tool.md).
   - **Surface:** Existing session-api worktree lifecycle, harness LSP integration tests, and client/server lifecycle.
   - **Acceptance:** In a disposable temporary Git repository, use the production host/session seam to make and enter actual worktrees through `main → tree A → main → tree B`. Put different unique symbols at the same relative path in each tree. Real TypeScript and Python language servers return only the active tree's known symbols and URIs after each transition; a concurrent request wave uses its captured root consistently, and a second session stays isolated. The regression demonstrates the rebind sweep still reclaims stale clients and that repeated switches do not reuse another tree's project. The harness and language-server processes and temporary Git data are cleaned in `finally` paths.
   - **Verification:** Extend existing `tests/session-api/worktree-rebind.test.ts` and LSP integration surfaces; run the focused host/LSP tests and both existing LSP probes. Use actual temporary files, actual `git worktree` operations, and real language servers for the root/URI assertions.
   - **Status:** [ ] pending
   - **Depends on:** T1.
   - **Completion/headroom:** The host fixture and integration seams may differ if they exercise production rebind behavior, both language servers, repeated transitions, concurrency, session isolation, and cleanup end to end.

4. **Lock the worktree trajectory in a tracked offline/real-model golden set** — `[implementation]`
   - **Inherits:** “Do not call `process.chdir`; preserve existing permission/read-policy/write containment.” Follow [docs/guides/prompt-development.md](../docs/guides/prompt-development.md): a trajectory set has a fixed input, a decidable trajectory, an offline half, a real-model half, and a roster entry beside its owning behavior.
   - **Surface:** Existing ACI golden/harness tests, the `real-llm/` runner surface, `vitest.real-llm.config.ts`, and the prompt-development golden-set roster.
   - **Acceptance:** Fixed cases cover creating a worktree and querying/renaming its unique symbol; entering an existing worktree and querying it; a file-omitted workspace query returning a known worktree symbol; exiting and confirming the original-tree symbol and bytes; and refusing an unsafe path without side effects. Successful hover and call-hierarchy cases target known symbols and assert meaningful non-null results. Gates inspect tool results, recorded production tool/loop trace, final filesystem contents, and result URIs; no silent tool success or model prose substitutes for these checks. The real-model runner drives actual host worktree creation/entry through the production seam and never manually rebinds to manufacture success. The set is registered in `TRACKED_INCLUDE` so a clone can run it. A missing real-model key is explicitly `Not run` and blocks a claim that the golden set passed; offline success alone is not a set pass.
   - **Implementation notes:** Reuse the existing `real-llm/tool-role-substitution.test.ts` and `real-llm/verify-status-contract.test.ts` runner pattern (`loadRealLlmEnv`, `buildHarnessEngine`, `run`) where it fits. Keep fixtures beside the owning behavior; do not create a central golden dump. Use the current model selection from settings without changing settings. Generated Git repositories and engines/pools are cleaned in `finally` paths.
   - **Verification:** Run the offline fixture tests and `npm run test:real-llm`. Do not replace hard gates with an LLM judge or pass-rate threshold.
   - **Status:** [ ] pending
   - **Depends on:** T1, T2, and T3.
   - **Completion/headroom:** The runner, fixture grouping, and exact prompt wording remain open if the fixed cases and observable gates hold, the set is cloned-and-runnable, and the real-model result is reported honestly.

5. **Verify the complete interactive worktree path in a real TUI session** — `[implementation]`
   - **Inherits:** “A workspace query without a file uses the active root.” “Do not call `process.chdir`.” Preserve existing worktree lifecycle and tool behavior from [docs/CONTEXT.md](../docs/CONTEXT.md) and the linked LSP specs.
   - **Surface:** Existing TUI/harness worktree and LSP surfaces, using the configured terminal interaction tool.
   - **Acceptance:** A real PTY session exposes the LSP capability, creates or enters a worktree, queries a known symbol, mutates it, exits the worktree, and queries the original tree. Captured terminal output and production trace show the calls and results; filesystem inspection confirms the worktree changed and the original file stayed unchanged. Stop the TUI/test server and LSP processes at the end.
   - **Verification:** Use the configured terminal tool's `start` / `stdin` / `stream` or `stdout` / `stop` lifecycle and record the observable output plus final file state.
   - **Status:** [ ] pending
   - **Depends on:** T4.
   - **Completion/headroom:** The exact keystrokes and terminal session setup may vary if the complete production path and both trees' final contents are directly observed.

## Architecture-change-reviewer verdict

```text
bounded-context-guardian: yes — the scope stays within LSP tools, their existing path-policy boundaries, and the harness/golden tests; it adds no permission policy.
input-contract-tests: yes — the revision explicitly covers empty, negative, overflow, concurrent wave snapshots, exceptions, and invalid or unsafe path fixtures.
error-handling-enforcer: yes — new failure branches must keep typed, nonempty errors with stage identity and // EXIT: conditions, while preserving the no-anchor sentinel.
complexity-anti-drift: yes — the shared per-call root/path snapshot keeps the tool handlers thin and avoids duplicated resolution logic.
minimal-change-verifier: yes — the production fix, regressions, and golden set all verify the same taskRoot switching failure.
```

## Delivery verification

After the focused tests added by each ticket pass, run the existing entry points below and record actual exit codes, case counts, and evidence locations. These commands are future implementation acceptance, not checks performed while writing this plan.

```bash
npm run typecheck
npm run typecheck:tests
npx vitest run tests/harness/lsp/live-directory.test.ts tests/harness/lsp/server.test.ts tests/harness/aci/lsp.test.ts tests/harness/aci/symbol-mutate.test.ts tests/harness/aci/symbol-mutate-preimage.test.ts tests/session-api/worktree-rebind.test.ts
npm test
npm run probe:lsp -- --lang typescript
npm run probe:lsp -- --lang python
npm run test:real-llm
```

Also run every new integration/offline fixture test selected during implementation and the T5 PTY scenario. A collected-but-skipped set, a zero-case run, or a fake server does not satisfy its corresponding real-server/real-model acceptance. Report unavailable checks as `Not run` with the reason; keep the affected ticket pending. Record the final code-review verdict and repair any blocking findings before delivery verification and commit. Push requires an explicit user instruction.
