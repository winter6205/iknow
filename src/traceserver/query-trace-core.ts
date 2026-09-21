import {
  dereferenceSystemBody,
  dereferenceTraceMessages,
  messageRole,
  projectToolResultsFromTrace,
} from "./project-tool-results.js";
import { projectRecordBase } from "./record-lookup.js";
import { TRACE_OUTPUT_BACKSTOP } from "./output-backstop.js";
import { createJsonlTraceReader } from "./reader.js";
import { findConversationTraceFile } from "./session-discovery.js";
import {
  TRACE_RECORD_TYPES,
  type TraceRecordRow,
  type TraceRecordType,
  type TraceQuery,
} from "./types.js";
import {
  TraceQueryValidationError,
  TraceSessionNotFoundError,
} from "./query-trace-errors.js";
import { parseInteger } from "./parse-integer.js";
import { toQueryTracePage } from "./envelope.js";

export const QUERY_TRACE_DEFAULT_LIMIT = 100;
export const QUERY_TRACE_MAX_LIMIT = 200;
export const QUERY_TRACE_PREVIEW_CAP = 400;

/**
 * The one description text for both faces (one source, and it claims no
 * character cap — the 4000-character sentence this replaces described a
 * budget the read side stopped owning).
 * What the row axis really guarantees is stated in its own terms: rows come back
 * as projections, list pagination is `limit` + `offset`, `records.length <
 * limit` is the end-of-data signal, and span-level reads on one record live on
 * `get_record`. Positive-trigger phrasing, enforced by
 * tests/harness/aci/tools/d9-description-guard.test.ts.
 */
export const QUERY_TRACE_DESCRIPTION =
  "Query local JSONL trace records with filters, returning one page of rows. " +
  "Rows are projection-only (message count, first/last previews of any role, " +
  'the last_assistant_preview taken from the last role="assistant" message ' +
  "(absent when no assistant message is on the record), tool_result summaries " +
  "with their character sizes, and error); use get_record to read one " +
  "record's content span by span. The page is filtered and paged by limit " +
  "(default 100, up to " +
  String(QUERY_TRACE_MAX_LIMIT) +
  ") and offset; the response echoes the effective limit and offset, so a page " +
  "shorter than the echoed limit means the filter has no more rows and offset + " +
  "rows returned continues it. Use contains (case-sensitive substring match " +
  "on the raw record line, covering llm_call messages and tool_call " +
  "arguments, plus the dereferenced system body and tool name list on " +
  "llm_call rows) to search record content, optionally combined with " +
  "record_type to narrow the hit type. conversation_id is required: discover " +
  "it with list_sessions, then pair this tool with get_record to reach a " +
  "record's content. If the model ends the turn without a following " +
  "llm_call, that last round's tool_results are not visible in the projection.";

