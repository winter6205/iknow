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
 */
import { ToolExecutionError } from "../../errors.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import type { AciToolDef } from "../types.js";
import {
  createQueryTraceCore,
  QUERY_TRACE_DEFAULT_LIMIT,
  QUERY_TRACE_MAX_LIMIT,
  QUERY_TRACE_MAX_RECORD_ID_SCAN,
  QUERY_TRACE_DESCRIPTION,
  TRACE_RECORD_TYPES,
  TraceQueryRecordScanError,
  TraceQueryValidationError as TraceserverQueryValidationError,
} from "../../../traceserver/index.js";

export const MAX_RECORD_ID_SCAN = QUERY_TRACE_MAX_RECORD_ID_SCAN;

const TOOL_NAME = "query_trace";

export class QueryTraceValidationError extends ToolExecutionError {
  readonly kind = "validation" as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${TOOL_NAME}: ${message}`);
    this.field = field;
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
      if (error instanceof TraceQueryRecordScanError) {
        throw new ToolExecutionError(`${TOOL_NAME}: ${error.message}`);
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
        limit: {
          type: "integer",
          minimum: 1,
          maximum: QUERY_TRACE_MAX_LIMIT,
          default: QUERY_TRACE_DEFAULT_LIMIT,
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
