/**
 * query_trace — read-only, projection-first access to the JSONL trace reader.
 *
 * The tool deliberately shares the traceserver record-type whitelist and reader
 * instead of maintaining a second parser. Normal llm_call rows omit messages
 * and expose only count/previews; record_id is the explicit drill-down escape
 * hatch for one row.
 */
import { join } from "node:path";

import { ToolExecutionError } from "../../errors.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import type { AciToolDef } from "../types.js";
import {
  createJsonlTraceReader,
  projectToolResultsFromTrace,
  TRACE_RECORD_TYPES,
  listSessions,
  type TraceQuery,
  type TraceRecordRow,
  type TraceRecordType,
  type TraceQueryResult,
} from "../../../traceserver/index.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
export const MAX_RECORD_ID_SCAN = 10_000;
const RESPONSE_CAP = 4_000;
const PREVIEW_CAP = 400;
const RECORD_ID_KEYS = [
  "llm_call_id",
  "tool_call_id",
  "turn_id",
  "violation_id",
  "session_id",
  "sandbox_cmd_id",
  "verification_id",
  "goal_id",
  "subagent_id",
  "subagent_step_id",
] as const;

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

export interface QueryTraceToolOptions {
  readonly traceDir: string;
}

export class QueryTraceValidationError extends ToolExecutionError {
  readonly kind = "validation" as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(`query_trace: ${message}`);
    this.field = field;
  }
}

export function createQueryTraceTool(
  options: string | QueryTraceToolOptions
): AciToolDef {
  const traceDir = typeof options === "string" ? options : options.traceDir;
  const handler = async (
    input: unknown,
    _ctx?: ToolExecutionContext
  ): Promise<string> => {
    const parsed = parseInput(input);
    const conversationId =
      parsed.conversationId ?? mostRecentConversationId(traceDir);
    if (conversationId === undefined) {
      return serializeResponse(emptyResult());
    }

    const reader = createJsonlTraceReader({
      filePath: join(traceDir, `${conversationId}.jsonl`),
    });
    const result =
      parsed.recordId === undefined
        ? reader.query(parsed.query)
        : findRecord(reader, parsed.query, parsed.recordId);
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
    return serializeResponse({
      records,
      total: result.total,
      skipped_lines: result.skippedLines,
      truncated: result.truncated,
      offset: result.offset,
    });
  };

  return Object.freeze({
    name: "query_trace",
    description:
      "Query local JSONL trace records with filters. Normal llm_call results are projection-only (message count, first/last previews, tool_result projection from llm_call.messages, and error); use record_id to drill into one record. By default drill-down returns tool_results; use detail=messages for messages. If the model ends the turn without a following llm_call, that last round's tool_results are not visible in the projection. Results are capped at 4000 characters.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        record_type: {
          type: "string",
          enum: [...TRACE_RECORD_TYPES],
        },
        status: { type: "string", enum: ["ok", "error"] },
        task_id: { type: "string" },
        parent_turn_id: { type: "string" },
        turn_id: { type: "string" },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          default: DEFAULT_LIMIT,
        },
        record_id: { type: "string" },
        detail: {
          type: "string",
          enum: ["tool_results", "messages"],
          default: "tool_results",
        },
        resume_offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    },
  });
}

function parseInput(input: unknown): {
  readonly query: TraceQuery;
  readonly conversationId?: string;
  readonly recordId?: string;
  readonly detail?: "messages" | "tool_results";
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError("query_trace: input must be an object");
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
    throw new QueryTraceValidationError(
      "conversation_id",
      "conversation_id must not contain path separators"
    );
  }
  const recordId = optionalNonEmptyString(raw.record_id, "record_id");
  const recordType = parseRecordType(raw.record_type);
  const status = parseStatus(raw.status);
  const limit = parseInteger(raw.limit, "limit", 1, MAX_LIMIT) ?? DEFAULT_LIMIT;
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
    throw new QueryTraceValidationError(
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
    throw new QueryTraceValidationError(
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
    throw new QueryTraceValidationError(
      "record_type",
      `record_type must be one of: ${TRACE_RECORD_TYPES.join(", ")}`
    );
  }
  return value as TraceRecordType;
}