interface QueryTraceInput {
  readonly conversation_id?: unknown;
  readonly record_type?: unknown;
  readonly status?: unknown;
  readonly task_id?: unknown;
  readonly parent_turn_id?: unknown;
  readonly turn_id?: unknown;
  readonly contains?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface QueryTraceCoreOptions {
  readonly traceDir: string;
}

export type QueryTraceCoreHandler = (input: unknown) => Promise<string>;

export function createQueryTraceCore(
  options: string | QueryTraceCoreOptions
): QueryTraceCoreHandler {
  const traceDir = typeof options === "string" ? options : options.traceDir;

  return async (input: unknown): Promise<string> => {
    const parsed = parseInput(input);
    // `conversation_id` is required on the tool face. A missing file raises
    // `session_not_found`, not the silent empty envelope the earlier default
    // returned when the implicit "newest session" was also missing.
    const filePath = findConversationTraceFile(traceDir, parsed.conversationId);
    if (filePath === undefined) {
      throw new TraceSessionNotFoundError(parsed.conversationId);
    }
    const reader = createJsonlTraceReader({ filePath });
    const query: TraceQuery = {
      ...(parsed.recordType !== undefined
        ? { recordType: parsed.recordType }
        : {}),
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
      ...(parsed.taskId !== undefined ? { taskId: parsed.taskId } : {}),
      ...(parsed.parentTurnId !== undefined
        ? { parentTurnId: parsed.parentTurnId }
        : {}),
      ...(parsed.turnId !== undefined ? { turnId: parsed.turnId } : {}),
      ...(parsed.contains !== undefined ? { contains: parsed.contains } : {}),
      limit: parsed.limit,
      offset: parsed.offset,
    };
    // Per-query memo for the system-body deref (contains arm only): the
    // blob pool is content-addressed, so the same sha always resolves to
    // the same body — one disk read + JSON.parse per sha per query.
    const systemBodies = new Map<string, string | undefined>();
    const result =
      parsed.contains === undefined
        ? reader.query(query)
        : // ADR-0116: the raw-line substring stays the fast path, but
          // llm_call rows are additionally matched after blob dereference —
          // otherwise "did the usage lock sentence go out" would still be
          // a blind spot for blob-stored bodies.
          await reader.queryContains(
            { ...query, contains: parsed.contains },
            isLlmCallLine,
            (row) =>
              llmCallBlobContains(row, filePath, parsed.contains!, systemBodies)
          );
    const projected = await Promise.all(
      result.records.map((row) => projectRecord(row, filePath))
    );
    return serializeListPage(
      toQueryTracePage(projected, {
        limit: parsed.limit,
        offset: parsed.offset,
      }),
      projected.length
    );
  };
}

interface ParsedQueryTraceInput {
  readonly conversationId: string;
  readonly recordType?: TraceRecordType;
  readonly status?: "ok" | "error";
  readonly taskId?: string;
  readonly parentTurnId?: string;
  readonly turnId?: string;
  readonly contains?: string;
  readonly limit: number;
  readonly offset: number;
}

function parseInput(input: unknown): ParsedQueryTraceInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TraceQueryValidationError("input", "input must be an object");
  }
  const raw = input as QueryTraceInput;
  // Required. Empty string still fails before the path-separator check, so
  // the path-separator rule continues to run on a non-empty value.
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
  const recordType = parseRecordType(raw.record_type);
  const status = parseStatus(raw.status);
  const limit =
    parseInteger(raw.limit, "limit", 1, QUERY_TRACE_MAX_LIMIT) ??
    QUERY_TRACE_DEFAULT_LIMIT;
  const offset = parseInteger(raw.offset, "offset", 0) ?? 0;
  return {
    conversationId,
    ...(recordType !== undefined ? { recordType } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(raw.task_id !== undefined
      ? { taskId: requireNonEmptyString(raw.task_id, "task_id") }
      : {}),
    ...(raw.parent_turn_id !== undefined
      ? {
          parentTurnId: requireNonEmptyString(
            raw.parent_turn_id,
            "parent_turn_id"
          ),
        }
      : {}),
    ...(raw.turn_id !== undefined
      ? { turnId: requireNonEmptyString(raw.turn_id, "turn_id") }
      : {}),
    // contains: case-sensitive raw-line substring. An empty string is invalid
    // input (same requireNonEmptyString style as the other string axes) —
    // "match every line" is expressed by omitting contains; no second
    // ambiguous meaning for the empty string.
    ...(raw.contains !== undefined
      ? { contains: requireNonEmptyString(raw.contains, "contains") }
      : {}),
    limit,
    offset,
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

/**
 * Line-scope for the contains deref arm (ADR-0116): llm_call rows are the
 * only records whose searchable body lives in the blob pool (system text;
 * message bodies stay out of contains semantics — the raw line still matches
 * them inline via the fast path). The mark relies on the writer's
 * JSON.stringify (compact, no spaces around the colon); a line that misses
 * it degrades to the historical raw-only behavior, never to a false hit.
 */
const LLM_CALL_LINE_MARK = '"record_type":"llm_call"';

function isLlmCallLine(line: string): boolean {
  return line.includes(LLM_CALL_LINE_MARK);
}

/** Post-prefilter match for one llm_call row: system body (blob-dereferenced) or any tool_names entry (ADR-0116). `systemBodies` is the per-query sha memo. */
async function llmCallBlobContains(
  row: TraceRecordRow,
  traceFilePath: string,
  needle: string,
  systemBodies: Map<string, string | undefined>
): Promise<boolean> {
  if (row["record_type"] !== "llm_call") return false;
  const systemText = await memoizedSystemBody(
    row["system"],
    traceFilePath,
    systemBodies
  );
  if (systemText !== undefined && systemText.includes(needle)) return true;
  const names = Array.isArray(row["tool_names"]) ? row["tool_names"] : [];
  return names.some((name) => typeof name === "string" && name.includes(needle));
}

/**
 * Dereference the system blob body at most once per sha (content-addressed
 * pool ⇒ same sha = same body). The shape gate mirrors
 * `dereferenceSystemBody`'s ref check so only rows that would pay for blob
 * IO get a memo entry; unreadable bodies memo as undefined exactly like the
 * direct call degrades them.
 */
async function memoizedSystemBody(
  system: unknown,
  traceFilePath: string,
  systemBodies: Map<string, string | undefined>
): Promise<string | undefined> {
  if (
    typeof system !== "object" ||
    system === null ||
    typeof (system as { sha?: unknown }).sha !== "string" ||
    typeof (system as { bytes?: unknown }).bytes !== "number"
  ) {
    return undefined;
  }
  const { sha } = system as { sha: string };
  if (systemBodies.has(sha)) return systemBodies.get(sha);
  const body = await dereferenceSystemBody(system, { traceFilePath });
  systemBodies.set(sha, body);
  return body;
}

function parseRecordType(value: unknown): TraceRecordType | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !(TRACE_RECORD_TYPES as ReadonlyArray<string>).includes(value)
  ) {
    throw new TraceQueryValidationError(
      "record_type",
      `record_type must be one of: ${TRACE_RECORD_TYPES.join(", ")}`
    );
  }
  return value as TraceRecordType;
}

