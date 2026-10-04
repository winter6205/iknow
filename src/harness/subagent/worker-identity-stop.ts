/**
 * Prove-and-stop for one session-owned worker process.
 *
 * The decision this module exists for: a pid is not an identity. Every signal
 * it sends is authorized by a FRESH comparison of the record's `/proc` start
 * time against the live process, so a recycled pid is never touched and an
 * unreadable identity is never guessed.
 *
 * Reused from the background plane, and why not the rest of it:
 *   - `readProcStartTime` (background/proc.ts) is the single /proc field-22
 *     reader in the repo, used as-is;
 *   - the evidence vocabulary (`not_started` / `confirmed_stopped` /
 *     `unconfirmed` with the same `observation_expired` / `teardown_failed`
 *     reasons) is the same one `CleanupEvidence` established, so an operator
 *     reading either plane reads the same words; this plane adds only
 *     `signal_refused`, for the refusal the group plane cannot express;
 *   - `GROUP_POLL_MS` is the same bounded-observation cadence.
 * The process-GROUP primitives are deliberately not reused: a subagent worker
 * is not detached, so its pgid IS the host's own process group — probing that
 * group reports the host, and signalling it would signal the parent (and every
 * other worker). This module works at pid granularity instead, and keeps the
 * group's errno discipline (ESRCH is the only definitive "gone"; anything else
 * is undecidable and never manufactures a stop).
 *
 * Nothing here converts a failure into a stop. The three outcomes are distinct
 * facts: `confirmed_stopped` (identity observed gone), `not_ours` (the pid is
 * someone else's now, so the owned worker is provably gone and the occupant was
 * left alone), `needs_handling` (death could not be confirmed).
 */
import { readFileSync } from "node:fs";

import { readProcStartTime } from "../background/proc.js";
import {
  GROUP_POLL_MS,
  type CleanupUnconfirmedReason,
} from "../sandbox/cleanup-result.js";
import {
  isPositivePid,
  queueWorkerStopEvidence,
  readWorkerIdentityRecords,
  type OwnedWorkerStopState,
  type WorkerIdentityReadError,
  type WorkerIdentityRecord,
} from "./worker-identity-record.js";

/** Same cadence the process-group plane polls with. */
const PROBE_POLL_MS = GROUP_POLL_MS;

/** Grace between SIGTERM and the SIGKILL backstop, and after SIGKILL. */
const TERM_GRACE_MS = 2_000;
const KILL_GRACE_MS = 2_000;

/**
 * Shorter windows for the just-spawned teardown, because that path is
 * synchronous: a host that cannot record a worker it just started must not
 * block for the long reconciliation windows. Neither window is a correctness
 * input — an unconfirmed teardown still fails the spawn closed — so they are
 * sized for promptness, not for giving a process time to die politely.
 */
const IMMEDIATE_TERM_GRACE_MS = 250;
const IMMEDIATE_KILL_GRACE_MS = 750;

/** `(pid, startTime)` — the record's identity half. */
export interface OwnedWorkerIdentity {
  readonly pid: number;
  /** null = unreadable at spawn, which can never confirm anything. */
  readonly startTime: number | null;
}

/** Why the probe could not decide whether the pid is the owned process. */
export type OwnedProbeUnconfirmedReason =
  /** The record carries no start time, so the live process cannot be matched. */
  | "identity_unreadable"
  /** /proc exists for the pid but its stat line could not be read. */
  | "starttime_unreadable"
  /** Not a usable pid value (never signalable: 0 addresses a process group). */
  | "invalid_pid";

/** What the live process at `pid` is, relative to the recorded identity. */
export type OwnedProcessProbe =
  /** No such process: the owned process is provably gone. */
  | { readonly state: "absent" }
  /** The live process carries the recorded start time: it is the owned worker. */
  | { readonly state: "ours"; readonly startTime: number }
  /** The pid was reused: the current occupant is NOT the owned worker. */
  | { readonly state: "recycled"; readonly startTime: number }
  /** Undecidable: never signal, never claim a stop. */
  | {
      readonly state: "unconfirmed";
      readonly reason: OwnedProbeUnconfirmedReason;
    };

