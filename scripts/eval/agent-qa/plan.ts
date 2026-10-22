/**
 * The frozen run plan: total input validation, budget enforcement rules, and the
 * write-once/verified-read pair that keeps a plan unchangeable after outcomes exist.
 *
 * Nothing here coerces, defaults, or repairs. A plan that does not state a field is a
 * plan that is refused, because a silently completed plan would let whatever the runner
 * happened to do become the protocol after the fact.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  CASE_GROUPS,
  DIGEST_PATTERN,
  EFFECT_POSITIONS,
  EFFECT_PREFIXES,
  EFFECT_SUFFIX_POSITIONS,
  LIMIT_NAMES,
  NOT_RUN_REASONS,
  ORACLE_KINDS,
  POSTURES,
  RUN_PLAN_FILE,
  REPORT_SCHEMA_VERSION,
  TOKEN_PATTERN,
  type Budget,
  type CaseGroup,
  type CaseReference,
  type EffectList,
  type FixtureRef,
  type LimitName,
  type LimitState,
  type NotRunReason,
  type OracleKind,
  type PlannedAttempt,
  type Posture,
  type RunPlan,
} from "./types.ts";
import {
  BudgetFailure,
  InvalidInputFailure,
} from "./failures.ts";
import { readJsonArtifact, writeJsonOnce } from "./artifacts.ts";

/**
 * Explicit magnitude ceiling. A budget beyond this is not a large number, it is a
 * non-answer: it cannot be applied at any execution boundary inside a run's lifetime,
 * so reporting it as enforceable would be a false claim.
 */
export const BUDGET_MAGNITUDE_CEILING = 1_000_000_000_000;

/** Collection ceilings: an unbounded plan document is an input fault, not a big run. */
export const MAX_PLAN_CASES = 1_000;
export const MAX_PLAN_ATTEMPTS = 10_000;

const PLAN_FIELDS: readonly string[] = [
  "schemaVersion",
  "runId",
  "evaluator",
  "modelRoute",
  "promptDigest",
  "toolDigest",
  "sourceDigest",
  "dataIdentity",
  "environmentIdentity",
  "posture",
  "budget",
  "cases",
  "attempts",
  "frozenBeforeAnyOutcome",
];

const CASE_FIELDS: readonly string[] = [
  "caseId",
  "group",
  "fixture",
  "fixtureLocks",
  "oracles",
  "allowedEffects",
  "forbiddenEffects",
];

const FIXTURE_FIELDS: readonly string[] = ["path", "fixtureId", "digest"];
const ORACLE_FIELDS: readonly string[] = ["oracleId", "kind", "evidence", "owns"];
const ATTEMPT_FIELDS: readonly string[] = ["attemptId", "caseId", "notRun"];
/** A budget's field set *is* the declared limit vocabulary; it is never re-spelled here. */
const BUDGET_FIELDS: readonly string[] = LIMIT_NAMES;

/** The plan format's cap on any free-text field; exported so a builder truncates to it. */
export const MAX_PLAN_TEXT_LENGTH = 512;

/**
 * A locked fixture is addressed by the test title it names, and a real title carries
 * spaces, CJK, colons and parentheses — 25 of the 37 addresses in the shipped catalog
 * are not identifier tokens. The plan freezes those titles verbatim, so the identifier
 * rule cannot be the bound here; these are.
 */
export const MAX_FIXTURE_ID_LENGTH = 200;

/**
 * Control characters are refused because an address is meant to be typed back: a title
 * holding a newline, tab or NUL is either a torn document or a smuggling attempt, and
 * neither belongs in a frozen plan.
 */
const FORBIDDEN_IN_FIXTURE_ID = /[\p{Cc}]/u;

type PlanRecord = Record<string, unknown>;

type BudgetFaultReason = "unreadable" | "unenforceable";

type BudgetFault = {
  readonly field: string;
  readonly reason: BudgetFaultReason;
  readonly detail: string;
};

