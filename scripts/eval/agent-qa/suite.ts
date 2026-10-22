/**
 * The offline suite: one frozen catalog, one run root, one real attempt per slot.
 *
 * The plan is always the whole catalog, so a selection can never shrink the denominator
 * — a slot that was not dispatched stays a planned, not-run slot and the report says so.
 * Everything the attempt lifecycle owes is `runAttempt`'s contract; this module only
 * sequences it and writes the two frozen documents that make the run root readable by
 * `buildReport` afterwards.
 */
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";

import { makeDir, writeJsonOnce } from "./artifacts.ts";
import { runAttempt } from "./attempt.ts";
import type { AttemptArm } from "./attempt.ts";
import { loadCases, resolveCatalog } from "./catalog.ts";
import { InvalidInputFailure, isEvalFailure } from "./failures.ts";
import type { EvalFailure, FailureNote, FailurePhase } from "./failures.ts";
import { MAX_PLAN_TEXT_LENGTH, freezePlan, validatePlan } from "./plan.ts";
import {
  ATTEMPTS_DIR,
  CATALOG_LOCK_FILE,
  EVALUATOR_VERSION,
  REPORT_SCHEMA_VERSION,
  type AgentQaCase,
  type AttemptRecord,
  type Budget,
  type CatalogLock,
  type CaseId,
  type CaseReference,
  type OracleDeclaration,
  type PlannedAttempt,
  type RunPlan,
} from "./types.ts";

/**
 * Frozen defaults for the offline arm. `wallMs` is a per-attempt ceiling the dispatch
 * abort enforces, not an annotation: an attempt that outruns it is interrupted and is
 * therefore not admissible measurement.
 */
export const DEFAULT_BUDGET: Budget = Object.freeze({
  maxTurns: 8,
  wallMs: 30_000,
  inputTokens: null,
  outputTokens: null,
});

export type SuiteInput = {
  /** Disposable run root; artifacts land here and `buildReport` reads them back. */
  readonly root: string;
  readonly repoRoot: string;
  /** Which slots to dispatch. The frozen plan always holds the full catalog. */
  readonly caseIds?: readonly CaseId[];
  readonly budget?: Budget;
  /** `absent` dispatches the unknown-usage arm, which halts the run after one slot. */
  readonly providerUsage?: "reported" | "absent";
};

/** One slot's outcome: a settled record, or the typed fault that stopped it. */
export type CaseRun = {
  readonly caseId: CaseId;
  readonly attemptId: string;
  readonly record: AttemptRecord | null;
  readonly failure: FailureNote | null;
};

export type SuiteResult = {
  readonly root: string;
  readonly runId: string;
  readonly runs: readonly CaseRun[];
  /** The slot that stopped the loop, when a budget or an unknown usage did. */
  readonly haltedAfter: HaltedAfter | null;
};

/** Why the suite stopped dispatching early; the remaining slots stay planned, not run. */
export type HaltedAfter = {
  readonly caseId: CaseId;
  readonly attemptId: string;
  readonly reason: "unknown-usage";
};

/** A frozen run root: the two documents every later reader needs, plus the registry. */
export type FrozenRunRoot = {
  readonly root: string;
  readonly plan: RunPlan;
  readonly lock: CatalogLock;
  readonly cases: readonly AgentQaCase[];
  readonly arm: AttemptArm;
};

function digestOf(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/**
 * An artifact root must be absolute and outside the repository whose bytes it measures.
 * Published as the contract every command checks before it creates or retains anything: a
 * refused root owes no directory, and a rebuilt report or comparison owes no file inside
 * the tree it is reporting on.
 */
export function assertRoots(
  root: string,
  repoRoot: string,
  phase: FailurePhase = "plan-validate"
): void {
  if (!isAbsolute(root) || !isAbsolute(repoRoot)) {
    // EXIT: a relative root makes the artifact location ambiguous, so bytes could land
    // inside the repository; nothing is created; dispatch may not continue.
    throw new InvalidInputFailure(
      "artifact root and repository root must both be absolute",
      phase
    );
  }
  const rel = relative(repoRoot, root);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    // EXIT: the artifact root is inside the repository, so the command would write the tree
    // it measures; nothing is created; dispatch may not continue.
    throw new InvalidInputFailure(
      `artifact root ${root} is inside repository ${repoRoot}; an artifact root must be disposable`,
      phase
    );
  }
}

/**
 * The selection is a filter over the frozen roster, never a way to widen or rename it:
 * an empty list would run nothing and a duplicate would read as two slots.
 */
