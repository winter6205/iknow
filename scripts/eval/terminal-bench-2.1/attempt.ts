/**
 * One attempt: durable lifecycle from allocation to finalization.
 *
 * Why this exists (issue 1219 requirement 2): in #1212 the driver appended its ledger row
 * only after the runner returned and after tallying, so a driver killed mid-attempt left
 * real tokens and no row. Here the order is inverted and made durable:
 *
 *   1. claim the manifest slot exclusively (two drivers cannot take the same slot);
 *   2. reserve the attempt directory exclusively (no accidental reuse or overwrite);
 *   3. fsync a `started` record — BEFORE the runner is invoked at all;
 *   4. append the ledger intent row;
 *   5. only then provision, dispatch and grade.
 *
 * Because step 3 precedes the runner, a process SIGKILLed at any point afterwards leaves a
 * discoverable, classifiable `interrupted` attempt. SIGKILL cannot run cleanup, so recovery
 * is by reconciliation from the retained records rather than by a graceful handler.
 *
 * The catchable half of the same requirement is handled inside `runAttempt`: a SIGTERM or
 * SIGINT CAN run cleanup, so waiting for a later reconciliation would leave the attempt open
 * for as long as the operator waits. `runAttempt` therefore finalizes at signal time, with
 * the status and usage actually known then, reaps what the attempt owns, and re-raises the
 * signal so the driver's exit is still the operator's signal rather than a success. The two
 * halves are complementary and neither replaces the other: the durable `started` record is
 * still what exposes a SIGKILL, which no handler can see.
 *
 * Also fixed from #1212: `model_dispatched`/`attempt_started` were written as the literal
 * string `pending` and never updated, and a constant `bundle_sha256` was written into the
 * ledger without hashing the extracted bundle. Both are real booleans and a recomputed
 * digest here.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import type { RunIdentity } from "./identities.js";
import { GATE_FAILURE_PREFIX } from "./accounting.js";
import type {
  AgentDispatchObservation,
  DispatchModel,
  DispatchStopReason,
  DispatchUsage,
} from "./docker.js";
import { appendRow, type LedgerRow, type UsageRecord } from "./ledger.js";
import {
  sha256File,
  verifyInstrument,
  type DispatchObservation,
  type ProvisionSpec,
  type RunnerPort,
} from "./runner.js";

/** Attempt outcome phase, as written to the attempt's own record file. */
export type AttemptStatus = "completed" | "invalid" | "interrupted";

export interface StartedRecord {
  readonly recordType: "attempt-started";
  readonly attemptId: string;
  readonly slotKey: string;
  readonly task: string;
  readonly arm: string;
  readonly maxTurns: number;
  readonly identity: RunIdentity;
  readonly pid: number;
  readonly startedAtEpochMs: number;
  /** Real booleans. #1212 wrote `pending` here and never updated it. */
  readonly attemptStarted: boolean;
  readonly modelDispatched: boolean;
  /** Recomputed from the extracted bundle, never a constant. */
  readonly bundleSha256: string;
  /** Hash of the host settings file. Contents never enter a record or fixture. */
  readonly settingsSha256: string;
}

/**
 * What the agent PUBLISHED about its dispatch, typed rather than flattened.
 *
 * This is the record's copy of the runner's parsed observation. The flattened `model`/`reason`
 * columns alone cannot carry the distinction that matters to an auditor: `unreadable-agent-output`
 * is a bare string there, indistinguishable from an ordinary producer value unless the retained
 * transcript under `process/ask.*` is opened, and the usage state is not on the row at all.
 *
 * Deliberately NOT carried here, even though the observation holds it:
 *
 *  - `agentOutput`, the whole stdout+stderr transcript. A row is appended once per attempt and
 *    is read by every consumer; a transcript would make it unbounded and would copy model output
 *    into a second durable place. Its home is the retained host artifacts (`process/ask.stdout`,
 *    `process/ask.stderr`), which `docker.ts` writes for exactly that reason.
 *  - anything from the settings file other than the route. That file carries the API key, so
 *    `readModelRoute` returns only `{source, route}` or `{source:"unavailable", route:null, detail}`
 *    — a `detail` that names the FILE, never its contents. Only those typed facts are persisted
 *    here, so no secret can reach a record, a log or an error message by this path.
 */