function asRecord(raw: unknown, subject: string): PlanRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    // EXIT: subject is not a document object — no field can be checked, so nothing is inferred; dispatch may not continue.
    throw new InvalidInputFailure(`${subject} is not an object`);
  }
  return raw as PlanRecord;
}

function checkFields(
  record: PlanRecord,
  allowed: readonly string[],
  subject: string,
  optional: readonly string[] = []
): void {
  const unknown = Object.keys(record).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    // EXIT: the document declares fields the plan format does not have — a field nobody specified cannot be trusted; dispatch may not continue.
    throw new InvalidInputFailure(`${subject} has unknown field(s): ${unknown.sort().join(", ")}`);
  }
  const missing = allowed.filter((k) => !Object.hasOwn(record, k) && !optional.includes(k));
  if (missing.length > 0) {
    // EXIT: a required field is absent — absent is never defaulted; dispatch may not continue.
    throw new InvalidInputFailure(`${subject} is missing field(s): ${missing.sort().join(", ")}`);
  }
}

function requireToken(record: PlanRecord, field: string, subject: string): string {
  const value = record[field];
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    // EXIT: identifier is not a bounded safe token — an unusable identity cannot be frozen; dispatch may not continue.
    throw new InvalidInputFailure(`${subject}.${field} is not a bounded identifier token`);
  }
  return value;
}

function requireText(record: PlanRecord, field: string, subject: string): string {
  const value = record[field];
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > MAX_PLAN_TEXT_LENGTH
  ) {
    // EXIT: text is empty, non-string or oversized — the field states nothing usable; dispatch may not continue.
    throw new InvalidInputFailure(`${subject}.${field} is not bounded non-empty text`);
  }
  return value;
}

function requireDigest(record: PlanRecord, field: string, subject: string): string {
  const value = record[field];
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    // EXIT: digest is not lowercase hex sha256 — it could never match a computed digest; dispatch may not continue.
    throw new InvalidInputFailure(`${subject}.${field} is not a sha256 hex digest`);
  }
  return value;
}

/**
 * The address of a locked fixture: bounded printable text, not an identifier token.
 * Stricter than a token here would refuse the catalog it is meant to freeze, and a
 * looser rule would accept an address nobody can type back.
 */
function requireFixtureId(record: PlanRecord, field: string, subject: string): string {
  const value = record[field];
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    FORBIDDEN_IN_FIXTURE_ID.test(value)
  ) {
    // EXIT: a fixture address must be printable, non-empty text to name bytes anyone can re-find; dispatch may not continue.
    throw new InvalidInputFailure(`${subject}.${field} is not a printable fixture title`);
  }
  if (value.length > MAX_FIXTURE_ID_LENGTH) {
    // EXIT: an over-cap title is not an address but a payload; the bound is stated so a writer can meet it; dispatch may not continue.
    throw new InvalidInputFailure(
      `${subject}.${field} exceeds ${MAX_FIXTURE_ID_LENGTH} characters`
    );
  }
  return value;
}

function requireStringArray(record: PlanRecord, field: string, subject: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    // EXIT: effect/oracle roster is not an array of non-empty strings — an unreadable roster is not an empty one, and neither is enforceable; dispatch may not continue.
    throw new InvalidInputFailure(`${subject}.${field} is not an array of non-empty strings`);
  }
  return value as string[];
}

/**
 * Whether one effect entry states a fact a reader in `list` consumes: the prefix's position
 * first, then the suffix's, so a suffix cannot smuggle a clause into a list that never asks
 * it. Both tables live in `types.ts`; nothing here decides grammar on its own.
 */
