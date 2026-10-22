/**
 * Incremental reader for the persisted session store (#1219).
 *
 * WHY a reader and not a file listing: acceptance and idleness are decided from
 * what the host PERSISTED, relative to a baseline. The historical driver read
 * zero bytes of the store — it accepted a stimulus when a new `.jsonl` file
 * appeared anywhere under `projects/`, which is why run3 journaled S4 as
 * "submission_verified" 113 ms before two sub-agent session dirs appeared, with
 * S4's text in no store file, and why resume1 recorded zero verifications for a
 * turn that was demonstrably accepted.
 *
 * The store's contract, as measured over a real 1017-record log:
 *   - there is NO top-level `role`; a user turn is `type:"message"` with
 *     `message.role === "user"`;
 *   - 176 of the user-role records carry `message.hostInjected === true`. They
 *     are host plumbing (status reconciliation, todo restatement) and must
 *     NEVER satisfy acceptance, so the guard is part of the predicate rather
 *     than a filter applied afterwards;
 *   - `native_state` with `boundary:"input"` is the acceptance boundary and
 *     `boundary:"terminal"` is the idle boundary; `boundary:"tool_batch"` is
 *     internal per-LLM-turn activity and is forbidden as an idle signal;
 *   - records after a crash carry `createdAt: null`, so no reader may require
 *     the stamp;
 *   - `turnId` names two disjoint things (a UUID on `operation_fact`, a message
 *     event id on `outcome`), so it is never used as a key here;
 *   - sub-agent transcripts are real `.jsonl` files under
 *     `<conv>/subagents/<uuid>/` and are excluded by path.
 *
 * Failure posture: an incomplete trailing line is a normal mid-append state and
 * is waited on, and an ABSENT store is a normal pre-first-input state (the
 * writer creates the file lazily) and polls as `exists: false`. A malformed
 * COMPLETE line, a schema violation or any read failure that is not mere absence
 * raises `ObserverError` — a broken observer is an error report, never a quiet
 * terminal, because "quiet" is what the stop rule reads as settled.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  isNativeStateBoundary,
  parseSessionJsonl,
  type SessionEventRecord,
  type SessionHeadRecord,
  type SessionJsonlRecord,
  type SessionNativeStateRecord,
  type SessionOutcomeRecord,
  type SessionTitleRecord,
} from "../../../src/session-api/store/jsonl.js";
import { computeProjectSlug } from "../../../src/shared/project-slug.js";
import { SUBAGENT_TRACE_DIR_NAME } from "../../../src/shared/session-tree-names.js";

/** Any record this observer reads. Narrower unions would need the off-chain
 *  record kinds duplicated at every call site. */
export type StoreRecord = SessionJsonlRecord;

/** Where a conversation lives on disk. */
export interface SessionLocation {
  readonly dataDir: string;
  readonly cwd: string;
  readonly conversationId: string;
}

/** A read that failed. Never an idle signal. */
export class ObserverError extends Error {
  constructor(
    readonly kind: "malformed_line" | "schema_invalid" | "read_failed",
    readonly line: number,
    readonly detail: string
  ) {
    super(`ObserverError(${kind}) at line ${line}: ${detail}`);
    this.name = "ObserverError";
  }
}

/** The measured position before the run started. */
export interface Baseline {
  readonly path: string;
  readonly conversationId: string;
  /**
   * Byte offset of the end of the last COMPLETE line.
   *
   * Retained because `run.ts` hands it to `deriveStoreCounters` as a one-shot
   * report field. It is NOT the reader's cursor: the header line changes length
   * mid-run, so this value does not survive a rewrite (see `lastLine`).
   */
  readonly byteOffset: number;
  readonly lineCount: number;
  /** Text of the last COMPLETE line — the reader's re-anchor identity. */
  readonly lastLine: string;
  readonly eventIds: readonly string[];
  readonly headId: string | null;
}

/** Records appended since the previous poll. */
export interface PollResult {
  readonly records: readonly StoreRecord[];
  readonly messages: readonly SessionEventRecord[];
  readonly inputAnchors: readonly string[];
  readonly terminalAnchors: readonly string[];
  readonly toolBatchAnchors: readonly string[];
  readonly outcomes: readonly SessionOutcomeRecord[];
  readonly headId: string | null;
  readonly bytesRead: number;
  readonly completeLines: number;
  /** Bytes of an incomplete trailing line, retained for the next poll. */
  readonly pendingTailBytes: number;
  readonly error: ObserverError | null;
  readonly exists: boolean;
}

