/**
 * Append-only single-file JSONL form of the session's authoritative history
 * (ADR-0027) — pure codec + projection, zero IO.
 *
 * Record shapes (one JSON per line):
 *   1. session header (first line):
 *      `{type:"session", ...SessionFileV1 metadata}` — goal/cwd/title/
 *      schemaVersion metadata; no separate meta.json. Built by spreading
 *      SessionFileV1 (minus messages), so unknown fields pass through
 *      (spread-preserve discipline holds in the JSONL form too).
 *   2. message event: `{type:"message", id:"e<N>", parent:"e<N-1>"|null,
 *      message: AnthropicNativeMessage}` — every event has a unique id and a
 *      parent, forming a chain; tool_result is a content block of a user
 *      message, never its own event.
 *   3. head record: `{type:"head", id:"e<N>"|null}` — the persisted rewind
 *      head pointer. The last head record wins; when absent the final event
 *      is used (tolerance: a crash may land between the event write and the
 *      head write).
 *   4. title record (ADR-0113): `{type:"title", text:string}` — the title
 *      event, the authoritative form of the title (never projected into
 *      messages or model prior). The header `title` is demoted to its
 *      cache: the load path overrides it from the latest event and
 *      save/rewind refresh the cache from event text on the write path, so
 *      extractTitle only acts as a placeholder when no title event exists.
 *   5. outcome record (ADR-0126): `{type:"outcome", turnId, stopReason}` — one
 *      authoritative terminal outcome per settled host turn, keyed to a stable
 *      turn identity (`turnId` = the turn's terminal message event id, i.e. the
 *      persisted head after that turn's save). Like the title event it is off
 *      the message chain, so abandoned fork branches never leak into
 *      projection; a turn with no outcome record projects as unknown (never a
 *      synthesized completion).
 *   6. native state record (ADR-0136): `{type:"native_state", anchorEventId,
 *      bodySha, boundary, messageCount}` — a REFERENCE to an immutable body
 *      under `<sessionFolder>/blobs/native/`, not the body itself. Off-chain
 *      like the title/outcome records (it never moves head or
 *      maxEventIndex) and anchored to a message event id, so selection is
 *      derived from the event/head chain alone.
 *   7. file intent record (ADR-0136): `{type:"file_intent", toolUseId,
 *      anchorEventId, targets, captured}` — the durable per-file write
 *      intent,
 *      written BEFORE the target is mutated and carrying EVERY target of a
 *      multi-file call (the in-memory preimage ledger is last-write-wins per
 *      toolUseId). `captured:false` records the `codeRestore.enabled`
 *      suppression so recovery reports the effect UNVERIFIED instead of
 *      inferring completion.
 *   8. operation fact record (ADR-0136): `{type:"operation_fact", factId,
 *      anchorEventId, baseBodySha, turnId?, fact, createdAt}` — one settled or
 *      dispatched operation that happened BETWEEN two published states (a tool
 *      result with its per-file associations, a graph node transition, owned
 *      worker progress). Off-chain like every other ADR-0136 record, so it is
 *      never projected into the session file and never selectable as a
 *      checkpoint.
 *
 * Named EXIT (exception class): `drop-trailing-corrupt-line` — if the last
 * non-empty line fails JSON.parse, drop that line and still load (the only
 * legal form of a crash mid-append); corruption on any other line →
 * parse_failed. Wrong shape (parses but invalid) → schema_invalid.
 *
 * id scheme: `e<index>`, where index is the event's position in messages[];
 * appendEvents continues numbering from the on-disk maxEventIndex+1, so
 * after a rewind the forked new events get fresh ids parented at the current
 * head while the old chain stays in the file — the primitive base for
 * rewind/fork semantics.
 *
 * save is append-only aware: align the caller's projection with the on-disk
 * head chain by longest common prefix (LCP). Identical projection → refresh
 * the header only (event/head records kept verbatim); projection extends the
 * chain → append the tail events; projection is a strict prefix → append
 * only a head record; divergence → continue a new branch from the LCP
 * boundary. Existing event records are never dropped, so a rewound-away
 * branch survives every save in the same file.
 */
import type {
  AnthropicNativeMessage,
  StopReason,
  SupplierStopDetail,
  TokenUsage,
} from "../../harness/index.js";
import type {
  FileIntentTarget,
  NativeStateBoundary,
  NativeStateMessage,
} from "../../shared/native-state-port.js";
import type {
  RuntimeGraphNodeFact,
  RuntimeOperationFact,
  RuntimeWorkerFact,
} from "../../shared/runtime-persistence.js";
import type { CheckpointRecord, GoalState, SessionFileV1 } from "./schema.js";
import { sanitizeSessionFile } from "./schema.js";

/** JSONL session-log extension. load picks the shape by extension:
 *  `<id>.jsonl` is JSONL (authoritative), otherwise legacy `<id>.json`. */
export const SESSION_JSONL_EXT = ".jsonl";

/** Session header record. Fields mirror SessionFileV1 minus messages;
 *  optional fields are omitted when absent (spread-discipline).
 *  `messageCreatedAt` is declared here (despite not being a
 *  SessionHeaderRecord-native field by intent) because the header line is
 *  built via `JSON.stringify({ type:"session", ...file_minus_messages })`
 *  after a stamped save — the array carries through to disk and back, so
 *  load() must accept it as part of the header shape. projectSessionLog
 *  strips it on the no-stamp branch so a stale header cannot poison the
 *  picker with misaligned timestamps. */
export interface SessionHeaderRecord {
  readonly type: "session";
  readonly schemaVersion: number;
  readonly conversation_id: string;
  /** ADR-0113: cache of the latest title record's text; an extractTitle
   *  placeholder only when no title event exists. The title event itself is
   *  authoritative; the read-path projection overrides this cache. */
  readonly title: string;
  readonly cwd: string;
  readonly sanitized_at: string;
  readonly jsonMode: boolean;
  readonly turnCount: number;
  readonly updatedAt: string;
  readonly checkpoints?: ReadonlyArray<CheckpointRecord>;
  readonly goal?: GoalState;
  readonly workspaceRoot?: string;
  readonly messageCreatedAt?: ReadonlyArray<string | null>;
  /** Parallel array of assistant-turn thinking duration (ms). Same
   *  spread-discipline as SessionFileV1.thinkingMs: absent is legal. */
  readonly thinkingMs?: ReadonlyArray<number | null>;
  /** Context-usage display snapshot (#1079): rides the header via the
   *  file-minus-messages spread, same add-on posture as goal/workspaceRoot.
   *  Shape is validated on load by sanitizeSessionFile, not here. */
  readonly lastUsage?: TokenUsage;
  /** ADR-0136: new-format marker, carried by the same header spread as the
   *  file's other optional add-ons. Absent = old format (see
   *  `isNewFormatSession`). */
  readonly nativeStateFormat?: number;
}

