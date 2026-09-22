/**
 * Nested load / append seam for worker transcripts (ADR-0102).
 *
 * Why a separate module instead of SessionStore methods: SessionStore's key
 * space is "a session leaf in the project pool"
 * (`<projectDir>/<id>/<id>.jsonl`), while a worker transcript is keyed by
 * `(parent conversationId, task_id)` and lives inside the parent session
 * folder at `subagents/<taskId>/<taskId>.jsonl` (ADR-0102: no extra leaf in
 * the project pool, so `listSessions` does not pick it up). The shape is the
 * same — header + parent-chained message events + trailing head in
 * append-only JSONL — so the read path reuses `parseSessionJsonl` /
 * `projectSessionLog` and the write path mirrors `appendEvents`' numbering /
 * chaining / tail-drop semantics. The codec seam is reused rather than the
 * logic copied: SSOT is jsonl.ts.
 *
 * Typed-error vocabulary matches SessionStoreError kinds (not_found /
 * write_failed / parse_failed / schema_invalid / io_error); the
 * `conversation_id` slot carries task_id — in the nested-key context it is
 * this ledger's external handle.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { AnthropicNativeMessage } from "../../harness/index.js";
import type { SessionStoreError } from "./errors.js";
import { splitTurns } from "./checkpoint.js";
import { closeoutOrphanToolUses } from "./closeout-projection.js";
import {
  headChainEvents,
  matchCodePreimage,
  messageEventId,
  parseSessionJsonl,
  projectSessionLog,
  sessionFileToJsonl,
  type ParsedSessionLog,
  type PreimageRef,
  type SessionEventRecord,
  type SessionHeadRecord,
} from "./jsonl.js";
import {
  CURRENT_SCHEMA_VERSION,
  extractTitle,
  type SessionFileV1,
} from "./schema.js";

/** Location of one worker ledger: nested path + external handle task_id
 *  (the identity slot for typed errors). */
export interface WorkerTranscriptLocation {
  readonly transcriptPath: string;
  readonly taskId: string;
}

/**
 * Read the worker transcript's current-head projection (same shape as
 * SessionStore.load's JSONL arm: orphan tool_uses get synthetic
 * tool_results, so consumers always receive an API-valid chain).
 * Missing file → not_found (the continue gate rejects legacy workers
 * without a transcript accordingly).
 */
export async function loadWorkerTranscript(
  loc: WorkerTranscriptLocation
): Promise<SessionFileV1> {
  const { transcriptPath, taskId } = loc;
  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      throw {
        kind: "not_found",
        conversation_id: taskId,
      } satisfies SessionStoreError;
    }
    throw {
      kind: "io_error",
      conversation_id: taskId,
      cause: fsErrMsg(err),
    } satisfies SessionStoreError;
  }
  try {
    const file = projectSessionLog(parseSessionJsonl(raw));
    return {
      ...file,
      messages: closeoutOrphanToolUses(file.messages),
    };
  } catch (err) {
    throw attachTaskId(taskId, err);
  }
}

/**
 * The `codePreimage`-bearing events on the worker transcript's current head
 * chain — the worker half of the rewind/restore input (ADR-0121). Raw
 * records are read (not the `loadWorkerTranscript` projection) because the
 * stamp lives on the event record, never in model message content.
 *
 * Missing file → empty (legal: the worker exited before its first commit,
 * exactly the `not_found`-is-fresh posture of the load path). Any other read
 * or parse fault propagates typed — a corrupt ledger must never be mistaken
 * for "no preimages", same as `loadWorkerTranscript`.
 */
export async function loadWorkerPreimageEvents(
  loc: WorkerTranscriptLocation
): Promise<ReadonlyArray<SessionEventRecord>> {
  const { transcriptPath, taskId } = loc;
  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) return [];
    throw {
      kind: "io_error",
      conversation_id: taskId,
      cause: fsErrMsg(err),
    } satisfies SessionStoreError;
  }
  try {
    return headChainEvents(parseSessionJsonl(raw)).filter(
      (e) => e.codePreimage !== undefined
    );
  } catch (err) {
    throw attachTaskId(taskId, err);
  }
}

/**
 * Read one worker's spawn join key: `toolUseId` in
 * `subagents/<taskId>/agent-<taskId>.meta.json` = the PARENT transcript's
 * `spawn_subagent` tool_use id (written by the manager at spawn). Absent
 * meta file or absent field → undefined (legacy worker / Postel meta: no
 * link exists, so the restore scan skips it). A present-but-corrupt meta
 * propagates `parse_failed` — an unparseable link is indistinguishable from
 * a matching one and must abort the restore, not silently drop a worker.
 * `metaPath` is computed by the caller from the fence-tmp path SSOT; this
 * module stays path-agnostic like the rest of the worker-transcript seam.
 */
