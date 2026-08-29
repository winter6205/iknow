/**
 * query_trace — ACI adapter for the traceserver query/projection core.
 *
 * The adapter owns only ACI metadata and domain-error translation. Query
 * validation, trace reading, projection, and response serialization are shared
 * with the MCP transport through src/traceserver.
 */
import { ToolExecutionError } from "../../errors.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import type { AciToolDef } from "../types.js";
import {
  createQueryTraceCore,
  QUERY_TRACE_DEFAULT_LIMIT,
  QUERY_TRACE_MAX_LIMIT,
  QUERY_TRACE_MAX_RECORD_ID_SCAN,
  TRACE_RECORD_TYPES,
  TraceQueryRecordScanError,
  TraceQueryValidationError as TraceserverQueryValidationError,
} from "../../../traceserver/index.js";

export const MAX_RECORD_ID_SCAN = QUERY_TRACE_MAX_RECORD_ID_SCAN;

export class QueryTraceValidationError extends ToolExecutionError {
  readonly kind = "validation" as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(`query_trace: ${message}`);
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
        throw new QueryTraceValidationError(
          error.field,
          stripQueryTracePrefix(error.message)
        );
      }
      if (error instanceof TraceQueryRecordScanError) {
        throw new ToolExecutionError(error.message);
      }
      throw error;
    }
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

function stripQueryTracePrefix(message: string): string {
  const prefix = "query_trace: ";
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}
