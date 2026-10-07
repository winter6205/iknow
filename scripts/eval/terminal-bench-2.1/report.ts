/**
 * What a run left behind, stated as the artifact an operator audits.
 *
 * Why this file is separate (issue 1219): `cli.ts` is the entry point, and everything it did
 * — argument parsing, config resolution, the gate probe, dispatch, the ordered loop, exit
 * mapping — sat in the same 1051 lines as every report derivation. That file crossed the
 * repo's `max-lines` soft limit, and the pressure that put it there is structural rather than
 * accidental: a report builder has to know the ledger's row shape, the accounting policy's
 * verdict shape, the check evaluator's shape and the gate record's shape, and none of those
 * change when a flag is renamed. Deriving an artifact and running a driver are two
 * responsibilities, so they are two modules, and `cli.ts` re-exports this half's public
 * surface so every existing import path still resolves.
 *
 * Two things live here and they are the same concern: RETAINING what the gate measured, and
 * BUILDING the report those retained records support. A run is auditable only if both halves
 * exist — a verdict nobody wrote down, and a report nobody derived, are the two ways #1212
 * left an operator doing arithmetic by hand. The read side (`readGateRecords`) and the write
 * side (`retainGateRecord`) are kept together for the same reason: splitting them would put
 * the producer of `<runRoot>/gates/*.gate.json` in one file and its only reader in another.
 *
 * What this module deliberately does NOT know: what a runner is, what a container provisioned,
 * or what a flag is named. The measurement seam stays in `cli.ts`; `GateRetention` narrows the
 * driver's wiring to the four things a verdict is retained against, so nothing here imports
 * from `cli.ts` and the dependency runs one way.
 *
 * Three properties the artifact has to hold, because the library does not enforce them:
 *  - a pre-dispatch gate failure is counted in BOTH `gateFailures` and `excluded`, and stays
 *    visible in its own `gate` bucket with the records that justify it;
 *  - usage that could not be read prints as `unknown`/null, never as 0, and the ceiling verdict
 *    that follows is the blocking one;
 *  - a `usable` verdict is a function of the required checks, never of the narrative.
 *
 * A gate record is selected BY IDENTITY through `preflight.selectGateRecord`, never by the
 * presence of a file: in #1212 that is exactly how a stale `EXCLUDE:oracle-or-grader` record
 * got picked for a run it did not describe.
 */
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  allocateAttemptId,
  classifyRetained,
  readAttemptRecords,
  recordGateFailure,
  type AttemptStatus,
  type FinalRecord,
  type StartedRecord,
} from "./attempt.js";
import {
  ceilingVerdict,
  computeDenominator,
  COUNTING_POLICY,
  GATE_FAILURE_PREFIX,
  spendForLedger,
  type CeilingVerdict,
  type Denominator,
  type SpendTotals,
  type TokenCeiling,
  type ValidityInput,
} from "./accounting.js";
import {
  evaluateChecks,
  isUnconditionallyUsable,
  usableVerdict,
  type CheckId,
  type CheckResult,
  type ProtocolCompliance,
} from "./checks.js";
import {
  driverSlotsOf,
  type ConfigParams,
  type DriverSlot,
  type EvalManifest,
  type ManifestSlot,
  type ResolvedConfig,
} from "./config.js";
import { retainedCtrfBytes } from "./docker.js";
import type { DriverExit, StopReason } from "./driver.js";
import {
  assessEvidence,
  tallyAttempt,
  type EvidenceAssessment,
  type TallyOutcome,
} from "./evidence.js";
import type { RunIdentity } from "./identities.js";
import {
  appendRow,
  finalizationOf,
  readLedger,
  unfinishedAttempts,
  writeFileFsync,
  type LedgerRow,
} from "./ledger.js";
import {
  selectGateRecord,
  type GateDecision,
  type GateRecord,
} from "./preflight.js";
import { sha256File } from "./runner.js";

/**
 * Shape of a retained grader result line. Only ever applied to a fallback log, never to the
 * observation the attempt finalized with — `accounting.ts` re-tests the recorded line itself.
 */
const RESULT_LINE = /[0-9]+\s+(?:passed|failed|error[s]?)/i;
const NETWORK_MARKER =
  /command not found|Failed to connect|Connection timed out|network timeout/i;

