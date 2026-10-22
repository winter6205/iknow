/**
 * The frozen 20-slot Agent QA catalog: case loading, digest resolution, lock
 * verification, and roster reconciliation.
 *
 * The catalog addresses fixtures by repo-relative path plus stable fixture id and
 * locks them by file digest. It never relocates or copies a golden set: a slot's
 * meaning is the address, and a digest is what makes an unnoticed move visible.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { VIOLATION_PREFIXES } from "../../../src/harness/permission/prefixes.ts";
import { AGENT_QA_CASES } from "./cases/index.ts";
import { ArtifactFailure, InvalidInputFailure, ioFailure } from "./failures.ts";
import {
  EVALUATOR_VERSION,
  GROUP_SLOT_COUNT,
  REPORT_SCHEMA_VERSION,
  ROSTER_STATES,
  type AgentQaCase,
  type CaseGroup,
  type CaseId,
  type CaseReference,
  type CatalogLock,
  type FixtureRef,
  type RosterState,
} from "./types.ts";

/**
 * Prefixes a `permission-record` oracle accepts as a denial. Derived from the
 * product's own prefix table because that table is the SSOT for both the emit
 * side and the recognize side: restating the literals here would let a prefix
 * change silently turn every denial into an unrecognized record.
 */
export const DENIAL_RECORD_PREFIXES: readonly string[] = Object.freeze(
  Object.values(VIOLATION_PREFIXES)
);

const CASE_GROUP_LIST: readonly CaseGroup[] = Object.keys(
  GROUP_SLOT_COUNT
) as readonly CaseGroup[];

const TOTAL_SLOTS: number = CASE_GROUP_LIST.reduce(
  (sum, group) => sum + GROUP_SLOT_COUNT[group],
  0
);

/**
 * Reads and digests bytes. A deliberate local copy of `sha256File` in
 * artifacts.ts: the catalog resolves before any artifact exists, so it must not
 * inherit the artifact-read failure kinds that phase owns. The duplication is
 * known and belongs in a consolidation task, not in this slot.
 */
function sha256OfBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A locked path is repo-relative and cannot climb out of the repo. */
function isLockablePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.split("/").includes("..")
  );
}

function fixtureBytes(repoRoot: string, caseId: CaseId, path: string): Buffer {
  const absolute = join(repoRoot, path);
  let stats;
  try {
    stats = statSync(absolute);
  } catch (error) {
    if (errnoCodeOf(error) === "ENOENT") {
      // EXIT: locked fixture absent — catalog unresolved, nothing written; dispatch may not continue.
      throw new ArtifactFailure(
        "missing-reference",
        "catalog-resolve",
        `${caseId} locks ${path}, which is absent under ${repoRoot}`
      );
    }
    // EXIT: fixture exists but cannot be stated — a filesystem fault, not an absence; dispatch may not continue.
    throw ioFailure(error, "catalog-resolve", `stat of ${path}`);
  }
  if (!stats.isFile()) {
    // EXIT: locked path is not a file — the address names nothing lockable; dispatch may not continue.
    throw new ArtifactFailure(
      "missing-reference",
      "catalog-resolve",
      `${caseId} locks ${path}, which is not a regular file`
    );
  }
  try {
    return readFileSync(absolute);
  } catch (error) {
    // EXIT: bytes unreadable after a successful stat — digest stays unknown; dispatch may not continue.
    throw ioFailure(error, "catalog-resolve", `read of ${path}`);
  }
}

/**
 * Digests one locked address. The address is `path#fixtureId`, so the file must
 * name the id it is addressed by: the digest of a file that never mentions the
 * id would lock an invention, which is exactly how a plausible-looking but
 * fabricated address survives a digest-only check.
 */
function digestFixture(
  repoRoot: string,
  caseId: CaseId,
  path: string,
  fixtureId: string
): string {
  const bytes = fixtureBytes(repoRoot, caseId, path);
  if (!bytes.toString("utf8").includes(fixtureId)) {
    // EXIT: the locked file does not name the fixtureId — the address resolves to nothing inside the file, so no digest of it is a lock; dispatch may not continue.
    throw new ArtifactFailure(
      "missing-reference",
      "catalog-resolve",
      `${caseId} locks ${path}#${fixtureId}, which the file does not name`
    );
  }
  return sha256OfBytes(bytes);
}

function errnoCodeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

function assertUniqueIds(cases: readonly AgentQaCase[]): void {
  const seen = new Set<CaseId>();
  for (const aCase of cases) {
    if (seen.has(aCase.caseId)) {
      // EXIT: a duplicated stable id would silently shrink the planned denominator; dispatch may not continue.
      throw new InvalidInputFailure(
        `case id ${aCase.caseId} appears more than once in the catalog`,
        "catalog-resolve"
      );
    }
    seen.add(aCase.caseId);
  }
}

