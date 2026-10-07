/**
 * Attempt validity, denominators and spend aggregation.
 *
 * Why it exists (issue 1219 requirement 2): `validity()` in #1212 returned `"VALID"` or
 * `"INVALID:ctrf,result_line"`, was duplicated verbatim in both drivers, and was only ever
 * written and printed — no consumer computed a denominator, so every rate in the write-up
 * was calculated by hand afterwards. Separately, the ceiling checks summed only
 * `input_tokens` + `output_tokens` while `cache_read_input_tokens` was tallied and never
 * surfaced: measured `cache_read_input_tokens=179410` against `input_tokens=15645`, an
 * 11.5x understatement of what a call actually costs.
 *
 * Three rules this module enforces:
 *  - Denominators are DERIVED from the ledger rows, including invalid and interrupted
 *    attempts, which stay visible in `attempted`.
 *  - Spend aggregates from EVERY started attempt, cache tokens included. Unknown usage is
 *    `unknown` — never zero — and an unknown usage BLOCKS further dispatch rather than
 *    permitting it against a claimed budget.
 *  - Pre-dispatch gate failures live in their own visible bucket under a counting policy
 *    frozen before the next run, never folded into the attempt denominator.
 */
import type {
  AttemptPhase,
  LedgerReadResult,
  LedgerRow,
  LedgerUnreadable,
} from "./ledger.js";

/** How one attempt is classified, kept separate from its task/grader outcome. */
export type AttemptClass = "valid" | "invalid" | "interrupted";

/** The #1167 three-clause evidence rule: ctrf retained, real result line, no network marker. */
export interface ValidityInput {
  readonly ctrfBytes: number;
  readonly resultLine: string;
  readonly networkFailureMarker: boolean;
}

export interface ValidityVerdict {
  readonly valid: boolean;
  readonly failedClauses: ReadonlyArray<string>;
  /** Machine-readable form retained in reports: `VALID` or `INVALID:a,b`. */
  readonly label: string;
}

/**
 * Frozen BEFORE the next run so the accounting cannot be tuned to the result it reports.
 * `unknown-usage-blocks-dispatch` is the load-bearing clause.
 */
export const COUNTING_POLICY = {
  policyId: "1219-denominator-v1",
  frozenBeforeNextRun: true,
  attemptedIncludesInvalid: true,
  attemptedIncludesInterrupted: true,
  excludedIsNotAttempted: true,
  gateFailuresCountedSeparately: true,
  unknownUsageIsNotZero: true,
  unknownUsageBlocksDispatch: true,
  cacheTokensCountedAsSpend: true,
  ceilingsObservedBetweenAttempts: true,
  ceilingsEnforcedLive: false,
  ceilingNote:
    "Ceilings are observed between attempts, not enforced live: a single in-flight " +
    "attempt can overshoot the claimed budget by its own final usage.",
} as const;

export interface SpendTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  /** Sum of all four, so cache reads count as spend rather than as free context. */
  readonly totalTokens: number;
  /** Attempts whose usage could not be read from retained artifacts. */
  readonly unknownUsageAttempts: ReadonlyArray<string>;
  /** True when every started attempt's usage is known. */
  readonly usageComplete: boolean;
  /**
   * Set when the ledger itself could not be read, so there is no per-attempt id to name.
   * It is the SAME unknown-usage condition, not a second one: `usageComplete` is false and
   * the ceiling halts exactly as it does for an unfinalized attempt.
   */
  readonly ledgerUnreadable: LedgerUnreadable | null;
  /** A readable prefix ended at damaged JSONL, so later usage may be missing. */
  readonly ledgerIntegrityIssue?: {
    readonly kind: "torn-lines";
    readonly tornLines: number;
  };
}

export interface Denominator {
  /** Every attempt that began, including invalid and interrupted ones. */
  readonly attempted: number;
  readonly valid: number;
  readonly invalid: number;
  readonly interrupted: number;
  /** Attempts that dispatched a model; the ones that can be blamed on model behaviour. */
  readonly modelAttributable: number;
  /** Explicit preflight exclusions. NOT attempts: no model was ever dispatched. */
  readonly excluded: number;
  /** Pre-dispatch gate failures, in their own bucket. */
  readonly gateFailures: number;
  readonly policyId: string;
}

const RESULT_LINE = /\d+\s+(passed|failed|error)/i;