/** Run-root-relative directory holding one identity-bound gate record per slot. */
export const GATES_DIR = "gates";
/** Run-root-relative path of the single machine-readable report artifact. */
export const REPORT_FILE = "run-report.json";
/** Bumped when the report shape changes, so a stale report cannot be read as this one's. */
export const REPORT_SCHEMA_VERSION = 1;
/** Bumped when the retained gate-record shape changes; separate from the report's version. */
export const GATE_RECORD_VERSION = 1;

/**
 * Read a slot's validity evidence from the artifacts the attempt actually retained.
 *
 * `resultLine` and `networkFailureMarker` come from the attempt's OWN finalization record —
 * the place `runStages` persists the observation the runner computes at grade time. They used
 * to be scraped out of `<attemptDir>/process/grader.log`, and NO production path writes that
 * file: the single writer in the tree was a test fixture. So the `result_line` clause failed
 * for every attempt no matter what the run retained — a real `reward=1` with a real result
 * line and a 2878-byte CTRF was published as `INVALID:result_line` in the same report whose
 * attempt row said `phase: "completed"`. Two verdicts for one attempt.
 *
 * The retained grader log is read only as a FALLBACK, for a record that never carried the
 * observation: one finalized before this field existed, or hand-built by a suite that owns
 * neither the runner nor the record. It is a fallback rather than a dependency now that
 * `docker.ts` tees grader output into that path, so the file has a producer on the real path
 * as well. A recorded observation always wins over it, so a recorded network marker can never
 * be washed away by a clean-looking log.
 *
 * A record that never settled — the write-ahead intent row a SIGKILL leaves — carries no
 * observation and no log, so it reads as an empty result line. That FAILS the clause rather
 * than passing it: an unobserved grade is never evidence that a grade happened.
 */
function evidenceFor(runRoot: string, slotKey: string): ValidityInput {
  const attemptDir = join(runRoot, slotKey);
  const final = finalRecordIn(attemptDir);
  const retainedLog = readFileSyncSafe(join(attemptDir, "process/grader.log"));
  return {
    ctrfBytes: retainedCtrfBytes(attemptDir),
    resultLine: final?.resultLine ?? RESULT_LINE.exec(retainedLog)?.[0] ?? "",
    networkFailureMarker:
      final?.networkFailureMarker ?? NETWORK_MARKER.test(retainedLog),
  };
}

/** The attempt's own finalization record, or `null` while it has not settled. */
function finalRecordIn(attemptDir: string): FinalRecord | null {
  return (
    readAttemptRecords(attemptDir).find(
      (record): record is FinalRecord =>
        record.recordType === "attempt-finalized"
    ) ?? null
  );
}

/** Read a retained file, treating an unreadable one as empty. Used by the gate-record reader. */
function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * One row per attempt: its finalization once it settled, its intent while it has not.
 *
 * `computeDenominator` counts the rows it is handed, and a settled attempt leaves TWO (the
 * write-ahead intent plus the finalization). Passing the raw ledger therefore counted every
 * settled attempt twice — precisely the hand arithmetic the report exists to eliminate. The
 * finalization row is preferred because it carries the real `modelDispatched` fact, where
 * the intent row only ever says `false`.
 */
function lifecycleRows(
  rows: ReadonlyArray<LedgerRow>
): ReadonlyArray<LedgerRow> {
  const one = new Map<string, LedgerRow>();
  for (const row of rows) {
    const held = one.get(row.attemptId);
    one.set(
      row.attemptId,
      held === undefined || held.phase === "intent" ? row : held
    );
  }
  return [...one.values()];
}

/**
 * Denominator + spend derived from the retained ledger and each attempt's real artifacts.
 * No number here is hardcoded: every count comes from what a run actually left behind.
 */