/**
 * Why this plane could not confirm disappearance. The first two values are the
 * group plane's own vocabulary, unchanged, so an operator reading either plane
 * reads the same words. `signal_refused` is this module's third value: the
 * identity could not be matched, so no signal was ever sent. Borrowing
 * `teardown_failed` for it made "we refused" and "we tried and delivery
 * failed" separable only by parsing free text.
 */
export type OwnedUnconfirmedReason =
  CleanupUnconfirmedReason | "signal_refused";

/** Bounded-observation evidence, at pid granularity. Same vocabulary as `CleanupEvidence`. */
export type OwnedStopEvidence =
  | { readonly state: "not_started" }
  | { readonly state: "confirmed_stopped"; readonly pid: number }
  | {
      readonly state: "unconfirmed";
      readonly reason: OwnedUnconfirmedReason;
      readonly pid: number;
      readonly detail: string;
    };

export interface OwnedWorkerStopResult {
  readonly taskId: string;
  readonly ownership: WorkerIdentityRecord["ownership"];
  readonly pid: number;
  readonly state: OwnedWorkerStopState;
  /** Whether a signal was actually delivered. Never true when `state` is `not_ours`. */
  readonly signalled: boolean;
  /** Why the stop was refused, or why it could not be confirmed. */
  readonly detail: string;
  readonly cleanup: OwnedStopEvidence;
}

export interface OwnedWorkerSweepResult {
  readonly workers: ReadonlyArray<OwnedWorkerStopResult>;
  /** Record files that could not be trusted; a worker behind one is unaccounted for. */
  readonly unreadable: ReadonlyArray<WorkerIdentityReadError>;
  /**
   * Verdicts this pass decided but could not write onto the record. The
   * verdict itself stays in `workers` — it is what was observed about the
   * process — but the durable record does not carry it, so the next pass
   * re-attempts that worker. Kept out of `workers` rather than folded into it
   * because downgrading a proven stop to `needs_handling` would misreport a
   * process that is observably gone as possibly still running.
   */
  readonly unrecorded: ReadonlyArray<UnrecordedWorkerVerdict>;
  /**
   * Records present under the root that this pass refused to sweep because
   * `sessionId` could not attribute them to the sweeping session. Always
   * empty when no session filter was requested.
   */
  readonly excluded: ReadonlyArray<ExcludedWorkerRecord>;
}

/** One decided verdict that never reached its identity record. */
export interface UnrecordedWorkerVerdict {
  readonly taskId: string;
  /** The outcome this pass decided; what the record should have carried. */
  readonly outcome: OwnedWorkerStopState;
  /** Why it is not on disk (absent, untrusted, or an errno from the rewrite). */
  readonly reason: string;
}

/**
 * One record this pass declined to sweep because the session filter could not
 * attribute it to the sweeping session. Reported rather than dropped: a worker
 * nobody may signal is still a worker somebody has to be told about.
 */
export interface ExcludedWorkerRecord {
  readonly taskId: string;
  readonly sessionId?: string;
  readonly reason: "foreign_session" | "unattributed_session";
}

/**
 * Test seams. Production callers pass none: the defaults are the real OS
 * primitives. `pidAlive` / `readStartTime` exist because a process that
 * survives SIGKILL, and a signal the kernel refuses, cannot be produced
 * against a real tree — the same reason the process-group plane documents its
 * own blinded probe.
 */
export interface WorkerIdentityDeps {
  readonly pidAlive?: (pid: number) => boolean;
  readonly readStartTime?: (pid: number) => number | undefined;
  /** Throws for a real delivery failure; ESRCH means "already gone", not failure. */
  readonly signalPid?: (pid: number, signal: NodeJS.Signals) => void;
  readonly waitMs?: (ms: number) => Promise<void>;
}