function selectCaseIds(
  roster: readonly CaseId[],
  requested: readonly CaseId[] | undefined
): CaseId[] {
  if (requested === undefined) return [...roster];
  if (requested.length === 0) {
    // EXIT: an explicit empty selection names no slot; the plan stays frozen and
    // nothing dispatches; dispatch may not continue.
    throw new InvalidInputFailure(
      "caseIds selection is empty; drop the filter or name at least one caseId",
      "plan-validate"
    );
  }
  const known = new Set(roster);
  const picked = new Set<CaseId>();
  for (const caseId of requested) {
    if (!known.has(caseId)) {
      // EXIT: an id outside the frozen catalog belongs to no slot; nothing dispatches;
      // dispatch may not continue.
      throw new InvalidInputFailure(
        `caseIds selection names ${caseId}, which the catalog does not hold`,
        "plan-validate"
      );
    }
    if (picked.has(caseId)) {
      // EXIT: a duplicated selection is the same slot twice, which no denominator can
      // count; nothing dispatches; dispatch may not continue.
      throw new InvalidInputFailure(
        `caseIds selection names ${caseId} more than once`,
        "plan-validate"
      );
    }
    picked.add(caseId);
  }
  // Catalog order is kept so the run's artifact sequence is reproducible.
  return roster.filter((caseId) => picked.has(caseId));
}

/**
 * The plan's own case shape: `validatePlan` refuses a field its format does not state,
 * and the only field it states differently is the oracle's prose (see `planOracleOf`).
 * The fixture addresses are frozen verbatim — a locked address is the plan's and the
 * lock's shared fact, so transliterating it in one of the two writings would make the
 * report's agreement check compare two documents that no longer say the same thing.
 */
function planCaseOf(reference: CaseReference): CaseReference {
  return {
    ...reference,
    oracles: reference.oracles.map((oracle) => planOracleOf(oracle)),
  };
}

/**
 * `OracleDeclaration.evidence` is the prose a reviewer reads, and the plan format caps
 * text at `MAX_PLAN_TEXT_LENGTH`. The evidence a case carries stays byte-for-byte whenever
 * it fits; only the overflow is cut at a word boundary with the elision marked, because a
 * silently reworded oracle declaration would be a different decision than the lock froze.
 */
function planOracleOf(oracle: OracleDeclaration): OracleDeclaration {
  if (oracle.evidence.length <= MAX_PLAN_TEXT_LENGTH) return oracle;
  return {
    ...oracle,
    evidence: `${oracle.evidence.slice(0, MAX_PLAN_TEXT_LENGTH - 20).replace(/\s+\S*$/, "")} …truncated`,
  };
}

function planDocument(
  runId: string,
  references: readonly CaseReference[],
  budget: Budget
): RunPlan {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId,
    evaluator: EVALUATOR_VERSION,
    modelRoute: "scripted-offline",
    // The offline arm has no prompt, tool, or source change to freeze: these digests
    // state the code the run is against, which is what makes a drift visible later.
    promptDigest: digestOf("agent-qa-offline-prompt"),
    toolDigest: digestOf("agent-qa-offline-toolset"),
    sourceDigest: digestOf("agent-qa-offline-source"),
    dataIdentity: "synthetic-offline",
    environmentIdentity: "scratch-loopback",
    posture: "scripted-offline",
    budget,
    cases: references.map(planCaseOf),
    // One planned attempt per slot, named by the slot: a repetition would be a second
    // planned attempt, never a retry of a failed one. An offline run declares no slot
    // off dispatch, so every one of them is meant to run.
    attempts: references.map((reference) => ({
      attemptId: `${reference.caseId}-a1`,
      caseId: reference.caseId,
      notRun: null,
    })),
    frozenBeforeAnyOutcome: true,
  };
}

function caseById(cases: readonly AgentQaCase[], caseId: CaseId): AgentQaCase {
  const found = cases.find((entry) => entry.caseId === caseId);
  if (found === undefined) {
    // EXIT: the lock names a slot the registry does not carry, so it cannot be
    // dispatched; the run root already exists and stays as written; dispatch of the
    // remaining slots continues only through the caller's own loop.
    throw new InvalidInputFailure(
      `catalog lock names ${caseId}, which the case registry does not carry`,
      "catalog-resolve"
    );
  }
  return found;
}

function failureRecord(error: EvalFailure): FailureNote {
  return {
    kind: error.kind,
    phase: error.phase,
    diagnostic: error.diagnostic,
  };
}

/** A planned slot the loop never reached: no record, no fault, still in the denominator. */
function notRunRun(caseId: CaseId): CaseRun {
  return { caseId, attemptId: `${caseId}-a1`, record: null, failure: null };
}