function readableIn(entry: string, list: EffectList): boolean {
  const prefix = EFFECT_PREFIXES.find(
    (candidate) => entry.startsWith(candidate) && entry.length > candidate.length
  );
  if (prefix === undefined || !EFFECT_POSITIONS[prefix].includes(list)) return false;
  const reader = EFFECT_SUFFIX_POSITIONS.find((declared) => declared.prefix === prefix);
  if (reader === undefined) return true;
  return !entry.endsWith(reader.suffix) || reader.lists.includes(list);
}

/**
 * An effect entry is read by prefix, from one list, so a prefix outside `EFFECT_POSITIONS`
 * for the list it sits in names a fact no evaluator can contradict: the slot would carry a
 * declared effect that every verdict silently ignores. `EFFECT_SUFFIX_POSITIONS` applies the
 * same rule to the grammar's suffixes. Refusing it here is what keeps the grammar a contract
 * rather than a wish list.
 */
function requireEffectArray(
  record: PlanRecord,
  field: string,
  list: EffectList,
  subject: string
): string[] {
  const entries = requireStringArray(record, field, subject);
  const unreadable = entries.filter((entry) => !readableIn(entry, list));
  if (unreadable.length > 0) {
    // EXIT: an effect names no reader can parse — its presence or absence could never be
    // decided, so the plan is refused instead of grading nothing as a check; dispatch may not continue.
    throw new InvalidInputFailure(
      `${subject}.${field} carries effect(s) no reader grades in the ${list} list: ${[...new Set(unreadable)].sort().join(", ")}`
    );
  }
  return entries;
}

function requireRelativePath(record: PlanRecord, field: string, subject: string): string {
  const value = requireText(record, field, subject);
  if (value.startsWith("/") || value.split("/").includes("..")) {
    // EXIT: fixture path escapes the repository root — a plan must not address files outside itself; dispatch may not continue.
    throw new InvalidInputFailure(`${subject}.${field} must be a repo-relative path`);
  }
  return value;
}

function shapeFaults(raw: PlanRecord): BudgetFault[] {
  const missing = BUDGET_FIELDS.filter((f) => !Object.hasOwn(raw, f));
  if (missing.length > 0) {
    // EXIT: budget lacks a limit — stop, nothing written, dispatch may not continue.
    return [
      {
        field: "budget",
        reason: "unreadable",
        detail: `budget is missing field(s): ${missing.sort().join(", ")}`,
      },
    ];
  }
  const unknown = Object.keys(raw).filter((k) => !BUDGET_FIELDS.includes(k));
  if (unknown.length > 0) {
    // EXIT: budget states a limit nobody declared — stop, nothing written, dispatch may not continue.
    return [
      {
        field: "budget",
        reason: "unreadable",
        detail: `budget has unknown field(s): ${unknown.sort().join(", ")}`,
      },
    ];
  }
  return [];
}

function countFaults(value: unknown, field: string, allowNull: boolean): BudgetFault[] {
  // EXIT: `null` on a token limit is a declared absence, which is readable and stays enforceable-free.
  if (allowNull && value === null) return [];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    // EXIT: the limit cannot be read — no default is substituted; dispatch may not continue.
    return [{ field, reason: "unreadable", detail: `budget ${field} is not a finite number` }];
  }
  if (Math.abs(value) > BUDGET_MAGNITUDE_CEILING) {
    // EXIT: overflow-class magnitude is not a limit anyone could apply; dispatch may not continue.
    return [
      {
        field,
        reason: "unenforceable",
        detail: `budget ${field} exceeds the magnitude ceiling ${BUDGET_MAGNITUDE_CEILING}`,
      },
    ];
  }
  if (!Number.isSafeInteger(value)) {
    // EXIT: a fractional count cannot be applied at a turn or step boundary; dispatch may not continue.
    return [{ field, reason: "unenforceable", detail: `budget ${field} is not an integer count` }];
  }
  if (value <= 0) {
    // EXIT: zero or negative would forbid the attempt it claims to bound; dispatch may not continue.
    return [
      {
        field,
        reason: "unenforceable",
        detail: `budget ${field} must be a positive count, got ${value}`,
      },
    ];
  }
  return [];
}