/** Content-addressed preimage reference a successful workspace write leaves
 *  behind (ADR-0036). `preimageSha` / `postimageSha` name blobs under the
 *  session's `code-snapshots/` directory (see code-snapshot-store.ts); the
 *  restore path resolves them back against `rootIdentity` + `relPath`.
 *  `absentBefore` is capture-time evidence (the tool saw ENOENT) that the
 *  path did not exist before that write, so restore deletes it instead of
 *  writing bytes back. Absent means the path existed — legacy transcript
 *  lines carry no key and an empty preimage never implies absence (ADR-0121);
 *  the capture side spreads the key only when true, keeping one schema. */
export interface PreimageRef {
  readonly relPath: string;
  readonly rootIdentity: string;
  readonly preimageSha: string;
  readonly postimageSha: string;
  readonly absentBefore?: boolean;
}

/** One message event: unique id + parent chain + verbatim native message.
 *  `createdAt` is the ingest timestamp (ISO) written by appendEvents;
 *  optional for legacy JSONL compat — parseSessionJsonl does not strictly
 *  validate it (spread discipline), absence never fails validation, and the
 *  projection lands it as messageCreatedAt[i] = null. `thinkingMs` is the
 *  assistant-turn thinking duration in ms, attached by appendEvents via
 *  conditional spread on assistant events only; non-assistant / streamed
 *  turns without thinking → field absent. `codePreimage` is attached by
 *  appendEvents only onto a successful (non-`is_error`) tool_result event
 *  whose `tool_use_id` matched a captured preimage; every other event →
 *  field absent. It is transcript-side only — never projected into model
 *  message content. */
export interface SessionEventRecord {
  readonly type: "message";
  readonly id: string;
  readonly parent: string | null;
  readonly message: AnthropicNativeMessage;
  readonly createdAt?: string;
  readonly thinkingMs?: number;
  readonly codePreimage?: PreimageRef;
}

/** The `tool_use_id` whose ref `matchCodePreimage` would resolve for this
 *  event — the FIRST captured, non-`is_error` tool_result block. The commit
 *  side's drain selects with this exact rule, so consumption can never strand
 *  a ref the append side would not land. */
export function matchCodePreimageId(
  message: AnthropicNativeMessage,
  preimages: ReadonlyMap<string, PreimageRef>
): string | undefined {
  for (const block of message.content) {
    if (block.type !== "tool_result" || block.is_error === true) continue;
    if (preimages.has(block.tool_use_id)) return block.tool_use_id;
  }
  return undefined;
}

/** Find the captured preimage ref for an event, if it is a successful
 *  (non-`is_error`) tool_result whose `tool_use_id` was captured. A batch may
 *  carry several tool_result blocks (parallel tools); the first captured,
 *  non-error one wins. Shared by the parent append
 *  (`SessionStore.appendEvents`) and the worker append
 *  (`appendWorkerTranscript`): one stamping rule for both transcripts. A
 *  second captured ref inside the same event is reported by the drain
 *  (`drainPreimageRefs`' `onUnstampable`), never silently consumed. */
export function matchCodePreimage(
  message: AnthropicNativeMessage,
  preimages: ReadonlyMap<string, PreimageRef> | undefined
): PreimageRef | undefined {
  if (preimages === undefined || preimages.size === 0) return undefined;
  const id = matchCodePreimageId(message, preimages);
  return id === undefined ? undefined : preimages.get(id);
}

/** The persisted rewind head pointer; id null means an empty transcript. */
export interface SessionHeadRecord {
  readonly type: "head";
  readonly id: string | null;
}

/** ADR-0113: title event — the authoritative form of the title. Not part of
 *  the message chain, never projected into messages or model prior; the
 *  header `title` is demoted to its cache (latest event text; an
 *  extractTitle placeholder only when no event exists). File order = append
 *  order; the read path takes the last one. */
export interface SessionTitleRecord {
  readonly type: "title";
  readonly text: string;
}

/** ADR-0126: terminal outcome of one settled host turn. Not part of the
 *  message chain (same posture as the title event), so an abandoned fork
 *  branch's outcome can never surface on the active chain. `turnId` is the
 *  turn's terminal message event id — the persisted head once that turn's
 *  messages landed — which stays stable for a `/continue` turn that appends no
 *  human message. File order = append order; the read path takes the last one
 *  per anchor. A turn with no record is unknown, never a synthesized
 *  completion. */
export interface SessionOutcomeRecord {
  readonly type: "outcome";
  readonly turnId: string;
  readonly stopReason: StopReason;
  /**
   * ADR-0126: the normalized supplier-stop detail behind a `nonSuccessStop`
   * (`truncation` = the output budget was exhausted). Optional and never
   * synthesized: a record written before this field, or a stop that carries no
   * supplier detail, loads with the key simply absent.
   */
  readonly supplierDetail?: SupplierStopDetail;
  /**
   * ADR-0135: why a turn was interrupted for security, carrying the bounded
   * cleanup evidence for the work that turn owned.
   *
   * Present only when the turn was actually stopped by the escalation (a
   * confirmed-violation threshold, or the pre-existing high-severity immediate
   * handling). An ordinary `cancelled` — a user Ctrl+C — leaves it absent, so
   * "the user stopped this" and "the harness stopped this" never share a
   * shape. ADR-0029's closed StopReason set is untouched: the reason stays
   * `cancelled` and this field is what distinguishes the cause.
   *
   * Every cancelled item is listed, including the ones whose teardown could
   * not be confirmed — a partial cleanup is recorded, not truncated away.
   */
  readonly securityInterruption?: SecurityInterruptionRecord;
}