function assertGroupAllocation(cases: readonly AgentQaCase[]): void {
  const counted = new Map<CaseGroup, number>();
  for (const group of CASE_GROUP_LIST) counted.set(group, 0);
  for (const aCase of cases) {
    const current = counted.get(aCase.group);
    if (current === undefined) {
      // EXIT: a case in an undeclared group has no slot budget, so no allocation claim holds; dispatch may not continue.
      throw new InvalidInputFailure(
        `${aCase.caseId} declares group ${String(aCase.group)}, which the catalog does not allocate`,
        "catalog-resolve"
      );
    }
    counted.set(aCase.group, current + 1);
  }
  for (const group of CASE_GROUP_LIST) {
    const observed = counted.get(group) ?? 0;
    if (observed !== GROUP_SLOT_COUNT[group]) {
      // EXIT: group allocation drifted from the frozen slot count; the denominator is wrong, dispatch may not continue.
      throw new InvalidInputFailure(
        `group ${group} holds ${observed} cases, expected ${GROUP_SLOT_COUNT[group]}`,
        "catalog-resolve"
      );
    }
  }
}

/**
 * Every slot must be decidable on its own terms: an address to lock and at least
 * one oracle to read. A slot with either missing could only ever be reported as
 * a pass by assertion.
 */
function assertDecidable(aCase: AgentQaCase): void {
  if (aCase.locks.length === 0) {
    // EXIT: a slot with no fixture address cannot be locked, so its digest could not go stale; dispatch may not continue.
    throw new InvalidInputFailure(
      `${aCase.caseId} declares no locked fixture`,
      "catalog-resolve"
    );
  }
  if (aCase.oracles.length === 0) {
    // EXIT: a slot with no oracle has no independent outcome source; dispatch may not continue.
    throw new InvalidInputFailure(
      `${aCase.caseId} declares no oracle`,
      "catalog-resolve"
    );
  }
  for (const lock of aCase.locks) {
    if (!isLockablePath(lock.path)) {
      // EXIT: an absolute or climbing lock path is not a repo-relative address; dispatch may not continue.
      throw new InvalidInputFailure(
        `${aCase.caseId} locks ${lock.path}, which is not a repo-relative path`,
        "catalog-resolve"
      );
    }
    if (lock.fixtureId.length === 0) {
      // EXIT: an empty fixtureId is named by every file ("" is a substring of all), so the address check would be vacuous; dispatch may not continue.
      throw new InvalidInputFailure(
        `${aCase.caseId} locks ${lock.path} with an empty fixture id`,
        "catalog-resolve"
      );
    }
  }
}

function validateCatalog(cases: readonly AgentQaCase[]): void {
  if (cases.length !== TOTAL_SLOTS) {
    // EXIT: the catalog is not the frozen 20, so no planned denominator or coverage claim is true; dispatch may not continue.
    throw new InvalidInputFailure(
      `catalog holds ${cases.length} cases, expected ${TOTAL_SLOTS}`,
      "catalog-resolve"
    );
  }
  assertUniqueIds(cases);
  assertGroupAllocation(cases);
  for (const aCase of cases) assertDecidable(aCase);
}

/**
 * One reference per case: the case's stable id plus every locked fixture it cites,
 * in declared order. A case with three locks must still be one slot, because the
 * plan validator refuses a duplicated caseId — a repeated slot is not an extra
 * repetition — so one reference per lock would make a real catalog impossible to
 * freeze into a run plan.
 */
function referenceFor(aCase: AgentQaCase, repoRoot: string): CaseReference {
  const fixtureLocks = aCase.locks.map((lock) => ({
    path: lock.path,
    fixtureId: lock.fixtureId,
    digest: digestFixture(repoRoot, aCase.caseId, lock.path, lock.fixtureId),
  }));
  return {
    caseId: aCase.caseId,
    group: aCase.group,
    // The primary stays locks[0] so every pre-existing reader keeps its meaning.
    fixture: fixtureLocks[0],
    fixtureLocks,
    oracles: aCase.oracles,
    allowedEffects: aCase.allowedEffects,
    forbiddenEffects: aCase.forbiddenEffects,
  };
}

function byCaseId(a: CaseReference, b: CaseReference): number {
  if (a.caseId === b.caseId) return 0;
  return a.caseId < b.caseId ? -1 : 1;
}

/** The declared cases, ordered by stable id, from the static registry. */
export function loadCases(): readonly AgentQaCase[] {
  return Object.freeze(
    [...AGENT_QA_CASES].sort((a, b) => (a.caseId < b.caseId ? -1 : 1))
  );
}

