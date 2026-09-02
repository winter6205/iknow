/**
 * get_record — ACI adapter for the traceserver content-axis core.
 *
 * The adapter owns only ACI metadata and domain-error translation. Record
 * addressing, part inventory, window slicing, and response serialization are
 * shared with the MCP transport through src/traceserver.
 *
 * spec SC20 counts the kinds this face can raise: `validation`, `record_scan`,
 * `record_not_found`, `window_overflow`, `session_not_found`, plus the reader's
 * `io_error`. Each one is translated on its own arm — a fall-through would turn
 * a typed refusal into the executor's generic "tool execution failed". Kinds
 * that carry facts the caller needs to re-aim its next call (an out-of-range
 * coordinate's real size, a `part_chars` budget) keep them as fields; the two
 * kinds whose facts are already in the message reuse `ToolExecutionError`, the
 * same ruling `query_trace` and `list_sessions` made for them.
 *
 * The shared core names no tool in its messages, so this face prefixes its own
 * name on every error it translates (spec SC16).
 */
import { ToolExecutionError } from "../../errors.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import type { AciToolDef } from "../types.js";
import {
  createGetRecordCore,
  GET_RECORD_DEFAULT_COUNT,
  GET_RECORD_MAX_COUNT,
  GET_RECORD_DESCRIPTION,
  TraceQueryRecordScanError,
  TraceQueryValidationError as TraceserverValidationError,
  TraceReadError,
  TraceRecordNotFoundError,
  TraceSessionNotFoundError,
  TraceWindowOverflowError,
} from "../../../traceserver/index.js";

const TOOL_NAME = "get_record";

export class GetRecordValidationError extends ToolExecutionError {
  readonly kind = "validation" as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${TOOL_NAME}: ${message}`);
    this.field = field;
  }
}

/** 扫到上限仍未命中：与「扫完了，没有」是两种主张，调用方下一步不同。 */
export class GetRecordScanError extends ToolExecutionError {
  readonly kind = "record_scan" as const;
  readonly recordId: string;
  readonly scanned: number;

  constructor(recordId: string, scanned: number, message: string) {
    super(`${TOOL_NAME}: ${message}`);
    this.recordId = recordId;
    this.scanned = scanned;
  }
}

export class GetRecordNotFoundError extends ToolExecutionError {
  readonly kind = "record_not_found" as const;
  readonly recordId: string;

  constructor(recordId: string, message: string) {
    super(`${TOOL_NAME}: ${message}`);
    this.recordId = recordId;
  }
}

export class GetRecordSessionNotFoundError extends ToolExecutionError {
  readonly kind = "session_not_found" as const;
  readonly conversationId: string;

  constructor(conversationId: string, message: string) {
    super(`${TOOL_NAME}: ${message}`);
    this.conversationId = conversationId;
  }
}

/**
 * 窗越出 part 末尾。带上 `part_chars` 与 `remaining`：本 kind 的全部用处就是让
 * 调用方一次算出末页坐标，缺了这两个字段它就退化成一条需要重读文档的错误。
 */
export class GetRecordWindowOverflowError extends ToolExecutionError {
  readonly kind = "window_overflow" as const;
  readonly fromChar: number;
  readonly count: number;
  readonly partChars: number;
  readonly remaining: number;

  constructor(source: TraceWindowOverflowError) {
    super(`${TOOL_NAME}: ${source.message}`);
    this.fromChar = source.fromChar;
    this.count = source.count;
    this.partChars = source.partChars;
    this.remaining = source.remaining;
  }
}

export interface GetRecordToolOptions {
  readonly traceDir: string;
}

export function createGetRecordTool(
  options: string | GetRecordToolOptions
): AciToolDef {
  const traceDir = typeof options === "string" ? options : options.traceDir;
  const core = createGetRecordCore({ traceDir });
  const handler = async (
    input: unknown,
    _ctx?: ToolExecutionContext
  ): Promise<string> => {
    try {
      return await core(input);
    } catch (error: unknown) {
      if (error instanceof TraceserverValidationError) {
        throw new GetRecordValidationError(error.field, error.message);
      }
      if (error instanceof TraceWindowOverflowError) {
        throw new GetRecordWindowOverflowError(error);
      }
      if (error instanceof TraceRecordNotFoundError) {
        throw new GetRecordNotFoundError(error.recordId, error.message);
      }
      if (error instanceof TraceSessionNotFoundError) {
        throw new GetRecordSessionNotFoundError(
          error.conversationId,
          error.message
        );
      }
      if (error instanceof TraceQueryRecordScanError) {
        throw new GetRecordScanError(
          error.recordId,
          error.scanned,
          error.message
        );
      }
      if (error instanceof TraceReadError) {
        // 读文件失败不是参数问题，所以不带 field；消息只含 errno code
        // （wrapIoError 刻意不泄漏 fs 细节），前缀仍是本工具名。
        throw new ToolExecutionError(`${TOOL_NAME}: ${error.message}`);
      }
      throw error;
    }
  };

  return Object.freeze({
    name: TOOL_NAME,
    description: GET_RECORD_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        // 必填：本面没有「缺省=最近活跃会话」，见 Assumption 4。
        conversation_id: { type: "string" },
        record_id: { type: "string" },
        detail: {
          type: "string",
          enum: ["tool_results", "messages"],
          default: "tool_results",
        },
        message_index: { type: "integer", minimum: 0 },
        part_index: { type: "integer", minimum: 0 },
        from_char: { type: "integer", minimum: 0 },
        count: {
          type: "integer",
          minimum: 1,
          maximum: GET_RECORD_MAX_COUNT,
          default: GET_RECORD_DEFAULT_COUNT,
        },
      },
      required: ["conversation_id", "record_id"],
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
