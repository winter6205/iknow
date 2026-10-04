/**
 * Per-task durable OS-identity record for session-owned workers.
 *
 * Why a record at all: a worker's in-memory `ChildProcess` dies with the host
 * process, so after an abnormal host exit the only surviving question is
 * "which OS process was this task id running, and is it still that one?". A
 * pid alone cannot answer it — the kernel recycles pids — so the record pairs
 * the pid with its `/proc` start time (ADR-0021's `starttime`, the same value
 * the background-task registry stores for its pgid-reuse check).
 *
 * Lifecycle: the record describes the CURRENT spawn of a task id. ADR-0102
 * resume reuses the task id and starts a NEW process, so the record is
 * rewritten on every spawn rather than written once; the writer therefore
 * always writes the full current state and never merges a previous run's stop
 * verdict onto a fresh process.
 *
 * Invariant this module owns: nothing outside the worker's own terminal
 * transition may write `completed` / `failed` here. A verification pass only
 * ever adds a `stop` block, so an unsettled worker stays unsettled on disk
 * however its process ends.
 *
 * Wire shape: snake_case field names, matching ADR-0021's background record so
 * the two per-task records read the same way. `starttime: null` is a real
 * value (the start time could not be read at spawn) and is never coerced into
 * a number or dropped.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { workerProcessRecordPath } from "../sandbox/fence-tmp.js";

/**
 * Wait/background ownership of a worker. Derived from the same
 * `excludeFromHostDrain` bit the host-drain gate already uses: the parent
 * awaits this worker's result inside the spawning call (foreground) or the
 * call returned a handle and completion arrives later (background).
 */
export type WorkerOwnership = "foreground" | "background";

/**
 * The worker's own lifecycle state, mirroring the manager's task state. A
 * verification pass never writes into this field.
 */
export type WorkerLifecycleState =
  "starting" | "running" | "completed" | "failed";

/** Outcome of a stop/verification pass over one owned worker. */
export type OwnedWorkerStopState =
  /** The owned process identity was observed gone. */
  | "confirmed_stopped"
  /** The pid now belongs to a different process, or its identity was unreadable. Never signalled. */
  | "not_ours"
  /** Termination could not be confirmed. The worker needs explicit handling. */
  | "needs_handling";

/** What one verification pass decided, stored so a second pass is a no-op. */
export interface WorkerIdentityStopEvidence {
  readonly verified_at: string;
  readonly outcome: OwnedWorkerStopState;
  /** Whether a signal was actually delivered to this pid. */
  readonly signalled: boolean;
  /** Human-readable cause for the operator-facing trace and logs. */
  readonly detail: string;
}

/** One task's current owned-worker identity, as it sits on disk. */
export interface WorkerIdentityRecord {
  readonly task_id: string;
  readonly ownership: WorkerOwnership;
  readonly worker_state: WorkerLifecycleState;
  readonly pid: number;
  /** `/proc` field 22 at spawn; null = unreadable, which can never confirm a stop. */
  readonly starttime: number | null;
  /** The worker's own transcript, which stays independently readable. */
  readonly transcript_path?: string;
  /**
   * Conversation that owns this worker. The runtime-persistence sink is
   * resolved per session, so a process that never held the worker still needs
   * this to route its verdicts to the right session's state.
   */
  readonly session_id?: string;
  /** `tool_use_id` of the spawn call, when the spawn is transcript-anchored. */
  readonly tool_use_id?: string;
  readonly updated_at: string;
  readonly stop?: WorkerIdentityStopEvidence;
}

/** Spawn-time fields; `updated_at` and any stop verdict are added by the writer. */
export type WorkerIdentityEntry = Omit<
  WorkerIdentityRecord,
  "updated_at" | "stop"
>;

/** A record file that could not be trusted; never dropped from a listing. */
export interface WorkerIdentityReadError {
  readonly path: string;
  readonly reason: string;
}

export interface WorkerIdentityRecords {
  readonly records: ReadonlyArray<WorkerIdentityRecord>;
  readonly unreadable: ReadonlyArray<WorkerIdentityReadError>;
}

