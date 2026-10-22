/**
 * Read-only comparison of two persisted reports, and of the identities they froze.
 *
 * The inputs are the retained report artifacts and nothing else: no plan is re-read,
 * no attempt is re-run, no provider is reached. A comparison is therefore only as
 * good as the identities the two reports carry, which is exactly why a drift in any
 * frozen identity refuses the comparison instead of being footnoted inside it.
 *
 * One treatment factor may be in play. `PERMITTED_IDENTITY_DIFF` is the SSOT for what
 * that factor is expected to move, derived identities included, so a source arm is
 * allowed to move the prompt and tool digests while a model arm is not.
 *
 * The fixture each attempt ran against is compared per case as well. No identity field
 * carries a fixture digest, so an arm that measured different bytes would otherwise pass
 * every identity rule and still answer a different question.
 *
 * A refused comparison is always an `IncomparableFailure` naming the rule it broke.
 * Silence is not an option here: two arms that differ by more than the named treatment
 * cannot be told apart from a version that fixed something, and that confusion is the
 * exact failure this capability exists to prevent.
 */
import { join, isAbsolute } from "node:path";

import { makeDir, readJsonArtifact, writeJsonOnce } from "./artifacts.ts";
import { IncomparableFailure, InvalidInputFailure } from "./failures.ts";
import {
  COMPARISONS_DIR,
  IDENTITY_FIELDS,
  PERMITTED_IDENTITY_DIFF,
  REPORTS_DIR,
  REPORT_SCHEMA_VERSION,
  TOKEN_PATTERN,
  type AgentQaReport,
  type AttemptReport,
  type CaseId,
  type CaseTransition,
  type CompareInput,
  type Comparison,
  type IdentityField,
  type ReportCounts,
  type TaskOutcome,
  type TreatmentFactor,
} from "./types.ts";

const COUNT_FIELDS: readonly (keyof ReportCounts)[] = [
  "planned",
  "executed",
  "valid",
  "passed",
  "interrupted",
  "providerErrors",
  "invalid",
  "notRun",
  "unknown",
];

/**
 * Identities the protocol freezes for every arm. A treatment factor may never move
 * these, so each one gets its own refusal rather than a shared "identity mismatch":
 * the reviewer has to see which invariant broke.
 */
const ARM_INVARIANTS: readonly (readonly [IdentityField, string])[] = [
  ["evaluator", "the evaluator version moved"],
  ["data", "the data identity moved"],
  ["environment", "the environment identity moved"],
  ["posture", "the execution posture moved"],
  ["budget", "the numeric budget identity moved"],
];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeRunId(runId: string): void {
  if (!TOKEN_PATTERN.test(runId)) {
    // EXIT: a run id that is not a bounded token could escape the artifact directories as a path segment; nothing is read or written; dispatch may not continue.
    throw new InvalidInputFailure(
      `run id ${runId} is not a bounded identifier token`,
      "compare"
    );
  }
}

function reportPath(root: string, runId: string): string {
  assertSafeRunId(runId);
  return join(root, REPORTS_DIR, `${runId}.report.json`);
}

function refusal(diagnostic: string): IncomparableFailure {
  return new IncomparableFailure(diagnostic);
}

function assertAttemptEntry(entry: unknown, index: number): void {
  if (!isRecord(entry)) {
    // EXIT: attempt ${index} of a persisted report is not a document, so the report is not this tool's; dispatch may not continue.
    throw refusal(`persisted report attempt ${index} is not an object`);
  }
  const required = [
    "attemptId",
    "caseId",
    "fixtureDigest",
    "outcome",
    "validity",
    "coverage",
    "posture",
  ];
  const missing = required.filter((field) => typeof entry[field] !== "string");
  if (missing.length > 0) {
    // EXIT: an attempt entry that does not state its four dimensions and its fixture cannot be placed on either side of a transition; dispatch may not continue.
    throw refusal(
      `persisted report attempt ${index} is missing dimension(s): ${missing.sort().join(", ")}`
    );
  }
}