/** Which frozen limits may declare no cap at all; the others must state a number. */
const NULLABLE_LIMITS: Readonly<Record<LimitName, boolean>> = {
  maxTurns: false,
  wallMs: false,
  inputTokens: true,
  outputTokens: true,
};

/**
 * Why a budget cannot be used, as data rather than as an exception, so the plan reader
 * and the budget reader can each report the same fault in their own contract's terms.
 */
function budgetFaults(value: unknown): BudgetFault[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    // EXIT: there is no budget document to read; dispatch may not continue.
    return [{ field: "budget", reason: "unreadable", detail: "budget is not an object" }];
  }
  const raw = value as PlanRecord;
  const shape = shapeFaults(raw);
  // EXIT: the budget's own field set is refused before its magnitudes are looked at; dispatch may not continue.
  if (shape.length > 0) return shape;
  return LIMIT_NAMES.flatMap((name) => countFaults(raw[name], name, NULLABLE_LIMITS[name]));
}

function assertPlanBudget(value: unknown): Budget {
  const faults = budgetFaults(value);
  if (faults.length > 0) {
    // EXIT: the plan's budget is not usable — a plan without an enforceable budget is not a frozen protocol; dispatch may not continue.
    throw new InvalidInputFailure(`run plan ${faults[0]?.detail ?? "budget is unusable"}`);
  }
  return value as Budget;
}

function validateOracle(entry: unknown, index: number): {
  oracleId: string;
  kind: OracleKind;
  evidence: string;
  owns?: string[];
} {
  const subject = `oracle[${index}]`;
  const record = asRecord(entry, subject);
  checkFields(record, ORACLE_FIELDS, subject, ["owns"]);
  const kind = record.kind;
  if (typeof kind !== "string" || !ORACLE_KINDS.includes(kind as OracleKind)) {
    // EXIT: oracle kind is outside the declared set — an unknown oracle cannot be evaluated by any reader; dispatch may not continue.
    throw new InvalidInputFailure(`${subject}.kind is not a declared oracle kind`);
  }
  const owns = record.owns;
  if (owns === undefined) {
    return {
      oracleId: requireToken(record, "oracleId", subject),
      kind: kind as OracleKind,
      evidence: requireText(record, "evidence", subject),
    };
  }
  const names = requireStringArray(record, "owns", subject);
  if (names.length === 0) {
    // EXIT: an oracle that owns nothing has no fact to read — that is an unreadable
    // oracle written into a frozen plan, so the plan is refused at validation.
    throw new InvalidInputFailure(`${subject}.owns is empty`);
  }
  if (new Set(names).size !== names.length) {
    // EXIT: one entry owned twice would grade the same fact under two verdicts; the
    // plan is refused rather than silently merged. Dispatch may not continue.
    throw new InvalidInputFailure(`${subject}.owns contains duplicate effect entries`);
  }
  return {
    oracleId: requireToken(record, "oracleId", subject),
    kind: kind as OracleKind,
    evidence: requireText(record, "evidence", subject),
    owns: names,
  };
}

function validateOracles(entry: PlanRecord, subject: string) {
  const value = entry.oracles;
  if (!Array.isArray(value) || value.length === 0) {
    // EXIT: a case with no oracle has nothing that could make a pass; the plan is refused rather than graded later; dispatch may not continue.
    throw new InvalidInputFailure(`${subject}.oracles must be a non-empty array`);
  }
  const oracles = value.map(validateOracle);
  const ids = oracles.map((o) => o.oracleId);
  if (new Set(ids).size !== ids.length) {
    // EXIT: two required oracles share an id — results could not be attributed; dispatch may not continue.
    throw new InvalidInputFailure(`${subject}.oracles contain duplicate oracleId values`);
  }
  return oracles;
}

