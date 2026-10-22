/**
 * Shared vocabulary for the agent-qa evaluation capability. Nothing here is
 * Terminal-Bench-specific; nothing here may be inferred from model prose.
 */

import type { CleanupStatus, FailureRef } from "./failures.ts";

export const REPORT_SCHEMA_VERSION = 1;
export const EVALUATOR_VERSION = "agent-qa-v1";

export const CASE_GROUPS = [
  "task",
  "tool",
  "turn",
  "recovery",
  "safety",
] as const;
export type CaseGroup = (typeof CASE_GROUPS)[number];

export const GROUP_SLOT_COUNT: Readonly<Record<CaseGroup, number>> = {
  task: 5,
  tool: 4,
  turn: 4,
  recovery: 3,
  safety: 4,
};

export type CaseId = string;

/**
 * The effect grammar `allowedEffects` / `forbiddenEffects` are written in, as one closed
 * set: a prefix from this list, a colon, and a non-empty subject. Every prefix here has a
 * reader in the oracle-target derivation, and the plan boundary refuses any entry outside
 * the list — an entry nobody parses would otherwise read as a declared effect that no
 * verdict can contradict.
 *
 * The list an entry sits in carries its polarity, so one fact has exactly one spelling:
 * `tool:<name>` in the allowed list is "a dispatch of it is recorded", the same entry in
 * the forbidden list is "no dispatch of it is recorded", and `tool:<name>:succeeded` in the
 * forbidden list is the weaker "recorded, but never applied". There is therefore no
 * `no-tool:` prefix: it named the forbidden list's own polarity in the allowed list, and
 * authors writing the natural form left declarations no reader graded. `EFFECT_POSITIONS`
 * and `EFFECT_SUFFIX_POSITIONS` below are that rule as data.
 */
export const EFFECT_PREFIXES = [
  "bytes:",
  "write:",
  "unchanged:",
  "tool:",
  "denied:",
  "stopped:",
] as const;
export type EffectPrefix = (typeof EFFECT_PREFIXES)[number];

/** Which list a prefix's reader consumes it from. */
export type EffectList = "allowed" | "forbidden";

/**
 * The readable positions, one per prefix, read off `attempt.ts`'s derivations: an entry in
 * any other position states a fact no reader grades, so the plan boundary refuses it.
 * `tool:` is readable in both lists because the list is what carries its polarity.
 */
export const EFFECT_POSITIONS: Readonly<Record<EffectPrefix, readonly EffectList[]>> = {
  "bytes:": ["allowed"],
  "write:": ["forbidden"],
  "unchanged:": ["allowed"],
  "tool:": ["allowed", "forbidden"],
  "denied:": ["allowed"],
  "stopped:": ["allowed"],
};

/**
 * The grammar's one suffix and the prefix whose reader consumes it: `tool:<name>:succeeded`
 * states a dispatch that is recorded but never applied. It is a position in the grammar, not
 * a character in a subject, so it is named here and every reader consumes it from here.
 */
export const EFFECT_RESULT_SUFFIX = ":succeeded";

/**
 * Which prefix reads which suffix, and from which list — `EFFECT_POSITIONS` one level down.
 * `:succeeded` is readable only in the forbidden list: in the allowed list it asks for a
 * dispatch row that no record can ever match, so the plan boundary refuses it there rather
 * than freezing a clause nothing can satisfy. A prefix absent here reads no suffix at all.
 */
export const EFFECT_SUFFIX_POSITIONS: readonly {
  readonly prefix: EffectPrefix;
  readonly suffix: string;
  readonly lists: readonly EffectList[];
}[] = [{ prefix: "tool:", suffix: EFFECT_RESULT_SUFFIX, lists: ["forbidden"] }];

/** A fixture address is `repo-relative/path#fixture-id`, resolved by digest. */
export type FixtureRef = {
  readonly path: string;
  readonly fixtureId: string;
  readonly digest: string;
};

