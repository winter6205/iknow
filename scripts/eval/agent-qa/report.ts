/**
 * Read-only report reconstruction for the agent-qa capability.
 *
 * Everything here is derived from retained artifacts: the frozen plan, the catalog
 * lock and the attempt records. The module holds no dispatch seam — it cannot reach a
 * provider, start a process, or re-run an attempt — so a report can be rebuilt by a
 * reviewer who has no credentials at all.
 *
 * Two house rules this file inherits from the existing evaluation capability:
 *  - an `unknown` stays `unknown`. A null usage counter is a different fact from a
 *    measured zero, and collapsing them is how "we could not look" becomes a number.
 *  - the denominator is frozen before the run. `planned` comes from the plan alone,
 *    so no outcome can shrink it, and every planned attempt is retained in the report
 *    even when nothing was ever dispatched for it.
 *
 * Four dimensions are emitted per attempt and never merged: outcome, validity,
 * coverage, posture with its declared limits. Each is copied from the stored record,
 * because the only acceptable source for a dimension is the artifact that recorded it.
 *
 * Three run-level states are kept apart for the same reason: `measurementComplete` (did
 * every planned attempt actually yield measurement), `usageTotals` (aggregate usage, null
 * wherever a member is unknown) and `cleanupUnconfirmed` (which attempts left cleanup
 * unproven). None of them may be inferred from the score, from `passed`, or from coverage.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { makeDir, readJsonArtifact, writeJsonOnce } from "./artifacts.ts";
import { isFullCoverage, reconcileRoster } from "./catalog.ts";
import {
  ArtifactFailure,
  CLEANUP_STATUSES,
  EvalFailure,
  FAILURE_KINDS,
  FAILURE_PHASES,
  InvalidInputFailure,
  ioFailure,
  isEvalFailure,
  type CleanupStatus,
} from "./failures.ts";
import { budgetDigest, declaredLimits, readPlan } from "./plan.ts";
import { reconstructAttempt } from "./retained.ts";
import {
  ATTEMPTS_DIR,
  ATTEMPT_PHASES,
  CATALOG_LOCK_FILE,
  DIGEST_PATTERN,
  EVIDENCE_COVERAGES,
  IDENTITY_FIELDS,
  LIMIT_NAMES,
  ORACLE_STATUSES,
  POSTURES,
  REPORTS_DIR,
  REPORT_SCHEMA_VERSION,
  TASK_OUTCOMES,
  TOKEN_PATTERN,
  VALIDITIES,
  type AgentQaReport,
  type AttemptRecord,
  type AttemptReport,
  type CaseId,
  type CatalogLock,
  type FixtureRef,
  type IdentityField,
  type NotRunReason,
  type OracleResult,
  type PlannedAttempt,
  type ReportCounts,
  type RosterState,
  type RunPlan,
  type UsageRecord,
  type Validity,
} from "./types.ts";

const ATTEMPT_FIELDS: readonly string[] = [
  "schemaVersion",
  "attemptId",
  "runId",
  "caseId",
  "fixtureDigest",
  "startedAtEpochMs",
  "settledAtEpochMs",
  "phase",
  "outcome",
  "validity",
  "coverage",
  "posture",
  "limits",
  "usage",
  "oracles",
  "traceRef",
  "failure",
  "cleanup",
];

const USAGE_FIELDS: readonly string[] = ["inputTokens", "outputTokens", "wallMs", "usageComplete"];
const LIMIT_FIELDS: readonly string[] = ["name", "declared", "applied", "observed", "overrun"];
const ORACLE_FIELDS: readonly string[] = ["oracleId", "kind", "status", "evidenceRef", "digest"];
const CLEANUP_FIELDS: readonly string[] = ["status", "owned"];
const FAILURE_FIELDS: readonly string[] = ["kind", "phase"];

/**
 * Cleanup states that attest the attempt left nothing behind unproven. Anything else
 * is its own named report state, never folded into `passed = 0`.
 */
const CLEANUP_ATTESTED: readonly CleanupStatus[] = ["confirmed", "not-applicable"];

/** Validity states that cannot state that a measurement was taken. */
const UNMEASURED_VALIDITIES: readonly Validity[] = ["not-run", "unknown"];

/**
 * The vocabularies a stored record is checked against are the ones the record type is
 * derived from: one list per dimension, imported, never restated here.
 */
const ENUM_FIELDS: readonly (readonly [string, readonly string[]])[] = [
  ["phase", ATTEMPT_PHASES],
  ["outcome", TASK_OUTCOMES],
  ["validity", VALIDITIES],
  ["coverage", EVIDENCE_COVERAGES],
  ["posture", POSTURES],
];

/** Validity buckets. `executed` is derived separately: unknown cannot state that it ran. */
const VALIDITY_BUCKET: Readonly<Record<Validity, keyof ReportCounts>> = {
  valid: "valid",
  invalid: "invalid",
  interrupted: "interrupted",
  "provider-error": "providerErrors",
  "not-run": "notRun",
  unknown: "unknown",
};

type UnknownRecord = Record<string, unknown>;

