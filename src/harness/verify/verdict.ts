/**
 * verify pure-function decision layer for the failure auto-correction loop.
 *
 * Three-state verdict / confirmation ladder / failure signature / trend
 * evaluation — all pure, zero IO, zero side effects. All state (bestFailed /
 * previous signature / consecutive-regression counts) is owned and passed in
 * by the caller (verify-loop); this module never remembers implicitly.
 */
import type {
  ConfirmationVerdict,
  TrendAction,
  TrendVerdict,
  Verdict,
} from "./types.js";

/** Built-in failure-line detection: when exit!=0, count these lines as failedCount. */
export const FAILURE_LINE_PATTERN = /^\s*(FAIL(ED)?|✗|×)\b|\berror:/i;

/* ------------------------------ three-state verdict ------------------------------ */

export interface AssessVerdictArgs {
  readonly exitCode: number;
  /** Failed cases this round; omitted when unparseable. */
  readonly failedCount?: number;
  /**
   * Whether ladder level 1 (full rerun) passed.
   * First verification (no rerun yet) passes undefined → treated as failed,
   * never a free pass.
   */
  readonly rerunPassed?: boolean;
  /**
   * Whether ladder level 2 (failed-case rerun) passed.
   * Omitted when rerunTemplate is unset → excluded from the unstable decision.
   */
  readonly singlePassed?: boolean;
}

/**
 * Three states: pass / true-failure / unstable.
 * - exit 0 or zero failures → pass;
 * - exit≠0 and every ladder level fails → true-failure;
 * - exit≠0 but full rerun passes → pass (flaky, no correction);
 * - exit≠0, full rerun still fails, single-case rerun passes → unstable
 *   (suite interference, no correction).
 */
export function assessVerdict(args: AssessVerdictArgs): Verdict {
  const { exitCode, failedCount } = args;
  if (exitCode === 0 || failedCount === 0) return "pass";
  if (args.rerunPassed === true) return "pass";
  if (args.singlePassed === true) return "unstable";
  return "true-failure";
}

/* ------------------------------ confirmation ladder ------------------------------ */

export interface ConfirmFailureArgs {
  /** Level 1: did the full rerun pass? */
  readonly rerunPassed: boolean;
  /**
   * Level 2: did the failed-case rerun pass?
   * Caller passes undefined when rerunTemplate is unset (single rerun skipped).
   */
  readonly singleRunPassed?: boolean;
}

export interface ConfirmationLadderResult {
  readonly verdict: ConfirmationVerdict;
  /** Whether level 1 failed (full rerun failed). */
  readonly rerunFailed: boolean;
  /** Whether level 2 ran and passed; undefined = single-rerun template unset. */
  readonly singleRunPassed?: boolean;
}

/**
 * Two-level confirmation ladder: each level runs at most once, no recursion;
 * only flaky when everything passes, only true-failure when everything fails.
 * The ladder short-circuits: full rerun passes → flaky, level 2 never runs;
 * level 2 is consulted only when the full rerun fails.
 */
export function confirmFailure(
  args: ConfirmFailureArgs
): ConfirmationLadderResult {
  if (args.rerunPassed) {
    return { verdict: "flaky", rerunFailed: false, singleRunPassed: undefined };
  }
  if (args.singleRunPassed === true) {
    return { verdict: "unstable", rerunFailed: true, singleRunPassed: true };
  }
  return {
    verdict: "true-failure",
    rerunFailed: true,
    singleRunPassed: args.singleRunPassed,
  };
}

/* ------------------------------ failure counting ------------------------------ */

export function countFailures(
  outputText: string,
  countRegex?: RegExp,
  exitCode?: number
): number | undefined {
  // exit-0 (pass) branch never counts failure lines — counting only serves failure semantics.
  if (exitCode !== undefined && exitCode === 0) return 0;

  if (countRegex !== undefined) {
    const match = countRegex.exec(outputText);
    // Only trust regexes that yield an integer count; no capture group / no
    // match → don't guess, fall back to the pure-signature path.
    if (match !== null && match[1] !== undefined) {
      const n = Number(match[1]);
      if (Number.isInteger(n) && n >= 0) return n;
    }
    return undefined;
  }

  let count = 0;
  for (const line of outputText.split("\n")) {
    if (FAILURE_LINE_PATTERN.test(line)) count += 1;
  }
  return count;
}

/* ------------------------------ failure signature ------------------------------ */

