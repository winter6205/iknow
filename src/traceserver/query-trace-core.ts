import {
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
 * The one description text for both faces (spec SC7 / SC18: one source, and it
 * claims no character cap — the 4000-character sentence this replaces described
 * a budget the read side stopped owning in plan `trace-mcp-read-side-split` T6).
 * What the row axis really guarantees is stated in its own terms: rows come back
 * as projections, list pagination is `limit` + `offset`, `records.length <
 * limit` is the end-of-data signal, and span-level reads on one record live on
 * `get_record`. Positive-trigger phrasing per #483 D9, enforced by
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
  "arguments) to search record content, optionally combined with " +
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
    // T7: `conversation_id` is required on the tool face (Assumption 4). A
    // missing file raises `session_not_found`, not the silent empty envelope the
    // pre-T7 default returned when the implicit "newest session" was also
    // missing.
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
    const result = reader.query(query);
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
  // T7: required. Empty string still fails before the path-separator check, so
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
    // contains: 大小写敏感的原始行子串。空串视为非法输入 (与 task_id 等
    // 字符串轴的 requireNonEmptyString 校验风格一致) — 「匹配所有行」由
    // 不传 contains 表达, 不给空串第二种歧义语义。
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

  const messages = Array.isArray(row["messages"]) ? row["messages"] : [];
  projected.messages_count = messages.length;
  if (messages.length > 0) {
    projected.first_message_preview = preview(messages[0]);
    projected.last_message_preview = preview(messages[messages.length - 1]);
    // v1.2 判据 (b): 外部 agent 取最终 assistant 结论的动线
    // (list_sessions(limit:1) -> query_trace(record_type:"llm_call", limit:1))
    // 需要**最后一条** role==="assistant" 消息的预览. last_message_preview
    // 对 loop-engine 尾部追加的 <agent_status> user 注入消息是死预览,
    // 故本字段专答「结论」一问. 与 first_message_preview / last_message_preview
    // 同源 (复用 preview(), 同一 cap, 同一截断语义). 字段缺席 = 合法态 (无
    // assistant 消息), 不是 empty string.
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (messageRole(message) === "assistant") {
        projected.last_assistant_preview = preview(message);
        break;
      }
    }
  }
  // T3 (SC7): 传 traceFilePath, blob 目录由 dirname(filePath)/blobs 派生。
  const toolResults = await projectToolResultsFromTrace(messages, {
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
 * 锚在 `TRACE_OUTPUT_BACKSTOP` 而不是一个更小的自有数字：本核的目的只是「让一页
 * 到调用方手里时仍是可解析的 JSON」，而帽的值与 MCP 面那层具名 backstop 同源于
 * executor 的 `OUTPUT_HARD_CAP`。整条 4000 字符红线随 plan
 * `trace-mcp-read-side-split` T6 离开代码库——它既不是读单元也不是可声明的合同。
 *
 * The end-of-data signal is implicit (`records.length < limit`), so no
 * metadata field accompanies this. `total` and `truncated` left the tool face
 * in T7 — they belonged to the panel's byte-paging semantics, not to the
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