type FrozenRun = {
  readonly plan: RunPlan;
  /** caseId -> required oracle ids, frozen by the catalog lock. */
  readonly required: ReadonlyMap<CaseId, readonly string[]>;
  /** caseId -> every fixture digest the lock froze for that case. */
  readonly fixtures: ReadonlyMap<CaseId, ReadonlySet<string>>;
  /** caseId -> the primary digest the plan froze, the only fixture fact a slot that never ran can state. */
  readonly planned: ReadonlyMap<CaseId, string>;
};

function protocolFailure(diagnostic: string, attemptId?: string): EvalFailure {
  return new EvalFailure({
    kind: "invalid-protocol",
    phase: "report",
    attemptId,
    diagnostic,
    dispatchMayContinue: false,
  });
}

function asRecord(value: unknown, subject: string, attemptId?: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    // EXIT: the artifact is not a document, so no dimension can be read and nothing is inferred; nothing to clean; dispatch may not continue.
    throw protocolFailure(`${subject} is not an object`, attemptId);
  }
  return value as UnknownRecord;
}

function knownFields(
  record: UnknownRecord,
  allowed: readonly string[],
  subject: string,
  attemptId?: string
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    // EXIT: the document carries fields the frozen format has no meaning for (assistant prose included) — refusing keeps an outcome from being derived out of nothing; dispatch may not continue.
    throw protocolFailure(
      `${subject} has unknown field(s): ${unknown.sort().join(", ")}`,
      attemptId
    );
  }
  const missing = allowed.filter((key) => !Object.hasOwn(record, key));
  if (missing.length > 0) {
    // EXIT: a required field is absent, and absent is never defaulted into a verdict; dispatch may not continue.
    throw protocolFailure(
      `${subject} is missing field(s): ${missing.sort().join(", ")}`,
      attemptId
    );
  }
}

function requireEnum(
  record: UnknownRecord,
  field: string,
  allowed: readonly string[],
  subject: string,
  attemptId?: string
): string {
  const value = record[field];
  if (typeof value !== "string" || !allowed.includes(value)) {
    // EXIT: the field states a value outside the frozen vocabulary, so no reader could tally it; dispatch may not continue.
    throw protocolFailure(`${subject}.${field} is not a declared value`, attemptId);
  }
  return value;
}

function requireDigest(value: unknown, subject: string, attemptId?: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    // EXIT: the digest is not lowercase hex sha256, so it could never match a frozen reference; dispatch may not continue.
    throw protocolFailure(`${subject} is not a sha256 hex digest`, attemptId);
  }
  return value;
}

function requireNullableNumber(value: unknown, subject: string, attemptId?: string): void {
  if (value === null || typeof value === "number") return;
  // EXIT: the amount is neither a measured number nor an explicit null, so it is neither zero nor unknown; dispatch may not continue.
  throw protocolFailure(`${subject} is not a number or null`, attemptId);
}

function requireStringArray(value: unknown, subject: string, attemptId?: string): readonly string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as readonly string[];
  }
  // EXIT: a roster that cannot be listed cannot be required of anything; dispatch may not continue.
  throw protocolFailure(`${subject} is not a list of strings`, attemptId);
}

function readCatalogLock(root: string): CatalogLock {
  const { value } = readJsonArtifact(join(root, CATALOG_LOCK_FILE));
  const record = asRecord(value, "catalog lock");
  if (record.schemaVersion !== REPORT_SCHEMA_VERSION || typeof record.evaluator !== "string") {
    // EXIT: the lock belongs to another schema, so its digests describe nothing this report can use; dispatch may not continue.
    throw protocolFailure(
      `catalog lock is schema ${String(record.schemaVersion)}, expected ${REPORT_SCHEMA_VERSION}`
    );
  }
  if (!Array.isArray(record.cases) || record.cases.length === 0) {
    // EXIT: a lock with no case references names no denominator; dispatch may not continue.
    throw new ArtifactFailure(
      "missing-reference",
      "report",
      "catalog lock holds no case references"
    );
  }
  return record as unknown as CatalogLock;
}

function oracleIdsOf(entry: UnknownRecord): readonly string[] {
  if (!Array.isArray(entry.oracles)) {
    // EXIT: the lock declares no readable oracle roster for the slot, so the slot is undecidable; dispatch may not continue.
    throw protocolFailure(`catalog lock case ${String(entry.caseId)} declares no oracle roster`);
  }
  const ids: string[] = [];
  for (const oracle of entry.oracles) {
    const id = asRecord(oracle, "catalog lock oracle").oracleId;
    if (typeof id !== "string" || id.trim() === "") {
      // EXIT: an oracle the lock cannot name cannot be required of an attempt; dispatch may not continue.
      throw protocolFailure(`catalog lock case ${String(entry.caseId)} holds an unnameable oracle`);
    }
    ids.push(id);
  }
  return ids.sort();
}

/**
 * Every locked address one case reference states. A reference that carries no list
 * could only ever be checked against its primary, which is how a second fixture of a
 * case drifts unreported.
 */