export async function readWorkerSpawnToolUseId(
  metaPath: string,
  taskId: string
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(metaPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw {
      kind: "io_error",
      conversation_id: taskId,
      cause: fsErrMsg(err),
    } satisfies SessionStoreError;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw {
      kind: "parse_failed",
      conversation_id: taskId,
      reason: "worker_meta_json",
    } satisfies SessionStoreError;
  }
  const toolUseId = (parsed as { toolUseId?: unknown }).toolUseId;
  return typeof toolUseId === "string" && toolUseId.length > 0
    ? toolUseId
    : undefined;
}

/**
 * Append-as-you-run: chain a batch of messages already in the authoritative
 * history onto the on-disk head plus one new head record (same numbering /
 * chaining / createdAt stamping discipline as SessionStore.appendEvents).
 * Missing file → the first batch creates the ledger: header + events + head
 * in one write (a worker transcript's birth batch = its initial-history
 * seed).
 *
 * Empty batch = no-op. `thinkingMs` shares appendEvents' boundary: the key
 * is attached only for assistant events with a finite >0 value.
 * `preimages` shares `SessionStore.appendEvents`' stamping contract (via the
 * same `matchCodePreimage`): a successful tool_result whose tool_use_id was
 * captured gets `codePreimage` on its event record — the worker transcript's
 * restore surface (ADR-0121).
 */
export async function appendWorkerTranscript(opts: {
  readonly location: WorkerTranscriptLocation;
  readonly events: ReadonlyArray<AnthropicNativeMessage>;
  readonly thinkingMs?: number;
  /** tool_use_id → captured preimage, for stamping successful tool_result
   *  events; absent/empty → no stamping. */
  readonly preimages?: ReadonlyMap<string, PreimageRef>;
  /** Working root written into the header when creating the ledger
   *  (worker = envelope.sandboxRoot). */
  readonly cwd?: string;
}): Promise<void> {
  const { location, events } = opts;
  if (events.length === 0) return;
  const { transcriptPath, taskId } = location;
  let raw: string | null;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch (err) {
    if (!isEnoent(err)) {
      throw {
        kind: "io_error",
        conversation_id: taskId,
        cause: fsErrMsg(err),
      } satisfies SessionStoreError;
    }
    raw = null;
  }
  try {
    if (raw === null) {
      await mkdir(dirname(transcriptPath), { recursive: true });
      const now = new Date().toISOString();
      const file: SessionFileV1 = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: taskId,
        messages: events,
        jsonMode: false,
        turnCount: splitTurns(events).length,
        updatedAt: now,
        title: extractTitle(events),
        cwd: opts.cwd ?? "",
        sanitized_at: now,
      };
      await writeFile(transcriptPath, sessionFileToJsonl(file), "utf8");
      return;
    }
    let log: ParsedSessionLog;
    try {
      log = parseSessionJsonl(raw);
    } catch (err) {
      throw attachTaskId(taskId, err);
    }
    const stampableThinkingMs =
      typeof opts.thinkingMs === "number" &&
      Number.isFinite(opts.thinkingMs) &&
      opts.thinkingMs > 0
        ? opts.thinkingMs
        : undefined;
    let next = log.maxEventIndex + 1;
    let parent = log.head;
    const lines: string[] = [];
    for (const message of events) {
      const eventId = messageEventId(next++);
      const codePreimage = matchCodePreimage(message, opts.preimages);
      const record: SessionEventRecord = {
        type: "message",
        id: eventId,
        parent,
        message,
        createdAt: new Date().toISOString(),
        ...(message.role === "assistant" && stampableThinkingMs !== undefined
          ? { thinkingMs: stampableThinkingMs }
          : {}),
        ...(codePreimage !== undefined ? { codePreimage } : {}),
      };
      lines.push(JSON.stringify(record));
      parent = eventId;
    }
    const head: SessionHeadRecord = { type: "head", id: parent };
    lines.push(JSON.stringify(head));
    await appendFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
  } catch (err) {
    if ((err as { kind?: string }).kind !== undefined) throw err;
    throw {
      kind: "write_failed",
      conversation_id: taskId,
      cause: fsErrMsg(err),
    } satisfies SessionStoreError;
  }
}

// -- module-level helpers ----------------------------------------------------

function attachTaskId(taskId: string, err: unknown): SessionStoreError {
  const e = err as { kind?: string; reason?: unknown; field?: unknown };
  if (e.kind === "parse_failed") {
    return {
      kind: "parse_failed",
      conversation_id: taskId,
      reason: typeof e.reason === "string" ? e.reason : "unknown",
    };
  }
  return {
    kind: "schema_invalid",
    conversation_id: taskId,
    field: typeof e.field === "string" ? e.field : "root",
  };
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** For native fs errors only; typed errors (discriminated union) must be
 *  routed by kind before this helper is used. */
function fsErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Path guard: the worker ledger path is an absolute path computed by the
 * parent (the envelope is an untrusted input surface — only the manager
 * produces it; the worker validates shape before consuming and rejects
 * relative paths / empty strings, leaving no silent write-to-cwd channel
 * when the parent failed to compute it).
 */
export function isWorkerTranscriptPathSafe(transcriptPath: string): boolean {
  return transcriptPath.length > 0 && isAbsolute(transcriptPath);
}