/** Apply the three-clause rule. Reward is deliberately not an input: it proves nothing here. */
export function classifyValidity(input: ValidityInput): ValidityVerdict {
  const clauses: Array<[string, boolean]> = [
    ["ctrf", input.ctrfBytes > 0],
    ["result_line", RESULT_LINE.test(input.resultLine)],
    ["no_network_marker", !input.networkFailureMarker],
  ];
  const failedClauses = clauses.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    valid: failedClauses.length === 0,
    failedClauses,
    label:
      failedClauses.length === 0
        ? "VALID"
        : `INVALID:${failedClauses.join(",")}`,
  };
}

/** Classify one attempt from its lifecycle phase and evidence; `excluded` rows are not attempts. */
export function classifyAttempt(
  row: LedgerRow,
  input: ValidityInput
): AttemptClass | "excluded" {
  if (row.excluded) return "excluded";
  if (row.phase === "interrupted") return "interrupted";
  if (row.phase === "intent") return "interrupted";
  if (row.phase === "invalid") return "invalid";
  return classifyValidity(input).valid ? "valid" : "invalid";
}

/**
 * Build the denominator from lifecycle rows. `evidence` supplies each attempt's measured
 * evidence so validity is DERIVED from retained artifacts, never from a stored label.
 */
export function computeDenominator(
  rows: ReadonlyArray<LedgerRow>,
  evidence: ReadonlyMap<string, ValidityInput>
): Denominator {
  let attempted = 0;
  let valid = 0;
  let invalid = 0;
  let interrupted = 0;
  let modelAttributable = 0;
  let excluded = 0;
  let gateFailures = 0;

  for (const row of rows) {
    if (isGateFailure(row)) {
      // A gate failure is a pre-dispatch refusal: no model ran, so it is neither an
      // attempt nor a task outcome. It stays visible in its own bucket.
      gateFailures += 1;
      excluded += 1;
      continue;
    }
    if (row.excluded) {
      excluded += 1;
      continue;
    }
    const cls = classifyAttempt(
      row,
      evidence.get(row.attemptId) ?? emptyEvidence()
    );
    if (cls === "excluded") {
      excluded += 1;
      continue;
    }
    attempted += 1;
    if (row.modelDispatched) modelAttributable += 1;
    if (cls === "valid") valid += 1;
    else if (cls === "interrupted") interrupted += 1;
    else invalid += 1;
  }
  return {
    attempted,
    valid,
    invalid,
    interrupted,
    modelAttributable,
    excluded,
    gateFailures,
    policyId: COUNTING_POLICY.policyId,
  };
}

/** Preflight-exclusion prefix on a row's reason. A gate failure never dispatched a model. */
export const GATE_FAILURE_PREFIX = "gate:";

function isGateFailure(row: LedgerRow): boolean {
  return row.reason.startsWith(GATE_FAILURE_PREFIX);
}

function emptyEvidence(): ValidityInput {
  return { ctrfBytes: 0, resultLine: "", networkFailureMarker: false };
}

/**
 * Aggregate spend from every attempt that was STARTED — valid, invalid and interrupted
 * alike, resolved per ATTEMPT rather than per ledger row.
 *
 * An attempt whose intent row was never finalized is counted as UNKNOWN, not skipped. It
 * was dispatched, the driver died before it could tally, and skipping it would report a
 * killed mid-attempt run as having complete usage — which then permits further dispatch
 * against a budget the run can no longer account for.
 */
export function aggregateSpend(rows: ReadonlyArray<LedgerRow>): SpendTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  const unknownUsageAttempts: string[] = [];

  const finalByAttempt = new Map<string, LedgerRow>();
  for (const row of rows) {
    if (row.phase !== "intent") finalByAttempt.set(row.attemptId, row);
  }

  const counted = new Set<string>();
  for (const row of rows) {
    if (counted.has(row.attemptId)) continue;
    counted.add(row.attemptId);
    const final = finalByAttempt.get(row.attemptId);
    if (final === undefined) {
      unknownUsageAttempts.push(row.attemptId);
      continue;
    }
    if (final.excluded) continue;
    const usage = final.usage;
    if (usage === null) {
      unknownUsageAttempts.push(row.attemptId);
      continue;
    }
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheCreationInputTokens += usage.cacheCreationInputTokens;
    cacheReadInputTokens += usage.cacheReadInputTokens;
  }
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens:
      inputTokens +
      outputTokens +
      cacheCreationInputTokens +
      cacheReadInputTokens,
    unknownUsageAttempts,
    usageComplete: unknownUsageAttempts.length === 0,
    ledgerUnreadable: null,
  };
}