function lockAddresses(entry: UnknownRecord, caseId: CaseId): readonly FixtureRef[] {
  if (!Array.isArray(entry.fixtureLocks) || entry.fixtureLocks.length === 0) {
    // EXIT: the lock declares no fixture list, so this case's other fixtures are unverifiable and unverifiable is not verified; dispatch may not continue.
    throw protocolFailure(`catalog lock case ${caseId} carries no fixtureLocks list`);
  }
  return entry.fixtureLocks.map((item, index) => {
    const subject = `catalog lock case ${caseId} fixtureLocks[${index}]`;
    const record = asRecord(item, subject);
    return {
      path: String(record.path),
      fixtureId: String(record.fixtureId),
      digest: requireDigest(record.digest, subject),
    };
  });
}

/**
 * `fixture` is `fixtureLocks[0]` by contract. A reference that disagrees with itself
 * claims two addresses for one slot, so which one the run measured would be a guess.
 */
function assertPrimaryIsFirstLock(
  entry: UnknownRecord,
  caseId: CaseId,
  first: FixtureRef
): void {
  const subject = `catalog lock case ${caseId} fixture`;
  const primary = asRecord(entry.fixture, subject);
  const digest = requireDigest(primary.digest, `${subject} digest`);
  if (primary.path === first.path && primary.fixtureId === first.fixtureId && digest === first.digest) {
    return;
  }
  // EXIT: the reference's primary disagrees with the first address of its own lock list; dispatch may not continue.
  throw new ArtifactFailure(
    "stale-digest",
    "report",
    `${caseId} fixture ${String(primary.path)}#${String(primary.fixtureId)} disagrees with ` +
      `the first locked address ${first.path}#${first.fixtureId}`
  );
}

function indexLock(lock: CatalogLock): Pick<FrozenRun, "required" | "fixtures"> {
  const required = new Map<CaseId, readonly string[]>();
  const fixtures = new Map<CaseId, Set<string>>();
  for (const reference of lock.cases) {
    const entry = asRecord(reference, "catalog lock case reference");
    const caseId = String(entry.caseId);
    const ids = oracleIdsOf(entry);
    if (ids.length === 0) {
      // EXIT: a slot whose lock declares no oracle could only ever be graded by assertion; dispatch may not continue.
      throw protocolFailure(`catalog lock case ${caseId} declares no oracle`);
    }
    required.set(caseId, ids);
    const addresses = lockAddresses(entry, caseId);
    assertPrimaryIsFirstLock(entry, caseId, addresses[0]);
    const allowed = fixtures.get(caseId) ?? new Set<string>();
    for (const address of addresses) allowed.add(address.digest);
    fixtures.set(caseId, allowed);
  }
  return { required, fixtures };
}

/** The primary digest the plan froze per case: the fixture fact a never-dispatched slot owes. */
function plannedFixtures(plan: RunPlan): ReadonlyMap<CaseId, string> {
  const planned = new Map<CaseId, string>();
  for (const reference of plan.cases) planned.set(reference.caseId, reference.fixture.digest);
  return planned;
}

/** The plan and the lock are two writings of one frozen decision, so they must agree. */
function assertPlanAgreesWithLock(
  plan: RunPlan,
  fixtures: ReadonlyMap<CaseId, ReadonlySet<string>>
): void {
  for (const reference of plan.cases) {
    const allowed = fixtures.get(reference.caseId);
    if (allowed === undefined || !allowed.has(reference.fixture.digest)) {
      // EXIT: the plan's fixture digest is not what the lock froze, so the run would be measured against a different fixture; dispatch may not continue.
      throw new ArtifactFailure(
        "stale-digest",
        "report",
        `run plan ${reference.caseId} fixture ${reference.fixture.path}#${reference.fixture.fixtureId} ` +
          "digest is not the digest the catalog lock froze"
      );
    }
  }
}

function readFrozenRun(root: string): FrozenRun {
  const plan = readPlan(root);
  const indexed = indexLock(readCatalogLock(root));
  assertPlanAgreesWithLock(plan, indexed.fixtures);
  return { plan, planned: plannedFixtures(plan), ...indexed };
}

/**
 * Attempt directories are the reservations the kernel already decided. A directory that
 * exists but holds no record is a fault, while a planned attempt with no directory at all
 * is an honest not-run slot: the two must never share a code path.
 */
function listReservedAttempts(attemptsRoot: string, planned: ReadonlySet<string>): Set<string> {
  if (!existsSync(attemptsRoot)) {
    // EXIT: nothing was ever reserved, so nothing ran; the report states zero executed and an incomplete roster; nothing to clean; dispatch may not continue.
    return new Set();
  }
  const reserved = new Set<string>();
  for (const entry of readdirSync(attemptsRoot, { withFileTypes: true }).sort(
    (a, b) => (a.name < b.name ? -1 : 1)
  )) {
    if (!entry.isDirectory()) {
      // EXIT: a stray file inside the attempts root is not a reserved attempt; dispatch may not continue.
      throw protocolFailure(`${attemptsRoot} holds ${entry.name}, which is not an attempt directory`);
    }
    if (!planned.has(entry.name)) {
      // EXIT: an attempt directory the frozen plan never planned would widen the denominator after the fact; dispatch may not continue.
      throw protocolFailure(`${entry.name} is not in the frozen plan`);
    }
    reserved.add(entry.name);
  }
  return reserved;
}

