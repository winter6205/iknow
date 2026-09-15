# Spec: transport retry, continue, failure persist

**Status:** ready for plan  
**Surface:** `src/harness/` (fault-class, race-timers, with-transport-retry, loop-engine), `src/session-api/` (checkpoint persist, continue-pending), `src/tui/` (continue, sticky notice)

## Goal

Model transport failures and human continue behave so a long turn can recover without mis-labeling clock aborts as user cancel, and so failed rounds do not erase the user's last task sentence.

## Settled invariants

1. **Idle expiry is retryable** only when the attempt produced **no visible output** (no text/thinking/tool deltas that count as visible for this contract). After visible output or an emitted `tool_use`, do **not** auto-retry the same step.
2. **Clock abort ≠ user cancel.** Idle/hardCap abort must classify as timeout (retry path when still invisible), never `user_cancel`.
3. **Idle default** moves to minute-scale (~5 minutes). ~20s with no stream bytes only updates sticky notice copy; the notice box does **not** auto-dismiss.
4. **Transport retry** uses second-scale exponential backoff, bounded attempts (implementer picks within 5–10 unless settings already expose a knob). Honor `retry-after` when present. Cover: 429, 5xx, explicit network faults, invisible idle/request timeout.
5. **Ctrl+C** aborts the foreground turn and **immediately** appends system `Interrupted by user.` (existing cancelled path).
6. **`/continue`** = skip-append continue of a pending tool loop. For that `run` only, strip a **trailing** interrupt system message from the model prior; **disk keeps** the interrupt. Empty Enter is **not** continue. Busy → `busy_stop_first` (no auto-abort).
7. **Normal typed input** after interrupt: model sees interrupt + new user text.
8. **`protocolError` / `emptyFinalResponse`:** persist the **user** message from that turn; do **not** persist the failed assistant turn. (`timeout` already persists — unchanged.)

## Out of scope

- Byte-level dual watchdog matrix / CI infinite 429 watchdog
- Non-streaming fallback double-shot
- Plugin slash / worktree deps / dispatch lesson (other specs)
- CLI continue beyond existing parity unless TUI contract already shared via hub

## Input-contract classes (public surfaces)

| Surface                         | empty                                             | invalid/negative                                         | overflow                                              | concurrent                                                                         | exception                                       |
| ------------------------------- | ------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| `/continue` / `continueSession` | no pending → typed `nothing_pending`              | args on `/continue` → usage EXIT (existing)              | N/A                                                   | busy → `busy_stop_first`                                                           | store load fail → typed notice                  |
| Transport retry                 | N/A                                               | non-retryable 4xx / cert → no retry                      | max attempts → `protocolError` + sticky English cause | abort during backoff → cancel, no further attempt                                  | translate miss → protocol_error not user_cancel |
| Persist predicate               | emptyFinalResponse → user kept, assistant dropped | protocolError with zero user delta → no orphan assistant | N/A                                                   | N/A                                                                                | save failure bubbles (existing)                 |
| Sticky notice                   | N/A                                               | N/A                                                      | N/A                                                   | new turn does not auto-clear sticky error until user acts (spec: no timer dismiss) | N/A                                             |

## Success criteria

- SC1: Invisible idle timeout retries at least once under test with fake clock / injected fault.
- SC2: Abort from idle timer is not `user_cancel` in fault translate.
- SC3: After Ctrl+C, transcript ends with interrupt system text; `/continue` step prior omits that trailing interrupt while file still has it.
- SC4: protocolError after a user query leaves that user message on disk and no failed assistant.
- SC5: Sticky abnormal-stop notice remains until user dismisses or starts a deliberate next action (no TTL auto-hide).

## Measured / out-of-band

Not this spec's landing gate: operator leader prompt end-to-end. Transport flakes during long explore remain a known risk until this lands.
