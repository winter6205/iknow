# 0011. maxTurns exceeded / abnormal stop: throw MaxTurnsExceeded + model-authored closing summary

Date: 2026-08-08
Status: accepted

## Context

`src/harness/loop-engine.ts:593-603` silently returns `{ kind: "stop", reason: "maxTurns" }` when the turn count hits the limit — no summary, no notification, and no turn record (`turn: null`). The external `stepWithTrace` consumes this stop result, but if the caller does not read it, the run "dies silently", and what the user sees is "it broke after 6 turns" with no idea why. Fixing the pain point "a hard stop leaves no trace of what was done" requires upgrading the over-limit case from "an ignorable return value" to "a forcibly-perceived exception".

## Decision

Over-limit (maxTurns) and the other abnormal stops (timeout / protocolError / cancelled) are unified as follows:

1. **Exit shape = throw**: over-limit throws `MaxTurnsExceeded` (`query.py:129-134` + `ui/runtime.py:681-682`), forcing caller awareness, replacing silent-stop. The exception bubbles up the call stack to the outer catch, which persists the current session.
2. **The exception is only a signal**: `MaxTurnsExceeded` carries the turns already run + the reason, but no messages snapshot / usage. Data stays in the session's authoritative state (`_messages` is the single append-only authority); the outer catch can reach everything. This avoids the "one copy in the exception, one copy in the session" duplication (SSOT).
3. **Closing = a real model summary**: after any abnormal stop, run **one extra turn** of a plain-text model call; the model parses the current transcript tail + the stop reason and outputs a "what was done + why it stopped" summary. The summary turn is **not counted toward maxTurns** (a fixed single epilogue, not a loop iteration).
4. **Three cuts to keep it simple**:
   - a fixed tail window (~8K tokens) as summary input — naturally within the window, so it cannot exceed the window and dodge the reactive-compact fallback;
   - an independent short timeout (~15s) + catch-all: if the summary fails, skip it; it never blocks the original stop reason, and there is no recursive "summary of a summary";
   - the summary result rides on a field of the existing `HarnessStreamEvent`'s new terminal member (or a `MaxTurnsExceeded` field) — no new mechanism.
5. **Not appended into `_messages`**: the summary is a display artifact; it must not pollute the authoritative history (otherwise, on resume, it looks like a real turn). Usage still lands in `LlmCallRecord` (ADR-0008 compliant).

## Considered Options

- **raise vs return**: keeping return but wiring the UI is the "minimal breakage" route, but it preserves the root of silent-stop — external callers can still ignore the return value. This round explicitly **discards the old design's silent-stop contract** as the improvement goal and chooses throw to force perception.
- **Model summary vs structured stop-reason snapshot**: a "loop packages existing state into a snapshot" route was considered (zero extra model calls, simpler), but the user explicitly wanted a **real model summary** — let the AI parse the current situation + the abnormal-termination cause and produce a natural-language wrap-up. The snapshot route was rejected.
- **Summary counted vs not counted in maxTurns**: counting it would mean "set 20, actually get 19 tool-work turns + 1 summary turn", violating least-astonishment; the summary is a plain-text epilogue that calls no tools and does not consume the "tool iteration" budget — chosen: not counted.

## Consequences

- (+) throw forces perception; users no longer "don't know why it stopped".
- (+) The summary covers all abnormal stops (maxTurns / timeout / protocolError / cancelled), not just maxTurns — because the summary does not depend on model stability (best-effort, skipped on failure), there is no worry about "leaning on the model once more when it is already unstable".
- (−) The three surfaces (chat REPL / ask / serve) must adapt to the throw contract — deliberate breakage, not a compromise made to preserve silent-stop.
- (−) The summary turn costs one extra model call (usage + latency), but best-effort + an independent short timeout keep the cost bounded.
- Rollback = turn throw back into a returned stop + drop the summary call; but once surface consumers have adapted to the throw contract, rollback cost rises — hence hard-to-reverse.

## Evidence pointers

- `src/harness/loop-engine.ts:593-603` — the current silent stop.
- `run_query()` state machine: over-limit on `max_turns` raises `MaxTurnsExceeded`.
- `src/harness/stream.ts:20-23` — `HarnessStreamEvent` has three members, no terminal event; a terminal member must be added to carry the summary.
- trace-service spec draft :124 — the `recordTurn` decision field already pre-declares the `max_turns_exceeded` stop reason.
- `docs/adr/0008-token-accounting-usage-placement.md` — usage is observability-first; `LlmCallRecord` carries tokens.
- `loop-engine.ts:215` — `DEFAULT_TIMEOUT_MS = 60_000`; a timeout can masquerade as "hung" — another path the summary/stop-reason must cover.