/** A persisted report is an untrusted document on disk: it is shape-checked before use. */
function assertReportShape(record: UnknownRecord, runId: string): void {
  if (record.schemaVersion !== REPORT_SCHEMA_VERSION) {
    // EXIT: report ${runId} is written by another schema, so its fields would mean something else; dispatch may not continue.
    throw refusal(
      `report ${runId} is schema ${String(record.schemaVersion)}, expected ${REPORT_SCHEMA_VERSION}`
    );
  }
  if (record.mayClaimCapability !== false) {
    // EXIT: a report that claims capability is not offline tooling evidence and cannot be an arm; dispatch may not continue.
    throw refusal(`report ${runId} does not hold mayClaimCapability false`);
  }
  const identities = record.identities;
  const counts = record.counts;
  if (!isRecord(identities) || !isRecord(counts)) {
    // EXIT: report ${runId} carries no identity or counts block, so eligibility could not be decided; dispatch may not continue.
    throw refusal(`report ${runId} holds no identities or counts block`);
  }
  for (const field of IDENTITY_FIELDS) {
    if (typeof identities[field] !== "string") {
      // EXIT: identity ${field} is unstated, and an unstated identity cannot be matched; dispatch may not continue.
      throw refusal(`report ${runId} does not state identity ${field}`);
    }
  }
  const missingCounts = COUNT_FIELDS.filter(
    (field) => typeof counts[field] !== "number"
  );
  if (missingCounts.length > 0) {
    // EXIT: counts are missing, so no delta could be stated; dispatch may not continue.
    throw refusal(
      `report ${runId} is missing count(s): ${missingCounts.join(", ")}`
    );
  }
  if (!Array.isArray(record.attempts)) {
    // EXIT: report ${runId} holds no attempt list, so no per-case transition could be read; dispatch may not continue.
    throw refusal(`report ${runId} holds no attempts array`);
  }
  record.attempts.forEach(assertAttemptEntry);
}

/**
 * Which root each arm's report is read from. `root` is the root the operator points at
 * and the root the comparison is retained under; the candidate normally lives in the root
 * its own run froze, because every evaluation gets its own artifact root. Reading across
 * two roots is therefore the ordinary case, and it is what spares a reviewer from copying
 * retained bytes between them.
 */
export function armRoots(input: CompareInput): {
  readonly baselineRoot: string;
  readonly candidateRoot: string;
} {
  const candidateRoot = input.candidateRoot ?? input.root;
  if (!isAbsolute(candidateRoot)) {
    // EXIT: a relative candidate root names no retained bytes, so no arm could be read; nothing is compared and nothing is retained.
    throw new InvalidInputFailure(
      `candidate root ${candidateRoot} is not an absolute path`,
      "compare"
    );
  }
  return { baselineRoot: input.root, candidateRoot };
}

/** The reader the CLI's exit-code gate shares with the comparison itself. */
export function readPersistedReport(
  root: string,
  runId: string
): AgentQaReport {
  const { value } = readJsonArtifact(reportPath(root, runId));
  if (!isRecord(value)) {
    // EXIT: the retained report is not a document; dispatch may not continue.
    throw refusal(`report ${runId} is not an object`);
  }
  assertReportShape(value, runId);
  return value as unknown as AgentQaReport;
}

function diffFields(
  baseline: AgentQaReport,
  candidate: AgentQaReport
): IdentityField[] {
  return IDENTITY_FIELDS.filter(
    (field) => baseline.identities[field] !== candidate.identities[field]
  );
}

/** Which treatment factors could account for the whole observed difference set? */
function explainingFactors(diff: readonly IdentityField[]): TreatmentFactor[] {
  return (Object.keys(PERMITTED_IDENTITY_DIFF) as TreatmentFactor[]).filter(
    (factor) => {
      const permitted = PERMITTED_IDENTITY_DIFF[factor] as readonly string[];
      return diff.every((field) => permitted.includes(field));
    }
  );
}

function assertFrozenAllowedSet(
  factor: TreatmentFactor,
  allowedDiff: readonly IdentityField[] | undefined
): void {
  if (allowedDiff === undefined) return;
  const permitted = PERMITTED_IDENTITY_DIFF[factor];
  const excess = allowedDiff.filter((field) => !permitted.includes(field));
  if (excess.length > 0) {
    // EXIT: the protocol declared a difference set the named factor cannot cause, so the arms were never frozen comparably; dispatch may not continue.
    throw refusal(
      `allowed identity difference set for treatment ${factor} exceeds the permitted fields: ${[...new Set(excess)].sort().join(", ")}`
    );
  }
}

/**
 * The declared treatment is checked first because it is the reviewer's own claim: a field it
 * cannot move makes the arms incomparable whatever any other factor might explain. The superset
 * rule then wins over the no-single-factor rule, and both over the plain non-permitted field, so
 * each of the three rules keeps a diagnostic a test can pin.
 */
