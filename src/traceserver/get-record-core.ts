/**
 * `get_record` — the content axis of the read side: one record named by
 * `record_id`, read as a character window the caller addresses. Shared core
 * behind both thin faces (ACI in-process + stdio MCP), mirroring the
 * `query_trace` / `list_sessions` contract: `options` in, one serialized JSON
 * string out; the faces add schema, tool-name prefix, and error mapping.
 *
 * The three axes have different read units, and this tool's reason to exist
 * lies right there:
 *   - `list_sessions`: one page of session summaries (catalog axis);
 *   - `query_trace`: one row (row axis: filter + pagination, whole records);
 *   - `get_record`: **one character window inside one part** (content axis).
 * Neither of the first two can answer "what are characters 9000-10000 of
 * this 43 KB tool result", and cramming a whole record into one output is
 * exactly why the executor cap exists. This axis lets the caller supply the
 * coordinates, making "how much to read" an explicit part of the contract
 * for the first time instead of an accidental property of the output.
 *
 * `conversation_id` is **required** on this face: `query_trace`'s
 * "default = newest session" was the root cause of external agents reading
 * files they never named; the content axis closes that first.
 */
import {
  collectToolResults,
  dereferenceSystemBody,
  dereferenceTraceMessages,
  messageContentBlocks,
  messageRole,
  type ProjectedToolResult,
} from "./project-tool-results.js";
import { createJsonlTraceReader } from "./reader.js";
import { findConversationTraceFile } from "./session-discovery.js";
import {
  lookupRecordById,
  projectRecordBase,
  type RecordMatch,
} from "./record-lookup.js";
import {
  TraceQueryValidationError,
  TraceRecordNotFoundError,
  TraceSessionNotFoundError,
  TraceWindowOverflowError,
} from "./query-trace-errors.js";
import { parseInteger } from "./parse-integer.js";
import type { TraceRecordRow } from "./types.js";

/**
 * Default window and window cap (measured: message p50 = 393, part p99 =
 * 13 848, part max = 43 174 characters).
 *
 * 400 lets one default call hold a median message and matches the row axis's
 * `TOOL_RESULT_PREVIEW_CAP` order of magnitude, so callers switching axes
 * need no conversion. 16 000 is set by the part distribution alone (p99
 * fits one window, max needs three) and **does not** promise "the largest
 * legal window also lands inside `TRACE_OUTPUT_BACKSTOP`" — measured
 * counterexample: the `record` scalar projection serializes to max 6 025
 * (over 5 546 records), and `text` inflates through `JSON.stringify`
 * escaping (p99 = 1.21, max = 1.30 times); either alone can cross the cap.
 * So the `count` budget is about **content characters**, not response size;
 * the core trims nothing in either case, and when the cap is crossed the
 * only thing that acts is the face's backstop (MCP) or the executor cap
 * (ACI, same value).
 *
 * Bounds are declared once each — in the core (`parseInteger`) and in both
 * faces' schemas — with identical values.
 */
export const GET_RECORD_DEFAULT_COUNT = 400;
export const GET_RECORD_MAX_COUNT = 16_000;

/**
 * The one description text for both faces (one source, and it
 * claims no character cap — the budget on this axis is the caller's own `count`).
 * Positive-trigger phrasing, enforced by
 * tests/harness/aci/tools/d9-description-guard.test.ts.
 */
export const GET_RECORD_DESCRIPTION =
  "Read one record's content with get_record, addressed as a character window " +
  "inside one record named by record_id in a required conversation_id. Two arms: " +
  "pass part_index to read a window, omit part_index to get an inventory of the " +
  "record's addressable parts — each part's coordinates, its message's role " +
  "(present under detail=messages; absent under detail=tool_results), and its " +
  "size in characters, with no content, which is how you learn a part's length " +
  "before spending output on it. A window returns exactly count characters " +
  "starting at from_char, reports the part's length as part_chars, and echoes " +
  "the effective coordinates, so count is the read unit you budget with. To page " +
  "through a part, read the first window, then raise from_char by count until " +
  "from_char + count would pass part_chars; a window past the part end answers " +
  "with that size and the remaining characters. Use detail=messages to address " +
  "an LLM call's message content blocks (each inventory part carries the role " +
  "of its message), which also requires message_index; use detail=system to " +
  "address an LLM call's identity-prefix body as one part, or detail=tools to " +
  "address its tool name list one part per name; leave detail at its default " +
  "tool_results to address that call's projected tool results by " +
  "part_index, in projection order and in full. Positions count UTF-16 code " +
  "units, so a boundary may fall between the halves of a surrogate pair. " +
  "Discover conversation_id with list_sessions and record_id with query_trace.";