/**
 * ADR-0135 security-interruption evidence as persisted on a turn outcome.
 *
 * `cleanup` is the per-item report: which work this turn owned, what was
 * actually done to it, and whether disappearance was proven. `unconfirmed`
 * is a real outcome, never a stop that silently became a success.
 */
export interface SecurityInterruptionRecord {
  /**
   * The engine's turn id for the turn that was interrupted (the same id the
   * harness trace writes on its `turn` record). Present so a reviewer can bind
   * this cause to one specific trace row instead of correlating by ordering —
   * two turns in one session are otherwise indistinguishable by position alone.
   *
   * Optional because the executor observes the turn id only when the engine
   * passes one to `executeAll` (a direct-handler / worker caller does not);
   * absence means "no turn identity was available", never a synthesized one.
   */
  readonly turnId?: string;
  /** `mid` = threshold reached; `high` = existing immediate handling. */
  readonly tier: "mid" | "high";
  /** The tool whose result tripped the escalation. */
  readonly tool: string;
  /** Consecutive confirmed violations that produced this interruption. */
  readonly confirmedViolations: number;
  /** Bounded per-item cleanup evidence for the interrupted turn's work. */
  readonly cleanup: ReadonlyArray<SecurityInterruptionItem>;
}

/** One turn-owned work item and the outcome of cancelling it. */
export interface SecurityInterruptionItem {
  readonly kind: "subagent" | "background_task";
  readonly id: string;
  readonly state: "stop_requested" | "confirmed_stopped" | "unconfirmed";
  /** Typed cause for `unconfirmed`; absent otherwise. */
  readonly reason?: string;
  /**
   * The plane's own bounded cleanup verdict, mirroring
   * `CleanupEvidence` (sandbox/cleanup-result.ts). `not_started` is honest
   * here: a stop request whose disappearance was never observed.
   */
  readonly cleanup: SecurityInterruptionCleanup;
}

export type SecurityInterruptionCleanup =
  | { readonly state: "not_started" }
  | {
      readonly state: "confirmed_stopped";
      readonly pgid: number;
      readonly task_id?: string;
    }
  | {
      readonly state: "unconfirmed";
      readonly reason: string;
      readonly pgid: number;
      readonly detail: string;
      readonly task_id?: string;
    };

/**
 * ADR-0136: reference to one published native state. The record carries the
 * content address of an immutable body under
 * `<sessionFolder>/blobs/native/` (native-state-store.ts) — never the body
 * itself, so publishing a state costs one line in the transcript and the
 * immutable content is shared.
 *
 * Off-chain in the same posture as the title/outcome records: it never moves
 * `head` or `maxEventIndex`, so a rewound-away branch's state can never be
 * selected. Selection is derived from the event/head chain
 * (`resolvePublishedNativeState`) — no timestamp ordering, no independent
 * current-state pointer, no branch registry.
 */
export interface SessionNativeStateRecord {
  readonly type: "native_state";
  /** Message event id this state is anchored to. Selectable only when it is
   *  on the selected head chain. */
  readonly anchorEventId: string;
  /** sha256 hex of the immutable body under `<sessionFolder>/blobs/native/`. */
  readonly bodySha: string;
  /** Which boundary published this state. */
  readonly boundary: NativeStateBoundary;
  readonly messageCount: number;
  readonly createdAt: string;
}

/** The durable record reuses the PORT's target shape verbatim — the request
 *  the harness hands the host and the line recovery reads back are ONE
 *  contract, declared once in `shared/native-state-port.ts`. Re-exported here
 *  because the record layer is where callers already import it from.
 *  `preimageSha` is absent exactly when the record is `captured:false`; an
 *  empty preimage never implies absence, `absentBefore` is the evidence. */
export type { FileIntentTarget };

/**
 * ADR-0136: durable file write intent, written BEFORE the target is mutated.
 *
 * `anchorEventId` is the persisted head at capture time — the assistant
 * tool_use event is already committed before any call in that response is
 * dispatched, so that head is a real branch anchor rather than a guess.
 * `captured:false` is a real outcome, not an absent record: the existing
 * `codeRestore.enabled` opt-out suppressed evidence capture, and the record
 * exists so recovery reports the effect UNVERIFIED instead of silently
 * inferring completion. Off-chain, like the other non-message records.
 */
export interface SessionFileIntentRecord {
  readonly type: "file_intent";
  readonly toolUseId: string;
  readonly anchorEventId: string;
  readonly targets: ReadonlyArray<FileIntentTarget>;
  readonly captured: boolean;
  readonly createdAt: string;
}

/**
 * ADR-0136: one operation fact appended between two published states.
 *
 * THE APPEND POSITION IS THE ORDER — it is the only thing that says which
 * published state a fact belongs after, and a sink must append in the order it
 * receives facts. `baseBodySha` names that state for convenience (the last
 * state this sink published, `null` before the first one); it is NOT a second,
 * separately-maintained order to keep in step, and nothing in the append path
 * may reorder or rewrite a fact. A published state is never mutated, and a
 * fact is never deleted.
 *
 * `factId` is caller-supplied and stable across a repeated append of the same
 * fact, which is what makes the dedup on append decidable (SC27: a repeated
 * open must not add a duplicate receipt).
 *
 * `anchorEventId` is the persisted head at append time and must be on the
 * selected head chain for the fact to be usable, exactly like the other
 * ADR-0136 records.
 */
export interface SessionOperationFactRecord {
  readonly type: "operation_fact";
  readonly factId: string;
  readonly anchorEventId: string;
  /** `bodySha` of the last state this sink published; null when none yet. */
  readonly baseBodySha: string | null;
  /** Turn the fact belongs to, when the turn identity is known. */
  readonly turnId?: string;
  /** The fact itself, in the harness's own vocabulary. */
  readonly fact: RuntimeOperationFact<NativeStateMessage>;
  readonly createdAt: string;
}

/** All record shapes after the header (in file order). */
export type SessionTailRecord =
  | SessionEventRecord
  | SessionHeadRecord
  | SessionTitleRecord
  | SessionOutcomeRecord
  | SessionNativeStateRecord
  | SessionFileIntentRecord
  | SessionOperationFactRecord;

