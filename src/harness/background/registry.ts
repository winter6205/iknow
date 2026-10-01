/**
 * Task registry persistence layer: BackgroundTaskRecord type + pure fs ops.
 *
 * On-disk shape is fixed by ADR-0021: one `<task_id>.json` per task, field
 * names in snake_case (owner_pid / conversation_id / exit_code / created_at)——
 * Persisted JSON key names follow this wire contract, consistent with
 * session-store conventions
 * (conversation_id is a wire field; host-side in-memory state stays camelCase
 * and is never persisted).
 *
 * Typed-error discriminated union BackgroundTaskError, kind contract:
 *  - empty_task_id / task_not_found / schema_invalid / io_failure are
 *    discriminated by kind; illegal vs. legal states are distinguished by the
 *    caller (io_failure = real fault; not_found on non-status paths is a
 *    distinguishable legal state). Render `${kind}: ${context}`.
 * Layering: registry is a pure fs layer, unaware of child processes / the
 * status machine; manager holds the in-memory Map and drives transitions. The
 * spawn-time json write (log_path known) is done by manager; this layer's
 * save accepts a complete record for persistence.
 */
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Task state-machine literals (finalized per ADR-0021). "dead" is
 *  written by the startup stale sweep (reap): owner_pid dead + pgid already
 *  gone / starttime matched → the process group has been SIGKILLed,
 *  converging the process-level lifecycle. */
export type BackgroundTaskStatus = "running" | "exited" | "killed" | "dead";

/**
 * Why a task reached its terminal state (ADR-0134). The first trigger to
 * arrive owns the task's terminal transition; a later competing trigger
 * (natural exit / stop / deadline / shutdown) observes this cause instead of
 * overwriting it, so a race never rewrites history.
 */
export type BackgroundTerminationCause =
  | "exit"
  | "stop_requested"
  | "deadline_expired"
  | "shutdown";

/**
 * Persisted record (ADR-0021): snake_case field names = wire contract,
 * together with the task_id format (`bg-` + 12 hex) forming the sole mapping
 * for bash_output / bash_stop inputs. exit_code defaults to null (running
 * state), filled with the natural exit code after termination. starttime is
 * optional (ADR-0021): field 22 of the process-group leader's
 * /proc/<pid>/stat, used by the startup stale sweep to avoid killing a
 * recycled pgid by mistake. Absent on non-Linux / when /proc is unreadable
 * -> reap applies a conservative policy for records without starttime
 * (skip only, never kill).
 */
export interface BackgroundTaskRecord {
  readonly task_id: string;
  readonly command: string;
  readonly owner_pid: number;
  readonly conversation_id: string;
  readonly pgid: number;
  readonly status: BackgroundTaskStatus;
  readonly exit_code: number | null;
  readonly created_at: string;
  readonly log_path: string;
  readonly starttime?: number;
  /**
   * ADR-0134: the model-supplied finite runtime budget, in milliseconds, as
   * validated at launch. Absent = the persistent-service lifecycle: no
   * runtime deadline exists for this task. Persisted alongside deadline_at so
   * a record read back from disk still states which contract the task runs
   * under.
   */
  readonly timeout_ms?: number;
  /**
   * ADR-0134: the one absolute instant this task's deadline expires, frozen
   * at launch (created_at + timeout_ms). Polling, log reads and stop requests
   * never recompute it, so a restored record reports the same clock the host
   * armed. Absent on a persistent-service task.
   */
  readonly deadline_at?: string;
  /**
   * ADR-0134: why the task became terminal. Absent while the task is running;
   * set once, by the transition that won the race.
   */
  readonly termination_cause?: BackgroundTerminationCause;
}

/**
 * Typed-error discriminated union. Carries an optional cause for debugging
 * the real root cause; rendered uniformly as `${kind}: ${context}` per the
 * typed-error catch contract.
 */
export type BackgroundTaskError =
  | { kind: "empty_task_id"; context: string }
  | { kind: "task_not_found"; context: string }
  | {
      kind: "task_not_in_scope";
      context: string;
      /** The task's real conversation_id (carried explicitly). Rendered as `${kind}: ${context}`. */
      owner_conversation_id: string;
    }
  | { kind: "schema_invalid"; context: string; cause?: unknown }
  | { kind: "io_failure"; context: string; cause?: unknown };