type Detail = "messages" | "tool_results" | "system" | "tools";

/**
 * The full detail enum, declared once for the core's validation message and
 * both faces' schemas (ACI + MCP) — the enum surface cannot drift between
 * the three. Order is the validation message's order; `tool_results` stays
 * the default.
 */
export const GET_RECORD_DETAIL_VALUES = [
  "tool_results",
  "messages",
  "system",
  "tools",
] as const;

interface GetRecordInput {
  readonly conversation_id?: unknown;
  readonly record_id?: unknown;
  readonly detail?: unknown;
  readonly message_index?: unknown;
  readonly part_index?: unknown;
  readonly from_char?: unknown;
  readonly count?: unknown;
}

export interface GetRecordCoreOptions {
  readonly traceDir: string;
}

export type GetRecordCoreHandler = (input: unknown) => Promise<string>;

export function createGetRecordCore(
  options: string | GetRecordCoreOptions
): GetRecordCoreHandler {
  const traceDir = typeof options === "string" ? options : options.traceDir;

  return async (input: unknown): Promise<string> => {
    const parsed = parseInput(input);
    // Reads walk the two-level tree
    // `<baseDir>/projects/<slug>/<convId>/trace.jsonl`, resolved by
    // session-discovery.ts's findConversationTraceFile. Miss ->
    // TraceSessionNotFoundError (kept distinct from a missing record: "the
    // session folder doesn't exist" and "read everything, no such record" are
    // different claims; merging them into one record_not_found would report
    // the former as the latter).
    const filePath = findConversationTraceFile(traceDir, parsed.conversationId);
    if (filePath === undefined) {
      throw new TraceSessionNotFoundError(parsed.conversationId);
    }
    const reader = createJsonlTraceReader({ filePath });
    // Same scan implementation as the row axis (record-lookup.ts): the limit,
    // id-field order, and the `record_scan` criterion all defined once.
    const found = lookupRecordById(reader, {}, parsed.recordId);
    if (found.match === undefined) {
      throw new TraceRecordNotFoundError(parsed.recordId);
    }

    // Blob dereference receives `traceFilePath`, not `traceDir` (ADR-0071) —
    // `dirname(traceFilePath)` is the blobs sibling directory, co-derived
    // with the main-session writer layout
    // (`<baseDir>/projects/<slug>/<convId>/trace.jsonl` + a sibling blobs/).
    // Read-side addressing already walks the two-level tree: filePath comes
    // from findConversationTraceFile.
    const parts = await addressParts(found.match.row, parsed.detail, filePath);
    return JSON.stringify(
      parsed.partIndex === undefined
        ? manifestOf(found.match, parsed, parts)
        : windowOf(found.match, parsed, parts)
    );
  };
}

/**
 * Resolved coordinates: `fromChar` / `count` are **effective values** (the
 * defaults when not passed); `messageIndex` / `partIndex` keep the
 * passed-or-not distinction — both arm selection and "which coordinates
 * took part in addressing" depend on it.
 */
interface ResolvedRequest {
  readonly detail: Detail;
  readonly messageIndex?: number;
  readonly partIndex?: number;
  readonly fromChar: number;
  readonly count: number;
  readonly windowCoordinatesGiven: {
    readonly fromChar: boolean;
    readonly count: boolean;
  };
}