export type SessionJsonlRecord = SessionHeaderRecord | SessionTailRecord;

/** Structured error thrown by parseSessionJsonl / projectSessionLog (no
 *  conversation_id — pure functions carry no store identity; the store
 *  catches and attaches it, matching sanitizeSessionFile's
 *  {kind:"schema_invalid", field} convention). */
export type SessionJsonlError =
  | { kind: "parse_failed"; reason: string }
  | { kind: "schema_invalid"; field: string };

/** Event id scheme: `e<index>`. appendEvents depends on this shape to
 *  recover the next index. */
export function messageEventId(index: number): string {
  return `e${index}`;
}

const EVENT_ID_RE = /^e(\d+)$/;

/** Parsed JSONL log: header + file-order events + effective head + max
 *  event index. */
export interface ParsedSessionLog {
  readonly header: SessionHeaderRecord;
  readonly events: ReadonlyArray<SessionEventRecord>;
  readonly head: string | null;
  /** N of the largest `e<N>` among events; -1 when there are none
   *  (appendEvents continues numbering from +1). */
  readonly maxEventIndex: number;
  /** All records after the header (event / head / title / outcome), in file
   *  order. The save header-refresh rewrite relies on them being preserved
   *  verbatim (including historical head records). */
  readonly records: ReadonlyArray<SessionTailRecord>;
}

/**
 * Serialize a SessionFileV1 to JSONL text (header + chained events + head).
 * Pure. Unknown top-level fields pass through into the header via spread;
 * `messages` never enters the header.
 */
export function sessionFileToJsonl(file: SessionFileV1): string {
  const { messages, messageCreatedAt, thinkingMs, ...meta } = file;
  const lines: string[] = [JSON.stringify({ type: "session", ...meta })];
  messages.forEach((message, index) => {
    const stamp = messageCreatedAt?.[index];
    const think = thinkingMs?.[index];
    const record: SessionEventRecord = {
      type: "message",
      id: messageEventId(index),
      parent: index === 0 ? null : messageEventId(index - 1),
      message,
      ...(typeof stamp === "string" ? { createdAt: stamp } : {}),
      // thinkingMs is only attached on assistant events (the consumer-side
      // ?? fallback already yields null for non-assistant elements, but skip
      // the key when there is no value to avoid noise).
      ...(typeof think === "number" && Number.isFinite(think) && think > 0
        ? { thinkingMs: think }
        : {}),
    };
    lines.push(JSON.stringify(record));
  });
  const head: SessionHeadRecord = {
    type: "head",
    id: messages.length === 0 ? null : messageEventId(messages.length - 1),
  };
  lines.push(JSON.stringify(head));
  return `${lines.join("\n")}\n`;
}

/**
 * Parse JSONL text into a structured log. Pure, no IO.
 *
 * Corrupt-tail EXIT `drop-trailing-corrupt-line`: the line is dropped only
 * when the last non-empty line fails JSON.parse (crash mid-append);
 * corruption on any other line → throw {kind:"parse_failed"}. Shape errors
 * → throw {kind:"schema_invalid"}:
 *   - first record is not a session header → field "root"
 *   - unknown record type → field "type"
 *   - event shape / id format / duplicate id / parent not seen earlier
 *     → field "events"
 *   - head references an unknown event id → field "head"
 */
export function parseSessionJsonl(raw: string): ParsedSessionLog {
  const lines = raw.split("\n");
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) lastNonEmpty = i;
  }
  const records: unknown[] = [];
  for (let i = 0; i <= lastNonEmpty; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Named EXIT: drop-trailing-corrupt-line — a crash can only leave a
      // half-written line at the append tail; dropping it keeps the rest of
      // the log intact.
      if (i === lastNonEmpty) break;
      throw {
        kind: "parse_failed",
        reason: `line ${i + 1}: ${line.slice(0, 120)}`,
      } satisfies SessionJsonlError;
    }
  }
  const [first, ...rest] = records;
  if (!isHeaderRecord(first)) {
    throw { kind: "schema_invalid", field: "root" } satisfies SessionJsonlError;
  }
  const events: SessionEventRecord[] = [];
  const tail: SessionTailRecord[] = [];
  const ids = new Set<string>();
  let head: string | null = null;
  let headSeen = false;
  let maxEventIndex = -1;
  for (const rec of rest) {
    if (isEventRecord(rec)) {
      maxEventIndex = Math.max(maxEventIndex, validatedEventIndex(rec, ids));
      ids.add(rec.id);
      events.push(rec);
      tail.push(rec);
      continue;
    }
    if (isHeadRecord(rec)) {
      head = rec.id; // the last head record wins
      headSeen = true;
      tail.push(rec);
      continue;
    }
    if (isOffChainRecord(rec)) {
      // ADR-0113 / ADR-0126 / ADR-0136: title, outcome, native-state,
      // file-intent and operation-fact records never change
      // head/maxEventIndex, they only ride
      // along in records (and are resolved against the head chain on read).
      tail.push(rec);
      continue;
    }
    throw { kind: "schema_invalid", field: "type" } satisfies SessionJsonlError;
  }
  if (!headSeen) {
    head = events.length === 0 ? null : events[events.length - 1]!.id;
  }
  if (head !== null && !ids.has(head)) {
    throw { kind: "schema_invalid", field: "head" } satisfies SessionJsonlError;
  }
  return { header: first, events, head, maxEventIndex, records: tail };
}

/** Event shape validation (extracted from the parseSessionJsonl main loop so
 *  its cyclomatic complexity does not grow with the title-record branch):
 *  illegal id format / duplicate id / parent not seen earlier →
 *  schema_invalid "events". On success returns N of `e<N>`. Parent-first is
 *  the append-only invariant (it still holds after the corrupt-tail drop — a
 *  referenced parent is always on an earlier line). The caller adds rec.id to
 *  ids only after validation passes. */
function validatedEventIndex(
  rec: SessionEventRecord,
  ids: Set<string>
): number {
  const match = EVENT_ID_RE.exec(rec.id);
  if (match === null || ids.has(rec.id)) {
    throw {
      kind: "schema_invalid",
      field: "events",
    } satisfies SessionJsonlError;
  }
  if (rec.parent !== null && !ids.has(rec.parent)) {
    throw {
      kind: "schema_invalid",
      field: "events",
    } satisfies SessionJsonlError;
  }
  return Number(match[1]);
}