export type OracleKind = (typeof ORACLE_KINDS)[number];

export type OracleDeclaration = {
  readonly oracleId: string;
  readonly kind: OracleKind;
  /** What the oracle reads; never the assistant's own completion text. */
  readonly evidence: string;
  /**
   * The exact `allowedEffects` / `forbiddenEffects` entries this oracle decides, so two
   * oracles of one kind read two different facts instead of both reading the whole list.
   * Omitted means the oracle reads every entry its kind can interpret.
   */
  readonly owns?: readonly string[];
};

export type CaseReference = {
  readonly caseId: CaseId;
  readonly group: CaseGroup;
  readonly fixture: FixtureRef;
  /** Every locked fixture this case cites; `fixture` is locks[0]. */
  readonly fixtureLocks: readonly FixtureRef[];
  readonly oracles: readonly OracleDeclaration[];
  readonly allowedEffects: readonly string[];
  readonly forbiddenEffects: readonly string[];
};

export type CatalogLock = {
  readonly schemaVersion: number;
  readonly evaluator: string;
  readonly cases: readonly CaseReference[];
};

/** Dimension 1 — decided by the case's oracles alone. */
export const TASK_OUTCOMES = ["passed", "failed", "undetermined"] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

/** Dimension 2 — whether the attempt is admissible as measurement. */
export const VALIDITIES = [
  "valid",
  "invalid",
  "interrupted",
  "provider-error",
  "not-run",
  "unknown",
] as const;
export type Validity = (typeof VALIDITIES)[number];

/** Dimension 3 — named required artifacts, not trace losslessness. */
export const EVIDENCE_COVERAGES = [
  "complete",
  "partial",
  "missing",
  "corrupt",
] as const;
export type EvidenceCoverage = (typeof EVIDENCE_COVERAGES)[number];

export const POSTURES = ["sandboxed", "eval-state", "scripted-offline"] as const;
export type ExecutionPosture = (typeof POSTURES)[number];

/** How far the attempt lifecycle itself got. */
export const ATTEMPT_PHASES = [
  "intent",
  "dispatched",
  "settled",
  "abandoned",
] as const;
export type AttemptPhase = (typeof ATTEMPT_PHASES)[number];

export const ORACLE_STATUSES = ["satisfied", "violated", "unreadable"] as const;
export type OracleStatus = (typeof ORACLE_STATUSES)[number];

export const ORACLE_KINDS = [
  "workspace-bytes",
  "acceptance-run",
  "effect-record",
  "permission-record",
] as const;

/** Dimension 4 — posture and each declared limit against what applied. */
export type Posture = ExecutionPosture;

export type LimitName = "maxTurns" | "wallMs" | "inputTokens" | "outputTokens";

/** Every limit a budget can freeze, in the order the budget digest serializes them. */
export const LIMIT_NAMES: readonly LimitName[] = [
  "maxTurns",
  "wallMs",
  "inputTokens",
  "outputTokens",
];

export type LimitState = {
  readonly name: LimitName;
  readonly declared: number | null;
  readonly applied: boolean;
  readonly observed: number | null;
  readonly overrun: boolean;
};

/**
 * What one attempt cost. `null` means unobserved, which is never the same fact as a
 * measured zero.
 *
 * The token counts are the attempt's totals over every model call it retained, not the
 * last call's reading: a run of three calls that each cost 11 input tokens costs 33, and
 * a number that belongs to one call cannot answer a question about the attempt. A call
 * that stated no usage — an error row omits the keys — therefore makes the total unknown
 * rather than partially known.
 */
export type UsageRecord = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly wallMs: number | null;
  readonly usageComplete: boolean;
};

export type OracleResult = {
  readonly oracleId: string;
  readonly kind: OracleKind;
  readonly status: OracleStatus;
  readonly evidenceRef: string;
  readonly digest: string;
};