function parseInput(input: unknown): ResolvedRequest & {
  readonly conversationId: string;
  readonly recordId: string;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TraceQueryValidationError("input", "input must be an object");
  }
  const raw = input as GetRecordInput;
  const conversationId = requireNonEmptyString(
    raw.conversation_id,
    "conversation_id"
  );
  if (conversationId.includes("/") || conversationId.includes("\\")) {
    throw new TraceQueryValidationError(
      "conversation_id",
      "conversation_id must not contain path separators"
    );
  }
  const recordId = requireNonEmptyString(raw.record_id, "record_id");
  const detail = parseDetail(raw.detail);
  // Coordinate **bounds** (negative, fractional, over-cap) are checked here;
  // coordinate **reachability** (how many messages / parts this record
  // actually has) is checked during addressing below, since that requires
  // reading the record first.
  const messageIndex = parseInteger(raw.message_index, "message_index", 0);
  const partIndex = parseInteger(raw.part_index, "part_index", 0);
  const fromChar = parseInteger(raw.from_char, "from_char", 0) ?? 0;
  const count =
    parseInteger(raw.count, "count", 1, GET_RECORD_MAX_COUNT) ??
    GET_RECORD_DEFAULT_COUNT;
  return {
    conversationId,
    recordId,
    detail,
    ...(messageIndex === undefined ? {} : { messageIndex }),
    ...(partIndex === undefined ? {} : { partIndex }),
    fromChar,
    count,
    // "The caller supplied window coordinates" and "window coordinates equal
    // the defaults" are different facts: the manifest arm rejects the former,
    // so a presence record is kept here rather than re-comparing values.
    windowCoordinatesGiven: {
      fromChar: raw.from_char !== undefined,
      count: raw.count !== undefined,
    },
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TraceQueryValidationError(
      field,
      `${field} must be a non-empty string`
    );
  }
  return value;
}

function parseDetail(value: unknown): Detail {
  if (value === undefined) return "tool_results";
  if (
    typeof value !== "string" ||
    !(GET_RECORD_DETAIL_VALUES as ReadonlyArray<string>).includes(value)
  ) {
    throw new TraceQueryValidationError(
      "detail",
      `detail must be one of: ${GET_RECORD_DETAIL_VALUES.join(", ")}`
    );
  }
  return value as Detail;
}

/** One addressable part: coordinates + full text. Both the window arm and the manifest arm answer from this single list, so they cannot disagree. */
interface AddressablePart {
  readonly messageIndex?: number;
  readonly partIndex: number;
  readonly text: string;
  readonly identity?: Record<string, unknown>;
  // Under detail=messages the manifest arm's parts carry their message's
  // role (ADR-0003 messages[].role domain: user / assistant / tool / system).
  // A projection-layer field: used only by the manifest arm, never in the
  // window arm, and never in detail=tool_results parts (a tool_result is by
  // definition on the user side; adding role would be redundant and confuse
  // the user message with the tool_results nested in it — see the
  // "tool_result projection" entry in CONTEXT.md).
  readonly role?: string;
}

/**
 * The addressable parts of one record, chosen by `detail`.
 *
 * `messages` takes the messages' content blocks (after ADR-0036 blob
 * dereference, so blob-stored and inline messages address identically);
 * `tool_results` takes the **full text** of projected tool_results, in
 * projection order — the row axis's `preview` is under a 400-character cap,
 * and using its length as this axis's size would tell callers "one window
 * holds it" when three are needed.
 */
async function addressParts(
  row: TraceRecordRow,
  detail: Detail,
  traceFilePath: string
): Promise<{
  readonly parts: ReadonlyArray<AddressablePart>;
  readonly messageCount: number;
}> {
  // ADR-0116 arms: `system` addresses the one dereferenced identity-prefix
  // body; `tools` addresses the step's tool-name list (one part per name,
  // the name echoed in the inventory identity). Neither is message-indexed,
  // so messageCount is unused there (selectParts rejects message_index) —
  // kept at 0 rather than paying for a messages deref these arms never read.
  if (detail === "system" || detail === "tools") {
    const parts =
      detail === "system"
        ? await systemParts(row, traceFilePath)
        : toolNameParts(row);
    return { parts, messageCount: 0 };
  }
  const messages = Array.isArray(row["messages"]) ? row["messages"] : [];
  // Pass traceFilePath, not traceDir — blob directory = dirname(filePath)/blobs.
  const dereferenced = await dereferenceTraceMessages(messages, {
    traceFilePath,
  });
  if (detail === "tool_results") {
    const results: readonly ProjectedToolResult[] =
      collectToolResults(dereferenced);
    return {
      messageCount: dereferenced.length,
      parts: results.map((result, index) => ({
        partIndex: index,
        text: result.text,
        identity: {
          tool_use_id: result.tool_use_id,
          ...(result.name === undefined ? {} : { name: result.name }),
          is_error: result.is_error,
        },
      })),
    };
  }
  const parts: AddressablePart[] = [];
  dereferenced.forEach((message, messageIndex) => {
    // Read role (when a string) off the dereferenced message. When
    // unreadable, omit role — dereference degradation to an empty array is
    // already handled inside dereferenceTraceMessages and cannot occur on the
    // normal path. Consistent with detail=tool_results parts: the field is
    // absent, never null/undefined.
    const role = messageRole(message);
    messageContentBlocks(message).forEach((block, partIndex) => {
      parts.push({
        messageIndex,
        partIndex,
        text: renderPart(block),
        ...(role === undefined ? {} : { role }),
      });
    });
  });
  return { parts, messageCount: dereferenced.length };
}