export interface DispatchEvidence {
  readonly stopReason: DispatchStopReason;
  readonly model: DispatchModel;
  readonly usage: DispatchUsage;
}

export interface FinalRecord {
  readonly recordType: "attempt-finalized";
  readonly attemptId: string;
  readonly status: AttemptStatus;
  readonly finishedAtEpochMs: number;
  readonly modelDispatched: boolean;
  readonly exitCodes: Readonly<Record<string, number>>;
  readonly reward: string | null;
  readonly graderExit: number | null;
  readonly usage: UsageRecord | null;
  readonly model: string;
  readonly reason: string;
  /**
   * The grader's result line, as observed at grade time.
   *
   * Why it is retained HERE: the validity rule in `accounting.ts` needs a result line, and
   * `report.ts` used to look for one in `<attemptDir>/process/grader.log` — a file nothing on
   * the production path writes. The runner computes the observation (`docker.ts` derives it
   * from grader output), so persisting it on the record is the only place the evidence can
   * come from that is actually produced.
   *
   * Optional ONLY because a finalization payload is also constructed by callers this module
   * does not own (`cli.test.ts`), and a required field would break a file this fix must not
   * touch. Absent means "not observed", and `report.ts` reads absent as a FAILED
   * `result_line` clause — never as a pass.
   */
  readonly resultLine?: string;
  /** Whether grader output carried a network-failure marker. Absent means "not observed". */
  readonly networkFailureMarker?: boolean;
  /**
   * The runner's PARSED dispatch facts, so a real stop reason is tellable from an unreadable
   * agent output by reading the ROW ALONE rather than by opening `process/ask.*`.
   *
   * Optional ONLY because a finalization payload is also constructed by callers this module does
   * not own (`cli.test.ts`, `reconcileInterrupted`, the pre-dispatch and signal paths), and a
   * required field would break files this change must not touch. Absent means "this runner port
   * reported no parsed evidence" — it is NOT "the agent output was unreadable", and it is never
   * read as such. See `dispatchEvidenceOf`.
   */
  readonly dispatchEvidence?: DispatchEvidence;
}

export type AttemptRecord = StartedRecord | FinalRecord;

const STARTED_FILE = "attempt-started.json";
const FINAL_FILE = "attempt-finalized.json";

export class SlotClaimError extends Error {
  constructor(
    readonly slotKey: string,
    readonly holder: string
  ) {
    super(`manifest slot ${slotKey} is already claimed by ${holder}`);
    this.name = "SlotClaimError";
  }
}

export class AttemptDirReservedError extends Error {
  constructor(readonly dir: string) {
    super(
      `attempt directory ${dir} is already reserved; refusing to reuse or overwrite it`
    );
    this.name = "AttemptDirReservedError";
  }
}

/** Unique per attempt: slot, wall-clock start and pid, so no two attempts collide. */
export function allocateAttemptId(
  slotKey: string,
  startedAtEpochMs: number,
  pid: number
): string {
  return `${slotKey}@${startedAtEpochMs}-${pid}`;
}

/**
 * Claim a manifest slot EXCLUSIVELY using O_EXCL. This is the cross-process lock: two
 * concurrent drivers racing for the same slot cannot both win, because the kernel decides
 * the winner atomically rather than a check-then-write in user space.
 */
export function claimSlot(
  slotsDir: string,
  slotKey: string,
  attemptId: string
): string {
  mkdirSync(slotsDir, { recursive: true });
  const claimPath = join(slotsDir, `${slotKey}.claim`);
  try {
    const fd = openSync(claimPath, "wx");
    try {
      appendFileSync(fd, `${attemptId}\n`);
    } finally {
      closeSync(fd);
    }
    return claimPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let holder = "unknown holder";
    try {
      holder = readFileSync(claimPath, "utf8").trim();
    } catch {
      // An unreadable claim is still a claim: fail closed rather than hand out the slot.
    }
    throw new SlotClaimError(slotKey, holder);
  }
}