function assertExplainedByFactor(
  factor: TreatmentFactor,
  diff: readonly IdentityField[]
): void {
  const permitted = PERMITTED_IDENTITY_DIFF[factor];
  if (diff.every((field) => permitted.includes(field))) return;
  if (
    permitted.every((field) => diff.includes(field)) &&
    diff.length > permitted.length
  ) {
    // EXIT: the observed difference set is a strict superset of what ${factor} may cause, so the candidate arm moved more than the treatment; dispatch may not continue.
    throw refusal(
      `identity difference set is a superset of the fields permitted for treatment ${factor}: ` +
        diff.slice().sort().join(", ")
    );
  }
  if (explainingFactors(diff).length === 0) {
    // EXIT: the arms moved in fields no single treatment can produce together, so more than one factor is in play; dispatch may not continue.
    throw refusal(
      `more than one treatment factor is in play: ${diff.slice().sort().join(", ")} ` +
        `cannot be caused by any single treatment`
    );
  }
  const offenders = diff.filter((field) => !permitted.includes(field)).sort();
  // EXIT: an identity the named treatment cannot move differs between the arms; dispatch may not continue.
  throw refusal(
    `identity field ${offenders.join(", ")} differs but treatment ${factor} permits only ` +
      permitted.slice().sort().join(", ")
  );
}

/** The eligibility rules for comparing two runs, each with its own refusal message. */
function assertEligible(
  baseline: AgentQaReport,
  candidate: AgentQaReport,
  factor: TreatmentFactor,
  allowedDiff: readonly IdentityField[] | undefined
): void {
  if (baseline.runId === candidate.runId) {
    // EXIT: an arm cannot be compared with itself, which would report zero movement as a result; dispatch may not continue.
    throw refusal(
      `both arms are run ${baseline.runId}; a comparison needs two distinct arms`
    );
  }
  for (const [field, message] of ARM_INVARIANTS) {
    if (baseline.identities[field] !== candidate.identities[field]) {
      // EXIT: ${message}, which every arm of this protocol freezes; dispatch may not continue.
      throw refusal(
        `${baseline.runId} vs ${candidate.runId}: ${message} (${field} identity)`
      );
    }
  }
  assertSameRoster(baseline, candidate);
  assertSameFixtures(baseline, candidate);
  assertFrozenAllowedSet(factor, allowedDiff);
  const diff = diffFields(baseline, candidate);
  if (allowedDiff !== undefined) {
    const undeclared = diff
      .filter((field) => !allowedDiff.includes(field))
      .sort();
    if (undeclared.length > 0) {
      // EXIT: the arms differ in a field the frozen protocol never declared as allowed; dispatch may not continue.
      throw refusal(
        `identity difference not in the frozen allowed set: ${undeclared.join(", ")}`
      );
    }
  }
  assertExplainedByFactor(factor, diff);
}

/**
 * Two runs are comparable only when their case sets match, and the persisted report is
 * where the case set is stated: it carries the case ids, the planned attempts per case,
 * and the fixture digest each attempt ran against, so all three are compared here — a
 * fixture that moved while the case ids and the planned counts stayed identical is
 * exactly the drift that must not read as comparable.
 */
function assertSameRoster(
  baseline: AgentQaReport,
  candidate: AgentQaReport
): void {
  const plannedOf = (report: AgentQaReport): Map<CaseId, number> => {
    const counts = new Map<CaseId, number>();
    for (const attempt of report.attempts) {
      counts.set(attempt.caseId, (counts.get(attempt.caseId) ?? 0) + 1);
    }
    return counts;
  };
  const before = plannedOf(baseline);
  const after = plannedOf(candidate);
  const drifted = [...new Set([...before.keys(), ...after.keys()])].filter(
    (caseId) => before.get(caseId) !== after.get(caseId)
  );
  if (drifted.length > 0) {
    // EXIT: the two arms do not plan the same cases the same number of times, so aggregate scores would divide by different denominators; dispatch may not continue.
    throw refusal(
      `case roster differs between ${baseline.runId} and ${candidate.runId}: ${drifted.sort().join(", ")}`
    );
  }
}

function fixtureDigestsOf(report: AgentQaReport): Map<CaseId, string[]> {
  const digests = new Map<CaseId, string[]>();
  for (const attempt of report.attempts) {
    digests.set(attempt.caseId, [
      ...(digests.get(attempt.caseId) ?? []),
      attempt.fixtureDigest,
    ]);
  }
  for (const [caseId, list] of digests) digests.set(caseId, [...list].sort());
  return digests;
}

/**
 * The fixture is part of what an arm measured. `assertSameRoster` keeps the case ids and
 * the planned counts equal, and no identity field carries a fixture digest, so without
 * this check two arms that ran different bytes would compare clean.
 */