/** detail=system (ADR-0116): the single dereferenced identity-prefix body, or no parts when the step sent none / the blob is unreadable. */
async function systemParts(
  row: TraceRecordRow,
  traceFilePath: string
): Promise<ReadonlyArray<AddressablePart>> {
  const text = await dereferenceSystemBody(row["system"], { traceFilePath });
  return text === undefined ? [] : [{ partIndex: 0, text }];
}

/** detail=tools (ADR-0116): one part per tool name; the name rides in the inventory identity like tool_results carries its tool name. */
function toolNameParts(
  row: TraceRecordRow
): ReadonlyArray<AddressablePart> {
  const names = Array.isArray(row["tool_names"]) ? row["tool_names"] : [];
  const parts: AddressablePart[] = [];
  for (const entry of names) {
    if (typeof entry !== "string") continue;
    parts.push({
      partIndex: parts.length,
      text: entry,
      identity: { name: entry },
    });
  }
  return parts;
}

/**
 * A part's text: whatever form it was stored in — a bare string as itself,
 * everything else (content block objects etc.) as its JSON text. This is
 * the single rendering rule: one place, so the manifest's `chars` and the
 * window's `text` cannot evolve apart.
 */
function renderPart(part: unknown): string {
  return typeof part === "string" ? part : JSON.stringify(part);
}

/** Manifest arm: record scalars + coordinates and sizes of addressable parts, no content. */
function manifestOf(
  match: RecordMatch,
  parsed: ResolvedRequest,
  addressable: {
    readonly parts: ReadonlyArray<AddressablePart>;
    readonly messageCount: number;
  }
): Record<string, unknown> {
  rejectUnusedWindowCoordinates(parsed);
  const scoped = parsed.messageIndex !== undefined;
  const parts = selectParts(addressable.parts, parsed, addressable);
  return {
    record: projectRecordBase(match.row),
    matched_on: match.matchedOn,
    detail: parsed.detail,
    ...(scoped ? { message_index: parsed.messageIndex } : {}),
    parts: parts.map((part) => ({
      ...(part.messageIndex === undefined || scoped
        ? {}
        : { message_index: part.messageIndex }),
      part_index: part.partIndex,
      chars: part.text.length,
      ...(part.identity ?? {}),
      // Under detail=messages parts carry their message's role;
      // detail=tool_results parts have none (AddressablePart.role unset in
      // the tool_results branch of addressParts). Field absent = key not
      // rendered, consistent with the other part fields in this file.
      ...(part.role === undefined ? {} : { role: part.role }),
    })),
  };
}

/** Window arm: record scalars + matched axis + effective coordinates + part size + exactly `count` characters. */
function windowOf(
  match: RecordMatch,
  parsed: ResolvedRequest,
  addressable: {
    readonly parts: ReadonlyArray<AddressablePart>;
    readonly messageCount: number;
  }
): Record<string, unknown> {
  const part = selectParts(addressable.parts, parsed, addressable)[0]!;
  const { fromChar, count } = parsed;
  if (fromChar + count > part.text.length) {
    throw new TraceWindowOverflowError({
      fromChar,
      count,
      partChars: part.text.length,
    });
  }
  // `text` must be the last key: the face's backstop cuts from the tail, so
  // key order decides whether the cut hits the content or the echoed
  // coordinates (the latter surviving so the caller can resend with only a
  // smaller `count`, without re-addressing).
  return {
    record: projectRecordBase(match.row),
    matched_on: match.matchedOn,
    detail: parsed.detail,
    ...(parsed.messageIndex === undefined
      ? {}
      : { message_index: parsed.messageIndex }),
    part_index: parsed.partIndex!,
    from_char: fromChar,
    count,
    part_chars: part.text.length,
    text: part.text.slice(fromChar, fromChar + count),
  };
}

