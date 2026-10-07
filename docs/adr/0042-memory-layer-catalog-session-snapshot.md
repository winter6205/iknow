# 0042. memory_layer catalog session-level snapshot — taken once at start, frozen for the session

Date: 2026-09-04
Status: accepted

> **Amendment 2026-09-05** (ADR-0044): the promote section is no longer assembled into `system`, so it is no longer a resident of this ADR's snapshot. The catalog (if still assembled) and the git block still snapshot per this ADR.

> **Amendment 2026-09-11** (memory-toggle-live): the snapshot's premise is that its inputs "cannot change within the session by construction", but the TUI `/memory` panel turned autoExtract into a host-flippable live flag — after a flip, the snapshot keeps emitting the catalog for the old flag state, breaking the assembly layer's existing contract (`autoExtract === false` → no catalog injected). Revision: **an explicit user toggle flip is a controlled exception to the snapshot** — the resolver behind the TUI surface snapshots per flag value (one frozen copy per value; byte-stable when nothing flips), and the host invalidates the snapshot at commit time via `invalidateMemorySystem`, so the flip takes effect on the **next run**; the one-off KV cache invalidation is the accepted cost of this exception. Explicit user actions only: auto-memory writes still do not trigger invalidation (the original D1 ruling stands).

> **Amendment 2026-10-07** (total memory OFF): the 2026-09-11 exception widens from the catalog to every memory model input, and D1's snapshot scope is reopened to match. The existing TUI `/memory` **Automatic memory** switch is the total memory capability switch (ADR-0031, same day). On its explicit OFF transition the host removes the memory existence pointer **and every other memory input** — catalog, ADR-0034 D2 prefetch payloads, and the memory tool schemas — rather than re-resolving another per-flag-value frozen copy, so the next model request carries no memory surface at all; that enumeration is the scope: the slot's **static instruction and identity layer is not a memory input** and stays assembled under OFF, so OFF removes what the memory library contributes, not the layer that happens to carry it; `invalidateMemorySystem` still fires exactly once, at that same toggle-commit boundary, and tool availability, system assembly, executor checks, and cache state change together as one transition. The boundary is explicit: **memory writes do not invalidate** — the original D1 ruling and the per-session freeze both stand, so memories written mid-session are still invisible to that session's snapshot; the OFF transition is a user action, not a write. ADR-0034 D2's prefetch channel placement and D3's channel/trust semantics are otherwise unchanged — OFF removes prefetch _content_ rather than relocating it. The on-disk store is left untouched, and an ON transition re-enters the 2026-09-11 per-flag-value snapshot path unchanged.

## Context

Ruling made mid-deliberation on ticket G1 (prefix stability boundary) of the wayfinder map "model-facing prefix layering and cache realization". G1 adopts a strict eligibility line: for content to qualify for the prefix region (`tools` + `system`), its input source must be **constructionally** incapable of changing within a session — "measured not to have changed" doesn't count. Auditing against that line, the only unqualified part of `memory_layer` is the catalog section (the live titles/hooks plus discipline sentence that [ADR-0034](0034-auto-memory-catalog-prefetch-channels.md) D1 allows into system): it is read through `memory/refresh.ts`'s mtime gating, and an auto-memory write (ADR-0031, asynchronous after the completed gate, arriving in clusters) changes it on the very next assembly — R4 measured 1–3 wobbles per session, each invalidating the passive cache of the **entire messages history** after system. ADR-0034 D2 already moved the heavy payloads (bodies / prefetch) to the user-message side, off the prefix; this ADR deals only with the catalog.

## Decision

1. **Snapshot the catalog**: the catalog section inside `memory_layer` (plus the promote section at the same layer) is snapshotted **once at the session's first assembly, then frozen for the session** — the implementation semantics change from "mtime-compared cache (refreshes on change)" to "snapshot (never recomputed)". Memories written during the session are invisible to the **current session's** catalog and enter the index next session; this is an accepted cost with minimal impact for a catalog (a memory the model just wrote doesn't need to re-see itself via the index).
2. **bodies / prefetch channels unchanged**: ADR-0034 D2 stands (prefetch attaches to user messages, marked advisory); this ADR does not touch them.
3. **Existing channel / trust semantics unchanged**: ADR-0034 D1's "catalog in system, bodies not", the rule that un-promoted bodies never enter system, and the English discipline sentence are all kept as-is; the only thing that changes is the **freshness timing** of catalog content (refresh on every write → frozen per session).
4. Once frozen, `memory_layer` becomes a session-level constant section and passes G1's strict eligibility line; the open question "aligning auto-memory write timing with the cache boundary" dissolves (write timing no longer affects the cache).

## Why not

- **Move the catalog out of system too (merge into the user-message side, same slot as prefetch)**: would disturb ADR-0034 D1's "catalog in system" channel design — a large blast radius; snapshotting reaches the goal with a single timing change.
- **Keep the status quo (mtime gating, refresh on every write)**: 1–3 full messages-cache invalidations per session; "should writes be throttled" becomes a new endless trade-off (throttling preserves the cache but hurts memory freshness).
- **Relax the eligibility line to tolerate wobble**: conflicts with G1's strict line (only constructional immutability qualifies) and the destination "don't rely on individual judgment"; "how many wobbles to tolerate" has no mechanical answer.

## Consequences

- **Positive / Applied:** the row in the R4 wobble table — "any system section changes (memory written) → all messages invalidated, 1–3 times per session" — is eliminated; the only remaining unqualified system-side section is `<mcp_tools_overview>` (ruled separately).
- **Negative / Trade-offs:** memories written mid-way through a long session are invisible to the current session's catalog / promote sections (`memory_recall` can still fetch them in real time, and bodies via prefetch are unaffected) — the loss is limited to "the model's catalog-level visibility of its own auto-collected memories", judged acceptable.

## Evidence pointers

- R4 measurement (wayfinder map "model-facing prefix layering and cache realization"): `memory/refresh.ts` mtime gating + memoization mechanics; auto-memory writes arrive in clusters (08-28 16:49 / 17:02, 09-02 22:46, etc.).
- ADR-0009 D3 / D6; ADR-0031 (async extraction, clustered writes); ADR-0034 D1 / D2.
- D1 (of the same map): the git block's precedent — "snapshot at start, never refresh during the session" — same cost structure.
- `docs/guides/runtime-capability-recovery.md` §"Memory switch behavior" and `docs/implementation-plans/runtime-capability-recovery.md` T3 — the approved total-OFF contract this 2026-10-07 amendment records; the implementation it requires landed on `feat/runtime-capability-recovery` (commit `a7985406f`), with the observed OFF/ON request surface recorded in `docs/evidence/runtime-capability-recovery-validation-matrix.md`.
