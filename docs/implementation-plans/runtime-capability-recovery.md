# Plan: Runtime capability recovery

**Goal:** Package installs requested within the existing permission and egress boundaries produce truthful, recoverable results; TypeScript and Python LSP work in real projects; and the existing TUI memory switch disables the complete memory capability when OFF.
**Approach:** Start by reproducing and classifying the trace symptoms, then settle the existing LSP and memory contract records before implementation. Land command execution, LSP recovery, and memory gating as three independent behavior changes; synchronize the remaining memory vocabulary after its runtime behavior is verified. Do not add an npm-specific bypass, widen network policy, or change shell-wide pipeline semantics.
**Spec link:** [`specs/251-lsp-tool.md`](../../specs/251-lsp-tool.md) (existing LSP spec; the approved recovery brief supplies the additional command and memory contracts).
**Approved contract brief:** [`docs/guides/runtime-capability-recovery.md`](../guides/runtime-capability-recovery.md)
**Read-side contracts:** [`specs/251-lsp-tool.md`](../../specs/251-lsp-tool.md); ADR-0031, ADR-0033, ADR-0042, ADR-0086, ADR-0097, ADR-0104, ADR-0107, ADR-0140, and ADR-0032; [`docs/guides/prompt-development.md`](../guides/prompt-development.md).
**Per-ticket loop (implementation bullets):** TDD → typecheck + focused tests → verification-before-completion. After all implementation bullets: code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion → commit.
**Delivery status:** Implementation landed on branch `feat/runtime-capability-recovery` (see each ticket's `Status:` line). The branch is **not yet merged**; no ticket below records a merge commit. Ticket status lines use the sibling plans' `Status: [x] implemented (<sha>)` form without the `and merged` wording, because nothing here has been merged.
**Fix gate:** Reproduce a gap before changing runtime behavior. If a route already meets its acceptance, retain it and record the evidence; the incident does not establish that every listed client is broken.
**Completion rule for every ticket:** Its acceptance has observable evidence, and a second implementer could satisfy it using different helper names and internal file splits.
**Failure contract for T4–T6:** Preserve or introduce typed failure results at the owning module's interface; permission, egress, spawn, exit, timeout, cancellation, LSP initialization, and memory-disabled outcomes must retain their identity and cause through the model-visible projection. Generic strings alone do not satisfy this contract. Every added fallback branch documents its exit criteria with `// EXIT:`; no swallowed exception or silent downgrade passes acceptance.

## Existing implementation scope

These are candidate touch points, not a prescribed patch. Reproduction selects the smallest required subset; tests remain with their owning behavior.

| Separate logical task | Existing touch points                                                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: Command execution  | `src/harness/aci/tools/bash.ts`, `src/harness/sandbox/egress/assembly.ts`, `src/harness/sandbox/egress/session.ts`, `src/harness/background/manager.ts`, `src/harness/verify/sandbox-run.ts`; existing permission policy is inherited. |
| B: LSP recovery       | `src/harness/lsp/server.ts`, `src/harness/lsp/client.ts`, `src/harness/aci/tools/lsp.ts`, `src/harness/aci/tools/symbol.ts`, `scripts/lsp-probe.ts`, `scripts/lsp-probe-targets.ts`.                                                   |
| C: Memory OFF         | `src/tui/app.tsx`, `src/tui/deps.ts`, `src/harness/build-engine.ts`, `src/harness/memory/assembly.ts`, `src/harness/memory/auto-hook.ts`, `src/harness/aci/tools/registry.ts`, and the existing CLI / session-api assembly paths.      |

Keep A, B, and C separately reviewable and landable. No functional code, settings, dependencies, or lockfiles are changed by this planning delivery.

## Settled contract and open choices

- **Settled:** Permission, filesystem, egress, domain approval, and explicit-deny behavior remain the existing policy for foreground, background, and verify routes. `full_auto` keeps its existing bounded meaning and does not bypass egress or hard walls. Non-interactive unknown-domain access remains fail-closed. Package setup must work across ecosystems without an npm-only exception.
- **Settled:** A shell command's reported status is the shell's actual status. A pipeline without `pipefail` cannot prove an earlier installer's status; tests that need that status must run the installer directly or opt into `pipefail` for that command. Do not enable `pipefail` globally.
- **Settled:** LSP evidence names the server and failed stage. Unsupported methods remain distinct from startup failure. The target includes real TypeScript and Python servers, project/worktree executable resolution, and same-session recovery after an approved install.
- **Settled:** The existing TUI **Automatic memory** switch is the total memory capability switch. OFF takes effect on the next model request: no memory tools/schema, existence pointer, catalog, prefetch, background memory jobs, or memory writes; stale calls are rejected before reading or writing; stored data is retained. ON restores current behavior, including ADR-0033's existing Dream schedule; `ask` remains opted out. No new UI or settings field is introduced.
- **Open until evidence:** Which command-execution or LSP layer caused the trace incident. Preserve observed exit/stage evidence and keep any code fix minimal to the reproduced gap.
- **Open to implementers:** Exact helper, type, and test-file structure. The current Python probe's operation coverage and assertions must be strengthened, but implementation names and internal seams remain open.

## ACR

```text
bounded-context-guardian: yes — A/B/C remain separately landable within existing execution, LSP, and memory capabilities.
input-contract-tests: yes — the boundary allocation covers all five classes for T4–T6, with overflow N/A justified for the boolean toggle.
error-handling-enforcer: yes — the failure contract requires typed outcomes and causes, // EXIT: criteria, and no swallowed exceptions.
complexity-anti-drift: yes — helper and file structure stay open, and fixes are gated on reproducing a gap.
minimal-change-verifier: yes — A/B/C remain separate; Python real-server checks, total memory OFF, existing Dream behavior, and permission/egress boundaries are explicit.
```

## Tasks (ordered by dependency)

1. **Capture reproducible command and LSP failure evidence** — tag: `[decision]`
   - **Inherits:** Approved brief: the trace establishes an unavailable-server result and install attempts, but does not establish their underlying cause; reports must state observed command and server-stage evidence.
   - **Surface:** Existing command execution, egress, and LSP paths.
   - **Acceptance:** A focused reproduction records the actual shell exit result and, for LSP, server identity plus whether failure occurred during selection, executable resolution, spawn/exit, initialization, request timeout, or method dispatch. It distinguishes permission refusal, egress denial, and runtime failure. If the incident cannot be reproduced, the result says so and does not claim a network cause. No behavior code changes in this ticket.
   - Status: [x] implemented (`78614f0c3`) — the reproduction lands in `docs/evidence/runtime-capability-recovery-t1-evidence.md` and records four findings: a piped install that reported success it did not have (the upstream status is unrecoverable without `pipefail`), a stalled retry whose result cannot classify why, an LSP unavailable result carrying neither a stage nor a cause, and a real-server probe that is green while its assertions are advisory. No behavior code changed in this ticket.

2. **Align the existing LSP contract with the approved Python acceptance** — tag: `[decision]`
   - **Inherits:** Approved brief: TypeScript and Python must both be proven with real servers; Python coverage uses a project `pyproject.toml` and `.venv`.
   - **Surface:** Existing LSP spec and probe contract.
   - **Acceptance:** The existing LSP spec records the TS + Python requirement and the probe's operation-level acceptance, including multi-file Python definition, hover, cross-file references, and diagnostics. It does not create a new spec, prescribe internal implementation names, or add a dependency.
   - Status: [x] implemented (`463186d28`, `84b0e562b`) — `specs/251-lsp-tool.md` records the real TypeScript + Python requirement and the probe's operation-level acceptance (S12, S19–S21), and `scripts/lsp-probe.ts` / `scripts/lsp-probe-targets.ts` grow a real multi-file Python project with meaningful per-operation assertions.

3. **Reconcile the total OFF contract with memory ADRs** — tag: `[decision]`
   - **Inherits:** Approved brief: the current TUI switch is the complete memory capability switch; OFF disables memory for the next request and ON restores existing behavior.
   - **Surface:** Existing memory ADRs, especially ADR-0031 and ADR-0042.
   - **Acceptance:** Record the OFF transition and its cache/executor boundary before memory implementation; preserve ADR-0086's runtime-capability write gate, ADR-0033's ON-time Dream schedule, the `ask` opt-out, and on-disk data. No new setting or Dream scheduling rule is introduced.
   - > Contradicts ADR-0031 D5 as amended by ADR-0086 — its dual-off path permits a mechanical-only GC and capability sweep, while the approved TUI OFF contract stops all memory jobs and writes. Reopen this clause because dual-off now represents a total user-selected capability state.
   - > Contradicts ADR-0042's session-frozen memory prefix/snapshot contract — the approved OFF transition must remove the existence pointer and all other memory model inputs on the next request, with cache invalidation at the explicit toggle boundary. Reopen the snapshot scope because the accepted transition covers tools and prefetch as well as the catalog.
   - Status: [x] implemented (`84b0e562b`) — ADR-0031, ADR-0033 and ADR-0042 each carry a 2026-10-07 amendment recording the total-OFF transition and the reopened dual-off / snapshot-scope clauses; ADR-0033's Dream schedule, ADR-0086's persist gate, ADR-0010's `ask` opt-out and the on-disk store are preserved unchanged, and no new setting or Dream rule is introduced.

4. **Preserve truthful, recoverable command execution across routes** — tag: `[implementation]`
   - **Inherits:** ADR-0097 / ADR-0104 / ADR-0107 egress rules and ADR-0140 permission boundary remain in force; the approved brief requires real result status, diagnostics, and cleanup across foreground, background, and verify.
   - **Surface:** Existing command execution, permission, egress, and verification capabilities.
   - **Acceptance:** Capture configured terminalcp PTY interactions: ordinary mode requests approval for the same install that `full_auto` permits inside the boundary without Bash approval; interactive unknown-domain approval follows the current path, background/verify unknown-domain access remains fail-closed, and explicit denies still win. Exercise Node and Python package setup plus an allowed fetch client such as curl to PyPI; do not widen presets. For foreground, background, and verify, success, nonzero exit, timeout, denied egress, and spawn failure return the actual status and useful stderr and release process/proxy resources. Verify an installed executable is usable by its consumer. A pipeline is tested with its declared shell semantics; it must not imply recovery of an upstream status hidden by a later successful command.
   - **Acceptance commands:** `npx vitest run tests/harness/sandbox/egress-assembly.test.ts tests/harness/aci/bash-egress-approval.test.ts tests/harness/aci/bash-egress.test.ts tests/harness/aci/bash-egress-typed-failure.test.ts tests/harness/aci/bash-foreground-deadline.test.ts tests/harness/aci/bash-background.test.ts tests/harness/aci/bash-background-deadline.test.ts tests/harness/aci/bash-output-stop.test.ts tests/harness/aci/bash-service-loop.e2e.test.ts tests/harness/verify/sandbox-run.test.ts tests/harness/verify/yolo-sandbox-run.test.ts tests/harness/build-engine-egress-wiring.test.ts tests/harness/egress-entry-wiring.test.ts`; product path `npm test`.
   - Status: [x] implemented (`118d326f9`) — foreground, background and verify routes return the shell's actual status plus useful stderr and release process/proxy resources on success and failure, with egress failure staying fail-closed and signal/termination recorded.
   - [blocks: T1]
   - [parallel] with T6 after each ticket's own decision prerequisites.

5. **Make real TypeScript and Python LSP use recoverable after install** — tag: `[implementation]`
   - **Inherits:** The approved brief and T2 require project/worktree resolution, preserved explicit overrides and process `PATH`, server/stage-specific failures, and same-session recovery after an approved install. Unsupported methods are capability results, not startup failures.
   - **Surface:** Existing LSP server/client and ACI LSP capabilities plus the existing probe.
   - **Acceptance:** With Node ≥20 and the existing local TypeScript Language Server / Pyright dev dependencies, real TypeScript Language Server and Pyright operations in a TypeScript project and a Python project with `pyproject.toml` and `.venv` prove definition, hover, cross-file references, and diagnostics with meaningful assertions. Python uses at least two source files; no key operation can be skipped and counted as success. Resolution finds active-project/worktree executables while retaining existing overrides and `PATH` fallback. A failed start exposes server identity and its stage; after an approved install or repair, the affected server can be retried successfully in the same session without an unbounded retry loop. Do not route retry through a terminal shutdown path.
   - **Acceptance commands:** `npm run probe:lsp -- --lang typescript` and `npm run probe:lsp -- --lang python`; `npx vitest run tests/harness/lsp/server.test.ts tests/harness/lsp/client.test.ts tests/harness/aci/lsp.test.ts`.
   - Status: [x] implemented (`463186d28`) — resolution gains the active project/worktree layer (npm bin shim, then project venv) below the retained explicit override and above the retained `PATH` fallback; a failed start names the server and its stage; and an approved install lets the same session retry within a bounded budget that never takes the host-exit latch.
   - [blocks: T1, T2, T4]

6. **Make the existing TUI memory switch a complete OFF gate** — tag: `[implementation]`
   - **Inherits:** T3's ADR amendments and the approved brief; ON retains existing Dream scheduling, OFF leaves persisted files unchanged, and `ask` stays opted out.
   - **Surface:** Existing TUI memory control, host assembly, memory tools/jobs, and model-input assembly.
   - **Acceptance:** Capture configured terminalcp PTY interaction in one live TUI session; toggle OFF and inspect the next actual model request: no memory tool schemas/catalog, existence pointer, or prefetch; stale-history `memory_recall`/`memory_save` calls are rejected before read/write; queued, exit, mechanical-GC, capability-sweep, extraction, and Dream work does not run; storage remains available after toggling ON. Tool schemas, system assembly, executor enforcement, and relevant cache state change together at the explicit toggle. ON follows existing ADR-0033 behavior. Apply the OFF state consistently across host assembly paths. Follow the existing prompt-development roster for the memory-prefetch STATIC + SEAM gap: build the offline + real trajectory set, or register the gap with its reason; a bare `Not run` does not pass.
   - **Acceptance commands:** `npx vitest run tests/harness/build-engine.test.ts tests/harness/build-engine-auto-memory.test.ts tests/harness/identity/system-injection.test.ts tests/session-api/hub-memory-prefetch.test.ts`; `bun test tests/tui/memory-picker.test.tsx`. Capture the actual PTY interaction and next-request contents; run `npm run test:real-llm` for any trajectory set's real-model half, reporting `Not run` if unavailable.
   - Status: [x] implemented (`a7985406f`) — OFF now gates the whole memory capability at one transition: tool schemas, catalog, existence pointer and prefetch leave the request, stale `memory_recall` / `memory_save` calls are refused with a typed error before any store access, and no memory hook or background job is assembled; ON restores existing behavior. The memory-prefetch trajectory gap is registered with its reason in `docs/guides/prompt-development.md`.
   - [blocks: T3]
   - [parallel] with T4/T5 only when assigned worktrees avoid shared assembly and test-file writes.

7. **Synchronize the CONTEXT comparison with the landed OFF behavior** — tag: `[implementation]`
   - **Inherits:** T3's resolved memory contract and T6's verified runtime behavior; ADR-0086's capability-write filtering remains intact.
   - **Surface:** `docs/CONTEXT.md` memory entries.
   - **Acceptance:** The `dream vs auto_extract` comparison and related hook wording accurately describe the total OFF behavior and existing ON schedule. This is a docs-only change, separate from behavior implementation, with no new domain term or ADR.
   - Status: [x] implemented (`84b0e562b`) — the `dream vs auto_extract` comparison and the `auto_extract` entry in `docs/CONTEXT.md` now describe the total OFF transition instead of the mechanical-only dual-off pass; docs-only, with no new domain term or ADR.
   - [blocks: T3, T6]

## Decision persistence handoff

No new domain term is selected by this plan, so there is no glossary entry to persist in this delivery. The ADR reopening items are recorded in T3 and must be written through `domain-modeling` before T6 starts; this plan does not mark those pending amendments accepted or silently override the current ADRs. T7 uses the same workflow for the existing CONTEXT entries.

## Input boundary allocation

T4, T5, and T6 must include these applicable classes in their focused tests before implementation. Cases exercise existing input fields and interfaces; do not add new public inputs merely to fill the matrix. A class without an applicable numeric or signed input is explicitly N/A with a reason, rather than an unreported omission.

| Class                 | T4: execution                                                                                                                          | T5: LSP                                                                                                                                            | T6: memory toggle                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty                 | Empty command and missing task identity are rejected before starting resources.                                                        | Empty query/file/symbol identity follows its existing documented contract; no malformed server request is silently treated as a successful lookup. | Missing memory settings use the existing OFF default; an absent memory store does not expose memory while OFF.                                                                               |
| Invalid / negative    | Invalid command options and negative deadline/output limits follow the existing input contract; rejected calls start no child process. | Invalid file/symbol identity and negative range/limit inputs, wherever already exposed, retain typed failures.                                     | Invalid non-boolean persisted toggle values use the settings contract; negative values are invalid booleans, not a distinct signed domain.                                                   |
| Overflow              | Excessive existing deadline/output limits cannot wrap or allocate unbounded resources.                                                 | Oversized existing query/range/response inputs follow bounded transport and result contracts without a false success.                              | Arithmetic overflow is N/A: the switch is boolean and introduces no numeric counter. If implementation adds a generation counter or bounded queue, its numeric limits gain an overflow case. |
| Concurrent / repeated | Concurrent same-domain approvals and repeated stop/cancel requests settle consistently and release resources once.                     | Concurrent same-root starts/retries share the existing lifecycle correctly; repeated recovery does not leak or terminally disable the pool.        | Repeated OFF/ON and OFF racing with queued/background work reject stale reads/writes; the next request uses one coherent capability state.                                                   |
| Exception             | Permission/approval callback, proxy setup, spawn, and cleanup exceptions retain typed failure and resource evidence.                   | Executable resolution, spawn, initialization, request, and recovery exceptions retain server identity and a typed stage.                           | Persistence or job exceptions cannot re-enable memory, expose stale schemas, or write after OFF; the toggle has a deterministic reported outcome.                                            |

## Implementation verification and evidence

- Run the applicable focused commands above and `npm run typecheck`, then the product path `npm test` once the behavior changes are integrated.
- For TS and Python, retain per-operation real-server results and expected definition/reference targets or diagnostic content; mock dispatch tests and skipped critical operations do not satisfy the real LSP requirement.
- Use `mcp__terminalcp__terminalcp` for the actual approval and memory toggle interactions in disposable workspaces. Preserve sanitized request/trace evidence and stop all test processes and language servers afterwards.
- Use isolated install/cache/store paths, retain explicit permission and egress denies, and verify installation artifacts from the consumer process. Do not modify real user stores or repository lockfiles to create fixtures.
- Inspect real trace files with the production writer/reader if error evidence changes; preserve record identities, statuses, and cancellation/cleanup results. For model-visible changes, update only the existing prompt-development roster and run any applicable offline and real-model halves.
- Publish a validation matrix with command or PTY operation, observed result, and evidence. A missing dependency, blocked install, missing credential, or unsupported required method is an explicit non-pass with its reason, never a green or a hidden skip.
