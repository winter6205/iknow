/**
 * Message-contract SSOT for the server-ised sandbox execution plane.
 *
 // (ADR-0045)
 *
 * Two protocol shapes:
 *   1. Short-lived request/response (foreground + verify): `exec(req): Promise<ExecResponse>`
 *      waits for the child to exit and returns a one-shot result.
 *   2. Long-lived task handle (background): `spawn(req): Promise<SpawnResponse>`
 *      resolves the task_id synchronously; the returned handle exposes
 *      stdout/stderr/exit/stopped events (AsyncIterable) + a stop control message.
 *
 * The typed-error discriminated union for the fault paths (overflow merged into
 *
 // (ADR-0045)
 * the truncateByCodePoint contract) is defined here; the server throws typed
 * errors internally and clients branch on kind. This file only pins the shapes,
 * handler implementations live in ./index.ts.
 */
import type { BwrapFence } from "../bwrap.js";
import type { CleanupEvidence } from "../cleanup-result.js";

/** Short-lived exec request — returns a one-shot result after the child exits. */
export interface ExecRequest {
  readonly kind: "exec";
  readonly fence: BwrapFence;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** Defaults to DEFAULT_MAX_OUTPUT_CODE_POINTS (12_000). ≤0 / non-integer → RangeError. */
  readonly maxOutputCodePoints?: number;
  /** Defaults to 2_000 ms. Negative → RangeError; 0 = SIGKILL immediately, no SIGTERM first. */
  readonly killGraceMs?: number;
  /**
   * ADR-0134: this run's runtime deadline, enforced by the process plane and
   * reported back as `deadline_expired` on the response. Undefined = no
   * deadline (the pre-ADR-0134 exec shape, still what verify and every other
   * exec consumer send).
   */
  readonly deadlineMs?: number;
  /**
   * Bounded wait for process-group disappearance before the teardown reports
   * `unconfirmed`. Defaults to GROUP_SETTLE_MS; it bounds the verdict wait
   * only, never the kill route. Negative → RangeError (negative_argument).
   */
  readonly groupObserveMs?: number;
}

export interface ExecResponse {
  /** On signal termination mapped by SIGNAL_EXIT_CODES (128 + signal number); missing exit falls back to 1. */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * The signal that terminated the fence, when the child died by signal.
   * `exitCode` alone folds every cause of signal N into the same 128+N, so the
   * name travels with the response; absent means the child was not
   * signal-terminated (a natural exit, including a non-zero one).
   */
  readonly signal?: string;
  /**
   * Bounded-teardown evidence for the fence's process group, so a timeout or
   * an abort that could not confirm disappearance is visible to the caller
   * instead of being flattened into an exit code. Absent only when the fence
   * never started (no process group to report on).
   */
  readonly cleanup?: CleanupEvidence;
  /**
   * ADR-0134: true only when the run was ended by its own `deadlineMs` rather
   * than by the caller or by a natural exit. Additive: an exec without a
   * deadline omits it entirely, so consumers that predate ADR-0134 read the
   * exact same response as before.
   */
  readonly deadline_expired?: boolean;
}

/** Long-lived spawn request — resolves task_id synchronously; the handle keeps emitting events. */
export interface SpawnRequest {
  readonly kind: "spawn";
  readonly fence: BwrapFence;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** Defaults to 2_000 ms (SIGTERM→SIGKILL escalation grace); negative → RangeError. */
  readonly killGraceMs?: number;
  /** Bounded wait for process-group disappearance before the `stopped` event reports `unconfirmed`. Defaults to GROUP_SETTLE_MS. */
  readonly groupObserveMs?: number;
  /** Placeholder form (conversation roundtrip) — persisted to disk; the caller restores the real value before passing the fence. */
  readonly recordCommand?: string;
  /** Session identity (passed through to the manager.state in-memory Map). */
  // (ADR-0021)
  readonly conversationId?: string;
}