/**
 * Per-part-arm addressing vocabulary for the three non-message-indexed
 * details: `phrase` names the arm in the message_index rejection, `unit`
 * names the pagination unit in out-of-range errors (kept verbatim for
 * tool_results, whose wording predates ADR-0116).
 */
const PART_ARM: Record<
  "tool_results" | "system" | "tools",
  { readonly phrase: string; readonly unit: string }
> = {
  tool_results: { phrase: "projected tool results", unit: "tool results" },
  system: { phrase: "the record's system body", unit: "system body parts" },
  tools: { phrase: "the record's tool name list", unit: "tool names" },
};

function partArmOf(detail: Detail): "tool_results" | "system" | "tools" {
  if (detail === "system") return "system";
  if (detail === "tools") return "tools";
  return "tool_results";
}

/**
 * Narrow coordinates to one part — both arms share one criterion, so
 * "coordinates that took part in addressing must be answered; unused
 * coordinates must be rejected" is implemented once.
 *
 * Out-of-range `message_index` / `part_index` report `validation` with the
 * **real addressable count** (the error kind set stays at five, no sixth);
 * the non-message arms (`tool_results`, ADR-0116's `system` / `tools`) do
 * not address by message at all, so passing one is rejected; a
 * `detail=messages` window requires `message_index` — defaulting it to 0
 * would answer "the message nobody named" as "message 0".
 */
function selectParts(
  parts: ReadonlyArray<AddressablePart>,
  parsed: ResolvedRequest,
  addressable: { readonly messageCount: number }
): ReadonlyArray<AddressablePart> {
  const { detail, messageIndex, partIndex } = parsed;
  if (detail !== "messages") {
    const arm = partArmOf(detail);
    if (messageIndex !== undefined) {
      throw new TraceQueryValidationError(
        "message_index",
        `message_index addresses one message; detail=${arm} addresses ${PART_ARM[arm].phrase}, which ${
          arm === "tool_results" ? "are" : "is"
        } not message-indexed`
      );
    }
    if (partIndex === undefined) return parts;
    if (partIndex >= parts.length) {
      throw outOfRange("part_index", partIndex, parts.length, PART_ARM[arm].unit);
    }
    return parts.slice(partIndex, partIndex + 1);
  }
  const windowArm = partIndex !== undefined;
  if (!windowArm && messageIndex === undefined) return parts;
  if (messageIndex === undefined) {
    if (!windowArm) return parts;
    throw new TraceQueryValidationError(
      "message_index",
      "message_index is required for a window: detail=messages parts are addressed by message_index plus part_index"
    );
  }
  if (messageIndex >= addressable.messageCount) {
    throw outOfRange(
      "message_index",
      messageIndex,
      addressable.messageCount,
      "messages"
    );
  }
  const scoped = parts.filter((part) => part.messageIndex === messageIndex);
  if (partIndex === undefined) return scoped;
  if (partIndex >= scoped.length) {
    throw outOfRange(
      "part_index",
      partIndex,
      scoped.length,
      "content blocks",
      `message ${messageIndex} has`
    );
  }
  return scoped.slice(partIndex, partIndex + 1);
}

function outOfRange(
  field: "message_index" | "part_index",
  index: number,
  count: number,
  unit: string,
  owner = "this record has"
): TraceQueryValidationError {
  return new TraceQueryValidationError(
    field,
    `${field} ${index} is out of range: ${owner} ${count} ${unit}`
  );
}

/** Without `part_index` the manifest arm has no window to read, so window coordinates are rejected there, not ignored. */
function rejectUnusedWindowCoordinates(parsed: ResolvedRequest): void {
  if (parsed.partIndex !== undefined) return;
  for (const [field, given] of [
    ["from_char", parsed.windowCoordinatesGiven.fromChar],
    ["count", parsed.windowCoordinatesGiven.count],
  ] as const) {
    if (!given) continue;
    throw new TraceQueryValidationError(
      field,
      `${field} addresses a window and requires part_index; omit the window coordinates to read the inventory instead`
    );
  }
}
