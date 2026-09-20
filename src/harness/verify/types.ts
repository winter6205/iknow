/**
 * verify bounded context — shared type contracts for the failure
 * auto-correction loop. Naming and field semantics were finalized in the
 * original spec's glossary and decision log.
 */

/** Three-state round verdict. unstable = suite-wide failure passes when re-run alone (interference). */
export type Verdict = "pass" | "true-failure" | "unstable";

/**
 * One evidence item from the classifier judge subagent (used when no verify
 * command is configured). A check without a command counts as skip, not pass.
 */
export interface ClassifierCheck {
  readonly command: string;
  readonly output?: string;
  readonly result: "pass" | "fail";
}

/**
 * Classifier result union (4 states):
 *  - pass: judge considers the task done (must carry non-empty evidence);
 *  - fail: task not done; `missing` lists what is absent (consumed by the
 *    failure envelope);
 *  - abort: judge ran but cannot decide — transport / schema errors and the
 *    pass-with-empty-evidence downgrade all map here ("judge can't tell", not
 *    a task failure);
 *  - unverified: judge read the evidence, found it insufficient, and refuses
 *    to guess pass/fail — the judge's honest stop, strictly distinguished
 *    from abort (its own failure). `reason` required non-empty; `evidence`
 *    optional (no commands may have been run); consumers map it directly to
 *    the unstable stop with no envelope injection.
 *
 * Downgrade rule: `{kind:"pass", evidence:[]}` is silently rewritten to
 * abort by parseClassifierResult (reason prefixed with the missing-evidence
 * note); the judge prompt explicitly forbids that shape.
 */
export type ClassifierResult =
  | {
      readonly kind: "pass";
      readonly reason: string;
      readonly evidence: readonly ClassifierCheck[];
    }
  | {
      readonly kind: "fail";
      readonly reason: string;
      readonly missing: readonly string[];
      readonly evidence: readonly ClassifierCheck[];
    }
  | { readonly kind: "abort"; readonly reason: string }
  | { readonly kind: "unverified"; readonly reason: string };

/** Confirmation-ladder result (confirmFailure). flaky = full rerun passed, let it through without correction. */
export type ConfirmationVerdict = "flaky" | "unstable" | "true-failure";

/**
 * Trend verdict (evaluateTrend).
 * oscillation-tolerant = single-round regression without two consecutive rounds; allowed once.
 */
export type TrendVerdict =
  "progress" | "stuck" | "regression" | "oscillation-tolerant";

/** Recommended loop action from the trend verdict. */
export type TrendAction = "continue" | "stop";

/**
 * Parsed settings.verify section — the single carrier for verify config.
 *
 // (ADR-0015)
 * `command` must be present to enable the loop; other fields carry defaults
 * applied at the settings layer.
 */
export interface VerifyConfig {
  readonly command: string;
  /** Single-rerun template for failed cases, {files} placeholder; unset skips ladder level 2. */
  readonly rerunTemplate?: string;
  /** Failure-count override (regex, first capture group); takes priority over built-in line detection. */
  readonly countRegex?: string;
  /** Verify command timeout in seconds (default 600); timeout counts as unstable, not true failure. */
  readonly timeoutSec?: number;
  /** Exhaustion handling, default report (stop + honest report). */
  readonly onExhausted?: "report" | "escalate";
  /** Hard round cap, default 12; the judge is the trend, not the counter. */
  readonly maxRounds?: number;
  /**
   * Model slot for the classifier judge (used when command is absent).
   * Explicit value wins; defaults resolve to settings.llm.model.
   *
   // (ADR-0015)
   * Non-empty string only; no model IDs hardcoded in code.
   */
  readonly classifierModel?: string;
}

/**
 * Per-round record written to TraceService.
 * action expresses the loop disposition; finalOutcome is set only on the final round.
 */
export interface VerificationRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly round: number;
  readonly verdict: Verdict;
  readonly exitCode: number;
  readonly failedCount?: number;
  readonly signature?: string;
  readonly action: "continue" | "stop" | "escalate";
  readonly finalOutcome?: string;
  readonly ts: string;
  /**
   * Classifier-branch fields, filled by the judge when command is absent:
   *  - reason — the judge's one-line rationale (all states);
   *  - evidence — what the judge ran and saw (non-empty for pass/fail;
   *    abort has none);
   *  - missing — unfinished items listed on fail (absent for pass/abort).
   * Postel: optional keys are persisted only when present (JSON.stringify
   * drops undefined). Command-path records stay byte-identical without them.
   */
  readonly reason?: string;
  readonly evidence?: readonly ClassifierCheck[];
  readonly missing?: readonly string[];
  /**
   * Evidence-first pre-stage fields:
   *  - evidenceVerdict — checkEvidence's three-state verdict (persisted on
   *    INSUFFICIENT rounds);
   *  - gamingSignals — soft signals (fewer assertions / new skips / --no-verify),
   *    recorded only, never judged.
   * Postel: persisted only when present; command-path records unchanged.
   */
  readonly evidenceVerdict?: EvidenceVerdict;
  readonly gamingSignals?: ReadonlyArray<string>;
}

