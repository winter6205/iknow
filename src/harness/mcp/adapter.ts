import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/client";

import type { ToolExecutionContext } from "../tools/types.js";
import type { AciToolDef } from "../aci/types.js";
import { ToolExecutionError } from "../errors.js";

interface CallOptions {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
  readonly resetTimeoutOnProgress?: boolean;
}

export interface ToAciToolDefOptions {
  readonly server: string;
  readonly tool: McpTool;
  readonly call: (
    name: string,
    args: unknown,
    opts?: CallOptions
  ) => Promise<CallToolResult>;
  readonly timeoutMs: number;
}

const EMPTY_INPUT_SCHEMA = { type: "object", properties: {} } as const;

// 宿主 registry 的 Ajv 只 bundle draft-07 元模式；zod4 / MCP SDK 2.0 生成的
// inputSchema 带顶层 2020-12 `$schema`，compile 会被拒（#1058）。只剥顶层这
// 一处；无该键时返回原引用，保对象身份与 EMPTY_INPUT_SCHEMA 兜底语义。
// 已知限制：其余 2020-12 特有关键字（如 tuple 的 `prefixItems`）原样透传，
// draft-07 视角下可能被误读；当前已知消费方（zod4 常规关键字）不受影响。
function stripTopLevelSchemaKeyword(
  schema: Record<string, unknown>
): Record<string, unknown> {
  if (!("$schema" in schema)) {
    return schema;
  }
  const { $schema: _meta, ...rest } = schema;
  return Object.freeze(rest);
}

export function toAciToolDef(opts: ToAciToolDefOptions): AciToolDef {
  const { server, tool, call, timeoutMs } = opts;

  return Object.freeze({
    name: `mcp__${sanitizeSegment(server)}__${sanitizeSegment(tool.name)}`,
    description: tool.description ?? "",
    inputSchema: stripTopLevelSchemaKeyword(
      (tool.inputSchema ?? EMPTY_INPUT_SCHEMA) as Record<string, unknown>
    ),
    aci: {
      category: "write" as const,
      lazy: true,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "long" as const,
    },
    handler: async (
      input: unknown,
      ctx?: ToolExecutionContext
    ): Promise<string> => {
      let result: CallToolResult;
      try {
        result = await call(tool.name, input, {
          timeout: timeoutMs,
          resetTimeoutOnProgress: true,
          signal: ctx?.signal,
        });
      } catch (cause) {
        throw new ToolExecutionError(
          `MCP tool execution failed: ${errorMessage(cause)}`
        );
      }

      if (result.isError) {
        return extractText(result);
      }
      if (result.structuredContent !== undefined) {
        return JSON.stringify(result.structuredContent);
      }
      return extractText(result);
    },
  });
}

function sanitizeSegment(value: string): string {
  // 仅替换不可用于工具名的字符；**连字符 / 点保留**（deps.ts 的
  // mcpServerOfToolName 反解依赖这一点：配置 server 名 `codebase-memory`
  // 必须原样保留，面板 status.name 才能与工具归属对得上 —— #361 Phase D
  // 看板 bug 根因：此前 `-` 被替换成 `_`，导致 `mcp__codebase_memory__*`
  // 反解出 `codebase_memory`，与 status.name `codebase-memory` 永不匹配，
  // 列表工具数恒 0、详情页空白）。
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function extractText(result: CallToolResult): string {
  return result.content
    .filter(
      (
        block
      ): block is Extract<(typeof result.content)[number], { type: "text" }> =>
        block.type === "text"
    )
    .map((block) => block.text)
    .join("");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
