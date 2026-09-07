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
 * 声明界与 ACI 面逐字段同值（spec SC18）：两个必填 id 只声明 string，长度界由核
 * 统一给（核里 `conversation_id` / `record_id` 必须非空）；三个坐标 minimum 0；
 * `count` 1..GET_RECORD_MAX_COUNT。两面的差异只剩 schema 语言的表达法，不再有第二
 * 套数值。
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
 * 两张皮共用的 handler：成功 = core 的序列化文本；失败 = 本工具名 + core 的
 * message（SC16 锁定的可见形状）。三件工具同形，故只写一次。
 *
 * 读侧核抛出的域内错误都是 Error 子类（`TraceQueryValidationError` /
 * `TraceWindowOverflowError` / `TraceRecordNotFoundError` /
 * `TraceSessionNotFoundError` / `TraceQueryRecordScanError` / `TraceReadError`），
 * 所以 `String(error)` 只在非 Error 抛出时到达 —— 那是程序缺陷，兜成一条
 * `isError` 文本好过让 stdio 进程崩。
 * 仓库的 typed-error 渲染规则要求带 `kind`：本面**故意不带**。MCP 没有 ACI
 * `ToolExecutionError.kind` 那样的结构化通道，把 kind 拼进文本会改掉 SC16 的形状
 * （记为后续票，见 plan `trace-mcp-read-side-split` §执行期前提修正）。
 *
 * `applyTraceOutputBackstop` 是本面自己的帽，两条臂（成功文本与错误文本）都过它。
 * 为什么这里必须有、而 ACI 面没有：进程内那条路有 executor 的 `OUTPUT_HARD_CAP`
 * 兜底（契约 X 的唯一截断权威），stdio 这条路没有任何东西在它之后再看一眼文本。
 * 标记计入预算，所以返回长度**严格 ≤ `TRACE_OUTPUT_BACKSTOP`**。刻意**不**抄
 * executor 的 8 轮收敛循环：那个循环要处理的是任意 payload 结构（envelope、多
 * content block、对象图）反复序列化后的尺寸，本面每次只发一个已经序列化好的字符串，
 * 一次定长切分就是它的完整语义。
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

  // 内容轴最后注册：tools/list 的顺序就是三轴的阅读顺序（目录 → 行 → 内容），
  // 白名单仍然只有这三件（spec SC6）。
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
