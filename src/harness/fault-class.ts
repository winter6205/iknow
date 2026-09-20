/**
 * FaultClass policy table.
 *
 * Closed set `retry` | `fuse` | `none` over the API / tool / context /
 * control-flow axes. Answers only whether a transport failure is retryable
 * and whether same-argument failures count toward the fuse; never writes a
 * StopReason. This layer does not touch the ModelAdapter retry loop or tool
 * loop detection.
 */

export type FaultClass = "retry" | "fuse" | "none";

/** Which clock fired (same value domain as race-timers' `RaceExpirySource`). */
export type ClockAbortSource = "idle" | "hardCap";

/**
 * Typed marker for clock aborts.
 *
 * Both clocks and the host Ctrl+C travel the same `AbortSignal` channel, and
 * the SDK's `APIUserAbortError` **does not carry** `signal.reason` (fetch
 * doesn't forward it) — the thrown error alone cannot distinguish "a clock
 * fired" from "a human pressed Ctrl+C". So the source must be stamped on
 * `signal.reason`, and the translation layer
 * (`translateAnthropicTransportFault`) checks this marker before
 * classifying, so a clock abort is never mislabeled as `user_cancel`.
 *
 * `visible` = whether this attempt had any model output increment before
 * the fire (race-timers' `hadVisibleDelta`): only invisible aborts may retry
 * the whole attempt.
 */
export interface ClockAbortReason {
  readonly kind: "clock_abort";
  readonly source: ClockAbortSource;
  readonly visible: boolean;
}

const CLOCK_ABORT_KIND = "clock_abort";

export function clockAbortReasonOf(
  source: ClockAbortSource,
  visible: boolean
): ClockAbortReason {
  return Object.freeze({
    kind: CLOCK_ABORT_KIND,
    source,
    visible,
  }) satisfies ClockAbortReason;
}

/**
 * `signal.reason` → ClockAbortReason; non-clock aborts (no reason / host
 * reason) → undefined. Structural discrimination rather than `instanceof`:
 * reason is a plain value crossing `AbortSignal.any`, not an error-class
 * hierarchy.
 */
export function clockAbortOf(
  signal: AbortSignal | undefined
): ClockAbortReason | undefined {
  if (signal?.aborted !== true) return undefined;
  const reason: unknown = signal.reason;
  if (typeof reason !== "object" || reason === null) return undefined;
  const candidate = reason as {
    readonly kind?: unknown;
    readonly source?: unknown;
    readonly visible?: unknown;
  };
  if (candidate.kind !== CLOCK_ABORT_KIND) return undefined;
  const source = candidate.source;
  if (source !== "idle" && source !== "hardCap") return undefined;
  return {
    kind: CLOCK_ABORT_KIND,
    source,
    visible: candidate.visible === true,
  };
}

export type FaultEvent =
  | {
      readonly kind: "llm_http";
      readonly status: number;
      readonly retryAfterMs?: number;
    }
  /**
   * Clock fired (idle / hard cap). visible = output already streamed → no
   * auto-retry; invisible = this attempt produced no model output → a
   * retryable transport failure.
   */
  | {
      readonly kind: "clock_timeout";
      readonly source: ClockAbortSource;
      readonly visible: boolean;
    }
  /**
   * ADR-0111 invariant (a): the upstream stream ended without producing a
   * complete assistant Message (empty / truncated stream, the fault slot of
   * `ModelStreamIncompleteError`). Same `visible` rule as `clock_timeout`:
   * invisible → whole-step retry is safe; output already visible → no
   * auto-retry, a typed failure stands.
   */
  | { readonly kind: "stream_incomplete"; readonly visible: boolean }
  | { readonly kind: "llm_network" }
  | { readonly kind: "prompt_too_long" }
  | { readonly kind: "permission_deny" }
  | { readonly kind: "verify_fail" }
  | { readonly kind: "user_cancel" }
  | { readonly kind: "timeout" }
  | {
      readonly kind: "execution_failed";
      /** Number of execution_failed occurrences for the same tool+args (including this one). */
      readonly occurrenceCount: number;
    }
  | { readonly kind: "compact_failed" }
  | { readonly kind: "protocol_error" }
  | { readonly kind: "empty_final_response" };

/**
 * `retry-after` header → milliseconds ("honor retry-after"). Only two forms
 * are accepted:
 *   - delta-seconds (`"3"`, `"3.5"` — RFC 9110 allows fractional);
 *   - HTTP-date (`"Wed, 21 Oct 2015 07:28:00 GMT"`) → difference from
 *     `nowMs`.
 * Anything else (empty / non-numeric / past date / negative) → undefined =
 * treated as absent, falling back to the local backoff table: better to
 * decide for ourselves than to fire an immediate resend on a malformed
 * header.
 *
 * Lives here (not in the retry decorator) because it only determines the
 * **shape** of the FaultEvent, independent of the "how long to back off"
 * policy; the translator (anthropic-adapter) and the retry loop each depend
 * only on this module.
 */
export function parseRetryAfterMs(
  rawValue: string | null | undefined,
  nowMs: number = Date.now()
): number | undefined {
  if (rawValue === null || rawValue === undefined) return undefined;
  const raw = rawValue.trim();
  if (raw === "") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1_000 : undefined;
  }
  const epoch = Date.parse(raw);
  if (!Number.isFinite(epoch)) return undefined;
  const deltaMs = epoch - nowMs;
  return deltaMs >= 0 ? deltaMs : undefined;
}

const HTTP_RETRY_MIN = 500;
const HTTP_RETRY_MAX = 599;
const FUSE_MIN_OCCURRENCES = 2;

function isTransientHttpStatus(status: number): boolean {
  if (status === 429) return true;
  return status >= HTTP_RETRY_MIN && status <= HTTP_RETRY_MAX;
}

/**
 * Policy: 429 / 5xx / network → retry; repeated same-args execution_failed →
 * fuse; everything else none.
 *
 * A clock firing while **invisible** (this attempt produced no model output
 * increment) → retry — a stalled connection is not "the turn failed", so
 * resending the whole call is safe; once output is visible, no auto-retry:
 * it lands none and loop-engine closes via the existing timeout path.
 * Visibility is derived from stream events by race-timers
 * (`hadVisibleDelta`), not decided here.
 *
 * ADR-0111 invariant (a): an unfinished upstream stream
 * (`stream_incomplete`) follows the same rule as `clock_timeout` — invisible
 * → retry (whole-step retry safe, within withTransportRetry's existing
 * budget); visible → none (no auto-retry; the typed error propagates to the
 * loop's closing path).
 */
export function classifyFault(
  event: FaultEvent | null | undefined
): FaultClass {
  if (event == null) return "none";
  switch (event.kind) {
    case "llm_http":
      return isTransientHttpStatus(event.status) ? "retry" : "none";
    case "llm_network":
      return "retry";
    // Single implementation of the visible rule (both kinds share it:
    // clock_timeout and stream_incomplete, see the doc above).
    case "clock_timeout":
    case "stream_incomplete":
      return event.visible ? "none" : "retry";
    case "execution_failed":
      return event.occurrenceCount >= FUSE_MIN_OCCURRENCES ? "fuse" : "none";
    default:
      return "none";
  }
}
