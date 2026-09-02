import { join } from "node:path";

import { projectToolResultsFromTrace } from "./project-tool-results.js";
import {
  TRACE_RECORD_ID_SCAN_LIMIT,
  lookupRecordById,
  projectRecordBase,
  type RecordLookupResult,
} from "./record-lookup.js";
import { TRACE_OUTPUT_BACKSTOP } from "./output-backstop.js";
import { createJsonlTraceReader } from "./reader.js";
import {
  TRACE_RECORD_TYPES,
  type TraceRecordRow,
  type TraceRecordType,
  type TraceQuery,
  type TraceQueryResult,
} from "./types.js";
import { newestConversationId } from "./sessions.js";
import {
  emptyResponseEnvelope,
  toResponseEnvelope,
  type ResponseEnvelope,
} from "./envelope.js";
import { TraceQueryValidationError } from "./query-trace-errors.js";
import { parseInteger } from "./parse-integer.js";

export const QUERY_TRACE_DEFAULT_LIMIT = 100;
export const QUERY_TRACE_MAX_LIMIT = 200;
/**
 * 别名，不是第二份定义：`record_id` 扫描上限现在归
 * `record-lookup.ts`（两条内容轴共用）。保留本名是因为它已被
 * `src/harness/aci/tools/query-trace.ts` 与 `index.ts` 当公开面导出，
 * plan `trace-mcp-read-side-split` T7 把行轴瘦成行筛选 + 行分页时一并退役。
 */
export const QUERY_TRACE_MAX_RECORD_ID_SCAN = TRACE_RECORD_ID_SCAN_LIMIT;
export const QUERY_TRACE_PREVIEW_CAP = 400;

/**
 * The one description text for both faces (spec SC7 / SC18: one source, and it
 * claims no character cap — the 4000-character sentence this replaces described
 * a budget the read side stopped owning in plan `trace-mcp-read-side-split` T6).
 * What the row axis really guarantees is stated in its own terms: rows come back
 * as projections, `record_id` reads one record whole, a list page that would be
 * too wide keeps fewer **whole** records, and spans inside a record are
 * `get_record`'s axis. Positive-trigger phrasing per #483 D9, enforced by
 * tests/harness/aci/tools/d9-description-guard.test.ts.
 */
export const QUERY_TRACE_DESCRIPTION =
  "Query local JSONL trace records with filters, returning one page of rows. " +
  "Rows are projection-only (message count, first/last previews, tool_result " +
  "summaries with their character sizes, and error); use record_id to read one " +
  "record whole. By default a drill-down returns tool_results; use " +
  "detail=messages for messages. A list page keeps whole records only, so a page " +
  "answered with fewer rows than your limit left the widest trailing rows out by " +
  "that rule: narrow your filters to bring a smaller set back whole, and read one " +
  "record's content span by span with get_record, whose inventory reports each " +
  "part's size first. Name conversation_id from list_sessions, then pair this " +
  "tool with get_record to reach a record's content. If the model ends the turn " +
  "without a following llm_call, that last round's tool_results are not visible " +
  "in the projection.";

interface QueryTraceInput {
  readonly conversation_id?: unknown;
  readonly record_type?: unknown;
  readonly status?: unknown;
  readonly task_id?: unknown;
  readonly parent_turn_id?: unknown;
  readonly turn_id?: unknown;
  readonly limit?: unknown;
  readonly record_id?: unknown;
  readonly detail?: unknown;
  readonly resume_offset?: unknown;
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
    const serialize =
      parsed.recordId === undefined ? serializeListPage : serializeDrillDown;
    const conversationId =
      parsed.conversationId ?? newestConversationId(traceDir);
    if (conversationId === undefined) {
      return serialize(emptyResponseEnvelope());
    }

    const reader = createJsonlTraceReader({
      filePath: join(traceDir, `${conversationId}.jsonl`),
    });
    const result =
      parsed.recordId === undefined
        ? reader.query(parsed.query)
        : toDrillDownResult(
            lookupRecordById(reader, parsed.query, parsed.recordId)
          );
    const records =
      parsed.recordId === undefined
        ? await Promise.all(
            result.records.map((row) => projectRecord(row, traceDir))
          )
        : await Promise.all(
            result.records.map((row) =>
              projectDrillDownRecord(row, parsed.detail, traceDir)
            )
          );
    return serialize(toResponseEnvelope(result, records));
  };
}

