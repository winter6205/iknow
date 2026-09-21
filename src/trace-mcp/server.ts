import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  applyTraceOutputBackstop,
  createGetRecordCore,
  createListSessionsCore,
  createQueryTraceCore,
  GET_RECORD_DESCRIPTION,
  GET_RECORD_MAX_COUNT,
  LIST_SESSIONS_DESCRIPTION,
  LIST_SESSIONS_MAX_LIMIT,
  QUERY_TRACE_DEFAULT_LIMIT,
  QUERY_TRACE_DESCRIPTION,
  QUERY_TRACE_MAX_LIMIT,
  TRACE_RECORD_TYPES,
} from "../traceserver/index.js";

const listSessionsInputSchema = z
  .object({
    limit: z.number().int().min(1).max(LIST_SESSIONS_MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

const queryTraceInputSchema = z
  .object({
    conversation_id: z.string(),
    record_type: z.enum(TRACE_RECORD_TYPES).optional(),
    status: z.enum(["ok", "error"]).optional(),
    task_id: z.string().optional(),
    parent_turn_id: z.string().optional(),
    turn_id: z.string().optional(),
    contains: z.string().optional(),
    limit: z.number().int().min(1).max(QUERY_TRACE_MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

/**
 * Declared bounds match the ACI face field by field: the two required ids
 * declare only string, with length bounds given uniformly by the core (the
 * core requires non-empty `conversation_id` / `record_id`); the three
 * coordinates have minimum 0; `count` is 1..GET_RECORD_MAX_COUNT. The two
 * faces then differ only in schema language, never in a second set of
 * numbers.
 */
const getRecordInputSchema = z
  .object({
    conversation_id: z.string(),
    record_id: z.string(),
    detail: z.enum(["tool_results", "messages"]).optional(),
    message_index: z.number().int().min(0).optional(),
    part_index: z.number().int().min(0).optional(),
    from_char: z.number().int().min(0).optional(),
    count: z.number().int().min(1).max(GET_RECORD_MAX_COUNT).optional(),
  })
  .strict();

// One const per tool, named after that tool (matching QUERY_TRACE_DESCRIPTION):
// the shared core deliberately names no tool in its messages, so every tool
// registered here prefixes its own name at this boundary.
const LIST_SESSIONS_TOOL_NAME = "list_sessions";
const QUERY_TRACE_TOOL_NAME = "query_trace";
const GET_RECORD_TOOL_NAME = "get_record";

export interface TraceMcpServerOptions {
  readonly traceDir: string;
}

/**
 * Handler shared by both thin faces: success = the core's serialized text;
 * failure = this tool's name + the core's message (the locked visible
 * shape). All three tools are same-shaped, so it is written once.
 *
 * Every domain error thrown by the read-side core is an Error subclass
 * (`TraceQueryValidationError` / `TraceWindowOverflowError` /
 * `TraceRecordNotFoundError` / `TraceSessionNotFoundError` /
 * `TraceQueryRecordScanError` / `TraceReadError`), so `String(error)` is
 * only reached on a non-Error throw — a program defect; degrading it to an
 * `isError` text beats crashing the stdio process.
 * The repo's typed-error rendering rule demands `kind`; this face
 * **deliberately omits it**: MCP has no structured channel like ACI's
 * `ToolExecutionError.kind`, and splicing kind into the text would change
 * the locked shape (tracked as a follow-up).
 *
 * `applyTraceOutputBackstop` is this face's own cap; both arms (success text
 * and error text) pass through it. Why it must live here but not on the ACI
 * face: the in-process path is backstopped by executor's `OUTPUT_HARD_CAP`
 * (the single truncation authority); on the stdio path nothing looks at the
 * text afterwards. The marker counts against the budget, so the returned
 * length is **strictly ≤ `TRACE_OUTPUT_BACKSTOP`**. Deliberately **not** the
 * executor's 8-round convergence loop: that loop handles re-serialized sizes
 * of arbitrary payload structures (envelopes, multi content blocks, object
 * graphs); this face emits one already-serialized string per call, so a
 * single fixed-width cut is its complete semantics.
 */
function readOnlyToolHandler(
  toolName: string,
  core: (input: unknown) => Promise<string>
) {
  return async (input: unknown) => {
    try {
      return {
        content: [
          {
            type: "text" as const,
            text: applyTraceOutputBackstop(await core(input)),
          },
        ],
      };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text" as const,
            text: applyTraceOutputBackstop(`${toolName}: ${detail}`),
          },
        ],
        isError: true,
      };
    }
  };
}

export function createTraceMcpServer(
  options: TraceMcpServerOptions
): McpServer {
  const listSessions = createListSessionsCore(options);
  const queryTrace = createQueryTraceCore(options);
  const getRecord = createGetRecordCore(options);
  const server = new McpServer({
    name: "iknow-trace-mcp",
    version: "0.1.0",
  });

  // Registration order = tools/list order, arranged by the read-side axes:
  // catalog before records.
  server.registerTool(
    LIST_SESSIONS_TOOL_NAME,
    {
      description: LIST_SESSIONS_DESCRIPTION,
      inputSchema: listSessionsInputSchema,
      annotations: { readOnlyHint: true },
    },
    readOnlyToolHandler(LIST_SESSIONS_TOOL_NAME, listSessions)
  );

  server.registerTool(
    QUERY_TRACE_TOOL_NAME,
    {
      description: QUERY_TRACE_DESCRIPTION,
      inputSchema: queryTraceInputSchema,
      annotations: { readOnlyHint: true },
    },
    readOnlyToolHandler(QUERY_TRACE_TOOL_NAME, queryTrace)
  );

  // The content axis registers last: tools/list order is the reading order
  // of the three axes (catalog -> rows -> content), and the whitelist stays
  // exactly these three tools.
  server.registerTool(
    GET_RECORD_TOOL_NAME,
    {
      description: GET_RECORD_DESCRIPTION,
      inputSchema: getRecordInputSchema,
      annotations: { readOnlyHint: true },
    },
    readOnlyToolHandler(GET_RECORD_TOOL_NAME, getRecord)
  );

  return server;
}

export { QUERY_TRACE_DEFAULT_LIMIT };