function validateFixtureAddress(raw: unknown, subject: string): FixtureRef {
  const record = asRecord(raw, subject);
  checkFields(record, FIXTURE_FIELDS, subject);
  return {
    path: requireRelativePath(record, "path", subject),
    fixtureId: requireFixtureId(record, "fixtureId", subject),
    digest: requireDigest(record, "digest", subject),
  };
}

/**
 * Every locked fixture the case cites, in declared order. A case citing three golden
 * fixtures digests three addresses here, so a stale second fixture moves the plan rather
 * than passing as the primary's bytes.
 */
function validateFixtureLocks(entry: PlanRecord, subject: string): FixtureRef[] {
  const raw = entry.fixtureLocks;
  if (!Array.isArray(raw) || raw.length === 0) {
    // EXIT: a case that names no fixture list cannot be verified past its primary, which is the gap the list closes; dispatch may not continue.
    throw new InvalidInputFailure(`${subject}.fixtureLocks must be a non-empty array`);
  }
  return raw.map((item, index) =>
    validateFixtureAddress(item, `${subject}.fixtureLocks[${index}]`)
  );
}

function sameFixtureAddress(first: FixtureRef, second: FixtureRef): boolean {
  return (
    first.path === second.path &&
    first.fixtureId === second.fixtureId &&
    first.digest === second.digest
  );
}

function assertPrimaryIsFirstLock(
  fixture: FixtureRef,
  locks: readonly FixtureRef[],
  subject: string
): void {
  const [first] = locks;
  if (first !== undefined && sameFixtureAddress(fixture, first)) return;
  // EXIT: one slot states two primaries, so which address the run used would be a guess; dispatch may not continue.
  throw new InvalidInputFailure(`${subject}.fixture must equal ${subject}.fixtureLocks[0]`);
}

function lockedAddress(lock: FixtureRef): string {
  return `${lock.path}#${lock.fixtureId}`;
}

/**
 * One locked address belongs to one slot. Two cases naming it means either a copied slot
 * or a shared fixture whose outcome cannot be attributed, and a plan cannot report which.
 */
function assertUniqueLockedAddresses(cases: readonly CaseReference[]): void {
  const seen = new Map<string, string>();
  for (const item of cases) {
    for (const lock of item.fixtureLocks) {
      const address = lockedAddress(lock);
      const prior = seen.get(address);
      if (prior !== undefined) {
        // EXIT: one fixture address is locked by two slots; dispatch may not continue.
        throw new InvalidInputFailure(
          `run plan locks fixture address ${address} in both ${prior} and ${item.caseId}`
        );
      }
      seen.set(address, item.caseId);
    }
  }
}

function validateCaseShape(entry: unknown, index: number): CaseReference {
  const subject = `case[${index}]`;
  const record = asRecord(entry, subject);
  checkFields(record, CASE_FIELDS, subject);
  const group = record.group;
  if (typeof group !== "string" || !CASE_GROUPS.includes(group as CaseGroup)) {
    // EXIT: group is outside the declared roster — slot counts and coverage would be unverifiable; dispatch may not continue.
    throw new InvalidInputFailure(`${subject}.group is not a declared case group`);
  }
  const fixture = validateFixtureAddress(record.fixture, `${subject}.fixture`);
  const fixtureLocks = validateFixtureLocks(record, subject);
  assertPrimaryIsFirstLock(fixture, fixtureLocks, subject);
  const allowedEffects = requireEffectArray(record, "allowedEffects", "allowed", subject);
  const forbiddenEffects = requireEffectArray(record, "forbiddenEffects", "forbidden", subject);
  const oracles = validateOracles(record, subject);
  assertOwnedEffectsExist(oracles, [...allowedEffects, ...forbiddenEffects], subject);
  return {
    caseId: requireToken(record, "caseId", subject),
    group: group as CaseGroup,
    fixture,
    fixtureLocks,
    oracles,
    allowedEffects,
    forbiddenEffects,
  };
}

