/**
 * query_trace — ACI adapter for the traceserver query/projection core.
 *
 * The adapter owns only ACI metadata and domain-error translation. Query
 * validation, trace reading, projection, and response serialization are shared
 * with the MCP transport through src/traceserver.
 *
 * The shared core names no tool in its error messages, so this face prefixes
 * its own tool name (TOOL_NAME) on the two domain errors it translates. Any
 * other error is re-raised untouched.
 *
 * After the trace read-side split, the drill-down axis (`record_id` /
 * `detail`) is gone — `get_record` owns it. The face therefore drops those
 * three schema keys, gains `offset`, makes `conversation_id` required, and
 * maps the read-side `session_not_found` to a typed tool error.
 */
import { ToolExecutionError } from "../../errors.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import type { AciToolDef } from "../types.js";
import {
  createQueryTraceCore,
  QUERY_TRACE_DEFAULT_LIMIT,
  QUERY_TRACE_MAX_LIMIT,
  QUERY_TRACE_DESCRIPTION,
  TRACE_RECORD_TYPES,
  TraceQueryValidationError as TraceserverQueryValidationError,
  TraceSessionNotFoundError,
} from "../../../traceserver/index.js";

const TOOL_NAME = "query_trace";

export class QueryTraceValidationError extends ToolExecutionError {
  readonly kind = "validation" as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${TOOL_NAME}: ${message}`);
    this.field = field;
  }
}

/**
 * Row-axis contract: `session_not_found` was introduced by `get_record` and
 * is reused here — this is the second tool with a required
 * `conversation_id` (the shared assumption rules out "default = most
 * recently active session"). The message prefixes the tool name up front per
 * this face's convention; callers keep recognizing the same shape.
 */
export class QueryTraceSessionNotFoundError extends ToolExecutionError {
  readonly kind = "session_not_found" as const;
  readonly conversationId: string;

  constructor(conversationId: string, message: string) {
    super(`${TOOL_NAME}: ${message}`);
    this.conversationId = conversationId;
  }
}

export interface QueryTraceToolOptions {
  readonly traceDir: string;
}

export function createQueryTraceTool(
  options: string | QueryTraceToolOptions
): AciToolDef {
  const traceDir = typeof options === "string" ? options : options.traceDir;
  const core = createQueryTraceCore({ traceDir });
  const handler = async (
    input: unknown,
    _ctx?: ToolExecutionContext
  ): Promise<string> => {
    try {
      return await core(input);
    } catch (error: unknown) {
      if (error instanceof TraceserverQueryValidationError) {
        throw new QueryTraceValidationError(error.field, error.message);
      }
      if (error instanceof TraceSessionNotFoundError) {
        throw new QueryTraceSessionNotFoundError(
          error.conversationId,
          error.message
        );
      }
      throw error;
    }
  };

  return Object.freeze({
    name: TOOL_NAME,
    description: QUERY_TRACE_DESCRIPTION,
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
        contains: { type: "string" },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: QUERY_TRACE_MAX_LIMIT,
          default: QUERY_TRACE_DEFAULT_LIMIT,
        },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["conversation_id"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
      // ADR-0043 puts this first in the deferral order (trace read side,
      // row axis — the largest schema surface): deferred first when over
      // threshold. The stamp lives only here; `tool-overflow.ts` is the
      // decision-layer SSOT and this field is its data source.
      deferrable: true,
    },
  });
}
