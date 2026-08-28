# 0031. Auto-memory — trigger gate, four-state ingest, mechanical GC, provenance, default OFF

Date: 2026-08-26
Status: accepted

## Context

ADR-0009 Decision 5 shipped the memory layer as **explicit-write v0**: the store layout, `memory_recall` / `memory_save`, quarantine + promote grading. Background LLM auto-extraction was explicitly deferred to "a later standalone module", on the grounds that auto-extraction is the primary entry point for wrong memories (arXiv 2606.25161 — consolidation errors become persistent system-state errors) and that deferring it kept every v0 entry accountable.

That deferral has held long enough to collect its own cost. The consequence recorded in 0009 (`(−) No auto-accumulation in v0 — the memory store only grows through deliberate saves`) is the observed failure mode: the store stays near-empty because saving is a deliberate act the model rarely takes unprompted, so `memory_recall` returns nothing and the layer never earns its keep. Meanwhile the write side has hardened: `MemoryEntryV1` already carries `importance` / `ttl_days` / `disabled` / `supersedes`, `memory_save` already enforces the affirmative-phrasing gate and atomic tmp+rename writes, `promote.ts` already skips expired entries, and BM25-lite scoring already exists for neighbor lookup. Every mechanism auto-extraction needs to reuse is in place; what is missing is the trigger, the write algorithm, and a cleanup path.

There is also no cleanup at all today. `ttl_days` is honored by `listPromotableEntries` at read time but nothing ever flips `disabled`; `supersedes` is a frontmatter field with no enforcement; the store has no cap. An auto-write path without a cleanup path is a monotonically growing pile of unreviewed model output, which is exactly the failure ADR-0009 was protecting against.

`specs/auto-memory.md` is the thin spec that fixes D1–D5 for this module; this ADR is its design-truth landing. Scope is deliberately narrow: this ADR lands the deferred item and does **not** revisit ADR-0009 D1–D4 / D6 (three-layer placement, split-frequency injection timing, dual-channel trust routing, affirmative-phrasing discipline, static caps) or ADR-0010 (`memory_layer` single slot; `ask` fully opted out of the memory layer).

## Decision

Five decisions, mirroring `specs/auto-memory.md` D1–D5.

1. **Trigger = host-side, async, after a successful run.** Auto-extraction fires only after `StopReason=completed`, on the host side (chat / tui / serve), never inside the loop engine. The gate is session wind-down or an N≥2 completed-turn counter — **not** per-turn forced consolidation. Rationale: per-turn extraction doubles the LLM call count on the hot path, and a single turn rarely contains a cross-session fact worth persisting; a turn counter is a cheap mechanical proxy for "this conversation has accumulated something". `ask` gets no wiring at all (ADR-0010 D3 opt-out stands).

2. **Write algorithm = extract → neighbor → four-state op → shared atomic write.** An LLM pass extracts atomic candidate facts from the transcript slice; each candidate is scored against existing entries with the existing BM25-lite heuristic; the top neighbor decides one of four ops:

   | Op          | Condition                                                     | Effect                                                            |
   | ----------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
   | `ADD`       | no neighbor above the near-duplicate floor                    | new slug written                                                  |
   | `UPDATE`    | neighbor above floor, candidate carries strictly more content | neighbor's slug rewritten in place, `updated_at` bumped           |
   | `SUPERSEDE` | neighbor above floor, candidate contradicts / replaces it     | new slug written with `supersedes: <old>`; old slug soft-disabled |
   | `NOOP`      | neighbor above the identical floor, nothing new               | nothing written                                                   |

   Persistence reuses the `memory_save` write discipline verbatim — tmp + rename atomic replace, affirmative-phrasing gate, frontmatter serialization. `extract` / `decide ops` / `persist` stay three separate functions so the LLM half can be faked in tests and the deterministic half can be unit-tested with no model at all.

3. **Provenance = `source: auto` frontmatter, low-trust channel only.** Every auto-written entry carries `source: auto` in its frontmatter (an unknown-extra field that `sanitizeMemoryFile` / `serializeMemoryEntry` already round-trip, so no schema version bump). Auto entries reach the model **only** through `memory_recall` tool results — the ADR-0009 D3 dual-channel rule is unchanged — and are never blind-injected into `system`. Auto entries are not exempt from the promote gate: they still need ≥2 distinct-session recalls, same as hand-written ones. There is no auto-promote path.