export type AttemptRecord = {
  readonly schemaVersion: number;
  readonly attemptId: string;
  readonly runId: string;
  readonly caseId: CaseId;
  readonly fixtureDigest: string;
  readonly startedAtEpochMs: number | null;
  readonly settledAtEpochMs: number | null;
  readonly phase: AttemptPhase;
  readonly outcome: TaskOutcome;
  readonly validity: Validity;
  readonly coverage: EvidenceCoverage;
  readonly posture: Posture;
  readonly limits: readonly LimitState[];
  readonly usage: UsageRecord;
  readonly oracles: readonly OracleResult[];
  readonly traceRef: string | null;
  readonly failure: FailureRef | null;
  readonly cleanup: {
    readonly status: CleanupStatus;
    readonly owned: readonly string[];
  };
};

export type PlannedAttempt = {
  readonly attemptId: string;
  readonly caseId: CaseId;
  /** The frozen decision not to dispatch this slot; `null` means the plan means to run it. */
  readonly notRun: NotRunReason | null;
};

export type Budget = {
  readonly maxTurns: number;
  readonly wallMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
};

export type RunPlan = {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly evaluator: string;
  readonly modelRoute: string;
  readonly promptDigest: string;
  readonly toolDigest: string;
  readonly sourceDigest: string;
  readonly dataIdentity: string;
  readonly environmentIdentity: string;
  readonly posture: Posture;
  readonly budget: Budget;
  readonly cases: readonly CaseReference[];
  readonly attempts: readonly PlannedAttempt[];
  readonly frozenBeforeAnyOutcome: true;
};

export type IdentityField =
  | "evaluator"
  | "source"
  | "model"
  | "prompt"
  | "tool"
  | "data"
  | "environment"
  | "posture"
  | "budget";

/** The union's own list, so a reader of identities never re-spells the field set. */
export const IDENTITY_FIELDS: readonly IdentityField[] = [
  "evaluator",
  "source",
  "model",
  "prompt",
  "tool",
  "data",
  "environment",
  "posture",
  "budget",
];

export type TreatmentFactor = "source" | "model" | "prompt" | "tool";

/**
 * The identity fields a treatment factor may change, derived fields included:
 * prompt and tool surfaces are assembled from source, so a source arm is
 * expected to move their digests. Every other field must match.
 */
export const PERMITTED_IDENTITY_DIFF: Readonly<
  Record<TreatmentFactor, readonly IdentityField[]>
> = {
  source: ["source", "prompt", "tool"],
  model: ["model"],
  prompt: ["prompt"],
  tool: ["tool"],
};

export type AttemptReport = {
  readonly attemptId: string;
  readonly caseId: CaseId;
  readonly fixtureDigest: string;
  readonly outcome: TaskOutcome;
  readonly validity: Validity;
  readonly coverage: EvidenceCoverage;
  readonly posture: Posture;
  readonly limits: readonly LimitState[];
  readonly usage: UsageRecord;
  readonly traceRef: string | null;
  readonly oracleRefs: readonly string[];
};

export type ReportCounts = {
  readonly planned: number;
  readonly executed: number;
  readonly valid: number;
  readonly passed: number;
  readonly interrupted: number;
  readonly providerErrors: number;
  readonly invalid: number;
  readonly notRun: number;
  readonly unknown: number;
};

/** The six roster states a reviewer must be able to tell apart. */
export const ROSTER_STATES = [
  "executed",
  "partial",
  "missing",
  "skipped",
  "credential-blocked",
  "other-not-run",
] as const;
export type RosterState = (typeof ROSTER_STATES)[number];

/**
 * Why a run froze a slot not to dispatch. A decision taken before any outcome is
 * observed, so it belongs to the plan and is never a fault kind: a slot nobody
 * dispatched has no fault to attribute.
 */
export const NOT_RUN_REASONS = ["skipped", "credential-blocked"] as const;
export type NotRunReason = (typeof NOT_RUN_REASONS)[number];