const EMPTY: PollResult = {
  records: [],
  messages: [],
  inputAnchors: [],
  terminalAnchors: [],
  toolBatchAnchors: [],
  outcomes: [],
  headId: null,
  bytesRead: 0,
  completeLines: 0,
  pendingTailBytes: 0,
  error: null,
  exists: false,
};

/** `<data>/projects/<basename>-<sha1[:12]>/<conv>/<conv>.jsonl`. */
export function sessionFilePath(loc: SessionLocation): string {
  return join(
    loc.dataDir,
    "projects",
    computeProjectSlug(loc.cwd),
    loc.conversationId,
    `${loc.conversationId}.jsonl`
  );
}

/** True for any path inside a conversation's `subagents/` subtree. */
export function isSubagentSessionPath(path: string): boolean {
  return path.split(sep).includes(SUBAGENT_TRACE_DIR_NAME);
}

/** Every conversation file under the project, sub-agent transcripts excluded. */
export function listSessionFiles(loc: SessionLocation): string[] {
  const projectDir = join(loc.dataDir, "projects", computeProjectSlug(loc.cwd));
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return [];
  }
  return entries
    .filter((conv) => !conv.startsWith("."))
    .map((conv) => join(projectDir, conv, `${conv}${".jsonl"}`))
    .filter((path) => !isSubagentSessionPath(path))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
}