export interface BuildFailureSignatureArgs {
  readonly exitCode: number;
  /** Raw verification output; signature extraction is read-only on this text. */
  readonly outputText: string;
  /** settings.verify.countRegex; takes priority over built-in line detection. */
  readonly countRegex?: string;
}

/**
 * Normalized failure signature: exit code + failing case name / first error line.
 * Format: `exit=1|tests/auth.test.ts:login rejects bad token`.
 * countRegex wins when configured; neither available → bare `exit=N`
 * signature (stall detection only).
 */
export function buildFailureSignature(args: BuildFailureSignatureArgs): string {
  const { exitCode, outputText } = args;
  const firstLine = firstFailureLine(outputText, args.countRegex);
  return firstLine === undefined
    ? `exit=${exitCode}`
    : `exit=${exitCode}|${firstLine}`;
}

/**
 * Use the start of the first failure line as signature content.
 * With countRegex configured its match wins; otherwise fall back to built-in
 * failure-line detection.
 */
function firstFailureLine(
  outputText: string,
  countRegex?: string
): string | undefined {
  if (countRegex !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(countRegex);
    } catch {
      // Settings layer already guards invalid regexes; if unparseable here,
      // degrade to built-in detection.
      // EXIT: invalid regex → built-in failure-line fallback.
      re = FAILURE_LINE_PATTERN;
    }
    const match = re.exec(outputText);
    if (match !== null) return match[0].trim();
  }

  for (const line of outputText.split("\n")) {
    if (FAILURE_LINE_PATTERN.test(line)) {
      return stripFailureMarker(line);
    }
  }
  return undefined;
}

/**
 * Strip FAIL / FAILED / ✗ / × line markers, keeping the failing case name or
 * error content. The signature example
 * "exit=1|tests/auth.test.ts:login rejects bad token" has no "FAIL  " prefix —
 * signature content is the case name, not the line marker.
 * error: lines keep their "error:" prefix (the content itself is the error text).
 */
function stripFailureMarker(line: string): string {
  return line.replace(/^\s*(FAIL(ED)?|✗|×)\b\s*/, "").trim();
}

/* ------------------------------ trend evaluation ------------------------------ */

export interface EvaluateTrendArgs {
  /** Failed cases this round; undefined = unparseable (pure signature comparison). */
  readonly currentFailed?: number;
  /** Historical best (minimum) failure count. */
  readonly bestFailed?: number;
  /** Failed cases in the previous round. */
  readonly lastFailed?: number;
  readonly currentSignature: string;
  readonly lastSignature?: string;
}

export interface TrendResult {
  readonly trend: TrendVerdict;
  readonly action: TrendAction;
}

/**
 * Trend evaluation: the trend is the judge, maxRounds is only a backstop.
 * Rule order = priority; rules are mutually exclusive:
 * 1. progress: current < best → continue (better than historical best, always let through);
 * 2. stuck: identical signature for two consecutive rounds (current == last) → stop;
 * 3. regression: last > best and current > best (two rounds worse than best) → stop;
 * 4. oscillation-tolerant: current > best but last == best (single-round
 *    regression) → continue;
 * 5. fallback (rounds whose failure count is unparseable): never guess a stop;
 *    let it through.
 */
export function evaluateTrend(args: EvaluateTrendArgs): TrendResult {
  const { currentFailed, bestFailed, lastFailed, currentSignature } = args;
  const lastSignature = args.lastSignature;

  if (
    currentFailed !== undefined &&
    bestFailed !== undefined &&
    currentFailed < bestFailed
  ) {
    return { trend: "progress", action: "continue" };
  }

  if (
    currentFailed !== undefined &&
    lastFailed !== undefined &&
    lastSignature !== undefined &&
    lastSignature === currentSignature &&
    currentFailed === lastFailed
  ) {
    return { trend: "stuck", action: "stop" };
  }

  if (
    currentFailed !== undefined &&
    bestFailed !== undefined &&
    lastFailed !== undefined &&
    currentFailed > bestFailed &&
    lastFailed > bestFailed
  ) {
    return { trend: "regression", action: "stop" };
  }

  if (
    currentFailed !== undefined &&
    bestFailed !== undefined &&
    lastFailed !== undefined &&
    currentFailed > bestFailed &&
    lastFailed === bestFailed
  ) {
    return { trend: "oscillation-tolerant", action: "continue" };
  }

  return { trend: "oscillation-tolerant", action: "continue" };
}
