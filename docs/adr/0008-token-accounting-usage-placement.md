# 0008. Token accounting foundation — usage placement, field shape, transport, RunResult exposure

Date: 2026-08-05
Status: accepted

## Context

GH issue #160 (winter6205/iknow) — the design grilling graduated from #136 (adapter usage consumption + token accounting foundation, closed 2026-08-04 for deferral discipline). iknow's harness currently has **zero** token / usage / context-window code (`src/harness/` grep-empty; `anthropic-adapter.ts` `interpretMessage` silently drops `sdkResp.usage`; `AssistantTurnResult` has no usage field; `LlmCallRecord` has zero token fields). Meanwhile 9router / MiniMax-M3 provably returns Anthropic-compatible `usage` (`input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`; #132 probe D measured `cache_read_input_tokens: 128`). The TraceService module (`src/harness/trace/`, ADR-0003) is already landed and `specs/trace-service.md:120` pre-drafts nullable token fields.

Two constraints shape the design: (a) the 017 two-tier discipline — `tokenUsage` is B-layer / conditional-remediation (017:103), `RunResult` is forbidden from carrying diagnostics (017:67), and `LoopTrace` triple-bans payload-token-cost (CONTEXT.md + `loop-trace.ts` + spec判据12); (b) the "has-failure-evidence" trigger principle (EXECUTION-ORDER.md:79, 017:157) — don't build runtime machinery without a live consumer. An external reference (`docs/harness-report/`, the OpenHarness v0.1.9 mapping report) was studied: OpenHarness fragments usage across three surfaces but has **no runtime consumer** (`CostTracker` accumulates into dead data), uses only `input_tokens`+`output_tokens` (cache fields dropped — flagged as its top gap), and drives compression from char-estimation + provider-error reactive fallback rather than usage.

## Decision

Six decisions settled in the 2026-08-05 grilling session:

1. **Placement = TraceService `LlmCallRecord` extension (single canonical surface), usage is observability-first.** Usage lands as columns on `LlmCallRecord` (ADR-0003's independent bounded context; aligned with the `specs/trace-service.md:120` draft), NOT LoopTrace, NOT a standalone ledger. Rationale: today the only reader is the offline `grep`-ing developer; building a runtime ledger with no consumer is OpenHarness's `CostTracker` dead-data failure mode. The transport seam (`AssistantTurnResult`) is sealed — usage is copied into trace, with no in-process reader at placement time. An upgrade door is preserved (see Decision 4).

2. **Field shape = full SDK `Usage` four token fields, top-level flat.** `inputTokens: number` / `outputTokens: number` (required, mirroring the SDK contract) + `cacheCreationInputTokens: number | null` / `cacheReadInputTokens: number | null` (vendor may omit). The two cache fields are carried even though 9router has so far only proven `cache_read` — they cost nothing to transport and are the precondition for any cache-hit analysis (dropping them reproduces OpenHarness's flagged cache-blindness). SDK peripheral fields (`cache_creation` TTL object, `output_tokens_details`, `service_tier`) are NOT carried — no consumer exists for them. Fields sit flat on the record (consistent with existing `supplierStop`), not wrapped in a `usage` sub-object.

3. **Error branch = whole usage absent, not null-filled.** On the `recordLlmCall` error path (`modelPhase.kind === "stop"`), no usage block is written at all. This is the Postel reading of ADR-0003 Decision 9: "field absent" means "the call did not incur billing", not "declared but filled with null". Success branches carry usage (SDK guarantees it); error branches omit it entirely.

4. **Transport = adapter projects onto `AssistantTurnResult`, loop-engine fills `recordLlmCall` (sealed passthrough).** The adapter owns the SDK shape and is the only module that sees the response, so it must surface usage across the adapter→engine seam — but only as a sealed passthrough onto `AssistantTurnResult` (mirroring how `supplierStop` is already transported). Loop-engine, which already owns the timing fields (`startedAt`/`endedAt`/`durationMs`) and the ID-chaining (`llmCallId`), copies it into `recordLlmCall` at the existing instrumentation sites (`loop-engine.ts:549-577`). The adapter does NOT receive a TraceService dependency — that would violate least-knowledge, break ADR-0003 Decision 5's ID chaining, and it cannot see the loop-owned timing fields anyway. This is the Q1 upgrade door: a future runtime consumer only needs to open a read on the already-on-the-seam field.

5. **`RunResult.lastUsage` = the one runtime exposure, driven by a real consumer (TUI).** `RunResult` gains `lastUsage: { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens } | null` (null when the run had no successful model call). This reverses the default 017:67 "no diagnostics on RunResult" stance for a stated reason: 017:67's premise was field bloat **without readers**; the TUI context-usage display (specs/146, imminent) is a concrete reader. Only the **last** call's usage is exposed (sufficient for "how full is the window now"); the compression in-run anchor (prev-call `input_tokens` + incremental char estimate) is loop-engine internal state and is NOT part of this decision — it belongs to #119 phase-2 implementation.

6. **No chars/N estimation fallback; estimation serves compression, never accounting/display.** When a call returns no usage, the record omits the field (Decision 3) — estimation never substitutes for observed truth (Postel). Char-estimation is reserved exclusively for the future compression trigger's decision input (anchor + delta, where anchor = last real `usage.input_tokens` and delta = the just-appended-but-unsent content), per the OpenHarness-proven pattern "estimator only for compression, not accounting". The display path reads real usage (reactive, one-beat lag is acceptable for a display), never an estimate.

**Implementation split (sequencing decision):** the display path (adapter → `AssistantTurnResult` → loop-engine → `recordLlmCall` + `RunResult.lastUsage`) has a real consumer (TUI) and **may proceed**. The compression path (in-run anchor, incremental estimation, trigger logic) **remains blocked by failure evidence + the #119/#132 rulings**. This is the Q6 "分路实施" ruling.

## Consequences

- (+) `LlmCallRecord` gains usage columns; `AssistantTurnResult` gains one sealed transport field; `RunResult` gains `lastUsage`. All additive.
- (+) Observability first-class: per-call token truth is greppable in trace JSONL, with full cache breakdown, without building any runtime ledger.
- (+) The one runtime consumer (TUI display) gets a clean seam via `RunResult.lastUsage`; no consumer waits on the deferred compression path.
- (+) Cache-hit analysis stays possible (both cache fields carried) — avoids OpenHarness's flagged gap.
- (−) `RunResult` grows one field, a documented exception to 017:67's spirit (justified by the real TUI reader; recorded here so the reversal is visible).
- (−) Compression still cannot read a runtime usage anchor until #119 phase 2; until then it must rely on char-estimation + reactive fallback. Accepted: usage is observability, compression is estimation-driven.
- (−) The two cache fields may be null on providers that don't return them; consumers must null-check. No 9router `cache_creation` observation yet — field is present-but-null until a provider returns it.
- (−) `specs/trace-service.md:120` drafts three fields (`inputTokens`/`outputTokens`/`cacheReadTokens`) and is now superseded by this four-field shape; the spec needs a one-line update.
- Reversibility: placement/shape are hard to reverse once TUI depends on `RunResult.lastUsage`; the sealed-seam design keeps the future runtime-usage upgrade additive.
- 回退 = drop the four `LlmCallRecord` columns, the `AssistantTurnResult` transport field, and `RunResult.lastUsage`; the trace module reverts to ADR-0003 shape. Low cost; all additive.

**Why not alternatives:**

- _Dual surface (usage both on `AssistantTurnResult` AND as a standalone ledger)_: the ledger would have no runtime consumer today — reproduces OpenHarness `CostTracker` dead data. Rejected.
- _Standalone token snapshot / budget ledger_: builds a carrier for zero readers; violates the has-failure-evidence principle. Rejected.
- _Minimal two-field (`input`/`output` only)_: forecloses cache-hit analysis permanently (observability data is written-once, not refactorable). OpenHarness's minimalism is its flagged top gap. Rejected.
- _Adapter directly receives TraceService and writes `recordLlmCall`_: violates least-knowledge (adapter touching observability infra), breaks ADR-0003 Decision 5 ID chaining, and cannot see loop-owned timing fields. Rejected.
- _No `RunResult` exposure at all (pure observability)_: starves the imminent TUI context-usage display of any in-process source. Rejected once TUI was confirmed as a real consumer.
- _chars/N estimation filling the trace on missing usage_: injects guesses into observed truth; Postel says absent-field beats filled-estimate. Rejected.

## Evidence pointers

- GH issue #160 (winter6205/iknow) — the 6-question grilling; this ADR is its design-truth landing.
- GH issue #136 — predecessor task, closed 2026-08-04 for deferral; graduated the design to #160.
- `docs/harness-report/` — OpenHarness v0.1.9 mapping report (external reference: usage surfaces, CostTracker dead data, cache-field gap, char-estimation-for-compression pattern).
- `docs/adr/0003-trace-service-domain-interface.md` — TraceService bounded context, Postel (Decision 9), ID chaining (Decision 5), `recordXxx` never throws (Decision 13).
- `specs/trace-service.md:120` — the superseded three-field draft.
- `src/harness/trace/types.ts:42-52` — current `LlmCallRecord` (zero token fields).
- `src/harness/model-adapter/types.ts:83-94` — current `AssistantTurnResult` (no usage).
- `src/harness/loop-engine.ts:549-577` — the two `recordLlmCall` instrumentation sites.
- `specs/146-tui.md` — the TUI context-usage display (the real consumer for Decision 5).
- `docs/archive/wayfinder/issues/017-loop-hardening-for-migration.md` — 017:103 (B-layer tokenUsage), 017:67 (RunResult diagnostics refusal), 017:157 (conditional remediation).
- `docs/archive/wayfinder/EXECUTION-ORDER.md:79` — "条件式修复：只修复有失败证据的问题".
- Numbering note: #160/#136/#114 cite "ADR candidate 0007", but 0007 is reserved by `specs/120-session-persistence.md:30` + `specs/146-tui.md:23` for the session-storage disk-shape decision. Per "docs/adr/ max + 1, avoid collision", this ADR takes **0008**; 0007 stays reserved for session storage.