/** Release a slot claim. Idempotent: a crash path may call it after a partial write. */
export function releaseSlot(claimPath: string): void {
  rmSync(claimPath, { force: true });
}

/**
 * Reserve the attempt output directory EXCLUSIVELY. `mkdirSync` without `recursive` throws
 * EEXIST rather than silently reusing a directory, which is what prevents an accidental
 * re-run from overwriting a prior attempt's evidence.
 */
export function reserveAttemptDir(runRoot: string, slotKey: string): string {
  const dir = join(runRoot, slotKey);
  try {
    mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new AttemptDirReservedError(dir);
  }
  return dir;
}

/**
 * Write a record and fsync it. The fsync is the load-bearing part: without it a SIGKILLed
 * process can leave a `started` record that exists in the page cache but never reached disk.
 */
function writeRecordFsync(path: string, record: unknown): void {
  const fd = openSync(path, "w");
  try {
    appendFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface BeginAttemptInput {
  readonly runRoot: string;
  readonly slotsDir: string;
  readonly slotKey: string;
  readonly task: string;
  readonly arm: string;
  readonly maxTurns: number;
  readonly identity: RunIdentity;
  readonly ledgerPath: string;
  readonly bundlePath: string;
  readonly settingsPath: string | null;
  readonly startedAtEpochMs?: number;
  readonly pid?: number;
}

export interface AttemptHandle {
  readonly attemptId: string;
  readonly slotKey: string;
  readonly dir: string;
  readonly claimPath: string;
  readonly started: StartedRecord;
}

/**
 * Allocate an attempt: claim the slot, reserve the directory, fsync the `started` record and
 * append the ledger intent row. After this returns, the attempt exists on durable storage and
 * must appear in the denominator even if nothing else ever runs.
 */
export function beginAttempt(input: BeginAttemptInput): AttemptHandle {
  const pid = input.pid ?? process.pid;
  const startedAtEpochMs = input.startedAtEpochMs ?? Date.now();
  const attemptId = allocateAttemptId(input.slotKey, startedAtEpochMs, pid);
  const claimPath = claimSlot(input.slotsDir, input.slotKey, attemptId);
  try {
    const dir = reserveAttemptDir(input.runRoot, input.slotKey);
    const started: StartedRecord = {
      recordType: "attempt-started",
      attemptId,
      slotKey: input.slotKey,
      task: input.task,
      arm: input.arm,
      maxTurns: input.maxTurns,
      identity: input.identity,
      pid,
      startedAtEpochMs,
      attemptStarted: true,
      // Real boolean, not #1212's un-updated `pending` string.
      modelDispatched: false,
      bundleSha256: sha256File(input.bundlePath),
      settingsSha256:
        input.settingsPath === null ? "absent" : sha256File(input.settingsPath),
    };
    writeRecordFsync(join(dir, STARTED_FILE), started);
    appendRow(input.ledgerPath, intentRow(started));
    return { attemptId, slotKey: input.slotKey, dir, claimPath, started };
  } catch (error) {
    // Leaving the claim behind would block the slot forever; the attempt never began.
    releaseSlot(claimPath);
    throw error;
  }
}

/** The write-ahead ledger row: the attempt exists, with a REAL model-dispatch boolean. */
function intentRow(started: StartedRecord): LedgerRow {
  return {
    attemptId: started.attemptId,
    slotKey: started.slotKey,
    task: started.task,
    arm: started.arm,
    maxTurns: started.maxTurns,
    phase: "intent",
    recordedAtEpochMs: started.startedAtEpochMs,
    attemptStarted: started.attemptStarted,
    modelDispatched: started.modelDispatched,
    excluded: false,
    usage: null,
    reason: "",
  };
}

/**
 * Append the finalization record and its ledger row.
 *
 * `recordType` is stamped HERE, not taken from the caller: a finalization record whose
 * type is caller-supplied can be written without one, and a record with no type is exactly
 * the thing `classifyRetained` cannot find — which silently degrades an attempt to
 * `interrupted`.
 */
export function finalizeAttempt(
  handle: AttemptHandle,
  ledgerPath: string,
  final: Omit<FinalRecord, "attemptId" | "recordType">
): FinalRecord {
  const record: FinalRecord = {
    ...final,
    recordType: "attempt-finalized",
    attemptId: handle.attemptId,
  };
  writeRecordFsync(join(handle.dir, FINAL_FILE), record);
  appendRow(ledgerPath, {
    attemptId: handle.attemptId,
    slotKey: handle.slotKey,
    task: handle.started.task,
    arm: handle.started.arm,
    maxTurns: handle.started.maxTurns,
    phase: final.status,
    recordedAtEpochMs: final.finishedAtEpochMs,
    attemptStarted: true,
    modelDispatched: final.modelDispatched,
    excluded: false,
    usage: final.usage,
    reason: final.reason,
  });
  return record;
}

/** Append a finalization row for an attempt that never started (gate refusal). */
export function recordGateFailure(
  ledgerPath: string,
  started: StartedRecord,
  reason: string,
  finishedAtEpochMs: number
): void {
  appendRow(ledgerPath, {
    attemptId: started.attemptId,
    slotKey: started.slotKey,
    task: started.task,
    arm: started.arm,
    maxTurns: started.maxTurns,
    phase: "invalid",
    recordedAtEpochMs: finishedAtEpochMs,
    attemptStarted: false,
    modelDispatched: false,
    excluded: true,
    usage: null,
    reason: `${GATE_FAILURE_PREFIX}${reason}`,
  });
}

/** Read the retained records for an attempt directory; missing files read as absent. */
export function readAttemptRecords(dir: string): ReadonlyArray<AttemptRecord> {
  const records: AttemptRecord[] = [];
  for (const file of [STARTED_FILE, FINAL_FILE]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      records.push(JSON.parse(readFileSync(path, "utf8")) as AttemptRecord);
    } catch {
      // A torn record is evidence of a kill, not a reason to discard the other record.
    }
  }
  return records;
}

/** True when an attempt directory holds a durable `started` record. */
export function hasStartedRecord(dir: string): boolean {
  return existsSync(join(dir, STARTED_FILE));
}

/**
 * Classify an attempt from its retained records alone.
 *
 * `started` with no finalization means the process died before the runner returned — the
 * SIGKILL case, where no handler could run. That is `interrupted`, never `missing`.
 */
export function classifyRetained(
  dir: string
): "missing" | "interrupted" | AttemptStatus {
  const records = readAttemptRecords(dir);
  const final = records.find(
    (record) => record.recordType === "attempt-finalized"
  );
  if (final !== undefined) return final.status;
  return hasStartedRecord(dir) ? "interrupted" : "missing";
}

/** Reconcile unfinished attempts from retained artifacts and mark them interrupted. */
export function reconcileInterrupted(
  ledgerPath: string,
  handleById: ReadonlyMap<string, AttemptHandle>,
  finishedAtEpochMs: number
): ReadonlyArray<string> {
  const reconciled: string[] = [];
  for (const [attemptId, handle] of handleById) {
    if (classifyRetained(handle.dir) !== "interrupted") continue;
    finalizeAttempt(handle, ledgerPath, {
      status: "interrupted",
      finishedAtEpochMs,
      modelDispatched: handle.started.modelDispatched,
      exitCodes: {},
      reward: null,
      graderExit: null,
      usage: null,
      model: "unknown",
      reason: "reconciled-from-retained-artifacts",
    });
    reconciled.push(attemptId);
  }
  return reconciled;
}

export interface RunAttemptDeps {
  readonly runner: RunnerPort;
  readonly provisionSpec: ProvisionSpec;
  readonly maxTurns: number;
  readonly agentWallSec: number;
  readonly graderGraceSec: number;
  /** Declared verifier timeout from the task; the grader wall is this plus the grace. */
  readonly declaredVerifierTimeoutSec: number;
  /**
   * Reads spend back from the retained traces. Returning `null` means UNKNOWN, never
   * zero: an unreadable tally must halt further dispatch rather than look free.
   */
  readonly readUsage: (dir: string) => UsageRecord | null;
}

export interface RunAttemptResult {
  readonly attemptId: string;
  readonly status: AttemptStatus;
  readonly reward: string | null;
  readonly usage: UsageRecord | null;
  /**
   * The signal that finalized this attempt, or `null` when it settled normally. A driver
   * that only reads `status` still sees `interrupted`; this names the cause.
   */
  readonly signal: TerminationSignal | null;
}

/** A stop this process can still act on. SIGKILL is deliberately absent: nothing can. */
export type TerminationSignal = "SIGTERM" | "SIGINT";

/** Conventional 128+signum codes, so a caller that catches the re-raise still exits nonzero. */
const SIGNAL_EXIT_CODES: Readonly<Record<TerminationSignal, number>> = {
  SIGTERM: 143,
  SIGINT: 130,
};

/** Reason stamped on a finalization record written at signal time. */
const TERMINATION_REASON_PREFIX = "terminated-by:";

/** What the stages have established SO FAR, readable from inside a signal handler. */
interface AttemptProgress {
  /** Exit codes observed up to this moment; a signal records only what really ran. */
  exitCodes: Record<string, number>;
  /** Model identity once dispatch returned it; `none` before that. */
  model: string;
  /** True once the runner's dispatch was invoked, so the model may already have been called. */
  dispatched: boolean;
}

/**
 * One attempt's single right to write a finalization record, plus its process-level signal
 * wiring. A signal races the stages, so exactly one of {signal handler, normal return} may
 * finalize; the loser is told it lost instead of writing a second record.
 */
interface TerminationGuard {
  /** Finalize normally. False means a signal already finalized this attempt. */
  settle(final: Omit<FinalRecord, "attemptId" | "recordType">): boolean;
  /** Remove this attempt's process-level listeners. Idempotent. */
  dispose(): void;
  /** The signal that claimed the attempt, or `null` when it settled normally. */
  signal(): TerminationSignal | null;
}

/**
 * Install SIGTERM/SIGINT handling for one attempt.
 *
 * The order is load-bearing, not stylistic:
 *   1. claim the attempt, so a second signal — or a normal return that lands at the same
 *      moment — cannot finalize it twice;
 *   2. remove our own listeners, because re-raising while they are still installed is
 *      swallowed and re-enters the handler forever instead of terminating the process;
 *   3. write the finalization record NOW, while there is still a live process to write it: a
 *      second signal during teardown must never be able to lose the attempt's settlement;
 *   4. reap what the attempt owns, then restore the default disposition and re-raise, so the
 *      driver's exit remains the operator's signal instead of a success.
 *
 * Listeners are process-global, so `dispose` runs on every exit path including the normal
 * one. A driver runs many attempts in a single process, and one unremoved listener per
 * attempt would accumulate past Node's max-listeners warning long before the run finished.
 */
function installTerminationGuard(
  handle: AttemptHandle,
  ledgerPath: string,
  deps: RunAttemptDeps,
  progress: AttemptProgress
): TerminationGuard {
  let state: "running" | "finalized" | "terminated" = "running";
  let received: TerminationSignal | null = null;

  const dispose = (): void => {
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
  };
  const terminate = (signal: TerminationSignal): void => {
    if (state !== "running") return;
    state = "terminated";
    received = signal;
    dispose();
    finalizeAttempt(
      handle,
      ledgerPath,
      interruptedFinal(handle, deps, progress, signal)
    );
    void reapAndReraise(deps, signal);
  };
  const onTerm = (): void => terminate("SIGTERM");
  const onInt = (): void => terminate("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  return {
    settle: (final) => {
      if (state !== "running") return false;
      state = "finalized";
      finalizeAttempt(handle, ledgerPath, final);
      return true;
    },
    dispose,
    signal: () => received,
  };
}

/**
 * The finalization payload for a signalled attempt: what is genuinely known at signal time.
 * Usage is read back from the artifacts the attempt already retained, and stays `null` only
 * when it is genuinely unreadable — which accounting treats as unknown, never as zero.
 */
function interruptedFinal(
  handle: AttemptHandle,
  deps: RunAttemptDeps,
  progress: AttemptProgress,
  signal: TerminationSignal
): Omit<FinalRecord, "attemptId" | "recordType"> {
  return {
    status: "interrupted",
    finishedAtEpochMs: Date.now(),
    modelDispatched: progress.dispatched,
    exitCodes: progress.exitCodes,
    reward: null,
    graderExit: null,
    usage: readObservedUsage(deps, handle.dir),
    model: progress.model,
    reason: `${TERMINATION_REASON_PREFIX}${signal}`,
  };
}

/** Read usage at signal time. A throwing reader must not cost us the finalization itself. */
function readObservedUsage(
  deps: RunAttemptDeps,
  dir: string
): UsageRecord | null {
  try {
    return deps.readUsage(dir);
  } catch (error) {
    console.error(
      `attempt teardown: usage unreadable at signal time: ${String(error)}`
    );
    return null;
  }
}

/**
 * Reap what the attempt owns, then hand the process back to the signal's default
 * disposition. A failed reap is reported rather than swallowed, but it never keeps a
 * signalled process alive: the attempt is already durably finalized and the operator asked
 * to stop.
 */
async function reapAndReraise(
  deps: RunAttemptDeps,
  signal: TerminationSignal
): Promise<void> {
  try {
    await deps.runner.reap(deps.provisionSpec);
  } catch (error) {
    console.error(
      `attempt teardown: reap failed before ${signal}: ${String(error)}`
    );
  }
  process.exitCode = SIGNAL_EXIT_CODES[signal];
  process.kill(process.pid, signal);
}

/** What a caller sees when a signal finalized the attempt before its stages could. */
function interruptedResult(
  handle: AttemptHandle,
  guard: TerminationGuard
): RunAttemptResult {
  return {
    attemptId: handle.attemptId,
    status: "interrupted",
    reward: null,
    usage: null,
    signal: guard.signal(),
  };
}

interface AttemptOutcome {
  readonly final: Omit<FinalRecord, "attemptId" | "recordType">;
  readonly status: AttemptStatus;
  readonly reward: string | null;
  readonly usage: UsageRecord | null;
}

/**
 * Run one attempt through the injected runner port, finalizing on every path.
 *
 * A catchable SIGTERM/SIGINT is finalized HERE, at signal time, rather than left for a later
 * reconciliation: the attempt's known status and observed usage are only knowable while the
 * process is still alive to write them down. `cli.ts` needs no change for this — the handler
 * re-raises the signal itself, so the driver dies by it exactly as it would have without us.
 */
export async function runAttempt(
  handle: AttemptHandle,
  ledgerPath: string,
  deps: RunAttemptDeps
): Promise<RunAttemptResult> {
  const progress: AttemptProgress = {
    exitCodes: {},
    model: "none",
    dispatched: false,
  };
  const guard = installTerminationGuard(handle, ledgerPath, deps, progress);
  try {
    const outcome = await runStages(handle, deps, progress);
    if (!guard.settle(outcome.final)) return interruptedResult(handle, guard);
    return {
      attemptId: handle.attemptId,
      status: outcome.status,
      reward: outcome.reward,
      usage: outcome.usage,
      signal: null,
    };
  } finally {
    guard.dispose();
  }
}

/** Drive the runner stages, recording progress as it goes so a signal can report it. */
async function runStages(
  handle: AttemptHandle,
  deps: RunAttemptDeps,
  progress: AttemptProgress
): Promise<AttemptOutcome> {
  const problems = verifyInstrument(
    handle.started.identity,
    deps.provisionSpec.nodeArchivePath,
    deps.provisionSpec.bundlePath
  );
  if (problems.length > 0) {
    return withoutDispatch(
      { provision: 90 },
      `${GATE_FAILURE_PREFIX}instrument-integrity: ${problems.join("; ")}`
    );
  }

  const provision = await deps.runner.provision(deps.provisionSpec);
  progress.exitCodes = { provision: provision.exitCode };
  if (!provision.bootVerified) {
    return withoutDispatch(
      { provision: provision.exitCode },
      `${GATE_FAILURE_PREFIX}agent-boot-unverified`
    );
  }

  progress.dispatched = true;
  const dispatch = await deps.runner.dispatch(deps.provisionSpec, {
    maxTurns: deps.maxTurns,
    agentWallSec: deps.agentWallSec,
    graderGraceSec: deps.graderGraceSec,
  });
  progress.model = dispatch.model;
  progress.exitCodes = { ...progress.exitCodes, dispatch: dispatch.exitCode };
  const grade = await deps.runner.grade(
    deps.provisionSpec,
    deps.declaredVerifierTimeoutSec + deps.graderGraceSec
  );
  const usage = deps.readUsage(handle.dir);
  const status: AttemptStatus =
    grade.exitCode === 0 && grade.reward !== null ? "completed" : "invalid";
  return {
    status,
    reward: grade.reward,
    usage,
    final: {
      status,
      finishedAtEpochMs: Date.now(),
      modelDispatched: true,
      exitCodes: progress.exitCodes,
      reward: grade.reward,
      graderExit: grade.exitCode,
      usage,
      model: dispatch.model,
      reason: dispatch.stopReason,
      // The runner's PARSED dispatch facts. Without these the row carries only two flattened
      // strings, and `unreadable-agent-output` is indistinguishable from a real producer value
      // unless an auditor opens the retained transcript.
      dispatchEvidence: dispatchEvidenceOf(dispatch),
      // The grade observation the runner already computed. Dropped here it reached no record,
      // which is why the report's `result_line` clause failed on every real attempt.
      resultLine: grade.resultLine,
      networkFailureMarker: grade.networkFailureMarker,
    },
  };
}

/**
 * The runner's parsed dispatch facts, or `undefined` when the runner reported none.
 *
 * `RunnerPort.dispatch` is declared as returning the PLAIN `DispatchObservation`, because port
 * implementations outside this module's ownership — `smoke-exec.sealedPort`, the attempt-suite
 * fakes — construct that literal without the parse, and a required field would break files this
 * change does not own. The docker runner returns the narrowed `AgentDispatchObservation`, so on
 * the production path the facts are always present.
 *
 * Absence therefore means "this runner port reported no parsed evidence" and NOTHING more. It is
 * deliberately not recorded as `unreadable`: a minimal observation makes no claim at all about
 * what the agent published, and writing one would fabricate exactly the fact the typed union
 * exists to keep honest.
 */
function dispatchEvidenceOf(
  observation: DispatchObservation
): DispatchEvidence | undefined {
  const reported = observation as Partial<AgentDispatchObservation>;
  const { parsedStopReason, parsedModel, usage } = reported;
  if (
    parsedStopReason === undefined ||
    parsedModel === undefined ||
    usage === undefined
  ) {
    return undefined;
  }
  return { stopReason: parsedStopReason, model: parsedModel, usage };
}

/**
 * An attempt that never dispatched a model. Recorded as `invalid` with the `gate:` prefix so
 * accounting files it in the pre-dispatch bucket, not as an attempt.
 */
function withoutDispatch(
  exitCodes: Readonly<Record<string, number>>,
  reason: string
): AttemptOutcome {
  return {
    status: "invalid",
    reward: null,
    usage: null,
    final: {
      status: "invalid",
      finishedAtEpochMs: Date.now(),
      modelDispatched: false,
      exitCodes,
      reward: null,
      graderExit: null,
      usage: null,
      model: "none",
      reason,
    },
  };
}