/** Whether one stop verdict reached its record file, and if not, why not. */
export type WorkerStopEvidenceWrite =
  | { readonly recorded: true }
  | { readonly recorded: false; readonly reason: string };

/**
 * Stable discriminator for a durable-record write that did not happen.
 *
 * A caller must be able to branch on this without parsing a message, because
 * the two routes it separates are not interchangeable: the spawn path fails
 * closed (terminate the child it just started), while a lifecycle transition
 * only reports (the transition itself is not the thing that failed). `Error`
 * alone cannot carry that distinction without string matching, which is why
 * this is a typed class with a fixed `code`.
 */
export const WORKER_IDENTITY_WRITE_ERROR_CODE = "worker_identity_unpersisted";

/**
 * A per-task identity record could not be written (or could not be replaced
 * atomically and could not be written directly either).
 *
 * Fail-closed by construction: an identity missing from disk is exactly what
 * leaves a worker unreconcilable after the host dies, so this error carries the
 * task it belongs to and the underlying throwable, and no caller may convert
 * it into a successful spawn.
 */
export class WorkerIdentityWriteError extends Error {
  override readonly name = "WorkerIdentityWriteError";
  readonly code = WORKER_IDENTITY_WRITE_ERROR_CODE;
  readonly taskId: string;
  /** The original throwable, kept so a report names the real errno. */
  override readonly cause: unknown;