/**
 * An oracle may only own an effect the case actually declares: a name that appears in no
 * effect list is a typo, and a typo here would silently strand the oracle on nothing.
 */
function assertOwnedEffectsExist(
  oracles: readonly { oracleId: string; owns?: string[] }[],
  declared: readonly string[],
  subject: string
): void {
  const known = new Set(declared);
  for (const oracle of oracles) {
    const stray = (oracle.owns ?? []).filter((name) => !known.has(name));
    if (stray.length > 0) {
      // EXIT: the oracle claims an effect the case never declared — no reader could
      // decide it, so the plan is refused instead of freezing an ungradeable slot.
      throw new InvalidInputFailure(
        `${subject} oracle ${oracle.oracleId} owns effect(s) no list declares: ${stray.join(", ")}`
      );
    }
  }
}

/**
 * A repeated caseId is two different faults: the same declaration twice is a duplicate,
 * and the same id carrying different content is a conflicting identity.
 */
function assertCaseIdentity(cases: readonly CaseReference[]): void {
  const seen = new Map<string, string>();
  for (const item of cases) {
    const shape = JSON.stringify(item);
    const prior = seen.get(item.caseId);
    if (prior !== undefined && prior !== shape) {
      // EXIT: one caseId declares two identities — no comparison could name which one was run; dispatch may not continue.
      throw new InvalidInputFailure(
        `run plan declares conflicting identities for caseId ${item.caseId}`
      );
    }
    if (prior !== undefined) {
      // EXIT: one caseId is declared twice — a duplicated slot is not an extra repetition; dispatch may not continue.
      throw new InvalidInputFailure(`run plan declares duplicate caseId ${item.caseId}`);
    }
    seen.set(item.caseId, shape);
  }
}

function validateCases(value: unknown): CaseReference[] {
  if (!Array.isArray(value)) {
    // EXIT: cases is not a list — the denominator cannot be fixed; dispatch may not continue.
    throw new InvalidInputFailure("run plan cases is not an array");
  }
  if (value.length === 0) {
    // EXIT: an empty catalog has no denominator to report against; dispatch may not continue.
    throw new InvalidInputFailure("run plan declares no cases");
  }
  if (value.length > MAX_PLAN_CASES) {
    // EXIT: the case list is beyond the declared plan size — an overflow-sized document is refused, not truncated; dispatch may not continue.
    throw new InvalidInputFailure(`run plan declares more than ${MAX_PLAN_CASES} cases`);
  }
  const cases = value.map(validateCaseShape);
  assertCaseIdentity(cases);
  assertUniqueLockedAddresses(cases);
  return cases;
}

/**
 * `notRun` is the one attempt field a plan may leave out, because leaving it out is the
 * ordinary case: the slot is meant to be dispatched. Stating it is a decision taken
 * before any outcome, which is exactly why it must be one of the two declared reasons
 * rather than a fault kind — nothing was run, so nothing can be blamed.
 */
function notRunReasonOf(
  record: PlanRecord,
  subject: string
): NotRunReason | null {
  const value = record.notRun;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !NOT_RUN_REASONS.includes(value as NotRunReason)) {
    // EXIT: a not-run reason outside the declared pair names no roster state — the slot
    // would be accounted under a bucket no reader can interpret; dispatch may not continue.
    throw new InvalidInputFailure(`${subject}.notRun is not a declared not-run reason`);
  }
  return value as NotRunReason;
}

function validateAttemptShape(entry: unknown, index: number): PlannedAttempt {
  const subject = `attempt[${index}]`;
  const record = asRecord(entry, subject);
  checkFields(record, ATTEMPT_FIELDS, subject, ["notRun"]);
  return {
    attemptId: requireToken(record, "attemptId", subject),
    caseId: requireToken(record, "caseId", subject),
    notRun: notRunReasonOf(record, subject),
  };
}