function assertSameFixtures(
  baseline: AgentQaReport,
  candidate: AgentQaReport
): void {
  const before = fixtureDigestsOf(baseline);
  const after = fixtureDigestsOf(candidate);
  for (const caseId of [...before.keys()].sort()) {
    const left = (before.get(caseId) ?? []).join(",");
    const right = (after.get(caseId) ?? []).join(",");
    if (left === right) continue;
    // EXIT: case ${caseId} ran against different fixture bytes in the two arms, so any difference could be the fixture rather than the treatment; dispatch may not continue.
    throw refusal(
      `fixture digest differs for ${caseId} between ${baseline.runId} and ${candidate.runId}: ` +
        `${left} vs ${right}`
    );
  }
}

function caseOutcome(attempts: readonly AttemptReport[]): TaskOutcome {
  const admissible = attempts.filter(
    (attempt) => attempt.validity === "valid" && attempt.coverage === "complete"
  );
  // An arm that produced no admissible measurement states nothing, so it states `undetermined`.
  if (admissible.length === 0) return "undetermined";
  if (admissible.some((attempt) => attempt.outcome === "failed"))
    return "failed";
  // A pass is only claimable when every planned attempt of that case in that arm is admissible
  // and passed, so a short arm can never read as an improvement over a complete one.
  return admissible.length === attempts.length &&
    admissible.every((attempt) => attempt.outcome === "passed")
    ? "passed"
    : "undetermined";
}

function attemptsByCase(
  report: AgentQaReport
): Map<CaseId, readonly AttemptReport[]> {
  const grouped = new Map<CaseId, readonly AttemptReport[]>();
  for (const attempt of report.attempts) {
    grouped.set(attempt.caseId, [
      ...(grouped.get(attempt.caseId) ?? []),
      attempt,
    ]);
  }
  return grouped;
}

function transitionsOf(
  baseline: AgentQaReport,
  candidate: AgentQaReport
): CaseTransition[] {
  const before = attemptsByCase(baseline);
  const after = attemptsByCase(candidate);
  const transitions: CaseTransition[] = [];
  for (const caseId of [...before.keys()].sort()) {
    transitions.push({
      caseId,
      baseline: caseOutcome(before.get(caseId) ?? []),
      candidate: caseOutcome(after.get(caseId) ?? []),
    });
  }
  return transitions;
}

/**
 * `ReportCounts` is readonly in the frozen type, so the delta accumulates in a mutable
 * mirror of it and is handed over once every field is filled.
 */
type MutableCounts = Record<keyof ReportCounts, number>;

function deltaOf(
  baseline: AgentQaReport,
  candidate: AgentQaReport
): ReportCounts {
  const delta = {} as MutableCounts;
  for (const field of COUNT_FIELDS)
    delta[field] = candidate.counts[field] - baseline.counts[field];
  return delta;
}

/** Where a retained comparison lives, so an operator is pointed at bytes, not a description. */
export function comparisonPath(root: string, comparison: Comparison): string {
  assertSafeRunId(comparison.baselineRunId);
  assertSafeRunId(comparison.candidateRunId);
  return join(
    root,
    COMPARISONS_DIR,
    `${comparison.baselineRunId}__vs__${comparison.candidateRunId}.json`
  );
}

/**
 * Compare two persisted reports and freeze the result. Differences are reported as
 * transitions and count deltas only: `statisticallyEstablished` is false in the type and
 * stays false, because a difference between two offline arms is not an established gain.
 *
 * The input is one object rather than five positional parameters: the caller names which
 * arm is which, so a swapped baseline cannot be silently accepted.
 */
export function compareReports(input: CompareInput): Comparison {
  const { root, baselineRunId, candidateRunId, treatmentFactor, allowedDiff } =
    input;
  const roots = armRoots(input);
  const baseline = readPersistedReport(roots.baselineRoot, baselineRunId);
  const candidate = readPersistedReport(roots.candidateRoot, candidateRunId);
  assertEligible(baseline, candidate, treatmentFactor, allowedDiff);
  const comparison: Comparison = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    treatmentFactor,
    baselineRunId,
    candidateRunId,
    transitions: transitionsOf(baseline, candidate),
    countsDelta: deltaOf(baseline, candidate),
    statisticallyEstablished: false,
  };
  persistComparison(root, comparison);
  return Object.freeze(comparison);
}

function persistComparison(root: string, comparison: Comparison): void {
  makeDir(join(root, COMPARISONS_DIR), "artifact-write");
  // The comparison is a derived artifact, but it is still write-once: two reviewers must not
  // end up holding different bytes for the same pair of arms, and a refused second call
  // (kind artifact-write, owned by writeJsonOnce) leaves the first result untouched.
  writeJsonOnce(comparisonPath(root, comparison), comparison);
}
