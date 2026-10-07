/**
 * Stop policy (#1219): what ended the run, and what may be concluded from it.
 *
 * WHY the cause is mandatory: run3 ended with `pty_eof`,
 * `exit_status {exited:true, code:143, detected_by:"teardown-waitpid"}` and
 * `died_at_rel_s: null` — a forced stop with no `stop_cause` field anywhere, and
 * no `quit` record. The old report read as a run that had simply finished, which
 * is the most expensive kind of wrong: it turns "we never completed" into "it
 * works". Here the cause is always named, and `natural` is true for exactly one
 * cause — a clean `/quit` exit — after every required stimulus was accepted AND
 * settled AND the frozen horizon was met.
 */

/** How the run ended. Never inferred from silence. */
export type StopCause =
  "clean_quit" | "forced" | "wall_timeout" | "process_exit" | "unproven";

/** An observed process exit. `detectedBy` is retained because a teardown
 *  discovery is weaker evidence than a waitpid observed during the run. */
export interface ExitStatus {
  readonly exited: boolean;
  readonly code: number | null;
  readonly signaled: boolean;
  readonly signal: string | null;
  readonly detectedBy: string;
}

export interface StopDecision {
  readonly cause: StopCause;
  /** True only for a natural completion. */
  readonly natural: boolean;
  /** Whether every precondition for stopping was met. */
  readonly readyToStop: boolean;
  /** Preconditions that failed, named one by one. */
  readonly missing: readonly string[];
  /** Whether the run may be reported as usable at all. */
  readonly usable: boolean;
  readonly reason: string;
}

/** Name the stop cause from what was actually observed. */
export function classifyStop(args: {
  readonly quitSent: boolean;
  readonly exit: ExitStatus | null;
  readonly wallExceeded: boolean;
  readonly forced: boolean;
}): StopCause {
  if (args.wallExceeded) return "wall_timeout";
  if (args.forced) return "forced";
  if (args.exit === null) return "unproven";
  const cleanExit =
    args.quitSent &&
    args.exit.exited &&
    args.exit.code === 0 &&
    !args.exit.signaled;
  return cleanExit ? "clean_quit" : "process_exit";
}

function missingPreconditions(args: {
  readonly requiredTags: readonly string[];
  readonly acceptedTags: readonly string[];
  readonly settledTags: readonly string[];
  readonly lastSettledAtMs: number | null;
  readonly nowMs: number;
  readonly horizonMs: number;
  readonly idleProven: boolean;
}): string[] {
  const missing: string[] = [];
  for (const tag of args.requiredTags) {
    if (!args.acceptedTags.includes(tag)) missing.push(`accept:${tag}`);
    if (!args.settledTags.includes(tag)) missing.push(`settle:${tag}`);
  }
  if (args.lastSettledAtMs === null) {
    missing.push("settlement");
  } else if (args.nowMs - args.lastSettledAtMs < args.horizonMs) {
    missing.push("horizon");
  }
  if (!args.idleProven) missing.push("idle_proven");
  return missing;
}

/**
 * Decide whether the run stopped naturally, and on what evidence.
 *
 * `cause` reports what the PROCESS did; `natural` additionally requires the
 * measured preconditions. A process that exits 0 while two of four stimuli were
 * refused is a `clean_quit` cause with `natural:false` — the two facts are
 * deliberately separate so neither can hide the other.
 */
export function decideStop(args: {
  readonly requiredTags: readonly string[];
  readonly acceptedTags: readonly string[];
  readonly settledTags: readonly string[];
  readonly lastSettledAtMs: number | null;
  readonly nowMs: number;
  readonly horizonMs: number;
  readonly quitSent: boolean;
  readonly exit: ExitStatus | null;
  readonly wallExceeded: boolean;
  readonly forced: boolean;
  readonly idleProven?: boolean;
}): StopDecision {
  const cause = classifyStop(args);
  const missing = missingPreconditions({
    requiredTags: args.requiredTags,
    acceptedTags: args.acceptedTags,
    settledTags: args.settledTags,
    lastSettledAtMs: args.lastSettledAtMs,
    nowMs: args.nowMs,
    horizonMs: args.horizonMs,
    idleProven: args.idleProven ?? true,
  });
  const natural = cause === "clean_quit" && missing.length === 0;
  return {
    cause,
    natural,
    readyToStop: missing.length === 0,
    missing,
    usable: natural,
    reason: natural
      ? `clean quit after every required stimulus was accepted, settled and the ${args.horizonMs}ms horizon elapsed`
      : `${cause}; unmet preconditions: ${missing.length === 0 ? "none" : missing.join(", ")}`,
  };
}

/** The stop cause recorded when the harness had to kill the child. */
export function forcedStop(
  reason: string,
  missing: readonly string[] = []
): StopDecision {
  return {
    cause: "forced",
    natural: false,
    readyToStop: false,
    missing,
    usable: false,
    reason,
  };
}