function assertAttemptIdentities(attempts: readonly PlannedAttempt[]): void {
  const ids = attempts.map((a) => a.attemptId);
  const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicated.length > 0) {
    // EXIT: two planned attempts share an attemptId — one attempt's outcome could be attributed to the other; dispatch may not continue.
    throw new InvalidInputFailure(
      `run plan declares duplicate attemptId value(s): ${[...new Set(duplicated)].sort().join(", ")}`
    );
  }
}

function assertCoverage(cases: readonly CaseReference[], attempts: readonly PlannedAttempt[]): void {
  const declared = new Set(cases.map((c) => c.caseId));
  const unknown = [...new Set(attempts.map((a) => a.caseId))].filter((id) => !declared.has(id));
  if (unknown.length > 0) {
    // EXIT: an attempt plans a case the catalog never declared — its outcome would belong to nothing; dispatch may not continue.
    throw new InvalidInputFailure(
      `run plan attempts reference undeclared caseId(s): ${unknown.sort().join(", ")}`
    );
  }
  const counts = cases.map(
    (item) => attempts.filter((a) => a.caseId === item.caseId).length
  );
  const uncovered = cases
    .filter((_item, index) => counts[index] === 0)
    .map((item) => item.caseId);
  if (uncovered.length > 0) {
    // EXIT: a planned case has no attempt at all — the denominator would silently become "not run"; dispatch may not continue.
    throw new InvalidInputFailure(
      `run plan covers no attempt for caseId(s): ${uncovered.sort().join(", ")}`
    );
  }
  const repetitions = counts[0] ?? 0;
  const uneven = cases
    .filter((_item, index) => counts[index] !== repetitions)
    .map((item) => item.caseId);
  if (uneven.length > 0) {
    // EXIT: cases were planned for different repetition counts — the arms would not be comparable; dispatch may not continue.
    throw new InvalidInputFailure(
      `run plan attempts are uneven: ${repetitions} per case expected, uneven for ${uneven.sort().join(", ")}`
    );
  }
}

function validateAttempts(
  value: unknown,
  cases: readonly CaseReference[]
): PlannedAttempt[] {
  if (!Array.isArray(value)) {
    // EXIT: attempts is not a list — the planned denominator is unreadable; dispatch may not continue.
    throw new InvalidInputFailure("run plan attempts is not an array");
  }
  if (value.length === 0) {
    // EXIT: a plan with no attempts cannot cover any case; dispatch may not continue.
    throw new InvalidInputFailure("run plan declares no attempts");
  }
  if (value.length > MAX_PLAN_ATTEMPTS) {
    // EXIT: the attempt list is beyond the declared plan size — refused as overflow-sized input, never silently trimmed; dispatch may not continue.
    throw new InvalidInputFailure(
      `run plan declares more than ${MAX_PLAN_ATTEMPTS} attempts`
    );
  }
  const attempts = value.map(validateAttemptShape);
  assertAttemptIdentities(attempts);
  assertCoverage(cases, attempts);
  return attempts;
}

