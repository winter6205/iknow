/**
 * Bounded transport retry, decorating ModelAdapter.step.
 *
 * It does not enter the loop state machine and does not piggyback on SDK
 * maxRetries. Vendor adapters only translate thrown errors into FaultEvents;
 * this module only backs off when classifyFault === "retry".
 *
 * The backoff is a seconds-scale exponential table (1s / 2s / 4s / 8s, cap
 * 16s) with 5 attempts (no settings knob exists; this is the low end of the
 * spec-permitted 5–10). When `retry-after` is present, a resend must not
 * happen earlier than the server's time. Clock-scheduled retries (idle /
 * hard-cap wakeups) are NOT here — loop-engine re-runs the whole race for
 * those (see runModelPhase); this module only exposes the same backoff table
 * for it to reuse.
 */

import { classifyFault, type FaultEvent } from "../fault-class.js";
import { TransportRetryExhaustedError } from "../errors.js";
import type { ModelAdapter } from "./types.js";
import { safeEmitStream } from "../stream.js";

export { TransportRetryExhaustedError };

/**
 * Bounded attempt budget. No settings knob today (not adding one); the low
 * end of the spec-permitted 5–10: enough to ride out "one deploy hiccup + one
 * slow link" without dragging a bad turn into the minutes range.
 */
export const TRANSPORT_MAX_ATTEMPTS = 5;

/** Seconds-scale exponential table (after the n-th failure wait `TRANSPORT_BACKOFF_MS[n-1]`). */
export const TRANSPORT_BACKOFF_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000,
];

/** Single-backoff cap; a longer `retry-after` is also clamped here (never wait unboundedly). */
export const TRANSPORT_BACKOFF_CAP_MS = 16_000;

/**
 * Delay after the `attempt`-th failure: table value doubling per step, capped at `CAP`.
 *
 * When `retryAfterMs` (milliseconds the adapter read from the `retry-after`
 * header) is present, take the larger of the two, then cap — resending
 * before the server's time burns an attempt for nothing; still bounded by
 * `CAP` so an absurd header can't hang the turn. Non-finite / negative
 * values are treated as absent.
 */
export function backoffDelayMs(
  attempt: number,
  retryAfterMs?: number,
  backoffMs: readonly number[] = TRANSPORT_BACKOFF_MS
): number {
  const tableMs =
    backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0;
  const floor =
    retryAfterMs !== undefined &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
      ? retryAfterMs
      : 0;
  return Math.min(Math.max(tableMs, floor), TRANSPORT_BACKOFF_CAP_MS);
}

export type TransportRetryOptions = {
  /** `signal` = this attempt's signal (clock-abort origin is marked on its reason). */
  readonly translate: (err: unknown, signal?: AbortSignal) => FaultEvent;
  readonly maxAttempts?: number;
  readonly backoffMs?: readonly number[];
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const DEFAULT_MAX_ATTEMPTS = TRANSPORT_MAX_ATTEMPTS;
const DEFAULT_BACKOFF_MS: readonly number[] = TRANSPORT_BACKOFF_MS;

function abortError(): DOMException {
  return new DOMException("This operation was aborted", "AbortError");
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "AbortError";
  }
  return err instanceof Error && err.name === "AbortError";
}

export async function sleepWithAbort(
  ms: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Human-readable fault short code (`llm_http: 429` / `llm_network`) — used only in transport_retry event text. */
function statusOf(fault: FaultEvent): string {
  return fault.kind === "llm_http" ? `llm_http: ${fault.status}` : fault.kind;
}

/** Backoff after this failure: exponential seconds table; `retry-after` takes precedence if larger (still capped). */
function delayFor(
  fault: FaultEvent,
  attempt: number,
  backoffMs: readonly number[]
): number {
  const retryAfterMs =
    fault.kind === "llm_http" ? fault.retryAfterMs : undefined;
  return backoffDelayMs(attempt, retryAfterMs, backoffMs);
}

export function withTransportRetry<T extends Pick<ModelAdapter, "step">>(
  adapter: T,
  options: TransportRetryOptions
): T {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = options.sleep ?? sleepWithAbort;
  const { translate } = options;

  const step: T["step"] = async (state, request, signal) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) throw abortError();
      try {
        return await adapter.step(state, request, signal);
      } catch (err) {
        lastErr = err;
        if (isAbort(err, signal)) throw err;
        const rawFault = translate(err, signal);
        const fault = classifyFault(rawFault);
        const canRetry = fault === "retry" && attempt < maxAttempts;
        if (!canRetry) {
          if (fault === "retry") {
            throw new TransportRetryExhaustedError(attempt, err);
          }
          throw err;
        }
        // Retry progress is not silent: before backing off, emit a
        // transport_retry event on the host stream (detail feeds the
        // "reconnecting" indicator text). Observer errors are swallowed by
        // safeEmitStream and never flow back into the retry path.
        safeEmitStream(request.onStream, {
          type: "transport_retry",
          attempt,
          maxAttempts,
          detail: statusOf(rawFault),
        });
        await sleep(delayFor(rawFault, attempt, backoffMs), signal);
      }
    }
    throw new TransportRetryExhaustedError(maxAttempts, lastErr);
  };

  return { ...adapter, step };
}
