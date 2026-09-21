/**
 * Startup stale sweep: reclaim background-task process groups whose
 * owner_pid is dead.
 *
 * Per ADR-0021 the iknow process is the physical anchor — after an abnormal
 * exit (SIGKILL / crash) the leftover background-task process groups have no
 * owner governance, and this sweep reclaims them on the next startup.
 *
 * Only owner-dead records are processed (owner check: `/proc/<pid>` exists +
 * stat readable = alive; otherwise dead). owner-alive records are skipped —
 * they are live tasks of another running iknow process; never kill across
 * processes.
 *
 * pgid-reuse hardening (ADR-0021): before killing, compare the starttime
 * from `/proc/<pgid-leader>/stat` with the starttime stored in the registry
 * record:
 *   - record has starttime and it mismatches -> the pgid was recycled by the
 *     kernel for a new group; mark dead only, never kill (the recycled group
 *     holds unrelated processes; a mistaken kill is unacceptable).
 *   - record has no starttime (older record) -> conservative policy: skip the
 *     record, keep the json, log it — better to miss than to mis-kill.
 *   - record starttime matches current / current unreadable (group already
 *     gone) -> SIGKILL the process group (ESRCH swallowed) + mark dead.
 *
 * Never throws: missing tasksDir / broken json / persistence failure ->
 * skip that entry (skipped) or continue best-effort, surfaced via log.
 * Returns a summary for the caller to display / assert.
 */
import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";

import type { BackgroundTaskRecord, BackgroundTaskLog } from "./registry.js";
import { createBackgroundRegistry } from "./registry.js";
import type { BackgroundTaskError } from "./registry.js";
import { readProcStartTime } from "./proc.js";

export interface ReapStaleTasksOptions {
  readonly tasksDir: string;
  /** Risk-event log (silent by default). */
  readonly log?: BackgroundTaskLog;
}

export interface ReapSummary {
  /** task_ids reclaimed (process group killed + json marked dead). */
  readonly reaped: readonly string[];
  /** task_ids skipped this pass (owner alive / no starttime / broken json, etc.). */
  readonly skipped: readonly string[];
}

/** /proc/<pid> exists + stat readable = alive (does not distinguish
 *  zombie/defunct — zombies still have stat; conservatively judged alive,
 *  waiting for the OS to reap them). */
function isPidAlive(pid: number): boolean {
  try {
    return existsSync(`/proc/${pid}`);
  } catch {
    return false;
  }
}

/** Per-record classification this pass -> counted as reaped / skipped / neither (already converged). */
type ReapAction = "reaped" | "skipped" | "none";

async function markDead(
  registry: ReturnType<typeof createBackgroundRegistry>,
  rec: BackgroundTaskRecord,
  taskId: string,
  log: BackgroundTaskLog
): Promise<void> {
  const next: BackgroundTaskRecord = {
    ...rec,
    status: "dead",
  };
  try {
    await registry.save(next);
  } catch (err) {
    log(
      `background reap: mark dead save failed: ${
        (err as BackgroundTaskError).context
      } — ${taskId}`
    );
  }
}

/** Log hygiene: append a reap marker line to the existing log file. Missing file -> swallow the error (never create). */
async function appendReapMarker(rec: BackgroundTaskRecord): Promise<void> {
  if (!existsSync(rec.log_path)) return;
  try {
    await appendFile(
      rec.log_path,
      `\n[reap ${new Date().toISOString()}] status=dead task_id=${rec.task_id} pgid=${rec.pgid}\n`,
      "utf8"
    );
  } catch {
    /* append failure must not block the reclamation flow */
  }
}

export async function reapStaleTasks(
  opts: ReapStaleTasksOptions
): Promise<ReapSummary> {
  const log = opts.log ?? (() => undefined);
  const registry = createBackgroundRegistry({
    tasksDir: opts.tasksDir,
    log,
  });
  const reaped: string[] = [];
  const skipped: string[] = [];

  let taskIds: readonly string[];
  try {
    taskIds = await registry.list();
  } catch (err) {
    // a missing directory lists as [] without throwing; other readdir
    // failures (path is a file, etc.) -> log + empty summary; the startup
    // sweep never crashes.
    log(
      `background reap: list failed: ${(err as BackgroundTaskError).context}`
    );
    return { reaped, skipped };
  }

  for (const taskId of taskIds) {
    const action = await handleRecord(registry, taskId, log);
    if (action === "reaped") reaped.push(taskId);
    else if (action === "skipped") skipped.push(taskId);
    // "none" -> already converged (already_dead), counted as neither reaped
    // nor skipped; mtime unchanged, zero json changes.
  }

  return { reaped, skipped };
}

/**
 * Process one record. Returns this pass's classification:
 *   - "reaped": owner_dead + starttime matches -> kill group + mark dead;
 *               owner_dead + starttime mismatch -> mark dead, no kill.
 *   - "skipped": owner_alive / no starttime / recoverable persistence failure
 *     / broken json.
 *   - "none": already-dead record (json converged, never rewritten —
 *     idempotence gate).
 */
async function handleRecord(
  registry: ReturnType<typeof createBackgroundRegistry>,
  taskId: string,
  log: BackgroundTaskLog
): Promise<ReapAction> {
  let rec: BackgroundTaskRecord;
  try {
    rec = await registry.load(taskId);
  } catch (err) {
    log(
      `background reap: load ${taskId} failed: ${
        (err as BackgroundTaskError).context
      } — skipped`
    );
    return "skipped";
  }

  // Idempotence gate: an already-dead record is the result of a previous
  // (or this) pass; the json has converged — do not rewrite (mtime unchanged,
  // zero json changes).
  if (rec.status === "dead") {
    log(`background reap: already dead, skip ${taskId}`);
    return "none";
  }

  if (isPidAlive(rec.owner_pid)) {
    log(`background reap: owner alive, skip ${taskId}`);
    return "skipped";
  }

  // No starttime (older record) -> conservative policy: skip, keep the json, log.
  if (rec.starttime === undefined) {
    log(
      `background reap: no starttime, conservative skip ${taskId} (pgid ${rec.pgid})`
    );
    return "skipped";
  }

  const currentStart = readProcStartTime(rec.pgid);
  if (currentStart !== undefined && currentStart !== rec.starttime) {
    // The pgid was recycled by the kernel for a new group — mark dead only, never kill unrelated processes.
    log(
      `background reap: starttime mismatch pgid ${rec.pgid} (${rec.starttime} != ${currentStart}) — mark dead only, no kill`
    );
    await markDead(registry, rec, taskId, log);
    await appendReapMarker(rec);
    return "reaped";
  }

  // owner dead + starttime matches (or current unreadable = group already
  // gone, ESRCH harmless). SIGKILL the whole group (physical reclamation,
  // least ambiguity). ESRCH swallowed.
  try {
    process.kill(-rec.pgid, "SIGKILL");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      log(`background reap: kill group ${rec.pgid} failed: ${String(err)}`);
    }
  }
  await markDead(registry, rec, taskId, log);
  await appendReapMarker(rec);
  return "reaped";
}