export function summarize(
  ledgerPath: string,
  config: Pick<ResolvedConfig, "manifest"> & {
    readonly params: Pick<ConfigParams, "runRoot">;
  }
) {
  const ledger = readLedger(ledgerPath);
  // Keyed by ATTEMPT id, because that is what `computeDenominator` looks the evidence up by.
  // Keying this map by manifest slot key made every lookup miss, so every settled attempt
  // classified as `INVALID:ctrf,result_line` — a denominator that reported zero valid work
  // however much the run actually retained. Fixing the key was necessary and not sufficient:
  // the evidence itself came from a file no production path writes, so `evidenceFor` now reads
  // the grade observation the attempt finalized with.
  const evidence = new Map<string, ValidityInput>();
  for (const row of ledger.rows) {
    if (!evidence.has(row.attemptId)) {
      evidence.set(
        row.attemptId,
        evidenceFor(config.params.runRoot, row.slotKey)
      );
    }
  }
  return {
    denominator: computeDenominator(lifecycleRows(ledger.rows), evidence),
    // `spendForLedger(ledger)`, NOT `aggregateSpend(ledger.rows)`: an unreadable ledger carries
    // `rows: []`, and `aggregateSpend([])` is vacuously `usageComplete`. Deriving from the rows
    // alone therefore reported a confident "known, 0 tokens" and let `ceilingVerdict` take its
    // PERMIT branch, so this artifact published `mayDispatch: true` for exactly the runs whose
    // spend is unknown — contradicting the driver's own budget gate, which already routes through
    // this same function. One channel, so the artifact and the driver cannot disagree.
    spend: spendForLedger(ledger),
    tornLines: ledger.tornLines,
    slots: config.manifest.slots.length,
  };
}

// ---------------------------------------------------------------------------
// Retaining what the gate measured
// ---------------------------------------------------------------------------

/** One retained gate record on disk: the judgement plus the identity it was made against. */
interface RetainedGate {
  readonly recordType: "gate-record";
  readonly schemaVersion: number;
  readonly slotKey: string;
  readonly record: GateRecord;
}

/**
 * Retain one identity-bound gate record under `<runRoot>/gates`.
 *
 * The identity travels INSIDE the record, so a later selection can be made by identity alone.
 * A decision with no record (a reject: the record was missing or stale, so nothing was
 * measured) has nothing to retain and returns `null`.
 */
export function retainGateRecord(
  gatesDir: string,
  slotKey: string,
  decision: GateDecision
): string | null {
  if (decision.record === null) return null;
  mkdirSync(gatesDir, { recursive: true });
  const path = join(gatesDir, `${slotKey}.gate.json`);
  const retained: RetainedGate = {
    recordType: "gate-record",
    schemaVersion: GATE_RECORD_VERSION,
    slotKey,
    record: decision.record,
  };
  writeFileFsync(path, `${JSON.stringify(retained, null, 2)}\n`);
  return path;
}

/**
 * A preflight exclusion as a lifecycle row: never attempted, never model-dispatched, and NOT
 * prefixed `gate:` — a gate failure stops the whole driver while an exclusion skips one slot,
 * so accounting must be able to tell them apart.
 */
export function recordGateExclusion(
  ledgerPath: string,
  started: StartedRecord,
  reason: string
): void {
  appendRow(ledgerPath, {
    attemptId: started.attemptId,
    slotKey: started.slotKey,
    task: started.task,
    arm: started.arm,
    maxTurns: started.maxTurns,
    phase: "invalid",
    recordedAtEpochMs: started.startedAtEpochMs,
    attemptStarted: false,
    modelDispatched: false,
    excluded: true,
    usage: null,
    reason,
  });
}

/** Measured sha of an operator-supplied file; an unreadable file never becomes a claim. */
function shaOrUnreadable(path: string): string {
  try {
    return sha256File(path);
  } catch {
    return "unreadable";
  }
}

/** The identity-bound context a pre-dispatch gate outcome is recorded against. */
function unstartedGateAttempt(
  identity: RunIdentity,
  slot: DriverSlot,
  recordedAtEpochMs: number,
  retention: GateRetention
): StartedRecord {
  return {
    recordType: "attempt-started",
    attemptId: allocateAttemptId(slot.slotKey, recordedAtEpochMs, process.pid),
    slotKey: slot.slotKey,
    task: slot.task,
    arm: slot.arm,
    maxTurns: slot.maxTurns,
    identity,
    pid: process.pid,
    startedAtEpochMs: recordedAtEpochMs,
    attemptStarted: false,
    modelDispatched: false,
    bundleSha256: shaOrUnreadable(retention.bundlePath),
    settingsSha256: shaOrUnreadable(retention.settingsPath),
  };
}

/**
 * What a gate outcome is retained against: an identity binding and the three paths a record and
 * a ledger row are written to. Deliberately narrower than the CLI's `DriverWiring` — retaining a
 * verdict needs no runner and no resolved config, so this module never has to know what a
 * container is, and `cli.ts` does not have to be imported back to reach it.
 */