/** A retained artifact's fault has to say which attempt it belongs to. */
function withAttemptIdentity(error: unknown, attemptId: string): EvalFailure {
  if (!isEvalFailure(error)) {
    return ioFailure(error, "artifact-read", `attempt ${attemptId}`, attemptId);
  }
  if (error.attemptId !== undefined) return error;
  // The kind, phase and diagnostic stay exactly as the reader produced them; only the identity is added.
  return new EvalFailure({
    kind: error.kind,
    phase: error.phase,
    caseId: error.caseId,
    attemptId,
    diagnostic: error.diagnostic,
    dispatchMayContinue: error.dispatchMayContinue,
    cleanup: error.cleanup,
  });
}

function assertUsage(value: unknown, subject: string, attemptId: string): void {
  const usage = asRecord(value, `${subject}.usage`, attemptId);
  knownFields(usage, USAGE_FIELDS, `${subject}.usage`, attemptId);
  for (const field of ["inputTokens", "outputTokens", "wallMs"]) {
    requireNullableNumber(usage[field], `${subject}.usage.${field}`, attemptId);
  }
  if (typeof usage.usageComplete !== "boolean") {
    // EXIT: completeness of usage cannot be stated, so no spend claim is supported; dispatch may not continue.
    throw protocolFailure(`${subject}.usage.usageComplete is not a boolean`, attemptId);
  }
}

function assertLimit(entry: unknown, subject: string, attemptId: string): string {
  const limit = asRecord(entry, `${subject}.limit`, attemptId);
  knownFields(limit, LIMIT_FIELDS, `${subject}.limit`, attemptId);
  requireEnum(limit, "name", LIMIT_NAMES, `${subject}.limit`, attemptId);
  if (typeof limit.applied !== "boolean" || typeof limit.overrun !== "boolean") {
    // EXIT: an applied or overrun flag that is not a boolean cannot state what the boundary did; dispatch may not continue.
    throw protocolFailure(`${subject}.limit flags are not booleans`, attemptId);
  }
  for (const field of ["declared", "observed"]) {
    requireNullableNumber(limit[field], `${subject}.limit.${field}`, attemptId);
  }
  return String(limit.name);
}

function assertOracle(entry: unknown, subject: string, attemptId: string): void {
  const oracle = asRecord(entry, `${subject}.oracle`, attemptId);
  knownFields(oracle, ORACLE_FIELDS, `${subject}.oracle`, attemptId);
  requireEnum(oracle, "status", ORACLE_STATUSES, `${subject}.oracle`, attemptId);
  const oracleId = String(oracle.oracleId);
  requireDigest(oracle.digest, `${subject}.oracle ${oracleId}`, attemptId);
  if (typeof oracle.evidenceRef !== "string" || oracle.evidenceRef.trim() === "") {
    // EXIT: an oracle result with no evidence reference links to nothing; dispatch may not continue.
    throw protocolFailure(`${subject}.oracle ${oracleId} names no evidence`, attemptId);
  }
}

function assertCleanup(value: unknown, subject: string, attemptId: string): void {
  const cleanup = asRecord(value, `${subject}.cleanup`, attemptId);
  knownFields(cleanup, CLEANUP_FIELDS, `${subject}.cleanup`, attemptId);
  requireEnum(cleanup, "status", CLEANUP_STATUSES, `${subject}.cleanup`, attemptId);
  requireStringArray(cleanup.owned, `${subject}.cleanup.owned`, attemptId);
}

function assertFailureField(value: unknown, subject: string, attemptId: string): void {
  if (value === null) return;
  const failure = asRecord(value, `${subject}.failure`, attemptId);
  knownFields(failure, FAILURE_FIELDS, `${subject}.failure`, attemptId);
  // A stored failure names itself from the vocabulary its writer uses. A string outside it
  // is a label no reader can interpret, so it is refused instead of landing in a bucket.
  requireEnum(failure, "kind", FAILURE_KINDS, `${subject}.failure`, attemptId);
  requireEnum(failure, "phase", FAILURE_PHASES, `${subject}.failure`, attemptId);
}

function assertAttemptOwnership(record: UnknownRecord, planned: PlannedAttempt, plan: RunPlan): void {
  const subject = `${planned.caseId} attempt ${planned.attemptId}`;
  const attemptId = planned.attemptId;
  if (record.attemptId !== planned.attemptId || record.caseId !== planned.caseId) {
    // EXIT: the record attributes itself to another slot, so its outcome would be counted against the wrong case; dispatch may not continue.
    throw protocolFailure(`${subject} is stored under a mismatched attemptId or caseId`, attemptId);
  }
  if (record.runId !== plan.runId) {
    // EXIT: the record belongs to a different run, and one artifact root cannot merge two runs' outcomes; dispatch may not continue.
    throw protocolFailure(
      `${subject} carries runId ${String(record.runId)}, not the plan's ${plan.runId}`,
      attemptId
    );
  }
}

