import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  createListSessionsCore,
  createQueryTraceCore,
  LIST_SESSIONS_DESCRIPTION,
  LIST_SESSIONS_MAX_LIMIT,
  QUERY_TRACE_DEFAULT_LIMIT,
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
    conversation_id: z.string().optional(),
    record_type: z.enum(TRACE_RECORD_TYPES).optional(),
    status: z.enum(["ok", "error"]).optional(),
    task_id: z.string().optional(),
    parent_turn_id: z.string().optional(),
    turn_id: z.string().optional(),
    limit: z.number().int().min(1).max(QUERY_TRACE_MAX_LIMIT).optional(),
    record_id: z.string().optional(),
    detail: z.enum(["tool_results", "messages"]).optional(),
    resume_offset: z.number().int().min(0).optional(),
  })
  .strict();

const QUERY_TRACE_DESCRIPTION =
  "Query local JSONL trace records with filters. Normal llm_call results are projection-only (message count, first/last previews, tool_result projection from llm_call.messages, and error); use record_id to drill into one record. By default drill-down returns tool_results; use detail=messages for messages. If the model ends the turn without a following llm_call, that last round's tool_results are not visible in the projection. Results are capped at 4000 characters.";

// One const per tool, named after that tool (matching QUERY_TRACE_DESCRIPTION):
// the shared core deliberately names no tool in its messages, so every tool
// registered here prefixes its own name at this boundary.
const LIST_SESSIONS_TOOL_NAME = "list_sessions";
const QUERY_TRACE_TOOL_NAME = "query_trace";

export interface TraceMcpServerOptions {
  readonly traceDir: string;
}

/**
 * 两张皮共用的 handler：成功 = core 的序列化文本；失败 = 本工具名 + core 的
 * message（SC16 锁定的可见形状）。三件工具同形，故只写一次（T6 的 `get_record`
 * 直接复用）。
 *
 * 读侧核抛出的域内错误都是 Error 子类（`TraceQueryValidationError` /
 * `TraceQueryRecordScanError` / `TraceReadError`），所以 `String(error)` 只在非
 * Error 抛出时到达 —— 那是程序缺陷，兜成一条 `isError` 文本好过让 stdio 进程崩。
 * 仓库的 typed-error 渲染规则要求带 `kind`：本面**故意不带**。MCP 没有 ACI
 * `ToolExecutionError.kind` 那样的结构化通道，把 kind 拼进文本会改掉 SC16 的形状
 * （记为后续票，见 plan `trace-mcp-read-side-split` §执行期前提修正）。
 */
function readOnlyToolHandler(
  toolName: string,
  core: (input: unknown) => Promise<string>
) {
  return async (input: unknown) => {
    try {
      return {
        content: [{ type: "text" as const, text: await core(input) }],
      };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `${toolName}: ${detail}` }],
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
  const server = new McpServer({
    name: "iknow-trace-mcp",
    version: "0.1.0",
  });

  // 注册顺序 = tools/list 顺序，按读侧三轴排列：目录轴先于记录轴。
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

  return server;
}

export { QUERY_TRACE_DEFAULT_LIMIT };