/**
 * Project a parsed log to the current-head transcript as SessionFileV1.
 * Walks head → root via parent, then reverses; events off the chain (fork
 * branches / orphans) stay on disk but are not projected. Metadata
 * validation reuses sanitizeSessionFile (schema SSOT). Pure.
 */
export function projectSessionLog(log: ParsedSessionLog): SessionFileV1 {
  const byId = new Map(log.events.map((e) => [e.id, e]));
  const messages: AnthropicNativeMessage[] = [];
  const createdAtList: Array<string | null> = [];
  // Rebuild the thinkingMs array in parallel — same spread-discipline as
  // createdAtList (no thinkingMs on the whole chain → no key).
  const thinkingMsList: Array<number | null> = [];
  const seen = new Set<string>();
  let cur = log.head;
  while (cur !== null) {
    if (seen.has(cur)) {
      // Defense: a cycle is impossible under the append-only + parent-first
      // invariants; one means real corruption.
      throw {
        kind: "schema_invalid",
        field: "events",
      } satisfies SessionJsonlError;
    }
    seen.add(cur);
    const event = byId.get(cur);
    if (!event) {
      throw {
        kind: "schema_invalid",
        field: "head",
      } satisfies SessionJsonlError;
    }
    messages.push(event.message);
    // `event.createdAt` is `string | undefined` in-memory; coerce the hole to
    // `null` so the parallel array matches the on-disk JSON shape (undefined
    // would serialize to null via JSON.stringify anyway). Validator accepts
    // only `null` holes — never `undefined`.
    createdAtList.push(event.createdAt ?? null);
    // `event.thinkingMs` is `number | undefined` in-memory (appendEvents only
    // attaches it for assistant events with a valid value). No thinkingMs →
    // null (aligned with the JSON round-trip shape); a number passes through
    // verbatim (appendEvents' entry already filtered <= 0 / non-finite, so no
    // re-check here).
    thinkingMsList.push(
      typeof event.thinkingMs === "number" ? event.thinkingMs : null
    );
    cur = event.parent;
  }
  messages.reverse();
  createdAtList.reverse();
  thinkingMsList.reverse();
  const { type: _type, ...meta } = log.header;
  // spread-discipline: when no event on the chain has createdAt (pure legacy
  // file / a fork branch never stamped by appendEvents), omit the key —
  // consistent with sanitizeSessionFile's conditional-goal-key discipline
  // (never emit `field: undefined` keys). This keeps the whole-object
  // round-trip sessionFileToJsonl → parseSessionJsonl → projectSessionLog
  // byte-stable for legacy files (anchored by existing deepEqual tests).
  // Any event with createdAt → emit the key; null elements mark positions
  // whose event lacks createdAt (old chain / fork branch), and the picker
  // renders them with the ?? "" fallback.
  const hasAny = createdAtList.some((c) => c !== null);
  // Stale-header guard: when the current head chain
  // carries no createdAt (rewind back into a pre-stamping fork branch, or a
  // legacy chain), a previously-stamped save left the header's
  // messageCreatedAt at its OLD length. Spread via `...meta` would leak that
  // stale array into the projection — picker joins index-by-index and would
  // read misaligned timestamps. Mirror `sanitizeSessionFile`'s `delete
  // result["summary"]` posture: drop the key explicitly when there's nothing
  // to emit. When `hasAny === true` the explicit `messageCreatedAt:` in the
  // result literal below overrides any stale value in `meta`.
  if (!hasAny) {
    delete meta.messageCreatedAt;
  }
  // thinkingMs mirrors messageCreatedAt's spread-discipline exactly: no
  // thinkingMs on the whole chain → no key; any event carrying a value →
  // emit the key, with null elements marking positions whose event has no
  // thinkingMs (non-assistant / streamed turn without thinking / legacy
  // file). Same stale-header guard: delete from meta explicitly when the
  // chain has no thinkingMs so the picker cannot read a misaligned array.
  const hasAnyThinking = thinkingMsList.some((c) => c !== null);
  if (!hasAnyThinking) {
    delete meta.thinkingMs;
  }
  // ADR-0113: the title event's text is authoritative and header `title` is
  // only a cache — projection overrides the cache with the latest event text
  // so the load()/list() read paths reflect events immediately (not waiting
  // for the next save to refresh the cache). No title event → header cache
  // as-is, legacy behavior unchanged.
  return sanitizeSessionFile({
    ...meta,
    title: resolveTitleText(log, meta.title),
    messages,
    ...(hasAny ? { messageCreatedAt: createdAtList } : {}),
    ...(hasAnyThinking ? { thinkingMs: thinkingMsList } : {}),
  });
}

/**
 * Title resolution for read paths (SSOT — the single definition of the
 * `latestTitleText ?? fallback` shape): the latest title event's text wins;
 * no title event → the caller's fallback (header cache / extractTitle
 * placeholder). A null log (legacy-only, no JSONL) also falls back.
 * Pure function.
 */
export function resolveTitleText(
  log: ParsedSessionLog | null,
  fallback: string
): string {
  return (log === null ? null : latestTitleText(log)) ?? fallback;
}

/**
 * ADR-0113: the text of the latest title event in the log (the last title
 * record in file order); no title events → null (caller falls back to the
 * extractTitle placeholder). Pure function.
 */
export function latestTitleText(log: ParsedSessionLog): string | null {
  for (let i = log.records.length - 1; i >= 0; i--) {
    const rec = log.records[i]!;
    if (rec.type === "title") return rec.text;
  }
  return null;
}

/**
 * The current-head chain as EVENTS, root → head order (the same walk
 * projectSessionLog does, but keeping id/parent). Fork branches / orphans
 * are not included. Throws schema_invalid on a cycle or a dangling head,
 * same as projectSessionLog. Pure.
 */
export function headChainEvents(
  log: ParsedSessionLog
): ReadonlyArray<SessionEventRecord> {
  return chainFromHead(log, log.head);
}