/** Dimension-by-dimension validation of one stored record; nothing here is inferred. */
function validateAttemptRecord(
  raw: unknown,
  planned: PlannedAttempt,
  frozen: FrozenRun
): AttemptRecord {
  const attemptId = planned.attemptId;
  const subject = `${planned.caseId} attempt ${attemptId}`;
  const record = asRecord(raw, subject, attemptId);
  knownFields(record, ATTEMPT_FIELDS, subject, attemptId);
  if (record.schemaVersion !== REPORT_SCHEMA_VERSION) {
    // EXIT: a record from another schema would be read with the wrong dimension meanings; dispatch may not continue.
    throw protocolFailure(`${subject} is schema ${String(record.schemaVersion)}`, attemptId);
  }
  assertAttemptOwnership(record, planned, frozen.plan);
  for (const [field, allowed] of ENUM_FIELDS) requireEnum(record, field, allowed, subject, attemptId);
  if (record.traceRef !== null && typeof record.traceRef !== "string") {
    // EXIT: a trace reference that is neither a string nor an explicit null resolves to nothing; dispatch may not continue.
    throw protocolFailure(`${subject}.traceRef is not text or null`, attemptId);
  }
  if (!Array.isArray(record.limits) || !Array.isArray(record.oracles)) {
    // EXIT: the limits or oracle roster is not a list, so two of the four dimensions are unreadable; dispatch may not continue.
    throw protocolFailure(`${subject} limits or oracles are not arrays`, attemptId);
  }
  assertUsage(record.usage, subject, attemptId);
  assertFailureField(record.failure, subject, attemptId);
  assertCleanup(record.cleanup, subject, attemptId);
  const limitNames = (record.limits as readonly unknown[]).map((limit) =>
    assertLimit(limit, subject, attemptId)
  );
  // Every entry is already one of LIMIT_NAMES, so a set of that size is exactly the
  // declared set: a missing name would read as "no such cap was frozen" rather than
  // "this record never said", and a repeated name states one limit twice while another
  // goes unstated.
  if (new Set(limitNames).size !== LIMIT_NAMES.length) {
    // EXIT: dimension 4 is incomplete, so the run cannot be reported against its own budget; dispatch may not continue.
    throw protocolFailure(
      `${subject} does not state each declared limit exactly once`,
      attemptId
    );
  }
  for (const oracle of record.oracles as readonly unknown[]) assertOracle(oracle, subject, attemptId);
  assertFixtureFrozen(record, planned, frozen);
  assertSettledOracles(record, planned, frozen);
  return record as unknown as AttemptRecord;
}

function assertFixtureFrozen(record: UnknownRecord, planned: PlannedAttempt, frozen: FrozenRun): void {
  const digest = requireDigest(
    record.fixtureDigest,
    `${planned.caseId} attempt ${planned.attemptId} fixture`,
    planned.attemptId
  );
  const allowed = frozen.fixtures.get(planned.caseId);
  if (allowed === undefined || !allowed.has(digest)) {
    // EXIT: the attempt ran against bytes the lock no longer names, so the measurement belongs to a different fixture; dispatch may not continue.
    throw new ArtifactFailure(
      "stale-digest",
      "report",
      `${planned.caseId} attempt ${planned.attemptId} fixture digest does not match the frozen catalog lock`,
      planned.attemptId
    );
  }
}

/**
 * A settled attempt owes every oracle its lock required. A not-settled one is owed
 * nothing: its missing evidence is the coverage fact the report has to show.
 */
function assertSettledOracles(record: UnknownRecord, planned: PlannedAttempt, frozen: FrozenRun): void {
  if (record.phase !== "settled") return;
  const retained = new Set(
    (record.oracles as readonly UnknownRecord[]).map((oracle) => String(oracle.oracleId))
  );
  for (const oracleId of frozen.required.get(planned.caseId) ?? []) {
    if (retained.has(oracleId)) continue;
    // EXIT: a settled attempt retained no result for a required oracle, and a missing oracle cannot pass; dispatch may not continue.
    throw new ArtifactFailure(
      "missing-reference",
      "report",
      `${planned.caseId} attempt ${planned.attemptId} retains no result for required oracle ${oracleId}`,
      planned.attemptId
    );
  }
}

function readAttemptRecord(
  root: string,
  planned: PlannedAttempt,
  frozen: FrozenRun
): AttemptRecord {
  try {
    // The retained reader decides what a directory means — settled, interrupted, or a
    // settlement that contradicts its own manifest — and verifies the index inside itself.
    return validateAttemptRecord(reconstructAttempt(root, planned.attemptId), planned, frozen);
  } catch (error) {
    // EXIT: the reserved attempt cannot be read or does not match what it froze; the retained bytes stay exactly as they are; dispatch may not continue.
    throw withAttemptIdentity(error, planned.attemptId);
  }
}

