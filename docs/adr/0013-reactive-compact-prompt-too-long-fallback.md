# 0013. Reactive compact: prompt-too-long fallback, overturning the Q3 "no reactive implementation" ruling

Date: 2026-08-08
Status: accepted

## Context

The Q3 resolution written at `src/harness/compress/index.ts:1` stated "proactive trigger, reactive not implemented". Proactive compact (`loop-engine.ts:919-929`) **estimates** token counts via `estimateMessagesTokens` and compresses ahead of time when the threshold is exceeded. But estimation always carries error, and in extreme cases (sudden growth / mis-estimation) the window can still blow out — the SDK then throws prompt-too-long (400 `BadRequestError`); R1 proved the adapter layer performs zero translation of it, and the bare rethrow reaches `loop-engine.ts:430-439`, which has only a `ProtocolError` branch, so everything else hits `throw err` and crashes the run. Proactive + calibration can only **lower** crash probability; it cannot eliminate the hard crash of "estimation missed it". Reactive is part of the loop contract (`query.py:768-777`), not an option.

## Decision

Overturn Q3; add the reactive compact fallback:

1. **Trigger**: SDK throws prompt-too-long (400) -> the adapter adds `PromptTooLongError extends ProtocolError` (R1 minimal change: add the class in `errors.ts` + wrap try/catch at the two SDK call sites `anthropic-adapter.ts:643/:510`, detecting `instanceof APIError && status 400 && invalid_request_error && mentions prompt length` -> throw `PromptTooLongError`) -> captured at `loop-engine.ts:430-439` (the `instanceof ProtocolError` branch hits).
2. **Patch contract**: limited to **1 attempt** per run (`reactive_compact_attempted`). If the retry after compaction still exceeds the limit -> throw (handed back to ADR-0012's over-limit semantics for closure). Avoids a wasteful "compress->throw->compress->throw" loop.
3. **Compression function**: reuse `compactMessages` (`loop-engine.ts:930`), the same logic as proactive, differing only in error-triggered vs estimation-triggered. No proactive/reactive intensity distinction is introduced.
4. **Coexistence with proactive**: reactive (discrete, "error-triggered") + proactive (continuous, "estimation-triggered") form double insurance, naturally conflict-free, needing no extra priority/threshold design.

## Considered Options

- **Keep Q3 (no reactive)**: rely on R3 estimation calibration to lower the probability, but estimation remains estimation, and extreme cases (estimation misses) still hard-crash. Crashing the run means the "last line of defense" is missing — unacceptable. Rejected.
- **Reactive with a more forceful compression (`force=True`, full)**: the trade-off being proactive-light / reactive-full; iknow's `compactMessages` can already compress, proactive has no light/full distinction, and reuse is the cleanest. Rejected.
- **Allow multiple reactive attempts**: unlimited retries only fall into a wasteful loop when "compression cannot shrink the window", burning tokens without solving anything. Limit to 1; throw once exceeded. Rejected.

## Consequences

- (+) When proactive estimation fails, the fallback compresses and retries, and the loop does not crash — eliminating the hard crash of "estimation missed it".
- (+) Loop contract alignment restored.
- (+) Minimal change: one `PromptTooLongError` + try/catch at two SDK call sites + one loop-engine branch; purely additive.
- (−) One extra model call (compression retry) occurs when "estimation missed it"; but with a 1-attempt limit and throw-on-exceed, cost is bounded.
- (−) Overturns the existing Q3 resolution — the `compress/index.ts:1` comment must be updated ("reactive not implemented" -> "reactive implemented"); that code change is deferred to the spec/implementation phase (spec-driven-development); the ADR records the decision only and does not touch code.
- Rollback = remove `PromptTooLongError` + the loop-engine reactive branch and restore Q3; but once surface consumers rely on the reactive fallback, rollback cost rises.

## Evidence pointers

- `src/harness/compress/index.ts:1` — the Q3 resolution "proactive trigger, reactive not implemented".
- `src/harness/loop-engine.ts:919-929` — proactive compact, estimation-triggered.
- `src/harness/loop-engine.ts:430-439` — the sole `ProtocolError` capture point (landing spot for the reactive branch).
- `src/harness/model-adapter/anthropic-adapter.ts:643/:510` — the two SDK call sites (landing spots for the reactive try/catch).
- R1 ticket (closed) — the adapter error-translation inventory; verified prompt-too-long currently gets zero translation and the bare rethrow crashes the run.
- Baselines: `query.py:768-777` (reactive compact -> continue) · `query.py:66-87` (`_is_prompt_too_long_error`) · `query.py:651` (`reactive_compact_attempted`).
- `docs/adr/0012-max-turns-user-switch-default-unlimited.md` — over-limit semantics; the "throw if the reactive retry still exceeds the limit" behavior depends on it for closure.
