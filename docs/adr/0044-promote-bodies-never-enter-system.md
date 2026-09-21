# 0044. Memory bodies never enter system — promote serves only GC

Date: 2026-09-05
Status: accepted

## Context

ADR-0009 D3 established: memories default to the low-trust channel (`memory_recall` / `tool_result`); after being recalled across ≥2 distinct sessions, a body may be assembled into system's promote section. ADR-0034 D4 gated that assembly behind `autoExtract === true`. The result: whatever problem you are working on today, once two sessions have paged through it, becomes next session's permanent operating manual. High-trust placement should be reserved for human-written `AGENTS.md`. The `memory_recall` contract is read-only and production paths never call `recordRecall`, so in practice this section is mostly empty today; keeping the assembly means the moment anyone wires up the counter, it fires.

## Decision

1. **No memory body of any provenance may enter `system`.** Hand-written, `source: auto`, `source: dream` — one rule. Assembly no longer builds a promote section.
2. **Keep `usage.json` / `eligibleForPromote` (≥2 distinct sessions), but only for `memory_gc`'s utility.** Do not wire `recordRecall` into `memory_recall` (it stays read-only).
3. **prefetch must no longer exclude ids by promote eligibility.** System has no corresponding section anymore, so excluding would make those entries disappear from the user side too.
4. This ADR does not decide whether the catalog still enters `system`, and does not change the prefetch payload shape.

## Consequences

- **Positive / Applied:** recall counts no longer buy system seats; the permanent manual lives only in `AGENTS.md`. Amends ADR-0009 D3's promote-in-system clause and ADR-0034 D4.
- **Negative / Trade-offs:** the memory store loses its "vet it, then run on it as a manual" path. To make a memory into a rule, write it into `AGENTS.md`.

## Why not

- **Ban only `source: auto|dream`, keep hand-written promotable:** whatever `memory_save` recorded of "today's problem" could still buy a system seat, conflicting with the destination.
- **Leave the assembly as is (it is mostly empty in practice):** the contract would still permit it to fire; conflicts with "recall must not enter the next session's system".