/**
 * Resolves the catalog against real files: shape first, then one digest per locked
 * address, one reference per case. The result is the frozen denominator every later
 * phase reads.
 */
export function resolveCatalog(repoRoot: string): CatalogLock {
  if (!isAbsolute(repoRoot)) {
    // EXIT: a relative root makes every locked address ambiguous; dispatch may not continue.
    throw new InvalidInputFailure(
      `repoRoot ${repoRoot} is not absolute`,
      "catalog-resolve"
    );
  }
  const cases = loadCases();
  validateCatalog(cases);
  const references = cases
    .map((aCase) => referenceFor(aCase, repoRoot))
    .sort(byCaseId);
  return Object.freeze({
    schemaVersion: REPORT_SCHEMA_VERSION,
    evaluator: EVALUATOR_VERSION,
    cases: Object.freeze(references),
  });
}

function staleDigest(caseId: CaseId, address: FixtureRef, observed: string): never {
  // EXIT: a locked fixture moved since resolve; the plan's digest no longer names these bytes, dispatch may not continue.
  throw new ArtifactFailure(
    "stale-digest",
    "catalog-resolve",
    `${caseId} fixture ${address.path}#${address.fixtureId} digest ` +
      `moved from ${address.digest} to ${observed}`
  );
}

/**
 * The lock list, read off a document this function did not write. A reference that
 * carries none cannot be verified past its primary, which is exactly the gap the list
 * exists to close.
 */
function locksOf(reference: CaseReference): readonly FixtureRef[] {
  const locks: unknown = reference.fixtureLocks;
  if (!Array.isArray(locks) || locks.length === 0) {
    // EXIT: the lock states no fixture list, so its other fixtures are unverifiable and unverifiable is not verified; dispatch may not continue.
    throw new InvalidInputFailure(
      `${reference.caseId} lock carries no fixtureLocks list`,
      "catalog-resolve"
    );
  }
  return locks as readonly FixtureRef[];
}

/**
 * Both halves of a reference are digested: the primary and every entry of its lock
 * list. A reference whose primary is not its own first lock asserts two addresses for
 * one slot, so which one the run used would be a guess.
 */
function verifyReference(reference: CaseReference, repoRoot: string): void {
  for (const address of [reference.fixture, ...locksOf(reference)]) {
    const observed = digestFixture(
      repoRoot,
      reference.caseId,
      address.path,
      address.fixtureId
    );
    if (observed !== address.digest) staleDigest(reference.caseId, address, observed);
  }
  assertPrimaryIsFirstLock(reference);
}

function assertPrimaryIsFirstLock(reference: CaseReference): void {
  const primary = reference.fixture;
  const [first] = locksOf(reference);
  if (
    primary.path === first.path &&
    primary.fixtureId === first.fixtureId &&
    primary.digest === first.digest
  ) {
    return;
  }
  // EXIT: the reference's primary names an address its own lock list does not put first, so the slot has two primaries; dispatch may not continue.
  throw new InvalidInputFailure(
    `${reference.caseId} fixture ${primary.path}#${primary.fixtureId} is not the first locked address`,
    "catalog-resolve"
  );
}

/** Re-digests every locked address — primary and lock list — and refuses a lock whose fixture has moved. */
export function verifyCatalog(lock: CatalogLock, repoRoot: string): void {
  if (!isAbsolute(repoRoot)) {
    // EXIT: a relative root cannot address the fixtures the lock names; dispatch may not continue.
    throw new InvalidInputFailure(
      `repoRoot ${repoRoot} is not absolute`,
      "catalog-resolve"
    );
  }
  if (
    lock.schemaVersion !== REPORT_SCHEMA_VERSION ||
    lock.evaluator !== EVALUATOR_VERSION
  ) {
    // EXIT: the lock was written by another schema or evaluator; its digests are not comparable; dispatch may not continue.
    throw new InvalidInputFailure(
      `catalog lock is schema ${lock.schemaVersion} / evaluator ${lock.evaluator}, ` +
        `expected ${REPORT_SCHEMA_VERSION} / ${EVALUATOR_VERSION}`,
      "catalog-resolve"
    );
  }
  if (lock.cases.length === 0) {
    // EXIT: an empty lock has no denominator to verify; dispatch may not continue.
    throw new InvalidInputFailure(
      "catalog lock holds no case references",
      "catalog-resolve"
    );
  }
  for (const reference of lock.cases) verifyReference(reference, repoRoot);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    // A missing optional field and an explicitly absent one are the same case.
    if (item !== undefined) out[key] = canonicalize(item);
  }
  return out;
}