function readRetainedRecords(root: string, frozen: FrozenRun): Map<string, AttemptRecord> {
  const planned = frozen.plan.attempts;
  const reserved = listReservedAttempts(
    join(root, ATTEMPTS_DIR),
    new Set(planned.map((item) => item.attemptId))
  );
  const records = new Map<string, AttemptRecord>();
  for (const item of planned) {
    if (reserved.has(item.attemptId)) records.set(item.attemptId, readAttemptRecord(root, item, frozen));
  }
  return records;
}

/**
 * A pass has to be admissible measurement, resolvable evidence and a confirmed cleanup:
 * the report's only green-facing numbers are the conditional score and full-catalog
 * coverage, so an attempt that left its owned resources unproven, or that could not
 * resolve its named artifacts, must not be able to raise either.
 */
function isAdmissiblePass(record: AttemptRecord): boolean {
  return (
    record.validity === "valid" &&
    record.coverage === "complete" &&
    record.outcome === "passed" &&
    record.cleanup.status === "confirmed"
  );
}

function countAttempts(plan: RunPlan, records: ReadonlyMap<string, AttemptRecord>): ReportCounts {
  const counts = {
    planned: plan.attempts.length,
    executed: 0,
    valid: 0,
    passed: 0,
    interrupted: 0,
    providerErrors: 0,
    invalid: 0,
    notRun: 0,
    unknown: 0,
  };
  for (const planned of plan.attempts) {
    const record = records.get(planned.attemptId);
    if (record === undefined) {
      counts.notRun += 1;
      continue;
    }
    counts[VALIDITY_BUCKET[record.validity]] += 1;
    if (!UNMEASURED_VALIDITIES.includes(record.validity)) counts.executed += 1;
    if (isAdmissiblePass(record)) counts.passed += 1;
  }
  return counts;
}

function resolvedOracleIds(record: AttemptRecord, required: readonly string[]): string[] {
  const wanted = new Set(required);
  // An unreadable oracle is a retained statement, not a usable link to evidence.
  return record.oracles
    .filter((oracle: OracleResult) => wanted.has(oracle.oracleId) && oracle.status !== "unreadable")
    .map((oracle) => oracle.oracleId)
    .sort();
}

/**
 * Coverage counts the named required artifacts and nothing else: the attempt record, the
 * trace reference it names, and one slot per oracle the lock required. An attempt that
 * reported its own coverage as anything but complete cannot also claim every named
 * artifact resolved — the stored status is the conservative word.
 */
function slotsFor(
  record: AttemptRecord | null,
  required: readonly string[]
): { readonly named: number; readonly resolved: number } {
  const named = 2 + required.length;
  if (record === null) return { named, resolved: 0 };
  if (record.coverage !== "complete") return { named, resolved: 1 };
  const trace = record.traceRef !== null && record.traceRef.trim() !== "" ? 1 : 0;
  return { named, resolved: 1 + trace + resolvedOracleIds(record, required).length };
}

function measurementCoverageOf(
  plan: RunPlan,
  records: ReadonlyMap<string, AttemptRecord>,
  required: ReadonlyMap<CaseId, readonly string[]>
): number {
  let named = 0;
  let resolved = 0;
  for (const planned of plan.attempts) {
    const slots = slotsFor(
      records.get(planned.attemptId) ?? null,
      required.get(planned.caseId) ?? []
    );
    named += slots.named;
    resolved += slots.resolved;
  }
  return resolved / named;
}

function plannedFixtureDigest(frozen: FrozenRun, caseId: CaseId): string {
  const digest = frozen.planned.get(caseId);
  if (digest !== undefined) return digest;
  // EXIT: the plan attempts a case its own case list never froze, so no fixture digest exists to state and an empty one would be a fabricated fact; dispatch may not continue.
  throw protocolFailure(`run plan attempts ${caseId}, which its case list does not freeze`);
}

function notRunReport(planned: PlannedAttempt, frozen: FrozenRun): AttemptReport {
  return {
    attemptId: planned.attemptId,
    caseId: planned.caseId,
    // A slot that never ran observed no fixture, so the only digest it can state is the
    // one the plan froze for it: a frozen-decision fact, never a measurement, and exactly
    // what lets a comparison see that two arms froze different bytes.
    fixtureDigest: plannedFixtureDigest(frozen, planned.caseId),
    outcome: "undetermined",
    validity: "not-run",
    coverage: "missing",
    posture: frozen.plan.posture,
    limits: declaredLimits(frozen.plan.budget),
    usage: { inputTokens: null, outputTokens: null, wallMs: null, usageComplete: false },
    traceRef: null,
    oracleRefs: [],
  };
}

function attemptReportOf(
  record: AttemptRecord | null,
  planned: PlannedAttempt,
  frozen: FrozenRun
): AttemptReport {
  if (record === null) return notRunReport(planned, frozen);
  return {
    attemptId: record.attemptId,
    caseId: record.caseId,
    fixtureDigest: record.fixtureDigest,
    outcome: record.outcome,
    validity: record.validity,
    coverage: record.coverage,
    posture: record.posture,
    limits: record.limits,
    usage: record.usage,
    traceRef: record.traceRef,
    oracleRefs: resolvedOracleIds(record, frozen.required.get(record.caseId) ?? []),
  };
}

