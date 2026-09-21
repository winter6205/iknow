# 0042. memory_layer catalog session-level snapshot — taken once at start, frozen for the session

Date: 2026-09-04
Status: accepted

> **Amendment 2026-09-05** (ADR-0044): the promote section is no longer assembled into `system`, so it is no longer a resident of this ADR's snapshot. The catalog (if still assembled) and the git block still snapshot per this ADR.

> **Amendment 2026-09-11** (memory-toggle-live): the snapshot's premise is that its inputs "cannot change within the session by construction", but the TUI `/memory` panel turned autoExtract into a host-flippable live flag — after a flip, the snapshot keeps emitting the catalog for the old flag state, breaking the assembly layer's existing contract (`autoExtract === false` → no catalog injected). Revision: **an explicit user toggle flip is a controlled exception to the snapshot** — the resolver behind the TUI surface snapshots per flag value (one frozen copy per value; byte-stable when nothing flips), and the host invalidates the snapshot at commit time via `invalidateMemorySystem`, so the flip takes effect on the **next run**; the one-off KV cache invalidation is the accepted cost of this exception. Explicit user actions only: auto-memory writes still do not trigger invalidation (the original D1 ruling stands).

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
