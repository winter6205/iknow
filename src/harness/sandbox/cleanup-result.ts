/**
 * Bounded process-tree cleanup evidence — the single discriminated result the
 * foreground plane (sandbox/runner.ts), the background plane
 * (sandbox/server/spawn.ts) and the background task manager
 * (background/manager.ts) all report through.
 *
 * Why a discriminated result and not a boolean: "the stop call returned" and
 * "the process tree is gone" are different facts, and the difference is
 * observable to the harness. A teardown is confirmed only when the process
 * group was probed and found absent; every other route (no teardown started,
 * a failed signal, a bounded observation that ended while members survived)
 * is reported as what it is. Nothing here converts a failure into a stop.
 *
 * The exit condition of any bounded cleanup built on this module is
 * therefore explicit: either the group was observed gone
 * (`confirmed_stopped`), or the bounded observation ended / the teardown
 * raised (`unconfirmed`, carrying which one and the process identity).
 */

/** Why a bounded cleanup could not confirm disappearance. */
export type CleanupUnconfirmedReason =
  /** The bounded observation window ended while group members were still alive. */
  | "observation_expired"
  /** A signal delivery or a liveness probe failed with a non-ESRCH errno. */
  | "teardown_failed";

/**
 * Cleanup evidence for one process group.
 *
 * `pgid` is absent only in `not_started`, where no teardown ever ran and no
 * process group was observed. `task_id` is carried when the caller owns a
 * task identity (the background plane); the foreground plane has none.
 */
export type CleanupEvidence =
  | { readonly state: "not_started" }
  | {
      readonly state: "confirmed_stopped";
      /** The process group observed absent — the direct-child pid equals its pgid (detached spawn). */
      readonly pgid: number;
      readonly task_id?: string;
    }
  | {
      readonly state: "unconfirmed";
      readonly reason: CleanupUnconfirmedReason;
      readonly pgid: number;
      /** Human-readable cause (errno name / stage) for the trace and logs. */
      readonly detail: string;
      readonly task_id?: string;
    };

/** No teardown was requested for this process group, so no stop may be claimed. */
export const NOT_STARTED_CLEANUP: CleanupEvidence = Object.freeze({
  state: "not_started",
});

/** The process group was probed and found absent. */
export function confirmedStopped(
  pgid: number,
  task_id?: string
): CleanupEvidence {
  return {
    state: "confirmed_stopped",
    pgid,
    ...(task_id !== undefined ? { task_id } : {}),
  };
}

/** The bounded cleanup ended without proof of disappearance. Never a success. */
export function unconfirmedCleanup(
  pgid: number,
  reason: CleanupUnconfirmedReason,
  detail: string,
  task_id?: string
): CleanupEvidence {
  return {
    state: "unconfirmed",
    reason,
    pgid,
    detail,
    ...(task_id !== undefined ? { task_id } : {}),
  };
}

/** Poll interval while waiting for a process group to disappear. */
export const GROUP_POLL_MS = 20;

/**
 * Process-group liveness probe: true if any member is present.
 *
 * ESRCH is the only definitive "gone" answer; every other errno (EPERM on a
 * group owned by another uid, for instance) is undecidable and is treated as
 * present, so an undecidable probe never manufactures a stop.
 */
export function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Test seam for the liveness probe. Production callers leave this unset; the
 * override exists because a group that survives SIGKILL cannot be produced on
 * Linux, so the observation-expiry route is unreachable against a real process
 * tree and needs a blinded probe to be exercised deterministically.
 */
let groupAliveOverride: ((pgid: number) => boolean) | undefined;

/** Replace the liveness probe for one test; pass undefined to restore. */
export function setProcessGroupAliveProbe(
  probe: ((pgid: number) => boolean) | undefined
): void {
  groupAliveOverride = probe;
}

/**
 * The group was observed gone. Every confirmation path goes through this one
 * function so a verdict can never mix a real probe with an overridden one.
 */
export function isProcessGroupGone(pgid: number): boolean {
  return (groupAliveOverride ?? processGroupAlive)(pgid) === false;
}

/**
 * Bounded poll until the process group disappears: emptied within the window
 * → true; window spent → decided by the last liveness probe.
 *
 * Bounded by iteration count rather than by the wall clock, so a frozen clock
 * (fake timers) can still complete the wait instead of spinning.
 */
export async function waitForProcessGroupGone(
  pgid: number,
  capMs: number
): Promise<boolean> {
  const probe = groupAliveOverride ?? processGroupAlive;
  const polls = Math.max(1, Math.ceil(capMs / GROUP_POLL_MS));
  for (let i = 0; i < polls; i += 1) {
    if (!probe(pgid)) return true;
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
  }
  return !probe(pgid);
}

/**
 * Signal a whole detached process group, reporting a delivery failure instead
 * of throwing or swallowing it.
 *
 * ESRCH means the group is already gone — the observation, not this call,
 * decides that fact, so it is not a failure. Any other errno is handed to
 * `onFailure`, which keeps the resulting evidence off `confirmed_stopped`.
 */
export function sendSignalToProcessGroup(
  pgid: number,
  signal: NodeJS.Signals,
  onFailure: (detail: string) => void
): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    onFailure(
      `kill -${pgid} ${signal} failed (${code ?? "unknown"}): ${String(error)}`
    );
  }
}