/** One-shot spawn response — resolves synchronously so the client returns immediately with the task_id. */
export interface SpawnResponse {
  readonly task_id: string;
  readonly log_path: string;
}

/** Long-lived task event stream (AsyncIterable); kind decides the shape. */
export type SandboxTaskEvent =
  | {
      readonly kind: "stdout";
      readonly chunk: string;
    }
  | {
      readonly kind: "stderr";
      readonly chunk: string;
    }
  | {
      readonly kind: "exit";
      readonly exit_code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | {
      readonly kind: "stopped";
      readonly signal: NodeJS.Signals | null;
      /**
       * What the bounded teardown observed for this task's process group.
       * `unconfirmed` means the stop was issued but disappearance was never
       * proven — the task's process may still exist, and the consumer must
       * not read this event as "the work is finished".
       */
      readonly cleanup: CleanupEvidence;
    };

/**
 * Long-lived handle — the protocol layer encapsulates the intermediate states of
 * the kill escalation: clients only go through stop(), and the SIGTERM→SIGKILL
 * escalation is an internal detail. Physical pid ownership stays with the host
 * (server runs in-process, so host = server).
 */
export interface SandboxTaskHandle {
  readonly task_id: string;
  readonly log_path: string;
  /**
   * AsyncIterable: the event stream (stdout/stderr/exit/stopped).
   *
   * Single-consumer contract: each call returns a new AsyncIterable; calling
   * `events()` twice on the same handle makes consumers compete for events —
   * the later one misses stdout/stderr queued before it, and the close sentinel
   * is visible to exactly one consumer. Design trade-off: with a same-process
   * router, consumers pair one-to-one (the bash tool's background is a
   * singleton), so there is no sharing need; if broadcasting is ever required,
   * add an explicit broadcast operator instead of silently loosening this
   * contract.
   */
  events(): AsyncIterable<SandboxTaskEvent>;
  /** Control message: SIGTERM → graceMs → SIGKILL (default 2_000 ms). Idempotent. */
  stop(graceMs?: number): Promise<void>;
}

/** Internal: queue-element discriminated union — SandboxTaskEvent or the close sentinel. */
export type QueuedTaskEvent = SandboxTaskEvent | { readonly kind: "close" };

/**
 * Typed errors for the fault paths: what remains once the merged-away kinds
 *
 // (ADR-0045)
 * (overflow via truncate, empty task_id) are excluded.
 *
 * Catch contract: clients must branch on kind first; render as
 * `${kind}: ${context}`; never funnel through
 * `err instanceof Error ? err.message : String(err)` into `[object Object]`.
 *
 * Design trade-offs:
 *   - `empty_task_id` removed — task_id is generated server-side via
 *     randomBytes, callers cannot supply it, so listing it in the union would
 *     be dead API surface.
 *   - `overflow` removed — output truncation is carried by truncateByCodePoint
 *
 // (ADR-0045)
 *     (the contract already used in runner.ts), no typed error is thrown.
 */
export type SandboxServerError =
  /** empty: request frame lacks fence / cwd is blank → throw without spawning. */
  | { kind: "empty_request"; context: string }
  /** negative: maxOutputCodePoints / killGraceMs out of range. RangeError passes through the truncateByCodePoint contract. */
  | { kind: "negative_argument"; context: string; cause: unknown }
  /** exception: child exited without acknowledgement / server unreachable (future cross-process scenario) — typed fail-loud, no degradation. */
  | {
      kind: "server_unreachable";
      context: string;
      cause?: unknown;
    }
  /** exception: after accept, the child died abnormally without acknowledgement — typed fail-loud + orphan process-group reap (stale-reap.ts discipline). */
  | {
      kind: "orphan_process_group";
      context: string;
      pgid?: number;
    };

/** Utility: render a typed-error literal as `${kind}: ${context}`. */
export function renderSandboxServerError(err: SandboxServerError): string {
  return `${err.kind}: ${err.context}`;
}