function assertScalars(record: PlanRecord): {
  schemaVersion: number;
  runId: string;
  evaluator: string;
  modelRoute: string;
  promptDigest: string;
  toolDigest: string;
  sourceDigest: string;
  dataIdentity: string;
  environmentIdentity: string;
  posture: Posture;
} {
  const schemaVersion = record.schemaVersion;
  // One document version per capability: plan, lock, attempt, report and comparison move together or retained bytes mean two things.
  if (schemaVersion !== REPORT_SCHEMA_VERSION) {
    // EXIT: the plan is written for another schema — reinterpreting it would silently change the protocol; dispatch may not continue.
    throw new InvalidInputFailure(
      `run plan schemaVersion must be ${REPORT_SCHEMA_VERSION}`
    );
  }
  if (record.frozenBeforeAnyOutcome !== true) {
    // EXIT: the plan does not assert it was frozen before any outcome — the denominator could still move; dispatch may not continue.
    throw new InvalidInputFailure(
      "run plan frozenBeforeAnyOutcome must be the literal true"
    );
  }
  const posture = record.posture;
  if (typeof posture !== "string" || !POSTURES.includes(posture as Posture)) {
    // EXIT: posture is undeclared — disclosure and sandboxing cannot be stated; dispatch may not continue.
    throw new InvalidInputFailure("run plan posture is not a declared posture");
  }
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: requireToken(record, "runId", "run plan"),
    evaluator: requireToken(record, "evaluator", "run plan"),
    modelRoute: requireToken(record, "modelRoute", "run plan"),
    promptDigest: requireDigest(record, "promptDigest", "run plan"),
    toolDigest: requireDigest(record, "toolDigest", "run plan"),
    sourceDigest: requireDigest(record, "sourceDigest", "run plan"),
    dataIdentity: requireToken(record, "dataIdentity", "run plan"),
    environmentIdentity: requireToken(record, "environmentIdentity", "run plan"),
    posture: posture as Posture,
  };
}

/** Immutability is part of the contract: an outcome must not be able to edit its own plan. */
function deepFreeze<T>(value: T): T {
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key];
    if (typeof child === "object" && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
}

export function validatePlan(raw: unknown): RunPlan {
  const record = asRecord(raw, "run plan");
  if (Object.keys(record).length === 0) {
    // EXIT: the document is empty — nothing was frozen; dispatch may not continue.
    throw new InvalidInputFailure("run plan is empty");
  }
  checkFields(record, PLAN_FIELDS, "run plan");
  const scalars = assertScalars(record);
  const budget = assertPlanBudget(record.budget);
  const cases = validateCases(record.cases);
  const attempts = validateAttempts(record.attempts, cases);
  return deepFreeze<RunPlan>({
    ...scalars,
    budget,
    cases,
    attempts,
    frozenBeforeAnyOutcome: true,
  });
}

/**
 * The budget's own contract, separate from the plan's so a budget can fail on its own
 * terms: unreadable limits and unenforceable limits are different facts, and both stop
 * dispatch.
 */
export function validateBudget(budget: Budget): Budget {
  const [fault] = budgetFaults(budget);
  if (fault !== undefined) {
    // EXIT: a budget that cannot be read or cannot be applied stops further dispatch; no artifact is written here.
    throw new BudgetFailure(
      fault.reason === "unreadable" ? "unreadable-budget" : "unenforceable-budget",
      fault.detail
    );
  }
  return budget;
}

/**
 * The limits the budget froze, each stated as nothing-yet-observed. A slot that never
 * dispatched can only state the frozen side of dimension 4; a dispatched slot overwrites
 * `applied`, `observed` and `overrun` with what its run actually did, never its name.
 */
export function declaredLimits(budget: Budget): LimitState[] {
  return LIMIT_NAMES.map((name) => ({
    name,
    declared: budget[name],
    applied: false,
    observed: null,
    overrun: false,
  }));
}

/**
 * Positional serialization: key order must never change a digest, or two identical
 * budgets would freeze as two different identities. `LIMIT_NAMES` states the order once,
 * and it is the order the digest has always frozen.
 */
export function budgetDigest(budget: Budget): string {
  const checked = validateBudget(budget);
  const canonical = JSON.stringify(LIMIT_NAMES.map((name) => checked[name]));
  return createHash("sha256").update(canonical).digest("hex");
}

export function freezePlan(root: string, plan: RunPlan): string {
  const checked = validatePlan(plan);
  return writeJsonOnce(join(root, RUN_PLAN_FILE), checked);
}

/** Re-validated through the production reader, so a hand-edited plan is refused. */
export function readPlan(root: string): RunPlan {
  return validatePlan(readJsonArtifact(join(root, RUN_PLAN_FILE)).value);
}
