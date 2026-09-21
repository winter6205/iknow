# 0091. A per-call tool timeout is not a turn timeout

Date: 2026-09-13
Status: accepted

## Context

When the ACI default tier (30s) elapses, the executor returns `execution_failed` + `"timeout"` for that **single** call (ADR-0005 still holds). `computeToolStopFlags` (`src/harness/loop-engine.ts`) must decide whether this tool phase triggered cancelled / timeout in order to steer the loop. The old predicate was `results.some(message === "timeout")` — a single-vote veto that turned a "slow `grep`" into a whole-session failure, voiding the successful read-only bash calls in the same wave (the shape is visible in existing traces: one wave with two `grep` errors + one `bash` ok, the session root record landing `error.type: "timeout"`). The user-visible surface of a per-call timeout is that one tool_result error, not a dead session.

## Decision

`StopReason: timeout` holds only when the outer `AbortSignal` has aborted and cancelled has not taken precedence. A per-call tool timeout is never escalated. The successful `tool_result`s of the other calls in the same wave must be handed to the model to continue.

The marker constant on `signal.reason` for a turn/host-clock abort is `TURN_CLOCK_ABORT_REASON = "turn-timeout"` (renamed from the old literal `"timeout"` — to avoid colliding with the per-call `"timeout"` failure label and with the existing `StopReason: timeout` literal; strict equality only, substring / prefix optimization is not allowed). `computeToolStopFlags` sets `timedOut` true only when `opts.signal?.reason === TURN_CLOCK_ABORT_REASON` **and** `signal.aborted === true`; every other abort (including a caller-initiated cancel) goes down the `cancelled` path.

## Why not

**Why not keep the `"timeout"` literal:** it is identical to the per-call `execution_failed` + `"timeout"` and identical to `StopReason: timeout`; any substring / prefix comparison would swallow a per-call timeout — or the model echoing the literal — as a turn timeout. Renaming is the cheapest fix and does not lose the `StopReason: timeout` control flow (`StopReason` remains `"timeout"`; the constant marks `signal.reason` — the two do not collapse into one site).

**Why not also escalate a per-call timeout to a turn timeout:** the user-visible surface is wrong; successful tool results in the parallel wave are wasted; the 30s tier sits too close to a real "whole-run hang" and would routinely kill long-running work.

**Why not widen the predicate to any `signal.aborted === true`:** cancel semantics would be swallowed by clock aborts, leaving "cancelled" and "clock expired" indistinguishable in the trace.

## Consequences

- (+) A per-call tool timeout fails only that tool_result (still `execution_failed` + `"timeout"`, ADR-0005 unchanged); the other calls in the wave continue.
- (+) Turn-clock aborts and caller cancels occupy two independent paths in both the trace and the control flow.
- (−) The `TURN_CLOCK_ABORT_REASON` literal and the `StopReason: timeout` literal are now separate; any substring / prefix comparison against `signal.reason` counts as a bug (a peer changed the constant value and correspondingly fixed the unit-test hookup anchor, from `"timeout"` to `"turn-timeout"`).

## Status of the turn-clock producer

The tool phase currently has **no** real turn/host-clock producer: `timedOut === true` in `computeToolStopFlags` can currently only come from a test seam (`tests/harness/aci/interrupt-routing.test.ts` — the ADR-0091 unit test calls `controller.abort("turn-timeout")` directly). When a future host / turn clock producer lands, it must abort with an `AbortSignal` whose `signal.reason === "turn-timeout"`, matching the existing anchor literal, and must **not** reuse the `"timeout"` literal lest the same-name ambiguity return. This ADR does not open a ticket for that producer.