/** ADR-0126: turn outcomes resolved against one transcript's active head
 *  chain (see `SessionStore.projectTurnOutcomes`). Outcome records whose
 *  anchor is not on the chain — a rewound-away branch, a compacted prefix —
 *  are dropped here, which is why the event is off-chain in the first place.
 *  Later records win for the same anchor (append-only re-record). Pure. */
export function resolveTurnOutcomes(log: ParsedSessionLog): {
  readonly messageEventIds: ReadonlyArray<string>;
  readonly outcomes: ReadonlyMap<string, SessionOutcomeRecord>;
} {
  const chain = headChainEvents(log);
  const onChain = new Set(chain.map((e) => e.id));
  const outcomes = new Map<string, SessionOutcomeRecord>();
  for (const rec of log.records) {
    if (rec.type !== "outcome" || !onChain.has(rec.turnId)) continue;
    outcomes.set(rec.turnId, rec);
  }
  return { messageEventIds: chain.map((e) => e.id), outcomes };
}

/** One on-chain file intent plus where its anchor sits on the selected chain,
 *  so a reader can tell "after the selected state" from "before it". */
export interface FileIntentPosition {
  readonly record: SessionFileIntentRecord;
  /** Index into `PublishedNativeStateSelection.messageEventIds`; always a real
   *  position (an intent whose anchor left the chain is not reported). */
  readonly anchorIndex: number;
}

/** The chain-derived view of what a session has published. */
export interface PublishedNativeStateSelection {
  /** Head chain event ids, root → head (index = chain position). */
  readonly messageEventIds: ReadonlyArray<string>;
  /** The selected published state: the LAST `native_state` record in file
   *  order whose anchor is on the head chain. null when none qualifies — a
   *  session never synthesizes a state it did not publish. */
  readonly selected: SessionNativeStateRecord | null;
  /** Chain position of the selected anchor; -1 when nothing is selected. */
  readonly anchorIndex: number;
  /** Every on-chain file intent, in file order, each with its chain
   *  position. Additive, never collapsed: repeated intents for one anchor
   *  stay distinct records. */
  readonly fileIntents: ReadonlyArray<FileIntentPosition>;
}

/**
 * ADR-0136: the selected published native state, resolved against one
 * transcript's active head chain — the same off-chain resolution
 * `resolveTurnOutcomes` does, so a rewound-away or compacted-away branch's
 * state is excluded here, which is why the record is off-chain in the first
 * place. Later records win for the same anchor (append-only re-record).
 *
 * Selection comes from the event/head chain ONLY: no timestamp comparison, no
 * independent current-state pointer, no branch registry. Pure.
 */
export function resolvePublishedNativeState(
  log: ParsedSessionLog
): PublishedNativeStateSelection {
  const chain = headChainEvents(log);
  const messageEventIds = chain.map((e) => e.id);
  const positionOf = new Map(messageEventIds.map((id, i) => [id, i]));
  let selected: SessionNativeStateRecord | null = null;
  let anchorIndex = -1;
  const fileIntents: FileIntentPosition[] = [];
  for (const rec of log.records) {
    if (rec.type === "native_state") {
      const at = positionOf.get(rec.anchorEventId);
      if (at !== undefined) {
        selected = rec;
        anchorIndex = at;
      }
      continue;
    }
    if (rec.type === "file_intent") {
      const at = positionOf.get(rec.anchorEventId);
      if (at !== undefined) fileIntents.push({ record: rec, anchorIndex: at });
      continue;
    }
  }
  return { messageEventIds, selected, anchorIndex, fileIntents };
}

/**
 * Ancestor chain from an arbitrary head id (null = empty). Rewind to a
 * skipped-branch user message walks this, not the current head prefix.
 * Throws schema_invalid on a cycle or dangling id. Pure.
 */
export function chainFromHead(
  log: ParsedSessionLog,
  head: string | null
): ReadonlyArray<SessionEventRecord> {
  const byId = new Map(log.events.map((e) => [e.id, e]));
  const chain: SessionEventRecord[] = [];
  const seen = new Set<string>();
  let cur = head;
  while (cur !== null) {
    if (seen.has(cur)) {
      throw {
        kind: "schema_invalid",
        field: "events",
      } satisfies SessionJsonlError;
    }
    seen.add(cur);
    const event = byId.get(cur);
    if (!event) {
      throw {
        kind: "schema_invalid",
        field: "head",
      } satisfies SessionJsonlError;
    }
    chain.push(event);
    cur = event.parent;
  }
  chain.reverse();
  return chain;
}

/**
 * Serialize a header + record list back to JSONL text (one record per
 * line, trailing newline). The header is built from SessionFileV1 metadata
 * (spread-preserve, minus messages); records pass through verbatim — the
 * append-only save relies on this to keep existing event/head records
 * byte-stable across a header refresh. Pure.
 */
export function serializeSessionLog(
  file: Omit<SessionFileV1, "messages">,
  records: ReadonlyArray<SessionTailRecord>
): string {
  const lines: string[] = [JSON.stringify({ type: "session", ...file })];
  for (const record of records) {
    lines.push(JSON.stringify(record));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Structural deep-equal over JSON-shaped values (message content blocks
 * included). Used by the append-only save to align the caller's projection
 * with the persisted head chain. Treats absent vs undefined as equal only
 * when the key is absent in BOTH (plain JSON semantics); arrays are
 * order-sensitive. Pure.
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, key)) return false;
    if (!jsonDeepEqual(ao[key], bo[key])) return false;
  }
  return true;
}

// -- record shape guards -------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isHeaderRecord(value: unknown): value is SessionHeaderRecord {
  return isRecord(value) && value["type"] === "session";
}

function isEventRecord(value: unknown): value is SessionEventRecord {
  return (
    isRecord(value) &&
    value["type"] === "message" &&
    typeof value["id"] === "string" &&
    (value["parent"] === null || typeof value["parent"] === "string") &&
    isRecord(value["message"])
  );
}

function isHeadRecord(value: unknown): value is SessionHeadRecord {
  return (
    isRecord(value) &&
    value["type"] === "head" &&
    (value["id"] === null || typeof value["id"] === "string")
  );
}

function isTitleRecord(value: unknown): value is SessionTitleRecord {
  return (
    isRecord(value) &&
    value["type"] === "title" &&
    typeof value["text"] === "string"
  );
}