export interface GateRetention {
  readonly runRoot: string;
  readonly ledgerPath: string;
  readonly bundlePath: string;
  readonly settingsPath: string;
  readonly identityFor: (slot: DriverSlot) => RunIdentity;
}

/** Retain the gate record, and make the outcome countable in the ledger. */
export function retainGateOutcome(
  retention: GateRetention,
  slot: DriverSlot,
  decision: GateDecision
): void {
  const { runRoot, ledgerPath, identityFor } = retention;
  const identity = identityFor(slot);
  const at = decision.record?.recordedAtEpochMs ?? Date.now();
  retainGateRecord(join(runRoot, GATES_DIR), slot.slotKey, decision);
  if (decision.kind === "pass") return;
  const unstarted = unstartedGateAttempt(identity, slot, at, retention);
  const reason = `${decision.verdict}: ${decision.reasons.join("; ")}`;
  if (decision.kind === "reject") {
    recordGateFailure(ledgerPath, unstarted, reason, at);
    return;
  }
  recordGateExclusion(ledgerPath, unstarted, reason);
}

/** Every retained gate record, in slot-key order. A torn record reads as absent, never as OK. */
export function readGateRecords(gatesDir: string): ReadonlyArray<GateRecord> {
  let names: string[];
  try {
    names = readdirSync(gatesDir).sort();
  } catch {
    return [];
  }
  const records: GateRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".gate.json")) continue;
    const retained = parseRetained(readFileSyncSafe(join(gatesDir, name)));
    if (retained !== null) records.push(retained.record);
  }
  return records;
}