export interface StopOwnedWorkerOptions extends WorkerIdentityDeps {
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  /**
   * Owning session to restrict the sweep to. When present, only records whose
   * own `session_id` equals it are swept: a record belonging to another
   * session, or to no session this process can attribute, is excluded rather
   * than signalled. Omitted → no session filter, which is the owning-process
   * posture where the root is already this session's.
   */
  readonly sessionId?: string;
}

/** `/proc` field 3 (single-letter state); undefined when unreadable. */
function readProcState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/)[0];
  } catch {
    return undefined;
  }
}

/**
 * Liveness at pid granularity. ESRCH is the only definitive "gone" answer; any
 * other errno (EPERM for another uid's process, for instance) is undecidable
 * and counted as alive, so an undecidable probe can never manufacture a stop.
 *
 * A zombie is the third case, and it counts as NOT alive: the process has
 * exited and cannot execute or be continued — it only holds its pid until its
 * parent reaps it. Reporting it as alive would turn a teardown this module just
 * performed into "survived", because the synchronous teardown path blocks the
 * event loop and therefore cannot reap the child it is waiting on.
 */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
  return readProcState(pid) !== "Z";
}

function defaultSignalPid(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

/**
 * Read the identity of a freshly spawned worker. `undefined` when the spawn
 * factory reported no pid at all (an in-process fake): there is nothing to
 * verify, so nothing is recorded rather than a half-identity.
 */
export function captureWorkerIdentity(
  pid: number | undefined
): OwnedWorkerIdentity | undefined {
  if (pid === undefined || !isPositivePid(pid)) return undefined;
  return { pid, startTime: readProcStartTime(pid) ?? null };
}

/**
 * Decide what the process at `pid` is, relative to the recorded identity.
 * Absence is checked first because it is the one answer that holds without an
 * identity: a pid with no process behind it cannot be anyone's live worker.
 */
export function probeOwnedProcess(
  identity: OwnedWorkerIdentity,
  deps: WorkerIdentityDeps = {}
): OwnedProcessProbe {
  const alive = deps.pidAlive ?? defaultPidAlive;
  if (!isPositivePid(identity.pid)) {
    return { state: "unconfirmed", reason: "invalid_pid" };
  }
  if (!alive(identity.pid)) return { state: "absent" };
  if (identity.startTime === null) {
    return { state: "unconfirmed", reason: "identity_unreadable" };
  }
  const readStartTime = deps.readStartTime ?? readProcStartTime;
  const current = readStartTime(identity.pid);
  if (current === undefined) {
    return { state: "unconfirmed", reason: "starttime_unreadable" };
  }
  return current === identity.startTime
    ? { state: "ours", startTime: current }
    : { state: "recycled", startTime: current };
}

/**
 * The single safety rule: these two verdicts prove the owned process is gone.
 * A recycled pid qualifies because the original process is dead by definition
 * — the current occupant is a different process entirely. "ours" means it is
 * still running, and "unconfirmed" means nobody knows.
 *
 * It is stated over the verdict vocabulary because that is what the durable
 * record, the operator surface and the probe both speak: the probe predicate
 * below reads the verdict its own probe would produce, so the pre-continuation
 * gate and the stop pass cannot disagree about what counts as proven death.
 */
function stopStateProvesGone(state: OwnedWorkerStopState): boolean {
  return state === "confirmed_stopped" || state === "not_ours";
}

/** The verdict a probe implies: what a pass would record if it ran this probe. */
function verdictOf(probe: OwnedProcessProbe): OwnedWorkerStopState {
  switch (probe.state) {
    case "absent":
      return "confirmed_stopped";
    case "recycled":
      return "not_ours";
    case "ours":
    case "unconfirmed":
      return "needs_handling";
  }
}

/** Whether a finished stop pass proved the record's owned process is gone. */
export function priorProcessProvablyGone(
  result: OwnedWorkerStopResult
): boolean {
  return stopStateProvesGone(result.state);
}

/** The same rule, for a live probe, for the pre-continuation gate. */
export function probeProvesProcessGone(probe: OwnedProcessProbe): boolean {
  return stopStateProvesGone(verdictOf(probe));
}

/** One operator-readable sentence per probe verdict. */
export function describeOwnedProcessProbe(
  probe: OwnedProcessProbe,
  identity: OwnedWorkerIdentity
): string {
  switch (probe.state) {
    case "absent":
      return `pid ${identity.pid} is gone`;
    case "recycled":
      return `pid ${identity.pid} now carries starttime ${probe.startTime}, not the recorded one`;
    case "ours":
      return `pid ${identity.pid} (starttime ${identity.startTime}) is still running`;
    case "unconfirmed":
      return `pid ${identity.pid} cannot be matched to the recorded worker: ${probe.reason}`;
  }
}

/**
 * The one record → identity mapping. The pre-continuation gate and this stop
 * pass both authorize signals from it, so it lives here and is imported rather
 * than retyped at a call site.
 */
export function identityOf(record: WorkerIdentityRecord): OwnedWorkerIdentity {
  return { pid: record.pid, startTime: record.starttime };
}

/** Bounded poll on the identity, not on a wall clock, so it completes under a frozen clock too. */
async function waitForIdentityGone(
  record: WorkerIdentityRecord,
  capMs: number,
  deps: WorkerIdentityDeps
): Promise<OwnedProcessProbe> {
  const waitMs =
    deps.waitMs ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const polls = Math.max(1, Math.ceil(capMs / PROBE_POLL_MS));
  let probe = probeOwnedProcess(identityOf(record), deps);
  for (let i = 0; i < polls && probe.state === "ours"; i += 1) {
    await waitMs(PROBE_POLL_MS);
    probe = probeOwnedProcess(identityOf(record), deps);
  }
  return probe;
}

/**
 * The one "could not confirm" builder, for every unconfirmed route.
 *
 * `reason` says which route it was and `signalled` says what the signal call
 * did, so an operator can tell "we refused to signal" from "we signalled and
 * the observation failed" without parsing `detail` — and a delivered signal is
 * never reported as an absent one.
 */
function needsHandling(
  record: WorkerIdentityRecord,
  reason: OwnedUnconfirmedReason,
  detail: string,
  signalled: boolean
): OwnedWorkerStopResult {
  return {
    taskId: record.task_id,
    ownership: record.ownership,
    pid: record.pid,
    state: "needs_handling",
    signalled,
    detail,
    cleanup: {
      state: "unconfirmed",
      reason,
      pid: record.pid,
      detail,
    },
  };
}

function observationExpired(
  record: WorkerIdentityRecord,
  signalled: boolean
): OwnedWorkerStopResult {
  const detail = `pid ${record.pid} (starttime ${record.starttime}) survived SIGKILL within the window`;
  return needsHandling(record, "observation_expired", detail, signalled);
}

function confirmedStop(
  record: WorkerIdentityRecord,
  signalled: boolean,
  detail: string
): OwnedWorkerStopResult {
  return {
    taskId: record.task_id,
    ownership: record.ownership,
    pid: record.pid,
    state: "confirmed_stopped",
    signalled,
    detail,
    cleanup: { state: "confirmed_stopped", pid: record.pid },
  };
}

function notOurs(
  record: WorkerIdentityRecord,
  detail: string
): OwnedWorkerStopResult {
  return {
    taskId: record.task_id,
    ownership: record.ownership,
    pid: record.pid,
    state: "not_ours",
    signalled: false,
    detail,
    cleanup: { state: "not_started" },
  };
}

/** What one signal call actually did, which is not the same as not throwing. */
type SignalDelivery =
  /** The kernel accepted the signal for this pid. */
  | { readonly delivered: true }
  /** ESRCH: there was no such process, so nothing was delivered to anyone. */
  | { readonly delivered: false; readonly reason: "already_gone" }
  /** Any other errno: the signal never reached this pid. */
  | {
      readonly delivered: false;
      readonly reason: "failed";
      readonly detail: string;
    };

/**
 * Signal one owned pid and report what the kernel did, as a fact rather than a
 * boolean. Three outcomes, because they are three different things for the
 * operator: delivered, already-gone (ESRCH — the process was never there to
 * signal), and failed. Collapsing the last two into "no error" is what made a
 * never-signalled worker report as signalled.
 */
function deliverSignal(
  target: { readonly pid: number },
  signal: NodeJS.Signals,
  deps: WorkerIdentityDeps
): SignalDelivery {
  const signalPid = deps.signalPid ?? defaultSignalPid;
  try {
    signalPid(target.pid, signal);
    return { delivered: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { delivered: false, reason: "already_gone" };
    const cause = err instanceof Error ? err.message : String(err);
    return {
      delivered: false,
      reason: "failed",
      detail: `kill ${target.pid} ${signal} failed (${code ?? "unknown"}): ${cause}`,
    };
  }
}

/** The kernel refused the signal outright: nothing was sent, and nothing will be. */
function deliveryFailed(
  record: WorkerIdentityRecord,
  signal: NodeJS.Signals,
  delivery: Extract<SignalDelivery, { readonly reason: "failed" }>
): OwnedWorkerStopResult {
  return needsHandling(
    record,
    "teardown_failed",
    `${signal} delivery: ${delivery.detail}`,
    false
  );
}

/**
 * The signal went out (or there was nothing left to signal) and the identity
 * still could not be confirmed. The delivery call already decided whether
 * anything was sent, and an observation that cannot decide does not undo that
 * — which is why this is a failed observation, not a refusal. A refusal is the
 * branch where the identity was never matched and nothing was sent at all.
 */
function undecidableAfterSignal(
  record: WorkerIdentityRecord,
  signal: NodeJS.Signals,
  probe: OwnedProcessProbe & { readonly state: "unconfirmed" },
  delivery: SignalDelivery
): OwnedWorkerStopResult {
  const sent = delivery.delivered
    ? "signalled"
    : "nothing to signal (pid already gone)";
  return needsHandling(
    record,
    "teardown_failed",
    `after ${signal}: ${describeOwnedProcessProbe(probe, identityOf(record))} (delivery: ${sent})`,
    delivery.delivered
  );
}

/** One signal + one bounded observation; shared by the SIGTERM and SIGKILL arms. */
async function signalAndObserve(
  record: WorkerIdentityRecord,
  signal: NodeJS.Signals,
  capMs: number,
  deps: WorkerIdentityDeps
): Promise<SignalAndObserve> {
  const delivery = deliverSignal(record, signal, deps);
  if (!delivery.delivered && delivery.reason === "failed") {
    return {
      kind: "stopped",
      result: deliveryFailed(record, signal, delivery),
    };
  }
  const probe = await waitForIdentityGone(record, capMs, deps);
  if (probe.state === "ours") {
    return { kind: "survived", signalled: delivery.delivered };
  }
  if (probe.state === "unconfirmed") {
    return {
      kind: "stopped",
      result: undecidableAfterSignal(record, signal, probe, delivery),
    };
  }
  return {
    kind: "stopped",
    result: confirmedStop(
      record,
      delivery.delivered,
      `${describeOwnedProcessProbe(probe, identityOf(record))} after ${signal}`
    ),
  };
}

/** What one signal-and-observe arm decided. */
type SignalAndObserve =
  | { readonly kind: "stopped"; readonly result: OwnedWorkerStopResult }
  /** The identity was still `ours` when the window ended. */
  | { readonly kind: "survived"; readonly signalled: boolean };

/**
 * The refusal branch: the identity could not be confirmed, so the live process
 * is never signalled and the worker is reported as needing handling. This is
 * the same answer whether the identity was missing, the stat line unreadable,
 * or the pid was not a process value at all.
 *
 * It carries `signal_refused` rather than the group plane's `teardown_failed`
 * because no teardown was attempted here: the reason has to be able to say
 * "we declined", not only "we tried and it went wrong".
 */
function refuseUnconfirmed(
  record: WorkerIdentityRecord,
  probe: OwnedProcessProbe & { readonly state: "unconfirmed" }
): OwnedWorkerStopResult {
  return needsHandling(
    record,
    "signal_refused",
    `identity not signalable: ${probe.reason} — refusing to signal pid ${record.pid}`,
    false
  );
}

/**
 * Stop one recorded worker and report what was proven.
 *
 * The order is fixed by the safety rule, not by convenience: probe, and only
 * signal a pid the probe called `ours`. An unconfirmable or recycled pid is
 * never signalled, and an already-absent pid is a confirmed stop that needed no
 * signal.
 */
export async function stopOwnedWorker(
  record: WorkerIdentityRecord,
  opts: StopOwnedWorkerOptions = {}
): Promise<OwnedWorkerStopResult> {
  const termGraceMs = opts.termGraceMs ?? TERM_GRACE_MS;
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const first = probeOwnedProcess(identityOf(record), opts);
  if (first.state === "unconfirmed") return refuseUnconfirmed(record, first);
  if (first.state === "absent") {
    return confirmedStop(
      record,
      false,
      `${describeOwnedProcessProbe(first, identityOf(record))} — no signal needed`
    );
  }
  if (first.state === "recycled") {
    return notOurs(
      record,
      `${describeOwnedProcessProbe(first, identityOf(record))} — not signalled`
    );
  }
  const afterTerm = await signalAndObserve(
    record,
    "SIGTERM",
    termGraceMs,
    opts
  );
  if (afterTerm.kind === "stopped") return afterTerm.result;
  const afterKill = await signalAndObserve(
    record,
    "SIGKILL",
    killGraceMs,
    opts
  );
  if (afterKill.kind === "stopped") return afterKill.result;
  // Surviving both arms means at least one signal did reach a live identity.
  return observationExpired(record, afterTerm.signalled || afterKill.signalled);
}

/**
 * What an immediate teardown of a just-started process actually achieved.
 * `gone` is a proven death; `terminated` is a death this pass caused;
 * `refused` is the honest "I did not signal, or I could not confirm" answer,
 * which the caller must not read as success.
 */
export type OwnedWorkerTerminateState = "gone" | "terminated" | "refused";

export interface OwnedWorkerTerminateResult {
  readonly state: OwnedWorkerTerminateState;
  readonly signalled: boolean;
  readonly detail: string;
}

/**
 * Park the thread without spinning and without needing the event loop to turn.
 *
 * Needed because the caller is synchronous: `spawn` returns a handle, so a
 * failed record write has nowhere to put an await, and a busy-wait would burn
 * a core for the length of the window.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Bounded synchronous observation of one identity; the async twin of `waitForIdentityGone`. */
function waitForIdentityGoneSync(
  identity: OwnedWorkerIdentity,
  capMs: number,
  deps: WorkerIdentityDeps
): OwnedProcessProbe {
  const polls = Math.max(1, Math.ceil(capMs / PROBE_POLL_MS));
  let probe = probeOwnedProcess(identity, deps);
  for (let i = 0; i < polls && probe.state === "ours"; i += 1) {
    sleepSync(PROBE_POLL_MS);
    probe = probeOwnedProcess(identity, deps);
  }
  return probe;
}

/** One signal plus a bounded synchronous observation, in the async twin's shape. */
/**
 * One signal attempt's outcome for the synchronous teardown: the identity probe
 * that followed, plus the delivery verdict when the kernel refused the signal.
 *
 * WHY the delivery verdict rides along: a refused signal decides nothing about
 * the process, and a caller that only reads the probe would read `unconfirmed`
 * as "gone after SIGTERM" and report a teardown that never happened. The
 * delivery failure is a different fact from the probe, so it is carried, not
 * flattened into a probe reason.
 */
type SyncSignalOutcome =
  | { readonly kind: "probe"; readonly probe: OwnedProcessProbe }
  | {
      readonly kind: "delivery_failed";
      readonly detail: string;
    };

function signalIdentitySync(
  identity: OwnedWorkerIdentity,
  signal: NodeJS.Signals,
  capMs: number,
  deps: WorkerIdentityDeps
): SyncSignalOutcome {
  const delivery = deliverSignal(identity, signal, deps);
  if (!delivery.delivered && delivery.reason === "failed") {
    return { kind: "delivery_failed", detail: delivery.detail };
  }
  return {
    kind: "probe",
    probe: waitForIdentityGoneSync(identity, capMs, deps),
  };
}

/**
 * Terminate the exact process a spawn just started, synchronously.
 *
 * This is the fail-closed arm of the record write: a worker whose identity
 * never reached disk cannot be stopped, verified or continued by the next
 * process, so leaving it running would manufacture an orphan that no later
 * process can even see. The same safety rule as the async pass — probe first,
 * signal only a pid the probe called `ours`, SIGKILL on that same pid as the
 * backstop — applies unchanged; only the waiting is synchronous.
 *
 * The caller must fail the spawn whatever this returns. `refused` means the
 * teardown was not proven, not that the process is safe to keep: the process
 * was never recorded in the first place, which is the actual failure.
 */
export function terminateOwnedWorkerNow(
  identity: OwnedWorkerIdentity,
  opts: StopOwnedWorkerOptions = {}
): OwnedWorkerTerminateResult {
  const termGraceMs = opts.termGraceMs ?? IMMEDIATE_TERM_GRACE_MS;
  const killGraceMs = opts.killGraceMs ?? IMMEDIATE_KILL_GRACE_MS;
  const first = probeOwnedProcess(identity, opts);
  if (first.state === "absent") {
    return {
      state: "gone",
      signalled: false,
      detail: `pid ${identity.pid} is gone — no signal needed`,
    };
  }
  if (first.state !== "ours") {
    return {
      state: "refused",
      signalled: false,
      detail: `pid ${identity.pid} not signalled: ${describeOwnedProcessProbe(first, identity)}`,
    };
  }
  const afterTerm = signalIdentitySync(identity, "SIGTERM", termGraceMs, opts);
  if (afterTerm.kind === "delivery_failed") {
    return {
      state: "refused",
      signalled: false,
      detail: `pid ${identity.pid} not signalled: ${afterTerm.detail}`,
    };
  }
  if (afterTerm.probe.state !== "ours") {
    return {
      state: "terminated",
      signalled: true,
      detail: `pid ${identity.pid} ${describeOwnedProcessProbe(afterTerm.probe, identity)} after SIGTERM`,
    };
  }
  const afterKill = signalIdentitySync(identity, "SIGKILL", killGraceMs, opts);
  if (afterKill.kind === "delivery_failed") {
    return {
      state: "refused",
      signalled: false,
      detail: `pid ${identity.pid} not signalled: ${afterKill.detail}`,
    };
  }
  if (afterKill.probe.state !== "ours") {
    return {
      state: "terminated",
      signalled: true,
      detail: `pid ${identity.pid} ${describeOwnedProcessProbe(afterKill.probe, identity)} after SIGKILL`,
    };
  }
  return {
    state: "refused",
    signalled: true,
    detail: `pid ${identity.pid} (starttime ${identity.startTime}) survived SIGTERM and SIGKILL within the window`,
  };
}

/**
 * A record that already carries a final outcome: this pass reports the STORED
 * outcome instead of deciding a new one, so a `not_ours` verdict is never
 * replayed as `confirmed_stopped` while its own detail and the record on disk
 * still say otherwise.
 *
 * `needs_handling` is deliberately absent: it is not final, so the operator's
 * next reopen may succeed and the pass re-attempts the worker.
 */
function replayedVerdict(
  record: WorkerIdentityRecord
): OwnedWorkerStopResult | undefined {
  const stop = record.stop;
  if (stop === undefined || stop.outcome === "needs_handling") return undefined;
  const detail = `identity already verified as ${stop.outcome} at ${stop.verified_at}`;
  // A replay sends nothing, so `signalled` describes this pass: false, whatever
  // the recorded pass delivered.
  return stop.outcome === "not_ours"
    ? notOurs(record, detail)
    : confirmedStop(record, false, detail);
}

/**
 * Whether this pass may sweep `record` at all, given the requested session.
 *
 * No filter → yes: the root is the sweeping session's own, which is the
 * owning-process posture. With a filter, only an exact `session_id` match
 * qualifies. An unattributed record does NOT qualify either: this process
 * cannot prove the worker is this session's, and signalling it on a guess is
 * the one thing the identity check exists to prevent.
 */
function sweepExclusion(
  record: WorkerIdentityRecord,
  sessionId: string | undefined
): ExcludedWorkerRecord | undefined {
  if (sessionId === undefined) return undefined;
  if (record.session_id === sessionId) return undefined;
  return {
    taskId: record.task_id,
    ...(record.session_id !== undefined
      ? { sessionId: record.session_id }
      : {}),
    reason:
      record.session_id === undefined
        ? "unattributed_session"
        : "foreign_session",
  };
}

/**
 * Reconcile every recorded worker under one root: prove each identity, stop
 * what is provably ours, and leave each verdict on the record so a second
 * sweep is a byte-identical no-op.
 *
 * `needs_handling` is deliberately re-attempted on a later pass (the operator's
 * next reopen may succeed); only a proven outcome is final. The pass is
 * sequential and each worker's observation window is bounded by poll count
 * rather than wall clock, so the sweep has an explicit exit condition instead
 * of an unbounded wait.
 *
 * A verdict is only reported as recorded when the write says so: `unrecorded`
 * names every decision that did not reach its record file, so the caller can
 * tell a proven stop from a proven stop the next process will re-attempt.
 *
 * Safe to call from a process that never held the children: everything it
 * decides comes from the durable records plus a fresh `/proc` read, and every
 * write is an atomic replace, so a pass that is interrupted leaves either the
 * previous complete record or the new one — never a verdict that only half
 * landed.
 */
export async function sweepOwnedWorkers(
  subagentsDir: string,
  opts: StopOwnedWorkerOptions = {}
): Promise<OwnedWorkerSweepResult> {
  const { records, unreadable } = readWorkerIdentityRecords(subagentsDir);
  const workers: OwnedWorkerStopResult[] = [];
  const unrecorded: UnrecordedWorkerVerdict[] = [];
  const excluded: ExcludedWorkerRecord[] = [];
  for (const record of records) {
    const skip = sweepExclusion(record, opts.sessionId);
    if (skip !== undefined) {
      excluded.push(skip);
      continue;
    }
    const replayed = replayedVerdict(record);
    if (replayed !== undefined) {
      workers.push(replayed);
      continue;
    }
    const result = await stopOwnedWorker(record, opts);
    const written = await queueWorkerStopEvidence(
      subagentsDir,
      record.task_id,
      {
        outcome: result.state,
        signalled: result.signalled,
        detail: result.detail,
      }
    );
    if (!written.recorded) {
      unrecorded.push({
        taskId: record.task_id,
        outcome: result.state,
        reason: written.reason,
      });
    }
    workers.push(result);
  }
  return { workers, unreadable, unrecorded, excluded };
}