/** Render helper: uniform typed-error shape (shared by tests and the catch contract). */
export function renderTaskError(err: BackgroundTaskError): string {
  return `${err.kind}: ${err.context}`;
}

/** Logger injected by registry/manager (tool side can swap implementations; no default = silent). */
export interface BackgroundTaskLog {
  (msg: string): void;
}

export interface BackgroundRegistry {
  /** Save one record (create or update); mkdir -p when the directory is missing. */
  readonly save: (record: BackgroundTaskRecord) => Promise<void>;
  /** Read a record by task_id; missing / invalid each throw a typed-error. */
  readonly load: (taskId: string) => Promise<BackgroundTaskRecord>;
  /** List all task_ids (only *.json file names). */
  readonly list: () => Promise<readonly string[]>;
  /** Delete the record file. */
  readonly remove: (taskId: string) => Promise<void>;
}

export interface BackgroundRegistryOptions {
  readonly tasksDir: string;
  /** Persistence-failure / risk-event log (silent by default). */
  readonly log?: BackgroundTaskLog;
}

export function createBackgroundRegistry(
  opts: BackgroundRegistryOptions
): BackgroundRegistry {
  const tasksDir = opts.tasksDir;
  const log = opts.log ?? (() => undefined);

  function filePath(taskId: string): string {
    return join(tasksDir, `${taskId}.json`);
  }

  async function save(record: BackgroundTaskRecord): Promise<void> {
    if (record.task_id.trim().length === 0) {
      throw {
        kind: "empty_task_id",
        context: "save",
      } satisfies BackgroundTaskError;
    }
    try {
      await mkdir(tasksDir, { recursive: true });
      await writeFile(
        filePath(record.task_id),
        JSON.stringify(record, null, 2),
        "utf8"
      );
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      log(`background registry save failed: ${cause}`);
      throw {
        kind: "io_failure",
        context: `save ${record.task_id}`,
        cause,
      } satisfies BackgroundTaskError;
    }
  }

  async function load(taskId: string): Promise<BackgroundTaskRecord> {
    if (taskId.trim().length === 0) {
      throw {
        kind: "empty_task_id",
        context: "load",
      } satisfies BackgroundTaskError;
    }
    let raw: string;
    try {
      raw = await readFile(filePath(taskId), "utf8");
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw {
          kind: "task_not_found",
          context: taskId,
        } satisfies BackgroundTaskError;
      }
      throw {
        kind: "io_failure",
        context: `load ${taskId}`,
        cause,
      } satisfies BackgroundTaskError;
    }
    try {
      return JSON.parse(raw) as BackgroundTaskRecord;
    } catch (err) {
      throw {
        kind: "schema_invalid",
        context: `parse ${taskId}`,
        cause: err instanceof Error ? err.message : String(err),
      } satisfies BackgroundTaskError;
    }
  }

  async function list(): Promise<readonly string[]> {
    let entries: string[];
    try {
      entries = await readdir(tasksDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      const cause = err instanceof Error ? err.message : String(err);
      log(`background registry list failed: ${cause}`);
      throw {
        kind: "io_failure",
        context: "list",
        cause,
      } satisfies BackgroundTaskError;
    }
    return entries
      .filter((name) => name.endsWith(".json"))
      .map((n) => n.slice(0, -5));
  }

  async function remove(taskId: string): Promise<void> {
    if (taskId.trim().length === 0) {
      throw {
        kind: "empty_task_id",
        context: "remove",
      } satisfies BackgroundTaskError;
    }
    try {
      await unlink(filePath(taskId));
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw {
          kind: "task_not_found",
          context: taskId,
        } satisfies BackgroundTaskError;
      }
      throw {
        kind: "io_failure",
        context: `remove ${taskId}`,
        cause,
      } satisfies BackgroundTaskError;
    }
  }

  return Object.freeze({ save, load, list, remove });
}