function parseRetained(body: string): RetainedGate | null {
  if (body === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const retained = parsed as Partial<RetainedGate>;
  return retained.record === undefined || retained.record === null
    ? null
    : (retained as RetainedGate);
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** One slot's gate outcome, as the report states it. */
export interface GateOutcome {
  readonly slotKey: string;
  readonly verdict: string;
  readonly reasons: ReadonlyArray<string>;
}

export interface GateSummary {
  /** Gate record files actually present under `<runRoot>/gates`. */
  readonly recordsRetained: number;
  /** Missing or stale for this run's identity: presence on disk never selected a record. */
  readonly rejected: ReadonlyArray<GateOutcome>;
  /** Explicit exclusions — a task/environment property, never a task failure. */
  readonly exclusions: ReadonlyArray<GateOutcome>;
  readonly passed: ReadonlyArray<string>;
  /** Pre-dispatch gate refusals recorded in the ledger, with the reasons they give. */
  readonly ledgerRefusals: ReadonlyArray<{ slotKey: string; reason: string }>;
}

export interface SpendSummary {
  /** `unknown` whenever any started attempt's usage could not be read. Never laundered to 0. */
  readonly usage: "known" | "unknown";
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly totalTokens: number | null;
  /**
   * Sums over the attempts whose usage IS known. When `usage` is `unknown` these are a
   * partial view, kept so a reader can see what was measured without it passing for a total.
   */
  readonly observed: SpendTotals;
  readonly usageComplete: boolean;
  readonly unknownUsageAttempts: ReadonlyArray<string>;
}

export interface ChecksSummary {
  readonly usable: boolean;
  readonly verdict: "usable" | "not-usable";
  /** True only when a verdict may be stated with no reservation at all. */
  readonly unconditional: boolean;
  readonly failedCheckIds: ReadonlyArray<CheckId>;
  readonly checks: ReadonlyArray<CheckResult>;
}

/** One attempt as its retained records describe it. */
export interface AttemptFact {
  readonly attemptId: string;
  readonly slotKey: string;
  readonly phase: "intent" | AttemptStatus;
  readonly modelDispatched: boolean;
  readonly gateFailure: boolean;
  readonly excluded: boolean;
  readonly usageKnown: boolean;
  /** What the attempt directory retains; `missing` means no started record at all. */
  readonly retained: "missing" | "interrupted" | AttemptStatus;
  readonly reason: string;
}

/** The single machine-readable artifact the operator reads instead of recomputing totals. */
export interface RunReport {
  readonly schemaVersion: number;
  readonly mode: "run" | "report-only";
  readonly runId: string;
  readonly code: number;
  /** `null` in report-only mode: no loop ran, so no stop reason is claimed. */
  readonly stopReason: StopReason | null;
  readonly stoppedAt: string | null;
  readonly slots: number;
  readonly denominator: Denominator;
  readonly gate: GateSummary;
  readonly attempts: ReadonlyArray<AttemptFact>;
  readonly spend: SpendSummary;
  readonly ceiling: CeilingVerdict;
  readonly checks: ChecksSummary;
  readonly countingPolicy: typeof COUNTING_POLICY;
  /** Torn ledger lines; `null` when the ledger was never read (unknown is not zero). */
  readonly tornLines: number | null;
  readonly reportPath: string;
}

export interface ReportInput {
  readonly mode: "run" | "report-only";
  readonly ledgerPath: string;
  readonly runRoot: string;
  readonly manifest: EvalManifest;
  /** The identity a gate record must match to be selectable. Never inferred from a record. */
  readonly identityFor: (slot: ManifestSlot) => RunIdentity;
  readonly ceiling: TokenCeiling | null;
  /** `null` in report-only mode: no loop ran, so no stop reason is claimed. */
  readonly exit: DriverExit | null;
}

/** A pre-dispatch refusal, per accounting's own rule. Never an attempt, never a task outcome. */
function isGateRefusal(row: LedgerRow): boolean {
  return row.reason.startsWith(GATE_FAILURE_PREFIX);
}

/** Attempt rows only. Mirrors `computeDenominator`, which files the rest elsewhere. */
function isAttemptRow(row: LedgerRow): boolean {
  return !row.excluded && !isGateRefusal(row);
}

/** One fact per attempt, from the ledger rows and the records its own directory retained. */
function attemptFacts(
  runRoot: string,
  rows: ReadonlyArray<LedgerRow>
): ReadonlyArray<AttemptFact> {
  const facts = new Map<string, AttemptFact>();
  for (const row of rows) {
    if (isAttemptRow(row))
      facts.set(
        row.attemptId,
        attemptFact(runRoot, row, finalizationOf(rows, row.attemptId))
      );
  }
  return [...facts.values()];
}

/**
 * One attempt, read off the LAST row that describes it: the finalization when it settled,
 * the write-ahead intent while it has not. The intent row is deliberately the fallback — its
 * `reason` is empty, its `modelDispatched` is false and its `usage` is null, which are exactly
 * the values "never settled" must report rather than guesses at what the attempt did.
 */
function attemptFact(
  runRoot: string,
  row: LedgerRow,
  final: LedgerRow | null
): AttemptFact {
  const last = final ?? row;
  return {
    attemptId: row.attemptId,
    slotKey: row.slotKey,
    phase: last.phase,
    modelDispatched: last.modelDispatched,
    gateFailure: isGateRefusal(last),
    excluded: last.excluded,
    usageKnown: last.usage !== null,
    retained: classifyRetained(join(runRoot, row.slotKey)),
    reason: last.reason,
  };
}

/**
 * Spend as an operator must read it: every counter is `null` while any attempt's usage is
 * unknown, so a partial sum can never be mistaken for what the run spent.
 */
function spendSummary(spend: SpendTotals): SpendSummary {
  const unknown = !spend.usageComplete;
  return {
    usage: unknown ? "unknown" : "known",
    inputTokens: unknown ? null : spend.inputTokens,
    outputTokens: unknown ? null : spend.outputTokens,
    cacheCreationInputTokens: unknown ? null : spend.cacheCreationInputTokens,
    cacheReadInputTokens: unknown ? null : spend.cacheReadInputTokens,
    totalTokens: unknown ? null : spend.totalTokens,
    observed: spend,
    usageComplete: spend.usageComplete,
    unknownUsageAttempts: spend.unknownUsageAttempts,
  };
}

/**
 * The gate summary for a run, with every slot's record selected BY IDENTITY through
 * `selectGateRecord`. A retained file whose identity drifted is reported as rejected even
 * though it is right there: that is the selection rule, and presence is not selection.
 */
function gateSummary(
  gatesDir: string,
  manifest: EvalManifest,
  identityFor: (slot: ManifestSlot) => RunIdentity,
  rows: ReadonlyArray<LedgerRow>
): GateSummary {
  const records = readGateRecords(gatesDir);
  const rejected: GateOutcome[] = [];
  const exclusions: GateOutcome[] = [];
  const passed: string[] = [];
  for (const slot of driverSlotsOf(manifest)) {
    const decision = selectGateRecord(records, identityFor(slot));
    if (decision.kind === "reject")
      rejected.push(gateOutcome(slot.slotKey, decision));
    else if (decision.kind === "exclude")
      exclusions.push(gateOutcome(slot.slotKey, decision));
    else passed.push(slot.slotKey);
  }
  return {
    recordsRetained: records.length,
    rejected,
    exclusions,
    passed,
    ledgerRefusals: rows
      .filter(isGateRefusal)
      .map((row) => ({ slotKey: row.slotKey, reason: row.reason })),
  };
}

function gateOutcome(slotKey: string, decision: GateDecision): GateOutcome {
  return { slotKey, verdict: decision.verdict, reasons: decision.reasons };
}

/** The tally of an attempt directory, or the fact that the tally itself could not run. */
function tallyOutcome(dir: string): TallyOutcome {
  try {
    return { kind: "tally", tally: tallyAttempt(dir) };
  } catch (error) {
    return { kind: "tally-failed", message: String(error) };
  }
}

/**
 * The attempt evidence every check is read off: the ledger's rows and the facts derived from
 * them, bound to the run root that holds the artifacts. Bundled because it is exactly this
 * triple that `evidenceAssessments`, `protocolOf` and `checksOf` each need — passing it as
 * three positional arguments to three functions is what pushed `checksOf` past the parameter
 * budget, and one object is the single place the pairing of rows to facts is stated.
 */
interface AttemptEvidence {
  readonly runRoot: string;
  readonly rows: ReadonlyArray<LedgerRow>;
  readonly facts: ReadonlyArray<AttemptFact>;
}

/**
 * Evidence assessment per attempt, from the artifacts it retained.
 *
 * `expectedTraces` is `null` because no caller can know the expectation up front — inventing
 * one here is what made the #1212 completeness verdict meaningless. The assessment therefore
 * records `unknown-expectation`, which fails `evidence-complete` rather than claiming a
 * completeness the run cannot prove. The stated gap is the honest report.
 */
function evidenceAssessments(
  evidence: AttemptEvidence
): ReadonlyArray<EvidenceAssessment> {
  return evidence.facts.map((fact) => {
    const final = finalRecordOf(
      evidence.runRoot,
      evidence.rows,
      fact.attemptId
    );
    return assessEvidence(tallyOutcome(join(evidence.runRoot, fact.slotKey)), {
      reward: final?.reward ?? "unknown",
      graderExit: final?.graderExit ?? -1,
      expectedTraces: null,
    });
  });
}

/** The retained finalization record for an attempt, or `null` while it never settled. */
function finalRecordOf(
  runRoot: string,
  rows: ReadonlyArray<LedgerRow>,
  attemptId: string
): FinalRecord | null {
  const final = finalizationOf(rows, attemptId);
  if (final === null) return null;
  const record = readAttemptRecords(join(runRoot, final.slotKey)).find(
    (entry): entry is FinalRecord => entry.recordType === "attempt-finalized"
  );
  return record ?? null;
}

/**
 * How many distinct attempts each slot saw. More than one is a re-driven slot.
 *
 * Gate rows are excluded through the same `isAttemptRow` predicate `attemptFacts` uses: a gate
 * outcome carries a FRESH synthetic attempt id, so a slot gated twice in one run root — the restart
 * case — counted two attempts here and failed `oneAttemptPerSlot` with no re-drive possible. A
 * pre-dispatch refusal is not an attempt; `computeDenominator` files it in the gate bucket.
 */
function attemptsPerSlot(
  rows: ReadonlyArray<LedgerRow>
): ReadonlyMap<string, number> {
  const perSlot = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!isAttemptRow(row)) continue;
    const seen = perSlot.get(row.slotKey) ?? new Set<string>();
    seen.add(row.attemptId);
    perSlot.set(row.slotKey, seen);
  }
  return new Map([...perSlot].map(([slotKey, seen]) => [slotKey, seen.size]));
}