function parseStatus(value: unknown): "ok" | "error" | undefined {
  if (value === undefined) return undefined;
  if (value !== "ok" && value !== "error") {
    throw new QueryTraceValidationError(
      "status",
      "status must be one of: ok, error"
    );
  }
  return value;
}

function parseInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new QueryTraceValidationError(
      field,
      `${field} must be an integer in ${minimum}..${maximum}`
    );
  }
  return value;
}

function mostRecentConversationId(traceDir: string): string | undefined {
  const sessions = listSessions(traceDir);
  return sessions.reduce<(typeof sessions)[number] | undefined>(
    (latest, session) =>
      latest === undefined || session.mtime > latest.mtime ? session : latest,
    undefined
  )?.conversation_id;
}

function findRecord(
  reader: ReturnType<typeof createJsonlTraceReader>,
  query: TraceQuery,
  recordId: string
): TraceQueryResult {
  const all: TraceRecordRow[] = [];
  let skippedLines = 0;
  let result = reader.query({ ...query, limit: MAX_LIMIT, offset: 0 });
  all.push(...result.records);
  skippedLines += result.skippedLines;
  while (
    all.length < result.total &&
    all.length < MAX_RECORD_ID_SCAN
  ) {
    const nextOffset = all.length;
    result = reader.query({
      ...query,
      limit: MAX_LIMIT,
      offset: nextOffset,
    });
    if (result.records.length === 0) break;
    all.push(...result.records);
    skippedLines += result.skippedLines;
  }
  const match = all.find((row) =>
    RECORD_ID_KEYS.some((key) => row[key] === recordId)
  );
  if (
    match === undefined &&
    all.length >= MAX_RECORD_ID_SCAN &&
    (all.length < result.total || result.truncated)
  ) {
    throw new ToolExecutionError(
      `query_trace: record_id scan exhausted after ${MAX_RECORD_ID_SCAN} records before finding '${recordId}'`
    );
  }
  return {
    records: match === undefined ? [] : [match],
    total: match === undefined ? 0 : 1,
    skippedLines,
    truncated: result.truncated,
    offset: result.offset,
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

function projectRecordBase(row: TraceRecordRow): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key !== "messages" && key !== "raw") projected[key] = value;
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
      text = String(value);
    }
  }
  return text.length <= PREVIEW_CAP
    ? text
    : `${text.slice(0, PREVIEW_CAP)}...[truncated]`;
}

function emptyResult(): {
  readonly records: ReadonlyArray<TraceRecordRow>;
  readonly total: number;
  readonly skipped_lines: number;
  readonly truncated: boolean;
  readonly offset: number;
} {
  return {
    records: [],
    total: 0,
    skipped_lines: 0,
    truncated: false,
    offset: 0,
  };
}

function serializeResponse(payload: {
  readonly records: ReadonlyArray<Record<string, unknown> | TraceRecordRow>;
  readonly total: number;
  readonly skipped_lines: number;
  readonly truncated: boolean;
  readonly offset: number;
}): string {
  const output = JSON.stringify(payload);
  if (output.length <= RESPONSE_CAP) return output;

  const compactRecords = payload.records.map((record) => compactRecord(record));
  for (let count = compactRecords.length; count >= 0; count--) {
    const compact = JSON.stringify({
      ...payload,
      records: compactRecords.slice(0, count),
      response_truncated: count !== compactRecords.length,
    });
    if (compact.length <= RESPONSE_CAP) return compact;
  }
  return JSON.stringify({
    records: [],
    total: payload.total,
    skipped_lines: payload.skipped_lines,
    truncated: true,
    offset: payload.offset,
    response_truncated: true,
  });
}

function compactRecord(
  record: Record<string, unknown> | TraceRecordRow
): Record<string, unknown> {
  const projected =
    "messages" in record
      ? projectRecordBase(record as TraceRecordRow)
      : (record as Record<string, unknown>);
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(projected)) {
    if (typeof value === "string") compact[key] = value.slice(0, 256);
    else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      compact[key] = value;
    } else if (key === "error") {
      compact[key] = value;
    }
  }
  return compact;
}