/** Keyed off the StopReason union so a new member fails compilation here until
 *  it is listed — the on-disk outcome can never accept a reason the harness
 *  does not produce. */
const STOP_REASON_MEMBERS: Record<StopReason, true> = {
  completed: true,
  maxTurns: true,
  nonSuccessStop: true,
  protocolError: true,
  emptyFinalResponse: true,
  cancelled: true,
  timeout: true,
  fused: true,
};

export function isStopReason(value: unknown): value is StopReason {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(STOP_REASON_MEMBERS, value)
  );
}

/** Same keyed-off-the-union discipline as `STOP_REASON_MEMBERS`, for the
 *  outcome's supplier-stop detail (ADR-0126). */
const SUPPLIER_STOP_DETAIL_MEMBERS: Record<SupplierStopDetail, true> = {
  truncation: true,
  refusal: true,
  other: true,
};

function isSupplierStopDetail(value: unknown): value is SupplierStopDetail {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SUPPLIER_STOP_DETAIL_MEMBERS, value)
  );
}

function isOutcomeRecord(value: unknown): value is SessionOutcomeRecord {
  if (
    !isRecord(value) ||
    value["type"] !== "outcome" ||
    typeof value["turnId"] !== "string" ||
    !isStopReason(value["stopReason"])
  ) {
    return false;
  }
  // Absent is the backward-compatible shape; a present value must be one the
  // adapter can actually normalize to.
  if (
    "supplierDetail" in value &&
    !isSupplierStopDetail(value["supplierDetail"])
  ) {
    return false;
  }
  return (
    !("securityInterruption" in value) ||
    isSecurityInterruption(value["securityInterruption"])
  );
}

/* ADR-0135: the security-interruption record is validated structurally, not
 * trusted. A persisted `confirmed_stopped` is a claim a reviewer will act on,
 * so a record that does not carry the identity and the evidence it asserts is
 * rejected with the file rather than projected as a clean stop. */

function isSecurityInterruptionCleanup(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const state = value["state"];
  if (state === "not_started") return true;
  if (typeof value["pgid"] !== "number") return false;
  if (value["task_id"] !== undefined && typeof value["task_id"] !== "string") {
    return false;
  }
  if (state === "confirmed_stopped") return true;
  return (
    state === "unconfirmed" &&
    typeof value["reason"] === "string" &&
    typeof value["detail"] === "string"
  );
}

function isSecurityInterruptionItem(value: unknown): boolean {
  if (!isSecurityInterruptionItemShape(value)) return false;
  const record = value as Record<string, unknown>;
  // The summary state and the evidence must agree. A record claiming
  // `confirmed_stopped` while its own evidence says no teardown was ever
  // started is a fabricated stop, and it is the one claim in this record a
  // reviewer would act on — so it is rejected rather than projected.
  const evidenceState = (record["cleanup"] as { state: string }).state;
  return interruptionStatesAgree(record["state"] as string, evidenceState);
}

/** The identity + evidence shape of one item, before any cross-field check. */
function isSecurityInterruptionItemShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value["kind"] !== "subagent" && value["kind"] !== "background_task") {
    return false;
  }
  if (typeof value["id"] !== "string") return false;
  if (!INTERRUPTION_ITEM_STATES.has(value["state"] as string)) {
    return false;
  }
  if (value["reason"] !== undefined && typeof value["reason"] !== "string") {
    return false;
  }
  return isSecurityInterruptionCleanup(value["cleanup"]);
}

/** The summary states an item may carry. */
const INTERRUPTION_ITEM_STATES: ReadonlySet<string> = new Set([
  "stop_requested",
  "confirmed_stopped",
  "unconfirmed",
]);

/**
 * Whether an item's summary state and its cleanup evidence tell the same story.
 *
 * A summary stop is a claim a reviewer acts on, so it must be backed by the
 * evidence's own confirmation: `confirmed_stopped` needs a confirmed teardown,
 * and `unconfirmed` must not be dressed up with one. `stop_requested` claims
 * nothing about the teardown, so the evidence is free.
 */
function interruptionStatesAgree(
  state: string,
  evidenceState: string
): boolean {
  if (state === "confirmed_stopped") {
    return evidenceState === "confirmed_stopped";
  }
  if (state === "unconfirmed") {
    return evidenceState !== "confirmed_stopped";
  }
  return true;
}

function isSecurityInterruption(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value["tier"] !== "mid" && value["tier"] !== "high") return false;
  if (value["turnId"] !== undefined && typeof value["turnId"] !== "string") {
    return false;
  }
  if (typeof value["tool"] !== "string") return false;
  if (typeof value["confirmedViolations"] !== "number") return false;
  const cleanup = value["cleanup"];
  return Array.isArray(cleanup) && cleanup.every(isSecurityInterruptionItem);
}

/** Keyed off the boundary union declared in the neutral port so a new member
 *  fails compilation here until it is listed — the on-disk record can never
 *  accept a boundary the publisher does not produce. */
const NATIVE_STATE_BOUNDARY_MEMBERS: Record<NativeStateBoundary, true> = {
  input: true,
  tool_batch: true,
  compaction: true,
  terminal: true,
};

export function isNativeStateBoundary(
  value: unknown
): value is NativeStateBoundary {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(NATIVE_STATE_BOUNDARY_MEMBERS, value)
  );
}

function isNativeStateRecord(
  value: unknown
): value is SessionNativeStateRecord {
  return (
    isRecord(value) &&
    value["type"] === "native_state" &&
    typeof value["anchorEventId"] === "string" &&
    typeof value["bodySha"] === "string" &&
    isNativeStateBoundary(value["boundary"]) &&
    typeof value["messageCount"] === "number" &&
    typeof value["createdAt"] === "string"
  );
}

/** A target is structurally checked, not trusted: `relPath` / `rootIdentity`
 *  are what recovery resolves the live file against, so an empty one is
 *  unresolvable rather than cosmetic — the same rule the append path applies
 *  before it writes. The sha keys are blob filenames; a present value must at
 *  least be a string here, and the sha256 alphabet gate belongs to the read
 *  path, which is where the value becomes a path segment. */
