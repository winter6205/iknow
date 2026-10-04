/**
 * Rebuild one logical sub-agent task from what survived a host restart.
 *
 * Why this exists: after the host process dies, the manager's in-memory task
 * map dies with it, so a `subagent_continue` for a task that is perfectly
 * alive on disk used to answer `not_found` — a claim that the task never
 * existed, which is false and which sends the model off to spawn a duplicate
 * worker behind the same history. The durable identity record plus the worker's
 * own transcript are enough to reconstruct what the map held, and this module
 * is that reader.
 *
 * Three rules, and they are what make the entry trustworthy rather than
 * convenient:
 *
 *   1. The record is the identity, and an untrusted record is NOT an absent
 *      one. A file that exists but does not parse means an identity was
 *      written and cannot now be confirmed, which is a refusal (`untrusted`),
 *      never a "no task here" and never a "stopped" verdict.
 *   2. Nothing is rehydrated into a live process. This produces a logical entry
 *      — id, agent type, ownership, progress, recorded state — with no
 *      `ChildProcess`, no timer, no abort controller, and no permission grant.
 *      Restoring those is out of scope by spec, and a reader that looked like
 *      it could would be the more dangerous artifact.
 *   3. The worker's transcript is READ, never repaired. A torn trailing append
 *      is reported as the interruption it is, and the entries before it are
 *      still progress.
 *
 * Harness boundary: the ledger codec lives in the store layer and may not be
 * imported here (Gate B), so the transcript is read as the append-only JSONL it
 * physically is. That is also the honest reading for this purpose — progress is
 * "how far the worker's own writer got", not a model-message projection.
 */
import { existsSync, readFileSync } from "node:fs";

import { workerMetaPath, workerTranscriptPath } from "../sandbox/fence-tmp.js";
import {
  readWorkerIdentityRecordState,
  type WorkerIdentityRecord,
  type WorkerLifecycleState,
  type WorkerOwnership,
} from "./worker-identity-record.js";

/** How far the worker's own transcript writer got before the host died. */
export interface WorkerTranscriptProgress {
  /** Complete, well-formed records committed to the worker's own ledger. */
  readonly committed: number;
  /** Role of the last complete record, when it names one. */
  readonly lastRole?: string;
  /**
   * A trailing line that does not parse. This is the interrupted-append
   * signature, and it is reported rather than repaired: the worker's writer was
   * mid-append when the host went away, and the entries before it are still the
   * truth.
   */
  readonly interrupted: boolean;
  /** Absent when the transcript has not been created yet. */
  readonly present: boolean;
}

const ABSENT_PROGRESS: WorkerTranscriptProgress = {
  committed: 0,
  interrupted: false,
  present: false,
};

/** The honest terminal state of a task whose process is gone. */
export function isTerminalWorkerState(state: WorkerLifecycleState): boolean {
  return state === "completed" || state === "failed";
}

/** One task reconstructed from disk: no live process, no restored handle. */
export interface RehydratedWorkerTask {
  readonly task_id: string;
  /** The identity this entry stands for, trusted because it parsed. */
  readonly record: WorkerIdentityRecord;
  readonly state: WorkerLifecycleState;
  readonly ownership: WorkerOwnership;
  readonly session_id?: string;
  readonly tool_use_id?: string;
  readonly transcript_path: string;
  /** Catalog persona id from the worker's own spawn meta; absent when unknown. */
  readonly agentType?: string;
  readonly progress: WorkerTranscriptProgress;
}

/**
 * Rehydration outcome, and the branch that matters: `absent` genuinely means
 * there is nothing on disk for this task id, and only then may a caller say the
 * task is unknown. `untrusted` means a record exists and cannot be believed.
 */
export type WorkerTaskRehydration =
  | { readonly kind: "absent" }
  | { readonly kind: "untrusted"; readonly reason: string }
  | { readonly kind: "reconstructed"; readonly task: RehydratedWorkerTask };