export type AgentQaReport = {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly identities: Record<IdentityField, string>;
  readonly counts: ReportCounts;
  /** Undefined when no attempt was valid; a report cannot be green then. */
  readonly conditionalScore: number | null;
  readonly measurementCoverage: number;
  readonly fullCatalogCoverage: boolean;
  /** False whenever any planned attempt is missing, skipped, or not run. */
  readonly measurementComplete: boolean;
  readonly usageTotals: UsageRecord;
  readonly cleanupUnconfirmed: readonly string[];
  readonly roster: Readonly<Record<RosterState, readonly string[]>>;
  readonly attempts: readonly AttemptReport[];
  readonly mayClaimCapability: false;
};

export type CaseTransition = {
  readonly caseId: CaseId;
  readonly baseline: TaskOutcome;
  readonly candidate: TaskOutcome;
};

export type Comparison = {
  readonly schemaVersion: number;
  readonly treatmentFactor: TreatmentFactor;
  readonly baselineRunId: string;
  readonly candidateRunId: string;
  readonly transitions: readonly CaseTransition[];
  readonly countsDelta: ReportCounts;
  readonly statisticallyEstablished: false;
};

export type CompareInput = {
  readonly root: string;
  readonly baselineRunId: string;
  readonly candidateRunId: string;
  readonly treatmentFactor: TreatmentFactor;
  readonly allowedDiff?: readonly IdentityField[];
  /**
   * Where the candidate's retained report lives. Every evaluation gets its own
   * artifact root, so a two-arm read normally crosses two roots; the comparison
   * itself is still written under `root`.
   */
  readonly candidateRoot?: string;
};

/** The wire body a scripted provider serves; one entry per model step. */
export type ScriptedStep =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    };

/**
 * One catalog slot. The trajectory lives with the evaluation capability because
 * the behavior under test is a whole Agent run; `locks` points at the
 * behavior-local fixture whose digest must not drift unnoticed.
 */
export type AgentQaCase = {
  readonly caseId: CaseId;
  readonly group: CaseGroup;
  readonly title: string;
  readonly locks: readonly {
    readonly path: string;
    readonly fixtureId: string;
  }[];
  readonly seed: readonly {
    readonly path: string;
    readonly contents: string;
    readonly mode?: "mkdir";
  }[];
  readonly turns: readonly string[];
  readonly scripted: readonly ScriptedStep[];
  readonly allowedEffects: readonly string[];
  readonly forbiddenEffects: readonly string[];
  readonly oracles: readonly OracleDeclaration[];
  /** Executed by the oracle, never by the runner, and never by the model. */
  readonly acceptance?: {
    readonly command: string;
    readonly expectExit: number;
  };
};

export const RUN_PLAN_FILE = "run-plan.json";
export const CATALOG_LOCK_FILE = "catalog-lock.json";
export const ATTEMPTS_DIR = "attempts";
export const REPORTS_DIR = "reports";
export const COMPARISONS_DIR = "comparisons";
export const CLAIM_FILE = ".claim";
export const ATTEMPT_FILE = "attempt.json";
export const INTENT_FILE = "intent.json";
export const DISPATCH_FILE = "dispatch.json";
export const USAGE_FILE = "usage.json";
export const TRACE_DIR = "trace";
export const OUTCOME_FILE = "outcome.json";
export const ORACLES_DIR = "oracles";
export const HASH_INDEX_FILE = "hash-index.json";

/**
 * The two formats the package's identifiers are written in, shared because a value
 * that crosses a module boundary has to be accepted by every reader of it: a digest
 * produced by one writer must pass the next reader's check or the artifact is refused
 * as corrupt. A token is also a file-name segment, so it may carry no separator and
 * no climbing segment.
 */
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/** The named required artifacts. Coverage is about these, never about trace losslessness. */
export const REQUIRED_ARTIFACTS: readonly string[] = Object.freeze([
  INTENT_FILE,
  DISPATCH_FILE,
  OUTCOME_FILE,
  USAGE_FILE,
  ATTEMPT_FILE,
]);
