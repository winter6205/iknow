# 0029. FaultClass runs parallel to StopReason; the tool loop stops with fused

Date: 2026-08-25
Status: accepted

StopReason continues to answer only "why did this run stop" (append-only, no re-ordering). Whether a failure warrants transport retry and whether it counts toward the tool loop uses a parallel closed set FaultClass (retry / fuse / none), avoiding cramming API/tool/context/control-flow failures into the stop union. Within a run, if the tool loop is judged stalled after the result has already been written to the append-only messages, a LOOP_DETECTED envelope is injected and the run ends with the new stop reason `fused` (the same discipline that appended cancelled/timeout in 017). Transport retry decorates ModelAdapter — it stays out of the loop, out of session-api, and unbound to any single SDK. Subagents must treat fused as a failure envelope. Rejected: a new stop reason without changing the worker; a circuit-break visible only to humans and not fed to the model next round; using consecutive N=3 instead of period+stall detection.

## Why not

- **Writing fault classes into StopReason**: mixes semantics with completed/cancelled, and the exhaustive branches in session-api and the worker would silently go wrong.
- **Reusing nonSuccessStop**: that is provider truncation/refusal, and tests could not assert loop detection.
- **Putting loop detection in verify-loop**: verify runs only after completed and cannot reach tool idling inside a run.