function presentString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Count the worker's committed ledger records. A line is progress only if it
 * is non-empty AND parses: a torn trailing append is evidence of interruption,
 * not a message, and admitting it would report progress the worker's own writer
 * never finished.
 */
function readProgress(transcriptPath: string): WorkerTranscriptProgress {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    // EXIT: an unreadable ledger is not "no progress"; it is progress this
    // process cannot read, and the caller already refuses unprovable tasks.
    return ABSENT_PROGRESS;
  }
  const lines = raw.split("\n");
  let committed = 0;
  let lastRole: string | undefined;
  let interrupted = false;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Only the tail can be torn: the writer appends, so a parse failure in
      // the middle would be a different defect and is reported the same way —
      // the committed prefix is still the truthful part.
      interrupted = true;
      continue;
    }
    committed += 1;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      presentString((parsed as { readonly role?: unknown }).role)
    ) {
      // Overwritten per record, so it ends on the LAST complete record — the
      // field is a "how far did the writer get" projection, not the first role.
      lastRole = (parsed as { readonly role: string }).role;
    }
  }
  return {
    committed,
    ...(lastRole !== undefined ? { lastRole } : {}),
    interrupted,
    present: true,
  };
}

/**
 * The agent type, from the worker's own spawn meta written once at dispatch.
 * Postel: a missing or unreadable meta is a legacy worker, so the field is
 * simply absent rather than guessed from the task id.
 */
function readAgentType(
  subagentsDir: string,
  taskId: string
): string | undefined {
  const path = workerMetaPath(subagentsDir, taskId);
  if (!existsSync(path)) return undefined;
  try {
    const meta: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof meta !== "object" || meta === null) return undefined;
    const value = (meta as { readonly agentType?: unknown }).agentType;
    return presentString(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The one reconstruction entry point. Callers treat the in-memory task map as
 * the fast path and reach for this only when the map has no such task — which,
 * in a live host, means the map is the authority and this is not consulted.
 */
export function rehydrateWorkerTask(
  subagentsDir: string,
  taskId: string
): WorkerTaskRehydration {
  const state = readWorkerIdentityRecordState(subagentsDir, taskId);
  if (state.kind === "absent") return { kind: "absent" };
  if (state.kind === "untrusted") {
    return { kind: "untrusted", reason: state.reason };
  }
  const record = state.value;
  const transcriptPath = workerTranscriptPath(subagentsDir, taskId);
  const agentType = readAgentType(subagentsDir, taskId);
  return {
    kind: "reconstructed",
    task: {
      task_id: record.task_id,
      record,
      state: record.worker_state,
      ownership: record.ownership,
      ...(record.session_id !== undefined
        ? { session_id: record.session_id }
        : {}),
      ...(record.tool_use_id !== undefined
        ? { tool_use_id: record.tool_use_id }
        : {}),
      transcript_path: transcriptPath,
      ...(agentType !== undefined ? { agentType } : {}),
      progress: readProgress(transcriptPath),
    },
  };
}

/**
 * The def half of a resume for a rehydrated task: the identity and capability
 * fields the map would have supplied, taken from what is actually on disk.
 *
 * Deliberately partial. The original `maxTurns` / `timeoutMs` / `sandboxRoot`
 * are not recorded per task, so they are left absent and the manager's existing
 * fallbacks apply — a reconstructed entry must not invent configuration it
 * cannot read, because an invented timeout or root is a silent behaviour
 * change behind an honest-looking entry.
 */
export function rehydratedResumeFields(task: RehydratedWorkerTask): {
  readonly conversationId?: string;
  readonly role?: string;
  readonly excludeFromHostDrain?: boolean;
} {
  return {
    ...(task.session_id !== undefined
      ? { conversationId: task.session_id }
      : {}),
    ...(task.agentType !== undefined ? { role: task.agentType } : {}),
    // The ownership the record carries is the same bit the drain gate reads,
    // so the resumed hop keeps the delivery channel its first hop had.
    ...(task.ownership === "foreground" ? { excludeFromHostDrain: true } : {}),
  };
}