4. **Cleanup = mechanical GC, no LLM.** A repeatable, idempotent GC pass with exactly three mechanical rules: (a) `ttl_days > 0` and elapsed → set `disabled: true`; (b) an entry named by another entry's `supersedes` → set `disabled: true`; (c) active entries over the store cap → disable the lowest-utility ones, where utility = `importance × recency × (1 + recall_count)` read from the existing `usage.json` sidecar. GC only ever soft-disables — it never deletes a file, so a wrong eviction is recoverable by hand-editing one frontmatter line. LLM-driven offline merge / summarization of the store is explicitly **not** in this track.

5. **Default OFF, failure never fails the turn.** `settings.memory.autoExtract` defaults to `false`; with the flag absent or non-`true`, behavior is byte-identical to today (no extra LLM call, no disk write, no new code path entered). Extraction failures raise typed `MemoryError` subclasses inside the module; the host call site swallows them behind an explicit `// EXIT: log-and-continue` comment. An ingest failure must never turn a successful user turn into a failed one — the user got their answer; a missed memory is not worth surfacing as an error.

## Consequences

- (+) ADR-0009 D5's deferral is discharged: the store can accumulate without the user or model having to remember to save, and the accumulation has a bounded, mechanical cleanup.
- (+) Blast radius stays where 0009 put it: auto entries are `tool_result`-channel data with no instruction authority, no auto-promote, and a `source: auto` label that makes them greppable and bulk-revertable.
- (+) GC is testable without a model — TTL / supersede / cap are pure predicates over frontmatter plus a usage sidecar, so the five boundary classes (empty / negative / overflow / concurrent / exception) are all unit-reachable.
- (+) Soft-disable-only cleanup means every GC decision is reversible; no data is destroyed by a heuristic.
- (−) One extra LLM call per trigger when the flag is on. Accepted: the trigger is gated (not per-turn) and the call is off the user's critical path (fire-and-forget after the turn completes).
- (−) The near-duplicate floor and the utility formula are static heuristics with no tuning evidence yet. Accepted for v0 — same posture as ADR-0009 D6's static caps; revisit when there is failure evidence, not before.
- (−) Wrong extractions will land. That is the risk ADR-0009 D5 named and it is real; the mitigations are the affirmative-phrasing gate (reused verbatim), the `source: auto` label, the no-auto-promote rule, and reversible soft-disable — not the absence of the feature.
- Reversibility: 回退 = flip the default (already OFF) or drop the host wiring. Auto-written entries on disk stay readable and are distinguishable by `source: auto`, so a bulk `disabled: true` sweep undoes the accumulation without touching hand-written entries.

**Why not alternatives:**

- _Per-turn synchronous extraction_: doubles model calls on the hot path and consolidates task-local state that ADR-0009 D4 explicitly bans from the store ("never per-task state"). Rejected.
- _Extraction prompt embedded in the loop engine_: the loop engine owns turn mechanics, not memory semantics; embedding the prompt there couples two bounded contexts and makes the feature untestable without a full engine. Rejected.
- _Hard delete on GC_: a heuristic that destroys data has no recovery path, and `disabled` already exists as the soft-off mechanism honored by assembly and promote. Rejected.
- _LLM-driven offline merge / store summarization_: a second unaccountable write path stacked on the first, before the first has any operational evidence. Deferred in this ADR; **discharged by ADR-0033** (`settings.memory.dream`, still default OFF, never inside GC).
- _Default ON_: ADR-0009's whole argument for deferral was accountability; shipping this ON by default would swap one unreviewed default for another. Rejected.
- _Auto-promote for high-importance auto entries_: promote moves content into the `system` instruction channel, which is precisely the trust boundary ADR-0009 D3 drew. Rejected.
- _Vector / embedding recall bundled into this module_: 0009 D5 reserved the vector seam for this module, but bundling it here would make one change both "start writing automatically" and "change how recall works". Out of scope; the seam at the recall interface stays reserved.

## Evidence pointers

- `docs/adr/0009-memory-file-layered-injection.md` Decision 5 — the deferral this ADR discharges (now carries a superseded-by pointer scoped to D5 only).
- `docs/adr/0010-memory-injection-landing-seam-integration.md` — `memory_layer` single slot; `ask` opt-out that this ADR preserves by not wiring `ask`.
- `specs/auto-memory.md` — the thin spec (D1–D5) this ADR lands; `plans/auto-memory.md` — the five-ticket implementation order.
- `src/harness/memory/` — the reused mechanisms: `frontmatter.ts` (unknown-extra round-trip → `source: auto` needs no schema bump), `bm25.ts` (`scoreMemoryEntries` neighbor lookup), `promote.ts` (`usage.json` sidecar + expiry predicate), `tools/save.ts` (affirmative-phrasing gate + tmp/rename atomic write).
- arXiv 2606.25161 (consolidation errors become persistent system-state errors) — the risk that justified the 0009 deferral and that D3/D4/D5 here mitigate rather than dismiss.