/**
 * The not-run buckets a retained record can reach on its own. `missing` is deliberately
 * absent: no record of its own exists for a slot nobody accounted for.
 */
type NotRunBucketName = NotRunReason | "other-not-run";

/**
 * The six roster states over cases (what a reviewer reads as the roster), while counts
 * stay over attempts (what the score divides). A case is collected when at least one of
 * its attempts produced admissible-or-failed measurement; `unknown` validity collects
 * nothing, because running or not is exactly what such a slot cannot state.
 */
function rosterFor(
  plan: RunPlan,
  records: ReadonlyMap<string, AttemptRecord>
): Record<RosterState, string[]> {
  const expected: CaseId[] = [];
  for (const reference of plan.cases) {
    if (!expected.includes(reference.caseId)) expected.push(reference.caseId);
  }
  const grouped = new Map<CaseId, PlannedAttempt[]>();
  for (const planned of plan.attempts) {
    grouped.set(planned.caseId, [...(grouped.get(planned.caseId) ?? []), planned]);
  }
  const collected: CaseId[] = [];
  const partial: CaseId[] = [];
  const buckets: NotRunBuckets = {
    skipped: [],
    "credential-blocked": [],
    "other-not-run": [],
  };
  for (const caseId of expected) {
    const attempts = grouped.get(caseId) ?? [];
    const state = caseRosterState(caseId, attempts, records, buckets);
    if (state === "collected") collected.push(caseId);
    if (state === "partial") {
      collected.push(caseId);
      partial.push(caseId);
    }
  }
  return reconcileRoster(expected, collected, {
    partial,
    skipped: buckets.skipped,
    credentialBlocked: buckets["credential-blocked"],
    otherNotRun: buckets["other-not-run"],
  });
}

type CaseState = "collected" | "partial" | "not-run";

type NotRunBuckets = Record<NotRunBucketName, CaseId[]>;

/**
 * The reason the plan froze this slot off dispatch, or null when it froze no reason. Two
 * attempts of one case naming two different reasons is a plan that disagrees with itself
 * about the same slot, so it is refused rather than resolved by list order.
 */
function declaredReason(
  caseId: CaseId,
  attempts: readonly PlannedAttempt[]
): NotRunReason | null {
  let reason: NotRunReason | null = null;
  for (const planned of attempts) {
    if (planned.notRun === null) continue;
    if (reason !== null && reason !== planned.notRun) {
      // EXIT: one case is declared not run twice, for two reasons; dispatch may not continue.
      throw protocolFailure(
        `${caseId} is frozen not-run for both ${reason} and ${planned.notRun}`
      );
    }
    reason = planned.notRun;
  }
  return reason;
}

function caseRosterState(
  caseId: CaseId,
  attempts: readonly PlannedAttempt[],
  records: ReadonlyMap<string, AttemptRecord>,
  buckets: NotRunBuckets
): CaseState {
  const present: AttemptRecord[] = [];
  for (const planned of attempts) {
    const record = records.get(planned.attemptId);
    if (record !== undefined) present.push(record);
  }
  const reason = declaredReason(caseId, attempts);
  // A case with no record at all is left unclassified, so reconcileRoster calls it `missing`.
  const first = present[0];
  if (first === undefined) {
    if (reason !== null) buckets[reason].push(caseId);
    return "not-run";
  }
  const bearing = present.filter(
    (record) => !UNMEASURED_VALIDITIES.includes(record.validity)
  );
  if (bearing.length === 0) {
    // A slot the plan froze off dispatch keeps that reason; one a fault stopped keeps
    // `other-not-run`, because the report may not invent a reason nobody declared.
    buckets[reason ?? "other-not-run"].push(caseId);
    return "not-run";
  }
  if (reason !== null) {
    // EXIT: measurement for a slot the plan froze as never dispatched — the artifacts and
    // the frozen decision describe different runs; dispatch may not continue.
    throw protocolFailure(
      `${caseId} is frozen not-run (${reason}) but retained measurement in ${bearing[0].attemptId}`,
      bearing[0].attemptId
    );
  }
  const everyPlannedRan = bearing.length === attempts.length;
  const everyEvidenceComplete = bearing.every((record) => record.coverage === "complete");
  return everyPlannedRan && everyEvidenceComplete ? "collected" : "partial";
}

/**
 * One extractor per identity field, keyed by the union itself: the type demands an entry
 * for every field `types.ts` declares, so renaming or adding a field stops compiling here
 * instead of silently reporting the old set. Declaration order follows `IDENTITY_FIELDS`.
 */
const IDENTITY_EXTRACTORS: Record<IdentityField, (plan: RunPlan) => string> = {
  evaluator: (plan) => plan.evaluator,
  source: (plan) => plan.sourceDigest,
  model: (plan) => plan.modelRoute,
  prompt: (plan) => plan.promptDigest,
  tool: (plan) => plan.toolDigest,
  data: (plan) => plan.dataIdentity,
  environment: (plan) => plan.environmentIdentity,
  posture: (plan) => plan.posture,
  // The budget identity is the frozen digest of its numbers, so two arms can be shown to
  // have declared the same limits without either restating them in prose.
  budget: (plan) => budgetDigest(plan.budget),
};