async function runOne(
  frozen: FrozenRunRoot,
  reference: CaseReference,
  aCase: AgentQaCase,
  planned: PlannedAttempt
): Promise<CaseRun> {
  const attemptId = planned.attemptId;
  try {
    const record = await runAttempt(frozen.root, frozen.plan, reference, aCase, frozen.arm);
    return { caseId: reference.caseId, attemptId, record, failure: null };
  } catch (error) {
    if (isEvalFailure(error)) {
      // EXIT: one slot faulted with a typed failure — its retained bytes stay and the
      // slot is reported as a failure, never dropped; the other slots may still dispatch.
      return {
        caseId: reference.caseId,
        attemptId,
        record: null,
        failure: failureRecord(error),
      };
    }
    // EXIT: a non-typed throw means the lifecycle broke outside its own contract; the
    // suite refuses to keep guessing at slots, so no further dispatch is authorized.
    throw error;
  }
}

/**
 * Writes the two frozen documents a run root is made of, and nothing else: no attempt
 * dispatches here. A witness that needs one slot's lifecycle without the whole roster
 * freezes through this seam and then calls `runAttempt` itself.
 */
export function freezeRunRoot(
  root: string,
  repoRoot: string,
  budget: Budget = DEFAULT_BUDGET,
  providerUsage: "reported" | "absent" = "reported"
): FrozenRunRoot {
  assertRoots(root, repoRoot);
  const lock = resolveCatalog(repoRoot);
  const runId = `offline-${randomUUID().slice(0, 8)}`;
  // `freezePlan` returns the artifact digest and hands back nothing, so the validated
  // document is held here: it is the same object that was just written, frozen.
  const plan = validatePlan(planDocument(runId, lock.cases, budget));
  freezePlan(root, plan);
  // The lock and the plan are two writings of one frozen decision, and both carry the full
  // fixture roster, so a later report can check every address a case cites.
  writeJsonOnce(join(root, CATALOG_LOCK_FILE), lock);
  makeDir(join(root, ATTEMPTS_DIR), "artifact-write");
  return {
    root,
    plan,
    lock,
    cases: loadCases(),
    arm: { ...(providerUsage === "absent" ? { providerUsage } : {}) },
  };
}

/**
 * Freezes the catalog against real files, then dispatches the selected slots through the
 * real production engine. Returns one entry per selected slot; the run root is the
 * artifact, so `buildReport(root)` can read it back in a different process.
 */
export async function runSuiteOffline(input: SuiteInput): Promise<SuiteResult> {
  const frozen = freezeRunRoot(
    input.root,
    input.repoRoot,
    input.budget ?? DEFAULT_BUDGET,
    input.providerUsage ?? "reported"
  );
  const roster = frozen.lock.cases.map((reference) => reference.caseId);
  const selected = selectCaseIds(roster, input.caseIds);

  const runs: CaseRun[] = [];
  let haltedAfter: HaltedAfter | null = null;
  for (const reference of frozen.lock.cases) {
    if (!selected.includes(reference.caseId)) continue;
    if (haltedAfter !== null) {
      // EXIT: the loop stopped early on a usage rule — the slot is reported as planned
      // and not run, never dropped, and the frozen denominator still counts it; no
      // further dispatch is authorized for this run identity.
      runs.push(notRunRun(reference.caseId));
      continue;
    }
    const planned = frozen.plan.attempts.find((item) => item.caseId === reference.caseId);
    if (planned === undefined) {
      // EXIT: the plan froze no attempt for a slot its own case list carries — the
      // denominator is inconsistent, so this slot is reported as a typed failure and
      // never dropped; the remaining slots may still dispatch.
      runs.push({
        caseId: reference.caseId,
        attemptId: `${reference.caseId}-a1`,
        record: null,
        failure: failureRecord(
          new InvalidInputFailure(
            `frozen plan carries no attempt for ${reference.caseId}`,
            "plan-validate"
          )
        ),
      });
      continue;
    }
    const run = await runOne(frozen, reference, caseById(frozen.cases, reference.caseId), planned);
    runs.push(run);
    // Only an attempt that actually ran and settled is an unaccounted cost. A slot the
    // provider faulted on spent nothing measurable, so it stays a fault, not a halt.
    if (
      run.record !== null &&
      run.record.validity === "valid" &&
      run.record.usage.usageComplete === false
    ) {
      // EXIT: the provider stated no usage for a run that completed, so no later slot can
      // be costed — the run stops here rather than dispatching slots whose budget nobody
      // can prove; retained artifacts stay as written and the rest stay planned, not run.
      haltedAfter = { caseId: run.caseId, attemptId: planned.attemptId, reason: "unknown-usage" };
    }
  }
  return { root: frozen.root, runId: frozen.plan.runId, runs, haltedAfter };
}