/** Zero totals with no attempt behind them; the shape an unreadable ledger degrades to. */
const NO_OBSERVED_SPEND: Omit<
  SpendTotals,
  "usageComplete" | "ledgerUnreadable"
> = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalTokens: 0,
  unknownUsageAttempts: [],
};

/**
 * Aggregate spend from a ledger READ, not from a list of rows.
 *
 * The distinction exists because `aggregateSpend([])` is vacuously `usageComplete`: given
 * no rows it cannot find an unknown attempt, so an unreadable ledger would otherwise
 * report "spend known, 0 tokens" and clear the budget for real money. Routing the unreadable
 * case through `usageComplete: false` keeps ONE unknown-usage channel — `ceilingVerdict` is
 * unchanged in kind, it simply halts one step earlier.
 */
export function spendForLedger(read: LedgerReadResult): SpendTotals {
  if (read.kind === "readable") {
    const spend = aggregateSpend(read.rows);
    if (read.tornLines === 0) return spend;
    return {
      ...spend,
      usageComplete: false,
      ledgerIntegrityIssue: {
        kind: "torn-lines",
        tornLines: read.tornLines,
      },
    };
  }
  return {
    ...NO_OBSERVED_SPEND,
    usageComplete: false,
    ledgerUnreadable: read.unreadable,
  };
}

/** A claimed token budget. Separate from `UsageRecord` because it has no cache counters. */
export interface TokenCeiling {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CeilingVerdict {
  readonly reached: boolean;
  /** False whenever any usage is unknown: unknown must not permit further dispatch. */
  readonly mayDispatch: boolean;
  readonly reason: string;
  readonly enforcement: "observed-between-attempts";
  readonly overshootNote: string;
}

/**
 * Decide whether another attempt may be dispatched against a claimed budget.
 *
 * Unknown usage halts: it is not evidence that the budget is intact.
 */
export function ceilingVerdict(
  spend: SpendTotals,
  ceiling: TokenCeiling | null
): CeilingVerdict {
  if (!spend.usageComplete) {
    return {
      reached: true,
      mayDispatch: false,
      reason: unreadableReason(spend),
      enforcement: "observed-between-attempts",
      overshootNote: COUNTING_POLICY.ceilingNote,
    };
  }
  if (ceiling === null) {
    return {
      reached: false,
      mayDispatch: true,
      reason: "no token ceiling configured",
      enforcement: "observed-between-attempts",
      overshootNote: COUNTING_POLICY.ceilingNote,
    };
  }
  const claimed = ceiling.inputTokens + ceiling.outputTokens;
  const over = overage(spend.totalTokens, claimed);
  return {
    reached: spend.totalTokens >= claimed,
    mayDispatch: spend.totalTokens < claimed,
    reason: over,
    enforcement: "observed-between-attempts",
    overshootNote: COUNTING_POLICY.ceilingNote,
  };
}

function overage(observed: number, claimed: number): string {
  return `observed ${observed} of claimed ${claimed} tokens across all four counters`;
}

/**
 * Name why usage is unknown. An unreadable ledger has no attempt ids to count, so saying
 * "unknown usage for 0 attempt(s)" would hide the actual fault behind a reassuring number.
 */
function unreadableReason(spend: SpendTotals): string {
  if (spend.ledgerUnreadable !== null) {
    return (
      `ledger ${spend.ledgerUnreadable.path} is unreadable ` +
      `(${spend.ledgerUnreadable.errno}); usage is unknown, not zero`
    );
  }
  if (spend.ledgerIntegrityIssue !== undefined) {
    return (
      `ledger has ${spend.ledgerIntegrityIssue.tornLines} torn line(s); ` +
      "usage after the readable prefix is unknown, not zero"
    );
  }
  return `unknown usage for ${spend.unknownUsageAttempts.length} attempt(s); unknown is not zero`;
}

/** Every phase a row may carry; exported so reports can state the vocabulary they used. */
export const PHASE_VOCABULARY: ReadonlyArray<AttemptPhase> = [
  "intent",
  "completed",
  "invalid",
  "interrupted",
];