/**
 * The plan's identities in `IDENTITY_FIELDS` order. The assertion only undoes what
 * `Object.fromEntries` widens; the table above is what makes the set total.
 */
function identitiesOf(plan: RunPlan): Record<IdentityField, string> {
  return Object.fromEntries(
    IDENTITY_FIELDS.map((field) => [field, IDENTITY_EXTRACTORS[field](plan)])
  ) as Record<IdentityField, string>;
}

/**
 * Whether the run measured everything it planned. A missing, skipped,
 * not-run or partially covered attempt makes this false even when the conditional score
 * itself is a number, because a score over a short roster is not the same fact as a
 * complete measurement.
 */
function measurementCompleteOf(
  plan: RunPlan,
  records: ReadonlyMap<string, AttemptRecord>,
  roster: Readonly<Record<RosterState, readonly string[]>>
): boolean {
  if (!isFullCoverage(roster)) return false;
  return plan.attempts.every((planned) => {
    const record = records.get(planned.attemptId);
    if (record === undefined) return false;
    return (
      !UNMEASURED_VALIDITIES.includes(record.validity) && record.coverage === "complete"
    );
  });
}

/** A null member makes the total null: summing an unknown is how "we could not look" becomes a spend. */
function sumCounter(values: readonly (number | null)[]): number | null {
  const counted = values.filter((value): value is number => value !== null);
  if (counted.length !== values.length) return null;
  return counted.reduce<number>((total, value) => total + value, 0);
}

/** Aggregate usage across attempts, with completeness as the conjunction over every member. */
function usageTotalsOf(attempts: readonly AttemptReport[]): UsageRecord {
  return {
    inputTokens: sumCounter(attempts.map((item) => item.usage.inputTokens)),
    outputTokens: sumCounter(attempts.map((item) => item.usage.outputTokens)),
    wallMs: sumCounter(attempts.map((item) => item.usage.wallMs)),
    usageComplete: attempts.every((item) => item.usage.usageComplete),
  };
}

/**
 * Cleanup that was never confirmed is its own named state, not a verdict folded into
 * task success: a slot nobody dispatched left nothing behind and so owes no cleanup
 * statement; a slot that left an owned resource unproven must be visible even when its
 * task outcome passed.
 */
function cleanupUnconfirmedOf(
  plan: RunPlan,
  records: ReadonlyMap<string, AttemptRecord>
): string[] {
  const unconfirmed: string[] = [];
  for (const planned of plan.attempts) {
    const record = records.get(planned.attemptId);
    if (record === undefined) continue;
    if (!CLEANUP_ATTESTED.includes(record.cleanup.status)) unconfirmed.push(record.attemptId);
  }
  return unconfirmed;
}

/**
 * Rebuild the report for `root` from retained artifacts only. The result is total: every
 * planned attempt appears, `planned` is the frozen denominator, and the capability claim
 * sits false in the type's own literal position because tooling evidence measures no model.
 */
export function buildReport(root: string): AgentQaReport {
  const frozen = readFrozenRun(root);
  const records = readRetainedRecords(root, frozen);
  const counts = countAttempts(frozen.plan, records);
  const roster = rosterFor(frozen.plan, records);
  const attempts = frozen.plan.attempts.map((planned) =>
    attemptReportOf(records.get(planned.attemptId) ?? null, planned, frozen)
  );
  const report: AgentQaReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: frozen.plan.runId,
    identities: identitiesOf(frozen.plan),
    counts,
    // A zero-valid run has nothing to divide by: null, never 0, and so never readable as green.
    conditionalScore: counts.valid === 0 ? null : counts.passed / counts.valid,
    measurementCoverage: measurementCoverageOf(frozen.plan, records, frozen.required),
    fullCatalogCoverage: isFullCoverage(roster),
    measurementComplete: measurementCompleteOf(frozen.plan, records, roster),
    usageTotals: usageTotalsOf(attempts),
    cleanupUnconfirmed: cleanupUnconfirmedOf(frozen.plan, records),
    roster,
    attempts,
    mayClaimCapability: false,
  };
  return Object.freeze(report);
}

/** Where a run's report lives, so an operator is pointed at bytes rather than a digest. */
export function reportPathFor(root: string, runId: string): string {
  if (!TOKEN_PATTERN.test(runId)) {
    // EXIT: a run id that is not a bounded token could escape the reports directory as a file name; nothing written; dispatch may not continue.
    throw new InvalidInputFailure(`run id ${runId} is not a bounded identifier token`, "report");
  }
  return join(root, REPORTS_DIR, `${runId}.report.json`);
}

/**
 * Persist the report exactly once. A second call for the same run refuses rather than
 * replacing bytes an earlier reader already relied on.
 */
export function persistReport(root: string, report: AgentQaReport): string {
  makeDir(join(root, REPORTS_DIR), "artifact-write");
  const path = reportPathFor(root, report.runId);
  // EXIT: writeJsonOnce owns the refusal (kind artifact-write) when this run's report already exists, and the existing bytes are never replaced.
  return writeJsonOnce(path, report);
}
