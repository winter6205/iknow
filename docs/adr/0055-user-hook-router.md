# 0055. User hooks are an in-process hook router; builtin hooks and user hooks keep two separate assembly paths

Date: 2026-09-08
Status: accepted

## Context

In-engine user hooks collapse into an **in-process router** under `src/harness/hooks/` (following ADR-0045: factories return pure functions — no fork, no daemon, no Unix socket). It hangs back onto step 1/5 of the existing permission 5-step chain and adds no new chain step. A later seam keeps this router as the single ingestion point: ADR-0095 compiles plugin-contributed `hooks/hooks.json` into async subprocess hooks **through the `HookContribution` seam (this ADR)** — Pre exit 2 = block, anything else fail-open.

## Decision

- **Builtin hooks** remain code-assembled (the secrets-guard compatibility path, TUI Post, violation observers, etc.); they are forbidden from being written into `settings.hooks` and cannot be unloaded by `hooks.enabled`.
- **User hooks** are precisely the declarative, deny-only layer on top of `settings.hooks` (absent = off).
- Isolation / hard-wall / secrets roundtrip / auto-memory are **not** swallowed into a single Policy server; those product switches are orthogonal to the hook master gate.
- V1 does not scan `~/.iknow/hooks/` — a file source is a future contribution interface; files landing in the directory do not auto-execute.

## Consequences

- Two assembly paths stay disjoint: builtin hooks can never be disabled via user settings, and user hooks can never silently acquire builtin status.
- Disabling hooks cannot accidentally turn off auto-memory: the user-hook enable switch is not shared with `/memory`.
- Pre hooks must remain synchronous and fail-closed inside the process, so any contributed hook (including ADR-0095's plugin hooks) runs under the same router semantics.

## Why not

- **OS / IPC hook server**: Pre must be synchronous and fail-closed; an IPC timeout would turn the hot path into a whole-tool veto.
- **One Policy monolith**: the four subsystems have different SSOTs and failure semantics; welding them together means touching user rules whenever isolation changes.
- **Sharing one enable switch between user hooks and `/memory`**: turning hooks off would wrongly turn off auto-memory.