/**
 * How many times each attempt was settled. A second finalization is a re-drive signature.
 *
 * Filtered by `isAttemptRow` for the same reason as `attemptsPerSlot`: a gate row is a pre-dispatch
 * refusal with a final phase, so counting it charged a slot that never dispatched a model with a
 * settlement and violated `noRetries`.
 */
function settlementsPerAttempt(
  rows: ReadonlyArray<LedgerRow>
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!isAttemptRow(row) || row.phase === "intent") continue;
    counts.set(row.attemptId, (counts.get(row.attemptId) ?? 0) + 1);
  }
  return counts;
}

/** Protocol compliance, read off the records rather than asserted by the narrative. */
function protocolOf(
  manifest: EvalManifest,
  evidence: AttemptEvidence
): ProtocolCompliance {
  const { runRoot, rows, facts } = evidence;
  return {
    frozenBeforeAnyOutcome: manifest.frozenBeforeAnyOutcome,
    oneAttemptPerSlot: [...attemptsPerSlot(rows).values()].every(
      (count) => count <= 1
    ),
    noRetries: [...settlementsPerAttempt(rows).values()].every(
      (count) => count <= 1
    ),
    // The ORIGINAL grader ran independently of the agent's stop reason, so an attempt that
    // never recorded a grader exit cannot be claimed to have used it.
    originalGraderUsed: facts.every(
      (fact) => finalRecordOf(runRoot, rows, fact.attemptId)?.graderExit != null
    ),
  };
}