function isFileIntentTarget(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value["relPath"])) return false;
  if (!isNonEmptyString(value["rootIdentity"])) return false;
  if (typeof value["absentBefore"] !== "boolean") return false;
  return (
    isOptionalShaField(value, "preimageSha") &&
    isOptionalShaField(value, "postimageSha")
  );
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isOptionalShaField(
  value: Record<string, unknown>,
  key: string
): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

function isFileIntentRecord(value: unknown): value is SessionFileIntentRecord {
  return (
    isRecord(value) &&
    value["type"] === "file_intent" &&
    typeof value["toolUseId"] === "string" &&
    typeof value["anchorEventId"] === "string" &&
    typeof value["captured"] === "boolean" &&
    typeof value["createdAt"] === "string" &&
    Array.isArray(value["targets"]) &&
    (value["targets"] as ReadonlyArray<unknown>).every(isFileIntentTarget)
  );
}

/**
 * Keyed off the harness's own fact unions so a new member fails compilation
 * here until it is listed — the on-disk record can never accept a status,
 * state, or kind the harness does not produce.
 */
const GRAPH_NODE_STATUS_MEMBERS: Record<RuntimeGraphNodeFact["status"], true> =
  {
    running: true,
    done: true,
    failed: true,
    skipped: true,
  };

const WORKER_OWNERSHIP_MEMBERS: Record<RuntimeWorkerFact["ownership"], true> = {
  foreground: true,
  background: true,
};

const WORKER_STATE_MEMBERS: Record<RuntimeWorkerFact["state"], true> = {
  starting: true,
  running: true,
  completed: true,
  failed: true,
  stopped: true,
  needs_handling: true,
};

type PersistedOperationFact = RuntimeOperationFact<NativeStateMessage>;

/**
 * Per-kind shape checks, keyed off the fact union (the same table-over-a-Record
 * discipline as the content-block validators). `startTime` is `number | null`
 * and a null stays null: a synthesized value would turn "cannot confirm this
 * worker stopped" into a false "stopped", which is the one answer the spec
 * forbids inventing.
 */
const FACT_VALIDATORS = new Map<
  PersistedOperationFact["kind"],
  (fact: Record<string, unknown>) => boolean
>([
  ["tool_result", isToolResultFact],
  ["graph_node", isGraphNodeFact],
  ["worker_progress", isWorkerFact],
]);

function isToolResultFact(fact: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(fact["toolUseId"]) &&
    isBatchIndex(fact["batchPosition"]) &&
    isBatchIndex(fact["batchSize"]) &&
    isNativeMessageLike(fact["resultMessage"]) &&
    isOptionalFileAssociations(fact["files"]) &&
    (fact["turnId"] === undefined || typeof fact["turnId"] === "string")
  );
}

function isGraphNodeFact(fact: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(fact["nodeId"]) &&
    hasMember(GRAPH_NODE_STATUS_MEMBERS, fact["status"]) &&
    isOptionalString(fact["output"]) &&
    isOptionalString(fact["error"])
  );
}

function isWorkerFact(fact: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(fact["taskId"]) &&
    hasMember(WORKER_OWNERSHIP_MEMBERS, fact["ownership"]) &&
    hasMember(WORKER_STATE_MEMBERS, fact["state"]) &&
    isOptionalProcessIdentity(fact["process"]) &&
    isOptionalString(fact["transcriptPath"]) &&
    isOptionalString(fact["toolUseId"])
  );
}

/** Process IDENTITY, not a handle: pid + the raw start time, nothing that can
 *  reach a live process. An unknown start time is `null`, never a guess. */
function isOptionalProcessIdentity(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value["pid"] === "number" &&
    (value["startTime"] === null || typeof value["startTime"] === "number")
  );
}

/** Record-layer message check (role + content array). Block-level shape is the
 *  published-snapshot validator's job — this layer only has to reject a line
 *  that cannot be projected at all. */
function isNativeMessageLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["role"] === "string" &&
    Array.isArray(value["content"])
  );
}

function isOptionalFileAssociations(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    (value as ReadonlyArray<unknown>).every(isFileOperationRecord)
  );
}

function isFileOperationRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value["relPath"]) &&
    isNonEmptyString(value["rootIdentity"]) &&
    typeof value["absentBefore"] === "boolean" &&
    isOptionalShaField(value, "preimageSha") &&
    isOptionalShaField(value, "postimageSha") &&
    (value["published"] === undefined ||
      typeof value["published"] === "boolean")
  );
}

function isBatchIndex(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function hasMember(
  members: Record<string, true>,
  value: unknown
): value is keyof typeof members {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(members, value)
  );
}

/**
 * A fact payload's failed field name, or null when well-formed. Exported
 * because the append path validates the SAME function the read path does — a
 * record that can be written must be a record that can be read back.
 */
export function factPayloadField(value: unknown): string | null {
  if (!isRecord(value) || typeof value["kind"] !== "string") return "fact";
  const validate = FACT_VALIDATORS.get(
    value["kind"] as PersistedOperationFact["kind"]
  );
  if (validate === undefined || !validate(value)) return "fact";
  return null;
}

function isOperationFactRecord(
  value: unknown
): value is SessionOperationFactRecord {
  return (
    isRecord(value) &&
    value["type"] === "operation_fact" &&
    isNonEmptyString(value["factId"]) &&
    isNonEmptyString(value["anchorEventId"]) &&
    (value["baseBodySha"] === null ||
      typeof value["baseBodySha"] === "string") &&
    (value["turnId"] === undefined || typeof value["turnId"] === "string") &&
    typeof value["createdAt"] === "string" &&
    factPayloadField(value["fact"]) === null
  );
}

/** The tail-record arms that only join `records` (see the parse loop):
 *  extracted so adding an off-chain arm costs parseSessionJsonl no decision
 *  point of its own. */
function isOffChainRecord(
  value: unknown
): value is
  | SessionTitleRecord
  | SessionOutcomeRecord
  | SessionNativeStateRecord
  | SessionFileIntentRecord
  | SessionOperationFactRecord {
  return (
    isTitleRecord(value) ||
    isOutcomeRecord(value) ||
    isNativeStateRecord(value) ||
    isFileIntentRecord(value) ||
    isOperationFactRecord(value)
  );
}
