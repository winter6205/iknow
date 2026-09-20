/**
 * Two clocks on a single `adapter.step`: the model-call idle clock and the
 * hard cap.
 *
 * Extracted from `createRaceOutcome` in `loop-engine.ts` rather than
 * embedding a second state machine there (complexity anti-drift): this
 * module only decides *when* something expires; winner attribution after
 * expiry, cleanup, and single-wins still live solely in
 * `createRaceOutcome`'s `settle`.
 *
 * The two clocks:
 *   - **idle**: silence cap with no model output increment. Only the
 *     streaming arm has increments to reset it, so `resolveModelClocks`
 *     resolves it to undefined on the non-streaming arm.
 *   - **hard cap**: a finite limit measured from this step's start; it fires
 *     even while output keeps flowing (the hard cap must never be tuned to
 *     infinite as an acceptance workaround).
 *
 * Both expiries fall onto the caller's existing `StopReason: timeout`
 * (cancelKind `timerTimeout`) — **no new stop reason**. The `source`
 * parameter of `onExpire` only lets unit tests assert precisely which clock
 * fired; loop-engine converges both into one timeout path.
 */
import type { HarnessStreamEvent } from "./stream.js";
import { safeEmitStream } from "./stream.js";

/**
 * The idle-reset event closed set: only **model output increments** count as
 * "still writing". `compaction_*` are progress of a compaction sub-process,
 * not this model call writing — resetting on them would let compaction noise
 * keep a stuck call alive. Same for `stop_summary` / `agent_status` /
 * `env_snapshot`.
 */
export function resetsModelIdle(event: HarnessStreamEvent): boolean {
  return (
    event.type === "thinking_delta" ||
    event.type === "text_delta" ||
    event.type === "tool_call_start" ||
    event.type === "tool_input_delta"
  );
}

/** Which clock fired. Both converge to `StopReason: timeout` on the loop-engine side. */
export type RaceExpirySource = "idle" | "hardCap";

export interface RaceTimers {
  /**
   * false = this call has only the hard cap (non-streaming arm / idle
   * unconfigured). The caller decides whether to wrap `onStream` — when
   * disabled it passes through untouched, byte-identical to pre-change
   * behavior.
   */
  readonly idleEnabled: boolean;
  /**
   * Whether a **model-visible output increment** (an event inside the
   * `resetsModelIdle` closed set) has appeared in this call so far. At
   * expiry it is the sole criterion for "may we resend the whole call" —
   * retrying after output would void what the model already wrote, so only
   * false allows retry; read by the caller (loop-engine's onExpire), not
   * decided here.
   */
  readonly hadVisibleDelta: boolean;
  /** Feed stream events here; only events in the closed set reset idle, others ignored. */
  readonly noteStreamEvent: (event: HarnessStreamEvent) => void;
  /** Called at settle to clear both clocks; afterwards `noteStreamEvent` never revives idle. */
  readonly cancel: () => void;
}

/**
 * Start the two clocks. `onExpire` is called at most once (the first clock
 * to fire wins, then this helper stops its own timers) — winner arbitration
 * still belongs to the caller's `settle`; this just avoids a second burst of
 * noise.
 *
 * Non-positive values mean off: `hardCapMs <= 0` keeps the existing
 * "modelTimeoutMs=0 disables the race" semantics; absent / <= 0
 * `idleTimeoutMs` → idle off.
 */
export function startRaceTimers(opts: {
  readonly hardCapMs: number;
  readonly idleTimeoutMs: number | undefined;
  readonly onExpire: (source: RaceExpirySource) => void;
}): RaceTimers {
  const idleEnabled =
    opts.idleTimeoutMs !== undefined && opts.idleTimeoutMs > 0;
  let stopped = false;
  let hadVisibleDelta = false;
  let hardCapTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const cancel = (): void => {
    stopped = true;
    if (hardCapTimer !== undefined) clearTimeout(hardCapTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    hardCapTimer = undefined;
    idleTimer = undefined;
  };

  const expire = (source: RaceExpirySource): void => {
    if (stopped) return;
    cancel();
    opts.onExpire(source);
  };

  if (opts.hardCapMs > 0) {
    hardCapTimer = setTimeout(() => expire("hardCap"), opts.hardCapMs);
  }
  const armIdle = (): void => {
    if (stopped || !idleEnabled) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire("idle"), opts.idleTimeoutMs);
  };
  armIdle();

  const timers: RaceTimers = {
    get idleEnabled(): boolean {
      return idleEnabled;
    },
    get hadVisibleDelta(): boolean {
      return hadVisibleDelta;
    },
    noteStreamEvent: (event: HarnessStreamEvent): void => {
      if (!resetsModelIdle(event)) return;
      // Set the flag before resetting idle: the expiry callback reading
      // `hadVisibleDelta` must not depend on event-vs-timer ordering (an
      // event in the closed set itself means this output was already seen
      // by the host).
      hadVisibleDelta = true;
      armIdle();
    },
    cancel,
  };
  return Object.freeze(timers);
}

/**
 * When idle is on, wrap the adapter's observer: **record the increment
 * first**, then forward to the host callback.
 *
 * Record-then-forward is deliberate — a throwing host observer must not make
 * idle miss this increment. Forwarding goes through `safeEmitStream`, the
 * same swallow semantics as the adapter / full-compact emit points (observer
 * exceptions must not back-flow into the streaming arm).
 *
 * When the host has not subscribed (`onStream === undefined`) a wrapper is
 * **still returned**: `wireStreamEvents` early-exits when the observer is
 * absent, so skipping the wrapper would mean idle never sees increments and
 * would inevitably false-kill the call.
 *
 * Idle off → return the host callback as-is (same reference; byte-identical
 * to pre-change behavior).
 */
export function observeModelIdle(
  timers: RaceTimers,
  onStream: ((event: HarnessStreamEvent) => void) | undefined
): ((event: HarnessStreamEvent) => void) | undefined {
  if (!timers.idleEnabled) return onStream;
  return (event: HarnessStreamEvent): void => {
    timers.noteStreamEvent(event);
    safeEmitStream(onStream, event);
  };
}

/**
 * Resolve "the legacy single clock + the streaming arm's two-clock config"
 * into the clocks this step actually uses.
 *
 * - Non-streaming arm (`stream=off` / offline stub): idle has no increments
 *   to reset → off; hard cap = the legacy `timeoutMs` resolution —
 *   byte-identical to pre-change behavior.
 * - Streaming arm: idle active; hard cap takes the explicit override,
 *   falling back to the legacy single clock when unset (never widened to
 *   infinite).
 *
 * Takes raw numbers rather than `LoopEngineDeps` to avoid a race-timers ←
 * loop-engine reverse dependency (loop-engine imports this module
 * one-directionally).
 */
export function resolveModelClocks(input: {
  readonly modelTimeoutMs: number;
  readonly streamingArm: boolean;
  readonly idleTimeoutMs: number | undefined;
  readonly hardCapMs: number | undefined;
}): { readonly hardCapMs: number; readonly idleTimeoutMs: number | undefined } {
  if (!input.streamingArm) {
    return { hardCapMs: input.modelTimeoutMs, idleTimeoutMs: undefined };
  }
  return {
    hardCapMs: input.hardCapMs ?? input.modelTimeoutMs,
    idleTimeoutMs: input.idleTimeoutMs,
  };
}
