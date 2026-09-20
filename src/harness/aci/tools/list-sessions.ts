/**
 * list_sessions — ACI adapter for the traceserver session-index core.
 *
 * The adapter owns only ACI metadata and domain-error translation. Reading the
 * index, the mtime-descending page order, paging, and response serialization are
 * shared with the MCP transport through src/traceserver.
 *
 * The shared core names no tool in its error messages, so this face prefixes
 * its own tool name (TOOL_NAME) on every error it translates. Any other
 * error is re-raised untouched.
 */
import { ToolExecutionError } from "../../errors.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import type { AciToolDef } from "../types.js";
import {
  createListSessionsCore,
  LIST_SESSIONS_DEFAULT_LIMIT,
  LIST_SESSIONS_MAX_LIMIT,
  LIST_SESSIONS_DESCRIPTION,
  TraceReadError,
  TraceQueryValidationError as TraceserverValidationError,
} from "../../../traceserver/index.js";

const TOOL_NAME = "list_sessions";

export class ListSessionsValidationError extends ToolExecutionError {
  readonly kind = "validation" as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${TOOL_NAME}: ${message}`);
    this.field = field;
  }
}

export interface ListSessionsToolOptions {
  readonly traceDir: string;
}

export function createListSessionsTool(
  options: string | ListSessionsToolOptions
): AciToolDef {
  const traceDir = typeof options === "string" ? options : options.traceDir;
  const core = createListSessionsCore({ traceDir });
  const handler = async (
    input: unknown,
    _ctx?: ToolExecutionContext
  ): Promise<string> => {
    try {
      return await core(input);
    } catch (error: unknown) {
      if (error instanceof TraceserverValidationError) {
        throw new ListSessionsValidationError(error.field, error.message);
      }
      if (error instanceof TraceReadError) {
        // A directory read failure is not a parameter problem, so no field
        // is attached; the message carries only the errno code (wrapIoError
        // deliberately hides fs details); the prefix is still this tool's name.
        throw new ToolExecutionError(`${TOOL_NAME}: ${error.message}`);
      }
      throw error;
    }
  };

  return Object.freeze({
    name: TOOL_NAME,
    description: LIST_SESSIONS_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: LIST_SESSIONS_MAX_LIMIT,
          default: LIST_SESSIONS_DEFAULT_LIMIT,
        },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
      // ADR-0043 puts it second in the deferral order (trace read side,
      // directory axis, after the row-axis query_trace).
      deferrable: true,
    },
  });
}