/**
 * Discriminated reason constants for typed persistence (unverified ≠ abort);
 * the field itself stays string to avoid touching existing parse paths.
 */
export const REASON_UNVERIFIED = "unverified" as const;
export const REASON_ABORT_TYPED = "abort" as const;
/** HITL: skip completion-facing LLM judge. Not a StopReason. */
export const REASON_HITL_SKIP_COMPLETION_JUDGE =
  "hitl_skip_completion_judge" as const;

/**
 * Reason discriminator: classifier = judge's one-line rationale;
 * unverified / abort = the two distinct stop kinds;
 * hitl_skip_completion_judge = named EXIT for normal HITL mode.
 *
 // (ADR-0024)
 */
export type VerifyReasonKind =
  "classifier" | "unverified" | "abort" | "hitl_skip_completion_judge";

/**
 * Evidence-sufficiency verdict from the deterministic evidence checker.
 * Different domain from the round Verdict above: this is the evidence-first
 * pre-stage over real execution evidence in the main transcript; callers
 * consume the verdict only, never count conditions themselves.
 */
export type EvidenceVerdict =
  "EVIDENCE_SUFFICIENT" | "EVIDENCE_CONTRADICTED" | "EVIDENCE_INSUFFICIENT";

/**
 * Extracted evidence for one bash test execution.
 * messageIndex = index into messages, the ordering anchor for staleness
 * (trust only the session's own tool-call order — no mtime/diff/git).
 */
export interface TestRunEvidence {
  /** Index into the messages array (ordering anchor). */
  readonly messageIndex: number;
  /** bash tool_use input.command. */
  readonly command: string;
  /** Structured JSON {code} from tool_result; null on is_error or missing code. */
  readonly exitCode: number | null;
  /** Whitelisted framework (numbers read only from summary lines, never from arbitrary output). */
  readonly framework: "pytest" | "jest" | "vitest" | "go" | "cargo" | null;
  /** stdout contains a whitelisted green summary line. */
  readonly greenSummary: boolean;
  /** Weak green: 0 tests / collected 0 / no tests found / narrow run. */
  readonly weakGreen: boolean;
  /** Failure swallowed: || true / || exit 0 / ; exit 0 / --passWithNoTests. */
  readonly swallowed: boolean;
}

/**
 * checkEvidence output. reasons feed the rerun envelope and evidenceContext;
 * gamingSignals are recorded only, never judged.
 */
export interface EvidenceReport {
  readonly verdict: EvidenceVerdict;
  readonly reasons: ReadonlyArray<string>;
  readonly runs: ReadonlyArray<TestRunEvidence>;
  /** Soft signals (fewer assertions / new skips / --no-verify); recorded only, never change verdict. */
  readonly gamingSignals: ReadonlyArray<string>;
  /** Code edited after the green evidence (STALE semantics). */
  readonly stale: boolean;
}

/**
 * Evidence report card attached to judge input: the judge upgrades from
 * task-only to task + evidenceContext. Task formula stays unchanged;
 * evidenceContext = checker verdict + insufficiency reasons + executed test
 * commands + rerun attempt + host-truncated evidence summary. Fields:
 *   - checkerVerdict — checkEvidence's three states;
 *   - reasons — insufficiency / contradiction reasons (same source as the
 *     rerun envelope's Missing section);
 *   - executedCommands — bash test commands run (report.runs commands);
 *   - rerunAttempted — whether a rerun was triggered before this round
 *     (derived by scanning messages for the [VERIFY: rerun needed] prefix);
 *   - evidenceSummary — one line per run (command + exit + green), truncated
 *     via truncateExcerpt.
 */
export interface EvidenceContext {
  readonly checkerVerdict: EvidenceVerdict;
  readonly reasons: ReadonlyArray<string>;
  readonly executedCommands: ReadonlyArray<string>;
  readonly rerunAttempted: boolean;
  readonly evidenceSummary: string;
}