/** Concatenated text of a message record's `text` blocks. */
export function messageText(record: SessionEventRecord): string {
  const blocks = record.message.content as ReadonlyArray<{
    type: string;
    text?: string;
  }>;
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/**
 * The acceptance guard. A record counts as a real user turn only when it is a
 * message, its role is `user`, it is NOT host-injected, and (when the baseline
 * event-id set is supplied) its id was not already persisted when the run
 * started.
 */
export function isRealUserMessage(
  record: StoreRecord,
  baselineEventIds?: ReadonlySet<string>
): boolean {
  if (record.type !== "message") return false;
  const message = record.message as
    { role?: string; hostInjected?: unknown } | undefined;
  if (message?.role !== "user") return false;
  if (message.hostInjected !== undefined) return false;
  return baselineEventIds === undefined || !baselineEventIds.has(record.id);
}

/** `boundary:"input"` — the host accepted a user turn and published state there. */
export function isInputBoundary(
  record: StoreRecord
): record is SessionNativeStateRecord {
  return record.type === "native_state" && record.boundary === "input";
}

/** `boundary:"terminal"` — the round returned control, i.e. the host is idle. */
export function isTerminalBoundary(
  record: StoreRecord
): record is SessionNativeStateRecord {
  return record.type === "native_state" && record.boundary === "terminal";
}

/** Record census by `type`, for the derived evidence counters. */
export function census(
  records: readonly StoreRecord[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    const type = String((record as { type?: unknown }).type ?? "unknown");
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

/** Read one file and validate it with the PRODUCTION parser. */
export function validateWholeFile(path: string): {
  records: readonly StoreRecord[];
  error: ObserverError | null;
} {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return {
      records: [],
      error: new ObserverError("read_failed", 0, String(err)),
    };
  }
  try {
    return {
      records: parseSessionJsonl(raw).records as readonly StoreRecord[],
      error: null,
    };
  } catch (err) {
    const detail =
      typeof err === "object" && err !== null
        ? JSON.stringify(err)
        : String(err);
    return {
      records: [],
      error: new ObserverError("schema_invalid", 0, detail),
    };
  }
}

function parseCompleteLine(line: string, lineNo: number): StoreRecord {
  try {
    return JSON.parse(line) as StoreRecord;
  } catch (err) {
    throw new ObserverError(
      "malformed_line",
      lineNo,
      `${String(err)} :: ${line.slice(0, 160)}`
    );
  }
}

function assertKnownType(record: StoreRecord, lineNo: number): void {
  const type = String((record as { type?: unknown }).type ?? "");
  const known = [
    "session",
    "message",
    "head",
    "title",
    "outcome",
    "native_state",
    "file_intent",
    "operation_fact",
  ];
  if (!known.includes(type)) {
    throw new ObserverError(
      "schema_invalid",
      lineNo,
      `unknown record type ${JSON.stringify(type)}`
    );
  }
}

function assertEventShape(
  record: StoreRecord,
  seen: Set<string>,
  lineNo: number
): void {
  if (record.type !== "message") return;
  const id = record.id;
  if (!/^e\d+$/.test(id)) {
    throw new ObserverError(
      "schema_invalid",
      lineNo,
      `event id must be e<index>; got ${JSON.stringify(id)}`
    );
  }
  if (seen.has(id))
    throw new ObserverError(
      "schema_invalid",
      lineNo,
      `duplicate event id ${id}`
    );
  if (record.parent !== null && !seen.has(record.parent)) {
    throw new ObserverError(
      "schema_invalid",
      lineNo,
      `parent ${record.parent} was never persisted`
    );
  }
  seen.add(id);
}

function assertHeadShape(
  record: StoreRecord,
  seen: ReadonlySet<string>,
  lineNo: number
): void {
  if (record.type !== "head") return;
  if (record.id !== null && !seen.has(record.id)) {
    throw new ObserverError(
      "schema_invalid",
      lineNo,
      `head points at unknown event ${record.id}`
    );
  }
}

function nativeAnchors(
  records: readonly StoreRecord[],
  boundary: string
): string[] {
  return records
    .filter(
      (r): r is SessionNativeStateRecord =>
        r.type === "native_state" && r.boundary === boundary
    )
    .map((r) => r.anchorEventId);
}

function headIdOf(records: readonly StoreRecord[]): string | null {
  const heads = records.filter(
    (r): r is SessionHeadRecord => r.type === "head"
  );
  return heads.length === 0 ? null : heads[heads.length - 1]!.id;
}

/**
 * Read the whole store as RAW BYTES. Absence is the writer's "not yet"; every
 * other failure is a broken observer.
 *
 * WHY THE WHOLE FILE. The writer is NOT append-only in byte offset. `save()`
 * writes the whole log to a tmp file and renames it over the authority, and the
 * `session` header on line 1 GROWS as a run progresses (`turnCount`, `title`,
 * `lastUsage`), so every record after it shifts. A reader carrying a monotonic
 * byte offset therefore resumes in the middle of a record and raises
 * `ObserverError(malformed_line)` mid-turn. Re-reading and re-anchoring on the
 * identity of the last consumed line is immune to that, and the store is small.
 */
function readWhole(path: string): StoreRead {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch (err) {
    if (isAbsentPath(err)) return { exists: false };
    throw new ObserverError("read_failed", 0, `${path}: ${String(err)}`);
  }
  return { exists: true, bytes: buffer };
}

/**
 * Split raw store bytes at the last newline: everything through it is a
 * complete line, everything after it is the tail the writer has not finished.
 *
 * The tail is returned as RAW BYTES and never decoded. The writer appends
 * without knowing where a read lands, so that boundary can fall inside a
 * multi-byte character; decoding the tail eagerly turned the split bytes into
 * `U+FFFD` and the continuation bytes were then never re-read — a permanent,
 * silent corruption of the very text acceptance matches on. The complete-line
 * region is safe to decode because it both starts and ends on an ASCII byte.
 *
 * CONTRACT (#1219): an incomplete trailing line is a WAIT. This function cannot
 * report it as a record and cannot report it as a fault, so the caller sees
 * only `tail`, and `pendingTailBytes` carries its size into the verdict.
 */
function splitCompleteLines(
  decoder: StringDecoder,
  bytes: Buffer
): { lines: string[]; tail: Buffer } {
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) return { lines: [], tail: bytes };
  const complete = decoder.write(bytes.subarray(0, lastNewline + 1));
  const lines = complete.split("\n");
  lines.pop();
  return { lines, tail: bytes.subarray(lastNewline + 1) };
}

/**
 * One read of the store. `exists: false` is the writer's "not yet" — the
 * conversation file is created lazily, on the first message — and is the ONE
 * non-fault a read can report. Everything else is an `ObserverError`.
 */
type StoreRead =
  | { readonly exists: true; readonly bytes: Buffer }
  | { readonly exists: false };

/** True for `ENOENT` only: the path is not there, so there is nothing to read.
 *  `EACCES` / `EISDIR` / `EIO` mean the store is there and unreadable, which
 *  is a broken observer, not a pending one. */
function isAbsentPath(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Take the measured baseline. An absent store is a legal zero baseline — the
 * first-input case has no file yet, and that is not an error.
 *
 * The offset covers COMPLETE lines only: a half-written trailing line stays
 * unread so the reader re-reads it once the writer finishes it, instead of
 * silently dropping the record it becomes.
 */
export function takeBaseline(loc: SessionLocation): Baseline {
  const path = sessionFilePath(loc);
  const zero: Baseline = {
    path,
    conversationId: loc.conversationId,
    byteOffset: 0,
    lineCount: 0,
    lastLine: "",
    eventIds: [],
    headId: null,
  };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return zero;
  }
  try {
    const log = parseSessionJsonl(raw);
    return {
      path,
      conversationId: loc.conversationId,
      byteOffset: completeLineEnd(raw),
      lineCount: completeLines(raw).length,
      lastLine: lastCompleteLine(raw),
      eventIds: log.events.map((e) => e.id),
      headId: log.head,
    };
  } catch {
    // A baseline over an unparseable store is measured from byte 0 so the
    // reader reports the malformed line as an ObserverError rather than
    // quietly starting past it.
    return zero;
  }
}

/** Byte offset just past the last newline: where the next complete line starts. */
function completeLineEnd(raw: string): number {
  return Buffer.byteLength(raw.slice(0, raw.lastIndexOf("\n") + 1), "utf8");
}

/** Every complete line, as text. The trailing empty element is dropped. */
function completeLines(raw: string): string[] {
  const lines = raw.split("\n");
  lines.pop();
  return lines.filter((l) => l !== "");
}

/** The last complete line's text, or `""` when there is none. */
function lastCompleteLine(raw: string): string {
  const lines = completeLines(raw);
  return lines.length === 0 ? "" : lines[lines.length - 1]!;
}

/**
 * Incremental tail reader over one conversation file.
 *
 * Only records after the baseline are yielded, so "relative to a baseline event
 * ID" is structural rather than a filter applied at the call site.
 *
 * WHY THE CURSOR IS A LINE ORDINAL AND NOT A BYTE OFFSET. `SessionStore.save()`
 * rewrites the whole log and the `session` header on line 1 grows with the run
 * (`turnCount`, `title`, `lastUsage`), so every later record shifts. Measured on
 * a real run: the file grew 362 → 1686 bytes while line 1 grew 335 → 452 with a
 * different hash. A monotonic `consumed` offset therefore resumes in the middle
 * of a record. The store is append-only in RECORD ORDER — `save()` never drops
 * an existing event or head record, and a fork appends rather than rewinds — so
 * a line ordinal is stable where a byte offset is not, and the text of the last
 * consumed line is the identity that proves it: if that text is no longer at
 * the recorded ordinal, the reader re-anchors on the line itself.
 */
export class SessionTailReader {
  readonly path: string;
  readonly baseline: Baseline;
  private readonly decoder = new StringDecoder("utf8");
  private seenIds = new Set<string>();
  private fatal: ObserverError | null = null;
  /** Complete lines ingested so far. Stable across a header rewrite. */
  private consumedLines: number;
  /** Text of the last complete line ingested — the re-anchor identity. */
  private lastLine: string;

  constructor(opts: {
    readonly location: SessionLocation;
    readonly baseline?: Baseline;
  }) {
    this.baseline = opts.baseline ?? takeBaseline(opts.location);
    this.path = this.baseline.path;
    this.consumedLines = this.baseline.lineCount;
    this.lastLine = this.baseline.lastLine;
    this.seenIds = new Set(this.baseline.eventIds);
  }

  /**
   * Records appended since the previous poll.
   *
   * An ABSENT store is "not yet", not a fault: the product creates the
   * conversation file lazily, on the first message, so the harness's
   * pre-stimulus poll legitimately finds no file. That poll succeeds with
   * `exists: false` and no records, and a later poll reads the store normally —
   * absence never latches, exactly as `takeBaseline` treats it as a legal zero
   * baseline.
   *
   * A real read or schema failure is RETURNED once as `PollResult.error` and
   * then latched: every later poll THROWS it, so a broken observer can never
   * read as a settled one.
   */
  poll(): PollResult {
    if (this.fatal !== null) throw this.fatal;
    let read: StoreRead;
    try {
      read = readWhole(this.path);
    } catch (err) {
      return this.fail(err);
    }
    if (!read.exists) return { ...EMPTY, exists: false, pendingTailBytes: 0 };
    const split = splitCompleteLines(this.decoder, read.bytes);
    let records: StoreRecord[];
    try {
      // `start` is the re-anchored ordinal, so a header that grew under a
      // full-file rewrite cannot shift an already-consumed record into view.
      const start = this.reanchor(split.lines);
      records = this.decode(split.lines.slice(start), start);
    } catch (err) {
      return this.fail(err);
    }
    return this.summarize(
      records,
      split.lines.length,
      read.bytes.length,
      split.tail.length
    );
  }

  /** Consume the trailing partial line if it ever completed, then re-poll. */
  flush(): PollResult {
    return this.poll();
  }

  /**
   * The ordinal the fresh lines start at, re-anchored on record IDENTITY.
   *
   * The recorded ordinal is trusted while the line it points at is still the
   * line that was consumed — which is the normal case, including after the
   * header grew, because only the header's LENGTH changes. If it is not, the
   * last consumed line is searched for by its text, and failing that the reader
   * reports an `ObserverError` rather than quietly resuming somewhere else.
   */
  private reanchor(lines: readonly string[]): number {
    if (this.lastLine === "" || lines[this.consumedLines - 1] === this.lastLine)
      return Math.min(this.consumedLines, lines.length);
    const found = lines.lastIndexOf(this.lastLine);
    if (found < 0)
      throw new ObserverError(
        "schema_invalid",
        0,
        `the last consumed record is no longer in ${this.path}; the store was ` +
          `rewritten below the reader's position`
      );
    this.consumedLines = found + 1;
    return this.consumedLines;
  }

  private fail(err: unknown): PollResult {
    this.fatal =
      err instanceof ObserverError
        ? err
        : new ObserverError("malformed_line", 0, String(err));
    return { ...EMPTY, error: this.fatal };
  }

  private decode(
    complete: readonly string[],
    startLineNo: number
  ): StoreRecord[] {
    const records: StoreRecord[] = [];
    // Report the REAL 1-based line number of each record in the file, so an
    // ObserverError points an auditor at the line they can open.
    let lineNo = startLineNo;
    for (const line of complete) {
      lineNo += 1;
      if (line.trim() === "") continue;
      const record = parseCompleteLine(line, lineNo);
      assertKnownType(record, lineNo);
      assertEventShape(record, this.seenIds, lineNo);
      assertHeadShape(record, this.seenIds, lineNo);
      records.push(record);
    }
    // Only now is the position durably advanced: a decode that threw leaves the
    // cursor where it was, and the error is latched by the caller anyway.
    if (complete.length > 0) {
      this.consumedLines += complete.length;
      this.lastLine = complete[complete.length - 1]!;
    }
    return records;
  }

  private summarize(
    records: readonly StoreRecord[],
    completeLines: number,
    size: number,
    pendingTailBytes: number
  ): PollResult {
    const since = records.filter((r) => r.type !== "session");
    return {
      records: since,
      messages: since.filter(
        (r): r is SessionEventRecord => r.type === "message"
      ),
      inputAnchors: nativeAnchors(since, "input"),
      terminalAnchors: nativeAnchors(since, "terminal"),
      toolBatchAnchors: nativeAnchors(since, "tool_batch"),
      outcomes: since.filter(
        (r): r is SessionOutcomeRecord => r.type === "outcome"
      ),
      headId: headIdOf(since) ?? this.baseline.headId,
      bytesRead: size,
      completeLines,
      pendingTailBytes,
      error: null,
      exists: true,
    };
  }
}

/** Re-exported so callers need one import for the measured position. */
export type {
  SessionEventRecord,
  SessionHeadRecord,
  SessionNativeStateRecord,
  SessionOutcomeRecord,
  SessionTitleRecord,
  SessionJsonlRecord,
};
export { isNativeStateBoundary };