/**
 * The required checks. A failed one is what forbids an unconditional `usable` verdict.
 *
 * `acceptedStimuli` is the frozen list minus the slots the gate explicitly excluded, not the
 * number of attempts that happened: a slot the driver accepted and then never settled — a
 * ceiling stop, a contended slot, a killed run — is exactly the gap `stimuli-settled` exists
 * to name. Counting only the attempts would make every partial run read as complete.
 *
 * `settledStimuli` is NOT clamped to `acceptedStimuli`. The `Math.min` that used to do that hid
 * over-settlement, which is a protocol fault and belongs in a failed check; `run-measured` is what
 * names it. `declaredSlots`/`attemptedStimuli` are what put a floor under the run, so a declared
 * slot list that produced nothing is refused instead of passing every check vacuously.
 */
function checksOf(
  manifest: EvalManifest,
  summary: {
    denominator: Denominator;
    tornLines: number | null;
    slots: number;
  },
  evidence: AttemptEvidence,
  gate: GateSummary
) {
  const unfinished = unfinishedAttempts(evidence.rows).length;
  const settled = Math.max(0, summary.denominator.attempted - unfinished);
  const accepted = Math.max(0, summary.slots - gate.exclusions.length);
  return evaluateChecks({
    unfinishedAttempts: unfinished,
    tornLedgerLines: summary.tornLines,
    declaredSlots: summary.slots,
    attemptedStimuli: summary.denominator.attempted,
    acceptedStimuli: accepted,
    settledStimuli: settled,
    evidence: evidenceAssessments(evidence),
    protocol: protocolOf(manifest, evidence),
    gateFailures: summary.denominator.gateFailures,
  });
}

/**
 * Build the report. Every field comes from `summarize` (ledger + retained artifacts) or from
 * the records themselves; nothing is a literal. `readLedger` is called again here for the
 * row-level detail `summarize` does not surface, and the file does not change between the
 * two reads — the loop has already finished.
 */
export function buildReport(input: ReportInput): RunReport {
  const summary = summarize(input.ledgerPath, {
    manifest: input.manifest,
    params: { runRoot: input.runRoot },
  });
  const rows = readLedger(input.ledgerPath).rows;
  const facts = attemptFacts(input.runRoot, rows);
  const evidence: AttemptEvidence = { runRoot: input.runRoot, rows, facts };
  const gate = gateSummary(
    join(input.runRoot, GATES_DIR),
    input.manifest,
    input.identityFor,
    rows
  );
  const checks = checksOf(input.manifest, summary, evidence, gate);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: input.mode,
    runId: input.manifest.runId,
    code: input.exit?.code ?? 0,
    stopReason: input.exit?.stopReason ?? null,
    stoppedAt: input.exit?.stoppedAt ?? null,
    slots: summary.slots,
    denominator: summary.denominator,
    gate,
    attempts: facts,
    spend: spendSummary(summary.spend),
    ceiling: ceilingVerdict(summary.spend, input.ceiling),
    checks: {
      usable: checks.usable,
      verdict: usableVerdict(checks),
      unconditional: isUnconditionallyUsable(checks),
      failedCheckIds: checks.failedCheckIds,
      checks: checks.checks,
    },
    countingPolicy: COUNTING_POLICY,
    tornLines: summary.tornLines,
    reportPath: join(input.runRoot, REPORT_FILE),
  };
}

/** Persist the artifact the operator reads. The same object is what the CLI prints. */
export function persistReport(runRoot: string, report: RunReport): RunReport {
  mkdirSync(runRoot, { recursive: true });
  writeFileFsync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
