# 0010. Memory-injection landing — seam integration strategy (#194 vs #196 `deps.system` seam arbitration)

Date: 2026-08-07
Status: accepted

## Context

GH issue #228 (winter6205/iknow, `wayfinder:grilling`, child of map #114 ④ memory layer) — the integration strategy for landing PR #194 (full #121 memory-injection v0: ADR-0009 → spec → plan → T1–T8 + code-review fixes, s4-check SUCCESS, 1456/1456 tests, draft only) onto master, where #196 identity-assembly has pre-empted the same `deps.system` seam (`identity/assemble.ts` 9-segment LOCKED pipeline with slots 5-9 reserved for #121). `git merge-tree` against `origin/master` reports 5 file collisions; the core collision is `src/harness/build-engine.ts` (two wiring patterns for the same seam: `createIknowSystemResolver` 9-segment identity pipeline vs #194's `assembleSystemPrompt` 5-segment memory pipeline). #119 Q6 (thresholds + `cache_control` breakpoint coordination) is staged behind this landing — system-prompt shape must be finalized before the Q6 cache-control breakpoint can be specified.

ADR-number collision prevention: master `docs/adr/` currently ends at 0008; #194 carries ADR-0009 (enters master via 6c layer 1). This ADR takes 0010.

## Decision

Six decisions settled in the 2026-08-07 grilling session, all recorded on issue #228:

**D1 — Seam arbitration.** Keep #196's 9-segment LOCKED pipeline (`IKNOW_ASSEMBLY_ORDER`) and connect #194's 5 memory segments into slots 5–9 — reverse-replacement rejected (would unwire the soul literal LOCKED and split #196's `shouldIncludeBootstrap({chat, tui})` decision).

**D2 — `memory_layer` slot (single-slot consolidation).** Memory 5 segments converge into a single `memory_layer` slot, delegating to #194's `createSystemResolver` (mtime cache + inflight dedup + cache-not-poisoned semantics, see ADR-0009 #121 T7 + `refresh.ts`). Position remains post-bootstrap. Internal concatenation order = user AGENTS → `PRIORITY_DECLARATION` → project AGENTS → `EXISTENCE_POINTER` → promote segment (locked by #121 spec SC 4/5). Independent per-segment consumption rejected (would change #194's resolver interface and require rewriting its refresh cache key management; the LOCKED-order semantics are not gained).

