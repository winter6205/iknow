# Runtime Capability Recovery

Status: **implemented on `feat/runtime-capability-recovery`; not yet merged**. This guide records the reviewed incident signal, the behavior verified before the work, the operator-agreed target, and the practical acceptance criteria the implementation is checked against. The behavior and its acceptance checks have landed, so it is no longer marked planned. The guide still does not change an ADR by itself: the memory OFF contract is carried by the ADR-0031 / ADR-0033 / ADR-0042 amendments recorded alongside it.

Implementation sequence: [Runtime Capability Recovery plan](../implementation-plans/runtime-capability-recovery.md).

## Incident signal

The reviewed session trace (`8f3b101d…`, 2026-10-07) showed LSP calls reporting a TypeScript server as unavailable, followed by repeated global npm installation attempts. The trace establishes the observed failures, not their underlying cause: the current LSP result does not preserve enough startup detail to prove whether a binary was missing, could not be spawned, or failed during initialization. A command piped through `tail` also does not establish the installer's exit status unless the shell preserves the upstream pipeline status.

The response must not turn an unavailable server or a timeout into a definite network diagnosis. Preserve the observed command result and identify which runtime layer failed before recommending a remedy.

## Verified current behavior

This section is the **baseline captured before this work landed**; its present-tense wording describes the starting point, not the code as it stands now. It is kept because the gap it describes is what the tickets were written against. What changed is recorded in the [plan's](../implementation-plans/runtime-capability-recovery.md) per-ticket statuses, in [`specs/251-lsp-tool.md`](../../specs/251-lsp-tool.md) for the LSP contract, and in [`docs/STATUS.md`](../STATUS.md) for the memory OFF contract.

### Command execution and network policy

- `bash` returns an exit code plus stdout and stderr. Foreground and background paths share command judgment and the sandbox assembly in [`bash.ts`](../../src/harness/aci/tools/bash.ts).
- Permission mode and network egress are separate decisions. `full_auto` allows calls inside the selected filesystem tier, subject to hard-wall/security prefilters and the boundary behavior in [ADR-0140](../adr/0140-full-auto-is-bounded.md). It does not turn off the egress domain gate.
- The production egress policy combines built-in domains with user additions; an explicit domain deny wins. The built-in set includes common package registries such as npm, Yarn, and PyPI. Interactive first-seen domains can use the approval path; background and verify have no ask surface and remain fail-closed. See [ADR-0097](../adr/0097-egress-proxy-seam-domain-allowlist.md), [ADR-0104](../adr/0104-egress-preset-allowlist.md), [ADR-0107](../adr/0107-egress-allowlist-no-host-socat.md), and [`assembly.ts`](../../src/harness/sandbox/egress/assembly.ts).
- Therefore an install request should be allowed by the normal command permission flow when it is within the selected boundary, and its network requests should follow the existing egress policy. This applies across package ecosystems and command entry points; it does not justify an npm-only bypass, a general network exemption, or relaxing explicit denies.

### LSP resolution and failure reporting

- The current server table supports TypeScript/JavaScript and Python through TypeScript Language Server and Pyright, alongside YAML, JSON, and Dockerfile servers. Python files route by extension; Pyright looks for common Python project markers and detects `VIRTUAL_ENV`, `.venv`, or `venv` interpreters. See [`server.ts`](../../src/harness/lsp/server.ts) and the current [LSP analysis](lsp-client-analysis.md).
- The current real-server probe does not establish full cross-file behavior for Python; single-file smoke coverage and treating a method-not-found skip as success would be insufficient acceptance for this recovery work.
- The npm-wrapper resolver first resolves a package from the harness module's `createRequire(import.meta.url)`, then probes the process `PATH`; an optional `LspCtx.resolveBin` can override it. It does not itself search the active project or worktree's `node_modules/.bin`. A successful global install is not sufficient evidence that the running harness can resolve that executable from its current environment.
- The LSP client records a failure in a per-root, per-server broken cache. The current failure union distinguishes `no-server`, `no-root`, and `spawn-failed`; spawn and initialization exceptions are reduced to `spawn-failed`, and stderr is resumed without being retained in the result. The model-facing message can include the server ID and a global npm install hint, but not the failed stage or original cause. See [`client.ts`](../../src/harness/lsp/client.ts), [`types.ts`](../../src/harness/lsp/types.ts), and [`lsp.ts`](../../src/harness/aci/tools/lsp.ts).
- Installing a dependency does not itself invalidate that broken entry. The client pool can be reset explicitly, but the normal install flow has no install-to-retry recovery seam.

### TUI memory toggle

- The existing TUI `/memory` panel has an **Automatic memory** row and a nested **Dream** row. Its main value is persisted as `settings.memory.autoExtract`; the current OFF transition also persists `dream: false`. No additional user-facing switch is part of the agreed target. See [`memory-picker.tsx`](../../src/tui/memory-picker.tsx) and [`persist-settings.ts`](../../src/config/persist-settings.ts).
- The existing memory decision says `autoExtract: true` implies a Dream pass when its gate is due, even when `dream` is false; the UI presents Dream as a nested toggle. This is current behavior, not a new scheduling decision for this work. Do not claim that the nested toggle independently suppresses Dream while extraction is enabled.
- Today that row controls automatic extraction and catalog/prefetch behavior; it is not a total memory-disable gate. With memory enabled for the TUI, `memory_recall` and `memory_save` are still registered through `memoryDir`; the existence pointer is assembled independently of `autoExtract`; and the automatic-memory hook still runs the mechanical GC/capability sweep on its gate and process exit when both extraction and Dream are off. The hook has zero LLM work in that dual-off state. See [`build-engine.ts`](../../src/harness/build-engine.ts), [`registry.ts`](../../src/harness/aci/tools/registry.ts), and [`assembly.ts`](../../src/harness/memory/assembly.ts).
- The internal `memory.enabled` assembly option already suppresses the memory surface for selected entry paths, but it is not the live TUI `/memory` switch. The agreed change is to connect the existing TUI control to that complete capability boundary.

## Agreed target

### General install-to-capability recovery

Treat package installation as a general command-execution and runtime-recovery path. It must work for any allowed package ecosystem or executable setup, not only npm. Keep the existing permission, filesystem, egress, approval, and explicit-deny rules for foreground commands, background tasks, and verification runs. In particular, non-interactive egress remains fail-closed when a domain needs approval.

The execution result must preserve the actual exit status, stdout/stderr, timeout or signal outcome, and cleanup outcome. The agent must validate that the expected executable is present and usable before claiming installation succeeded. A pipeline's final command status must not be presented as proof of an earlier installer succeeding.

LSP resolution should use the active project/worktree and its runtime environment where appropriate, while retaining explicit overrides and process `PATH` fallback. Recovery should identify the selected server and the stage that failed: server selection, executable resolution, process spawn/exit, initialization, request timeout, or an unsupported method. An unsupported method is a server capability result, not a startup failure. A successful dependency installation should allow the affected server's failed-start state to be cleared and retried in the same session, without an unbounded retry loop.

Failure feedback should carry a typed stage, server identity, and actionable evidence. Network denial, permission refusal, missing executable, child-process failure, initialization failure, timeout, and unsupported method must remain distinguishable. The model can report only the observed result and should not infer a network cause from a generic unavailable or timeout result.

### Memory switch behavior

The existing TUI **Automatic memory** switch is the total memory capability switch. No new setting or UI control is introduced.

When it is OFF, beginning with the next model request:

- omit memory tool schemas/catalog entries and any memory existence pointer from the model request;
- omit prefetch content and stop extraction, Dream, mechanical GC, capability sweeps, and other memory background jobs or writes;
- reject stale or already-pending `memory_recall` and `memory_save` calls at execution time, including calls present in older conversation history;
- update tool availability, system assembly, executor checks, and cache state as one toggle transition;
- retain the on-disk memory store unchanged for a later re-enable.

When it is ON, restore the current memory capability and keep the existing `autoExtract` / `dream` scheduling contract unchanged, including ADR-0033's rule that `autoExtract === true` implies Dream when its gate is due. Do not add Dream preference preservation or reinterpret the nested toggle as an independent scheduling gate in this work. The `ask` entry's existing memory opt-out remains intact. The total-disable contract requires an explicit update to [ADR-0031](../adr/0031-auto-memory-extract-and-mechanical-gc.md) where dual-off currently permits mechanical jobs, and the live system snapshot behavior in [ADR-0042](../adr/0042-memory-layer-catalog-session-snapshot.md) must be reconciled with removing the full memory surface on a toggle. ADR-0033's current schedule is retained; ADR-0086's runtime-capability persist gate remains unchanged.

## Practical acceptance

The implementation plan should turn these into executable checks before claiming recovery:

1. **Permission and egress:** in ordinary and `full_auto` modes, run an approved package-install command inside the current permitted filesystem boundary. Confirm built-in npm/Yarn/PyPI paths work under the existing egress policy, explicit denies still win, interactive unknown-domain approval follows the current approval path, and background/verify unknown-domain access remains fail-closed. Cover a Node install plus a non-npm client such as `curl` to PyPI. If `pip` or `uv` is not in the current command roster, exercise it through the existing approval path; do not add a command bypass or widen the default domain set.
2. **Execution evidence and cleanup:** cover foreground, background, and verify outcomes for success, nonzero exit, timeout, denied egress, and spawn failure. Assert that the actual status and useful stderr reach the result and that each route releases its process/proxy resources on success and failure.
3. **LSP after install:** use a TypeScript project and a Python project with `pyproject.toml`, a project `.venv`, and at least two related source files. Start the real TypeScript Language Server and Pyright; make semantic assertions for definition, hover, cross-file references, and diagnostics (including expected files/symbols or diagnostic content); install or repair a missing server and prove it becomes usable after same-session recovery. Run `npm run probe:lsp -- --lang typescript` and `npm run probe:lsp -- --lang python` where applicable. A `MethodNotFound` skip is not a passing result for these required operations. Assert server identity and failure stage in failure cases.
4. **TUI memory OFF/ON:** toggle OFF and inspect the actual next model request: no memory tools, existence pointer, catalog, or prefetch; old-history memory tool calls are refused before read/write; no queued or exit memory job runs; stored files remain byte-for-byte available after re-enabling. Toggle ON and verify the existing `autoExtract` / `dream` scheduling contract, including the `autoExtract === true` implication. Verify system/tool cache invalidation and executor enforcement in the same live session.
5. **Model-visible surfaces:** tool-schema and prompt changes must follow [`prompt-development.md`](prompt-development.md): use the existing memory fixtures/golden set where applicable, or register any uncovered trajectory gap there. A prompt sentence alone does not satisfy the OFF gate.

## Documentation and decision alignment

- This guide is marked implemented rather than planned because the behavior and its acceptance checks have landed on `feat/runtime-capability-recovery`; the branch is not yet merged. It records the agreement; it does not supersede accepted ADRs by itself.
- The affected memory decisions were reopened and amended with the implementation: ADR-0031 for the dual-off hook / total-OFF distinction and ADR-0042 for live snapshot invalidation, each under a 2026-10-07 amendment that also withdraws the 2026-09-11 mechanical-only carve-out. ADR-0010's `ask` opt-out, ADR-0033's existing schedule, and ADR-0086's rule against persisting runtime capability observations are preserved by those amendments.
- `docs/CONTEXT.md` is now synchronized with the landed behavior: the `dream vs auto_extract` comparison no longer says the hook is absent when both flags are off, and the dedicated `auto_extract` entry records the total-OFF transition. The comparison was edited by this work's own docs ticket, not by this guide.
- Do not claim the trace established why installation or LSP startup failed. The command and server-stage evidence it asks for is recorded in [`docs/evidence/runtime-capability-recovery-t1-evidence.md`](../evidence/runtime-capability-recovery-t1-evidence.md); later reports cite that evidence, not only the session symptom.