/** A canonical digest of a case: key order cannot move it, content change must. */
export function caseDigest(aCase: AgentQaCase): string {
  const canonical = JSON.stringify(canonicalize(aCase));
  return createHash("sha256").update(canonical).digest("hex");
}

export type RosterOptions = {
  /** Collected, but not every required artifact or oracle resolved. */
  readonly partial?: readonly string[];
  readonly skipped?: readonly string[];
  readonly credentialBlocked?: readonly string[];
  readonly otherNotRun?: readonly string[];
};

function assertNoDuplicates(ids: readonly string[], subject: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      // EXIT: the same slot named twice in one roster input is a conflicting input; dispatch may not continue.
      throw new InvalidInputFailure(
        `${subject} lists ${id} more than once`,
        "catalog-resolve"
      );
    }
    seen.add(id);
  }
}

function assertKnown(
  ids: readonly string[],
  expected: Set<string>,
  subject: string
): void {
  for (const id of ids) {
    if (!expected.has(id)) {
      // EXIT: a roster entry outside the frozen expectation cannot be attributed to a slot; dispatch may not continue.
      throw new InvalidInputFailure(
        `${subject} names ${id}, which the expected roster does not plan`,
        "catalog-resolve"
      );
    }
  }
}

function optState(opts: RosterOptions): Record<string, readonly string[]> {
  return {
    partial: opts.partial ?? [],
    skipped: opts.skipped ?? [],
    "credential-blocked": opts.credentialBlocked ?? [],
    "other-not-run": opts.otherNotRun ?? [],
  };
}

/**
 * Keeps the six roster states apart. Every expected slot must land in exactly
 * one of them: a slot that is simply absent from the result is indistinguishable
 * from a slot nobody looked for, which is how a green command hides a short run.
 */
export function reconcileRoster(
  expectedCaseIds: readonly CaseId[],
  collectedCaseIds: readonly CaseId[],
  opts: RosterOptions = {}
): Record<RosterState, string[]> {
  assertNoDuplicates(expectedCaseIds, "expected roster");
  assertNoDuplicates(collectedCaseIds, "collected roster");
  const expected = new Set(expectedCaseIds);
  const collected = new Set(collectedCaseIds);
  assertKnown(collectedCaseIds, expected, "collected roster");
  const states = optState(opts);
  for (const [state, ids] of Object.entries(states)) {
    assertKnown(ids, expected, `${state} roster`);
  }
  const executed = runConflictCheck(states, collected);
  const notRun = new Set<string>();
  for (const ids of Object.values(states)) {
    for (const id of ids) notRun.add(id);
  }
  const missing = expectedCaseIds.filter(
    (id) => !collected.has(id) && !notRun.has(id)
  );
  const result = {} as Record<RosterState, string[]>;
  for (const state of ROSTER_STATES) {
    result[state] =
      state === "executed"
        ? executed
        : state === "missing"
          ? [...missing].sort()
          : [...(states[state] ?? [])].sort();
  }
  return result;
}

/**
 * A slot is either executed or it was not run; naming it in both lists means the
 * two inputs disagree about what happened, which no report may average away.
 */
function runConflictCheck(
  states: Record<string, readonly string[]>,
  collected: Set<string>
): string[] {
  const claimed = new Map<string, string>();
  for (const [state, ids] of Object.entries(states)) {
    for (const id of ids) {
      const prior = claimed.get(id);
      if (prior !== undefined) {
        // EXIT: one slot classified as two different non-executed states; dispatch may not continue.
        throw new InvalidInputFailure(
          `${id} is classified as both ${prior} and ${state}`,
          "catalog-resolve"
        );
      }
      if (state !== "partial" && collected.has(id)) {
        // EXIT: a not-run classification for a slot that produced artifacts; dispatch may not continue.
        throw new InvalidInputFailure(
          `${id} is collected but classified ${state}`,
          "catalog-resolve"
        );
      }
      if (state === "partial" && !collected.has(id)) {
        // EXIT: partial presumes evidence exists; an absent slot is missing, not partial; dispatch may not continue.
        throw new InvalidInputFailure(
          `${id} is classified partial but was not collected`,
          "catalog-resolve"
        );
      }
      claimed.set(id, state);
    }
  }
  return [...collected].filter((id) => !claimed.has(id)).sort();
}

/** True only when every planned slot actually ran; an empty roster proves nothing. */
export function isFullCoverage(
  roster: Readonly<Record<RosterState, readonly string[]>>
): boolean {
  if (roster.executed.length === 0) {
    // EXIT: no executed slot — vacuous coverage is not coverage; the report stays non-green.
    return false;
  }
  return ROSTER_STATES.every(
    (state) => state === "executed" || roster[state].length === 0
  );
}