  constructor(taskId: string, cause: unknown) {
    super(
      `worker identity record for ${taskId} could not be written: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.taskId = taskId;
    this.cause = cause;
  }
}

/** Distinguishes temp files of concurrent writers within one process. */
let tempFileCounter = 0;

/**
 * Replace `path` with `content` so no reader can ever observe a partial file.
 *
 * A direct `writeFileSync` truncates first and writes after, so a crash (or a
 * concurrent reader) between the two observes an empty or half-written record —
 * and this record's whole job is to be the cross-process answer about a live
 * process. Staging into a temp file in the SAME directory and renaming keeps
 * the replace atomic (rename within one filesystem is), so the visible file is
 * always either the previous complete record or the new one.
 *
 * The direct write survives only as a fallback for a filesystem that refuses
 * `rename`; if that fallback then fails too, the caller must fail closed rather
 * than return as if the record existed. Bytes are unchanged from the direct
 * write's form, so every existing reader stays byte-compatible.
 */
function writeRecordFileAtomic(
  path: string,
  content: string,
  taskId: string
): void {
  tempFileCounter += 1;
  // Same directory, so rename stays within one filesystem and is atomic.
  const temp = join(
    dirname(path),
    `.process-${taskId}.json.${process.pid}.${tempFileCounter}.tmp`
  );
  try {
    writeFileSync(temp, content, "utf8");
    renameSync(temp, path);
    return;
  } catch (err) {
    try {
      // A rename refusal can leave the staged file behind; it is never a record
      // (its name is not one any reader looks up) but it must not accumulate.
      writeFileSync(path, content, "utf8");
      return;
    } catch (directErr) {
      throw new WorkerIdentityWriteError(taskId, directErr);
    } finally {
      if (existsSync(temp)) {
        try {
          renameSync(temp, `${temp}.discarded`);
        } catch {
          // EXIT: the staged file cannot be renamed away either. It is inert
          // (not a record name) and the record itself never landed, which is
          // the fact the caller fails closed on.
        }
      }
    }
  }
}

/**
 * Errno name, or a stable stand-in when the throwable carries none.
 *
 * Walks the `cause` chain: this module's own write failures are wrapped in a
 * `WorkerIdentityWriteError` whose `code` names the failure MODE, not the
 * errno. An operator (and every existing assertion) needs the errno, so the
 * innermost throwable decides.
 */
function errnoOf(err: unknown): string {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    const code = (current as NodeJS.ErrnoException | undefined)?.code;
    if (typeof code === "string" && code !== WORKER_IDENTITY_WRITE_ERROR_CODE) {
      return code;
    }
    const cause = (current as { readonly cause?: unknown } | undefined)?.cause;
    if (cause === undefined || cause === null) break;
    current = cause;
  }
  return (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
}

/**
 * A usable process pid, and the single definition of one: the parse site needs
 * the `value is number` narrowing, and the stop module needs the same answer
 * before it is willing to signal. 0 addresses a process group, so it is not a
 * pid.
 */
export function isPositivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isOwnership(value: unknown): value is WorkerOwnership {
  return value === "foreground" || value === "background";
}

function isWorkerState(value: unknown): value is WorkerLifecycleState {
  return (
    value === "starting" ||
    value === "running" ||
    value === "completed" ||
    value === "failed"
  );
}

function isStopState(value: unknown): value is OwnedWorkerStopState {
  return (
    value === "confirmed_stopped" ||
    value === "not_ours" ||
    value === "needs_handling"
  );
}

function isPresentString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Discriminated parse outcome. A boolean plus an out-parameter would let a
 * caller read the value it was handed on the failure path; this cannot.
 */
type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function parseStopEvidence(
  value: unknown
): Parsed<WorkerIdentityStopEvidence | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "stop evidence is not a JSON object" };
  }
  const raw = value as Record<string, unknown>;
  if (
    !isPresentString(raw.verified_at) ||
    !isStopState(raw.outcome) ||
    typeof raw.signalled !== "boolean" ||
    !isPresentString(raw.detail)
  ) {
    return { ok: false, reason: "stop evidence is missing a required field" };
  }
  return {
    ok: true,
    value: {
      verified_at: raw.verified_at,
      outcome: raw.outcome,
      signalled: raw.signalled,
      detail: raw.detail,
    },
  };
}

/**
 * The fields every record must carry, each with its own criterion. A table
 * rather than a chain of per-field branches: the required set is data, so
 * adding a field is one row and the parse stays a straight line.
 */
const REQUIRED_FIELDS: ReadonlyArray<
  readonly [key: string, ok: (value: unknown) => boolean]
> = [
  ["task_id", isPresentString],
  ["ownership", isOwnership],
  ["worker_state", isWorkerState],
  ["pid", isPositivePid],
  ["updated_at", isPresentString],
];

/** `starttime` is the one field with a real null: unreadable at spawn. */
function isStartTime(value: unknown): boolean {
  return value === null || Number.isFinite(value);
}

/** Postel projection of an optional string field, omitted when absent. */
function optionalField(
  raw: Record<string, unknown>,
  key: string,
  wire: string
): Record<string, string> {
  return isPresentString(raw[key]) ? { [wire]: raw[key] as string } : {};
}

/** JSON object root, or the reason the file is not one. */
function parseJsonObject(content: string): Parsed<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      reason: `json parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "record root is not a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Parse one record file. Every field the stop/continuation decisions read is
 * type-checked here, so a truncated or hand-edited file can never be read as
 * "identity confirmed": an unusable record is reported with its reason, and the
 * caller decides the fail-closed direction.
 */
function parseWorkerIdentityRecord(
  content: string
): Parsed<WorkerIdentityRecord> {
  const root = parseJsonObject(content);
  if (!root.ok) return root;
  const raw = root.value;
  for (const [key, ok] of REQUIRED_FIELDS) {
    if (!ok(raw[key])) {
      return { ok: false, reason: `missing or invalid ${key}` };
    }
  }
  if (!isStartTime(raw.starttime)) {
    return { ok: false, reason: "starttime is neither a number nor null" };
  }
  const stop = parseStopEvidence(raw.stop);
  if (!stop.ok) return stop;
  return {
    ok: true,
    value: {
      task_id: raw.task_id as string,
      ownership: raw.ownership as WorkerOwnership,
      worker_state: raw.worker_state as WorkerLifecycleState,
      pid: raw.pid as number,
      starttime: (raw.starttime ?? null) as number | null,
      ...optionalField(raw, "transcript_path", "transcript_path"),
      ...optionalField(raw, "session_id", "session_id"),
      ...optionalField(raw, "tool_use_id", "tool_use_id"),
      updated_at: raw.updated_at as string,
      ...(stop.value !== undefined ? { stop: stop.value } : {}),
    },
  };
}

/**
 * Write the task's current identity, replacing any previous record. The mkdir
 * backstop covers a task whose session layout has not been created yet (this
 * writer does not depend on the trace/meta writers having run first).
 *
 * A write failure throws `WorkerIdentityWriteError`: an identity that is
 * silently not on disk would leave the worker unidentifiable to the next
 * process, which is the one failure mode the record exists to prevent. The
 * spawn caller terminates the child it just started; a lifecycle transition
 * only reports.
 */
export function writeWorkerIdentityRecord(
  subagentsDir: string,
  entry: WorkerIdentityEntry
): WorkerIdentityRecord {
  const record: WorkerIdentityRecord = {
    ...entry,
    updated_at: new Date().toISOString(),
  };
  const path = workerProcessRecordPath(subagentsDir, record.task_id);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    throw new WorkerIdentityWriteError(record.task_id, err);
  }
  writeRecordFileAtomic(path, `${JSON.stringify(record)}\n`, record.task_id);
  return record;
}

/**
 * Attach one verification verdict to an existing record and report whether it
 * landed. A missing or untrusted record is a refusal with a reason, never a
 * silent success: the sweep reports from this answer, so a verdict that never
 * reached disk cannot be reported as proven.
 *
 * The read and the write are guarded separately, in the same errno discipline
 * `readWorkerIdentityRecords` uses, because this runs inside a sweep that has
 * already signalled the workers behind the other records — one EACCES must not
 * reject it and lose the verdicts the operator has not seen yet.
 */
export function recordWorkerStopEvidence(
  subagentsDir: string,
  taskId: string,
  evidence: Omit<WorkerIdentityStopEvidence, "verified_at">
): WorkerStopEvidenceWrite {
  const path = workerProcessRecordPath(subagentsDir, taskId);
  if (!existsSync(path)) {
    return { recorded: false, reason: "no identity record to update" };
  }
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    return { recorded: false, reason: `read failed (${errnoOf(err)})` };
  }
  const current = parseWorkerIdentityRecord(content);
  if (!current.ok) {
    return {
      recorded: false,
      reason: `record untrusted: ${current.reason}`,
    };
  }
  const at = new Date().toISOString();
  const updated: WorkerIdentityRecord = {
    ...current.value,
    updated_at: at,
    stop: { ...evidence, verified_at: at },
  };
  try {
    writeRecordFileAtomic(path, `${JSON.stringify(updated)}\n`, taskId);
  } catch (err) {
    return { recorded: false, reason: `write failed (${errnoOf(err)})` };
  }
  return { recorded: true };
}

/**
 * Per-task-id tail of the last queued verdict update, so two updates for one
 * task id queue instead of interleaving their read-modify-write cycles.
 *
 * A single-threaded synchronous writer cannot interleave with itself, so this
 * serializes the callers that can actually overlap — a sweep racing a stop, or
 * two sweeps started from different awaits. The last COMPLETED write wins: a
 * queued update reads whatever the previous one left, so a verdict is never
 * lost to a stale read, and the atomic replace means a reader between two
 * updates sees a complete record either way.
 */
const verdictQueues = new Map<string, Promise<unknown>>();

/**
 * Serialized form of `recordWorkerStopEvidence`, for callers that can await.
 *
 * Returns the same answer as the direct call; it only guarantees the update
 * does not overlap another update of the same task id.
 */
export function queueWorkerStopEvidence(
  subagentsDir: string,
  taskId: string,
  evidence: Omit<WorkerIdentityStopEvidence, "verified_at">
): Promise<WorkerStopEvidenceWrite> {
  // The queue lives per task id AND per subagents root: two roots can hold the
  // same task id, and their records are different files.
  const key = join(subagentsDir, taskId);
  const previous = verdictQueues.get(key) ?? Promise.resolve();
  const next = previous.then(
    () => recordWorkerStopEvidence(subagentsDir, taskId, evidence),
    () => recordWorkerStopEvidence(subagentsDir, taskId, evidence)
  );
  verdictQueues.set(
    key,
    next.catch(() => undefined)
  );
  void next.finally(() => {
    // Drop the tail once it is this task's last update, so the map does not
    // grow with every task id this process ever swept.
    if (verdictQueues.get(key) === next) verdictQueues.delete(key);
  });
  return next;
}

/**
 * Every record under a subagents root, plus the files that could not be
 * trusted. An ENOENT root is an empty listing, not a failure: a host that never
 * dispatched a worker has nothing to reconcile.
 *
 * This enumeration is also the sweep's selector, so it is where the two
 * excluded lifecycles are pinned down. The background Bash service and the
 * persistent-task lifecycle (ADR-0134 / ADR-0135) keep their own registries
 * under `<dataDir>/projects/<slug>/tasks/`, a different root from this
 * `subagents/` tree, and their records are not named `process-<taskId>.json` in
 * a `<taskId>/` child of it. Neither can be listed here even by accident:
 * selection requires the exact per-task path, and nothing else is ever opened.
 */
export function readWorkerIdentityRecords(
  subagentsDir: string
): WorkerIdentityRecords {
  let entries: string[];
  try {
    entries = readdirSync(subagentsDir);
  } catch (err) {
    if (errnoOf(err) === "ENOENT") {
      return { records: [], unreadable: [] };
    }
    return {
      records: [],
      unreadable: [
        {
          path: subagentsDir,
          reason: `list failed (${errnoOf(err)})`,
        },
      ],
    };
  }
  const records: WorkerIdentityRecord[] = [];
  const unreadable: WorkerIdentityReadError[] = [];
  for (const taskId of entries) {
    const path = workerProcessRecordPath(subagentsDir, taskId);
    if (!existsSync(path)) continue;
    // A record that cannot be *opened* is the same situation as one that
    // cannot be *parsed*: the listing's contract is that no record leaves it
    // unaccounted for. Letting the read throw would drop every other record in
    // the directory along with it, and a sweep that never ran is
    // indistinguishable from a directory that held no workers.
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (err) {
      unreadable.push({ path, reason: `read failed (${errnoOf(err)})` });
      continue;
    }
    const parsed = parseWorkerIdentityRecord(content);
    if (!parsed.ok) {
      unreadable.push({ path, reason: parsed.reason });
      continue;
    }
    records.push(parsed.value);
  }
  return { records, unreadable };
}

/** The record for one task, or undefined when absent or untrusted. */
export function readWorkerIdentityRecord(
  subagentsDir: string,
  taskId: string
): WorkerIdentityRecord | undefined {
  const state = readWorkerIdentityRecordState(subagentsDir, taskId);
  return state.kind === "record" ? state.value : undefined;
}

/**
 * Tri-state read of one task's record, because "there is no file" and "the
 * file is there but cannot be trusted" are different facts with different
 * consequences.
 *
 * A caller that must not signal an unproven process has to tell them apart:
 * an absent file is a legacy worker with no durable identity (nothing to
 * confirm, and the pre-record posture applies), while a file that exists and
 * does not parse means an identity WAS written and cannot now be trusted —
 * that is "cannot confirm", never "still running" and never "stopped". The
 * boolean-shaped read above collapses the two; this does not.
 */
export type WorkerIdentityRecordState =
  | { readonly kind: "absent" }
  | { readonly kind: "untrusted"; readonly reason: string }
  | { readonly kind: "record"; readonly value: WorkerIdentityRecord };

export function readWorkerIdentityRecordState(
  subagentsDir: string,
  taskId: string
): WorkerIdentityRecordState {
  const path = workerProcessRecordPath(subagentsDir, taskId);
  if (!existsSync(path)) return { kind: "absent" };
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    return { kind: "untrusted", reason: `read failed (${errnoOf(err)})` };
  }
  const parsed = parseWorkerIdentityRecord(content);
  return parsed.ok
    ? { kind: "record", value: parsed.value }
    : { kind: "untrusted", reason: parsed.reason };
}