function parseStatus(value: unknown): "ok" | "error" | undefined {
  if (value === undefined) return undefined;
  if (value !== "ok" && value !== "error") {
    throw new TraceQueryValidationError(
      "status",
      "status must be one of: ok, error"
    );
  }
  return value;
}

async function projectRecord(
  row: TraceRecordRow,
  traceFilePath: string
): Promise<Record<string, unknown>> {
  const projected = projectRecordBase(row);
  if (row["record_type"] !== "llm_call") return projected;

  const rawMessages = Array.isArray(row["messages"]) ? row["messages"] : [];
  // In blob mode `messages[i]` is either `{role, content:{sha,bytes}}` or a
  // whole `{sha,bytes}` (legacy residue). The read side's `messageRole()` can
  // still read the former's inline role, but `preview()` JSON.stringify-ing
  // the whole message would stuff `{"sha":...}` into the preview body — the
  // "preview is content, never sha literals" rule only held for the inline
  // shape and surfaced under real blob runs. Dereference first so messages
  // return to inline shape (`{role, content}` where content is a string or
  // array); `messageRole` / `preview` / `projectToolResultsFromTrace` all
  // then operate on the restored form. `dereferenceTraceMessages` has its own
  // "missing/corrupt blob must not throw into the caller turn" try/catch
  // degrading to `[]`: on failure messages_count=0 and the three preview
  // fields are absent — same shape as the empty boundary, a legal state.
  const messages = await dereferenceTraceMessages(rawMessages, {
    traceFilePath,
  });
  projected.messages_count = messages.length;
  if (messages.length > 0) {
    projected.first_message_preview = preview(messages[0]);
    projected.last_message_preview = preview(messages[messages.length - 1]);
    // Why a dedicated last_assistant_preview: the external-agent flow for
    // fetching the final assistant conclusion
    // (list_sessions(limit:1) -> query_trace(record_type:"llm_call", limit:1))
    // needs the preview of the **last** role==="assistant" message.
    // last_message_preview is a dead preview against the <agent_status> user
    // messages loop-engine appends at the tail, so this field answers the
    // "conclusion" question specifically. Same source as
    // first_message_preview / last_message_preview (reuses preview(), same
    // cap, same truncation semantics). Absent field = legal state (no
    // assistant message), not an empty string.
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (messageRole(message) === "assistant") {
        projected.last_assistant_preview = preview(message);
        break;
      }
    }
  }
  // Pass traceFilePath; the blob directory is derived as dirname(filePath)/blobs.
  const toolResults = await projectToolResultsFromTrace(rawMessages, {
    traceFilePath,
  });
  projected.tool_result_count = toolResults.length;
  if (toolResults.length > 0) {
    projected.tool_result_previews = toolResults
      .slice(0, 2)
      .map((result) => result.preview.slice(0, 200));
  }
  return projected;
}

function preview(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      // EXIT: cyclic or otherwise unserializable values fall back to a string preview.
      text = String(value);
    }
  }
  return text.length <= QUERY_TRACE_PREVIEW_CAP
    ? text
    : `${text.slice(0, QUERY_TRACE_PREVIEW_CAP)}...[truncated]`;
}

/**
 * List face: an over-backstop page narrows by **whole records only**. Records
 * are appended one at a time while the serialized envelope still fits, and the
 * first record that would not fit ends the page. Nothing is ever truncated
 * inside a record, and a page never shrinks to zero — when not even the first
 * record fits, that record is returned whole and the response overshoots the
 * backstop rather than lying about it.
 *
 * Anchored on `TRACE_OUTPUT_BACKSTOP` rather than a smaller private number:
 * this core's only goal is "a page still parses as JSON when it reaches the
 * caller", and the cap's value shares executor's `OUTPUT_HARD_CAP` through
 * the named MCP-face backstop. The whole 4000-character red line left the
 * codebase with the read-side split — it was neither a read unit nor a
 * declarable contract.
 *
 * The end-of-data signal is implicit (`records.length < limit`), so no
 * metadata field accompanies this. `total` and `truncated` left the tool
 * face — they belonged to the panel's byte-paging semantics, not to the
 * row-axis page the caller asked for.
 */
function serializeListPage(
  payload: ReturnType<typeof toQueryTracePage>,
  projectedCount: number
): string {
  const fullPage = JSON.stringify(payload);
  if (fullPage.length <= TRACE_OUTPUT_BACKSTOP) return fullPage;

  const envelopeOf = (count: number): string =>
    JSON.stringify({ ...payload, records: payload.records.slice(0, count) });
  // Start at 1, not 0: reaching here means there is at least one record (an
  // empty page serializes far below the backstop), and the floor of one is the
  // whole point — a query that matched must not report an empty list.
  let fitted = 1;
  while (
    fitted < projectedCount &&
    envelopeOf(fitted + 1).length <= TRACE_OUTPUT_BACKSTOP
  ) {
    fitted += 1;
  }
  return envelopeOf(fitted);
}