**D3 — Surface split (identity vs memory) for `ask`.** The `ask` surface keeps the identity-cognition layer (`identity` / `soul` / `user_profile`) and skips BOOTSTRAP, while entirely opting out from the memory layer (`AGENTS.md` + rules + memory library + `memory_recall` / `memory_save` tools). The `memory_layer` slot is left unwired for `ask`; memory tools are stripped from the registry. Full opt-out rejected (breaks "who am I" answers in `ask`), full opt-in rejected (#194's "ask is stateless" premise departed).

**D4 — ACI tool-set SSOT.** `memory_recall` and `memory_save` join `createDefaultAciRegistry` (the 8-tool SSOT factory in `src/harness/aci/tools/registry.ts`, anchored by #141 / #191 / a277f68); the registry grows to 10 tools, and `ask` strips them. Hand-writing tool arrays in `build-engine.ts` rejected (the original #194 symptom — multiple sources of truth is the exact drift class #141 closing was designed to prevent).

**D5 — Test matrix.** The memory-domain tests (`tests/harness/memory/`, 12 files: assembly / bm25 / discovery / frontmatter / paths / promote / refresh / schema / tools-recall / tools-save / integration) move over unchanged — they sit in their own bounded context and are orthogonal to the seam. The seam-layer test (`build-engine.test.ts`, `integration.test.ts`) is rewritten using **master as the base, plus the Q1–Q4 ruling semantics** — tests follow the ruling, not the old branch. Wholescale adoption of the branch test suite rejected (Q3 semantic reversal is one of the easiest drifts to miss).

**D6 — Landing strategy.** A new branch forks from current master; port in 5 layers, one commit per layer:

1. **docs layer** — bring in ADR-0009 (`docs/adr/0009-memory-file-layered-injection.md`, written here), the #121 spec/plan, and adapt the four CONTEXT.md vocabulary items against master's current state.
2. **memory module layer** — `src/harness/memory/{paths,schema,frontmatter,errors,index,discovery,bm25,promote,assembly,refresh}.ts` (+ the `tools/{recall,save}.ts` pair) wholesale from the branch.
3. **tool-registration layer** — extend `createDefaultAciRegistry` with `memory_recall` / `memory_save`; the entry points (`build-engine` / `tui/deps`) consume from the SSOT only.
4. **wiring layer** — `identity/assemble.ts` slots 5-9 collapse to a single `memory_layer` slot wiring to #194's `createSystemResolver`; `build-engine.ts` carries the `ask` strip (D3); `cli.ts` / `cli/runtime.ts` / `model-adapter/anthropic-adapter.ts` carry only the minimum needed for D3 + D4.
5. **tests layer** — memory-domain tests wholesale + seam-layer rewrite per D5.

PR #194 closes with a pointer to the new PR. In-place rebase (`6a`) rejected (12 commits × 25-commit divergence × D2/D3/D4 conflict resolution at the same time = rebase hell). Single merge commit (`6b`) rejected (one giant commit mixes conflict resolution with D2/D3/D4 semantic rewrites — unauditable).

## Consequences

- (+) #196's LOCKED order and soul literal values are untouched. #194's mtime cache / inflight deduplication / cache-not-poisoned semantics are inherited whole, with their T7 test coverage intact.
- (+) `createDefaultAciRegistry` becomes the single registration authority for all 10 tools; `ask` opt-out is a registry filter, not a per-entry-point reimplementation.
- (+) Surface semantics now have one explicit home — Q1–Q6's open question "ask is stateless but how stateless?" is settled for the lifetime of the surface taxonomy.
- (−) `IKNOW_ASSEMBLY_ORDER` formally goes from 9 enum members to 5 (identity / soul / user_profile / bootstrap / memory_layer). The "9-segment LOCKED" prose in `specs/196-identity-assembly.md:122-132` is an inaccurate description of the post-landing seam; spec needs a one-line update.
- (−) This ADR-0010 numbering was chosen to avoid collision with the arriving ADR-0009; once both are on master, a future reader sees a contiguous 0008→0009→0010 sequence rather than 0008→0010 (with ADR-0009's text in the middle). Traceability requires a casual look at PR #228's Notes, not just the ADR directory listing.
- Reversibility: the wiring decisions (D2/D3/D4) are local to one file each (`identity/assemble.ts` / `build-engine.ts` / `createDefaultAciRegistry`); rollback costs one commit revert. Once `RunResult.lastUsage` (ADR-0008 display arm) lands downstream of #228, downstream consumers may pin to the assembled `system` shape — at that point D2 becomes hard to reverse.

**Why not alternatives (called out in #228 body for grilling reference):**

- _Replace #196 pipeline with #194's unified `assembleSystemPrompt`_: would unwire the soul LOCKED literal value, drop the surface-driven BOOTSTRAP decision (`shouldIncludeBootstrap({chat, tui})`), and collapse the 4+5 segment split into one ordering that's harder to reason about per-layer. Rejected (Q1).
- _Run both #196 and #194 pipelines in parallel, branched by surface flag_: duplicate system assembly at runtime, hard to reason about which version's `EXISTENCE_POINTER` semantics apply. Rejected (Q1).
- _Cache after the #194 resolver returns, then post-process to split back into 5 slots for #196_: would invert D2's "single slot for memory" simplification and add a cache-shape that's not in either code path. Rejected (Q2 form A2b).
- _Cache the per-segment results independently across the 5 slots of the pipeline_: would change #194's resolver interface and require rewriting refresh cache key management. Rejected (Q2 form A2b, repeated).
- _Fully opt out of system on `ask`_: surfaces "who am I" deflection to a user-initiated flag — wrong default. Rejected (Q3 form 3b).
- _Hand-write 10-tool arrays at each entry point_: recreates the #141/191 exact drift class. Rejected (Q4 form 4b/c).
- _Adopt the #194 test suite wholesale and fix the conflicts in passing_: Q3's 3a ruling flips the ask semantics from #194's 3b; every ask-path test in #194 has a Q3-violation drift that is easy to overlook. Rejected (Q5 form 5b).
- _Rebase PR #194 in place onto current master (D6's `6a`)_: 12 commits × 25-commit divergence × D2/D3/D4 conflict resolution all in one rebase = un-auditable history. Rejected (Q6 form 6a).
- _Single merge commit of master into #194 (D6's `6b`)_: one giant commit mixes conflict resolution with D2/D3/D4 semantic rewrites — also un-auditable. Rejected (Q6 form 6b).

## Evidence pointers

- GH issue #228 (winter6205/iknow) — the 6-question grilling; this ADR is its design-truth landing. Resolution comment carries the per-question record.
- GH issue #114 — parent map ④ memory layer; `Decisions-so-far` index updated there (M5 entry, 2026-08-07).
- GH issue #196 / `docs/adr/0008-token-accounting-usage-placement.md` — the predecessor that pre-empted the seam (whose 9-segment LOCKED pipeline we keep).
- GH issue #121 / `docs/adr/0009-memory-file-layered-injection.md` — the memory-injection design this landing implements; enters master in landing layer 1.
- PR #194 (`worktree-wayfinder-121-memory-injection`) — draft branch carrying all T1–T8 commits; closes when the new landing PR carries this ADR's D1–D6 into master.
- `git merge-tree --write-tree --name-only origin/master origin/worktree-wayfinder-121-memory-injection` — the 5-file collision report (collision file list in #228 body).
- `src/harness/identity/assemble.ts:107-111` — #196's standing note "slots 5-9 reserved for #121 merge." (cited verbatim in Q1 ruling).