function parseInput(input: unknown): {
  readonly query: TraceQuery;
  readonly conversationId?: string;
  readonly recordId?: string;
  readonly detail?: "messages" | "tool_results";
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TraceQueryValidationError("input", "input must be an object");
  }
  const raw = input as QueryTraceInput;
  const conversationId = optionalNonEmptyString(
    raw.conversation_id,
    "conversation_id"
  );
  if (
    conversationId !== undefined &&
    (conversationId.includes("/") || conversationId.includes("\\"))
  ) {
    throw new TraceQueryValidationError(
      "conversation_id",
      "conversation_id must not contain path separators"
    );
  }
  const recordId = optionalNonEmptyString(raw.record_id, "record_id");
  const recordType = parseRecordType(raw.record_type);
  const status = parseStatus(raw.status);
  const limit =
    parseInteger(raw.limit, "limit", 1, QUERY_TRACE_MAX_LIMIT) ??
    QUERY_TRACE_DEFAULT_LIMIT;
  const detail = parseDetail(raw.detail);
  const resumeOffset = parseInteger(raw.resume_offset, "resume_offset", 0) ?? 0;
  return {
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(recordId !== undefined ? { recordId } : {}),
    ...(detail !== undefined ? { detail } : {}),
    query: {
      ...(recordType !== undefined ? { recordType } : {}),
      ...(status !== undefined ? { status } : {}),
      taskId: optionalNonEmptyString(raw.task_id, "task_id"),
      parentTurnId: optionalNonEmptyString(
        raw.parent_turn_id,
        "parent_turn_id"
      ),
      turnId: optionalNonEmptyString(raw.turn_id, "turn_id"),
      limit,
      resumeOffset,
    },
  };
}

function parseDetail(value: unknown): "messages" | "tool_results" | undefined {
  if (value === undefined) return undefined;
  if (value !== "messages" && value !== "tool_results") {
    throw new TraceQueryValidationError(
      "detail",
      "detail must be one of: messages, tool_results"
    );
  }
  return value;
}

function optionalNonEmptyString(
  value: unknown,
  field: string
): string | undefined {
  if (value === undefined) return undefined;
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

/**
 * 下钻是行轴的「一条记录的页」：命中即 1 条，未命中即现状的 `records: []`（T7 决
 * 定它是否换成 `record_not_found`，与内容轴不同的判据留在行轴里）。扫描本身在
 * `record-lookup.ts`，这里只做线形状的转换。
 */
function toDrillDownResult(found: RecordLookupResult): TraceQueryResult {
  return {
    records: found.match === undefined ? [] : [found.match.row],
    total: found.match === undefined ? 0 : 1,
    skippedLines: found.skippedLines,
    truncated: found.truncated,
    offset: found.offset,
  };
}

async function projectRecord(
  row: TraceRecordRow,
  traceDir: string
): Promise<Record<string, unknown>> {
  const projected = projectRecordBase(row);
  if (row["record_type"] !== "llm_call") return projected;

  const messages = Array.isArray(row["messages"]) ? row["messages"] : [];
  projected.messages_count = messages.length;
  if (messages.length > 0) {
    projected.first_message_preview = preview(messages[0]);
    projected.last_message_preview = preview(messages[messages.length - 1]);
  }
  const toolResults = await projectToolResultsFromTrace(messages, { traceDir });
  projected.tool_result_count = toolResults.length;
  if (toolResults.length > 0) {
    projected.tool_result_previews = toolResults
      .slice(0, 2)
      .map((result) => result.preview.slice(0, 200));
  }
  return projected;
}

async function projectDrillDownRecord(
  row: TraceRecordRow,
  detail: "messages" | "tool_results" | undefined,
  traceDir: string
): Promise<Record<string, unknown> | TraceRecordRow> {
  if (row["record_type"] !== "llm_call" || detail === "messages") return row;

  const projected = projectRecordBase(row);
  const messages = Array.isArray(row["messages"]) ? row["messages"] : [];
  projected.tool_results = await projectToolResultsFromTrace(messages, {
    traceDir,
  });
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
 * Drill-down face: the caller named one record, so that record is the answer.
 * The core drops, shortens, or flags nothing here — the executor is the only
 * truncation authority on the tool face (契约 X), and a caller that wants a span
 * of a long record now has `get_record` for that. `record_id` matched nothing →
 * the empty envelope (row-axis status quo until T7).
 */
function serializeDrillDown(payload: ResponseEnvelope): string {
  return JSON.stringify(payload);
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
 * metadata field accompanies this. `total` and `truncated` keep reporting what
 * the reader reported until plan `trace-mcp-read-side-split` T7 takes them off
 * the tool face.
 */
function serializeListPage(payload: ResponseEnvelope): string {
  const fullPage = JSON.stringify(payload);
  if (fullPage.length <= TRACE_OUTPUT_BACKSTOP) return fullPage;

  const envelopeOf = (count: number): string =>
    JSON.stringify({ ...payload, records: payload.records.slice(0, count) });
  // Start at 1, not 0: reaching here means there is at least one record (an
  // empty page serializes far below the backstop), and the floor of one is the
  // whole point — a query that matched must not report an empty list.
  let fitted = 1;
  while (
    fitted < payload.records.length &&
    envelopeOf(fitted + 1).length <= TRACE_OUTPUT_BACKSTOP
  ) {
    fitted += 1;
  }
  return envelopeOf(fitted);
}
