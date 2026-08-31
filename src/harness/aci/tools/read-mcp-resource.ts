/**
 * read_mcp_resource 工具 — wayfinder #440 Stream B T10（M1 / M2 / M3 决议）。
 *
 * 形态：两个显式工具的 read 侧（list 侧见 list-mcp-resources.ts）。
 * 模型按 list → read 两步式访问 MCP server 暴露的 resources。
 *
 * 依赖注入形态（lazy self-reference）：与 list 工具同形态——deps 收
 * `getManager: () => McpManager`，调用期才解引用。装配未完成 → 抛
 * ToolExecutionError（fail-fast；T11 条件化装配保证 manager 在场时
 * 才被路由到 handler）。
 *
 * 输入：server + uri 均为必填非空字符串（模型显式 list 后已知配对）。
 *
 * 输出 wire：单个 JSON envelope `{ server, uri, contents: [...] }`。
 * 每个 contents 项字段投影（text / blob 互斥）：
 *   - 必有：uri
 *   - 可选：mimeType（外部声明的内容类型）
 *   - 互斥：text（utf-8）或 blob（base64）——任一出现即另一缺席
 * 互斥保证源自 SDK 协议（TextResourceContents | BlobResourceContents
 * 联合）；本工具只做字段投影，不重复判别。
 *
 * 安全（M3 决议）：
 *   - 资源内容注入：不设 sanitization 层（外部内容当 untrusted 数据），
 *     executor 截断 20000 + 契约 X 兜底输出大小；
 *   - server / uri 入参 schema 最小校验 + typed-error 包装。
 *
 * ACI 元数据（M2 决议）：
 *   category: "read-only"        （与 list 同形态）
 *   isConcurrencySafe: false     （M2 决议保守默认，与 mcp__* 工具同形态）
 *   interruptBehavior: cancel    （与 list 同形态）
 *   timeoutTier: "default"       （30s —— server 子进程不可 fast）
 *
 * description（D9 / M2 决议）：仅写正面引导条件，不写负面禁令词。
 * 触发条件：已经从 list_mcp_resource 拿到 server + uri 配对后，调本工具
 * 取内容。
 */

import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError, errorMessage } from "../../errors.js";
import type {
  McpManager,
  McpResourceContent,
  ReadResourceResult,
} from "../../mcp/manager.js";

/**
 * 依赖注入：`getManager` 惰性解引用已装配 McpManager。
 * 装配未完成 → 抛 ToolExecutionError（与 list-mcp-resources.ts 同形态）。
 */
export interface ReadMcpResourceToolDeps {
  readonly getManager: () => McpManager;
}

interface ReadMcpResourceInput {
  readonly server?: unknown;
  readonly uri?: unknown;
}

/**
 * 工厂：createReadMcpResourceTool(deps) — read MCP resource 工具（第 27 件）。
 *
 * 返回的 AciToolDef 满足：
 *   - name === "read_mcp_resource"
 *   - inputSchema: { server 必填 + uri 必填 }，additionalProperties:false
 *   - aci 元数据：read-only / NOT concurrency-safe / cancel / default tier
 */
export function createReadMcpResourceTool(
  deps: ReadMcpResourceToolDeps
): AciToolDef {
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<string> => {
    const parsed = compileReadInput(input);
    const manager = resolveManager(deps.getManager);

    let result: ReadResourceResult;
    try {
      // ADR-0039 重开并推翻 M3 的旧决议：manager 已支持 signal，
      // read_mcp_resource 必须透传 ctx.signal 以兑现 cancel metadata。
      result = await manager.readResource(parsed.server, parsed.uri, {
        signal: ctx?.signal,
      });
    } catch (err) {
      if (err instanceof ToolExecutionError) throw err;
      throw new ToolExecutionError(
        `[read_mcp_resource] read failed: ${errorMessage(err)}`
      );
    }

    return JSON.stringify(projectReadResult(result));
  };

  return Object.freeze({
    name: "read_mcp_resource",
    description:
      "read_mcp_resource: read the content of a specific resource exposed by an MCP server. Use this after list_mcp_resources has surfaced the `server` and `uri` pair you want. Returns one JSON envelope with the resource content; each `contents` entry has `uri`, optional `mimeType`, and exactly one of `text` (utf-8 string) or `blob` (base64 string). Server processes the request (configured in user trust boundary); large content is truncated by the executor downstream.",
    inputSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          minLength: 1,
          description:
            "MCP server name returned by list_mcp_resources; the server must be currently connected.",
        },
        uri: {
          type: "string",
          minLength: 1,
          description:
            "Resource URI returned by list_mcp_resources; identifies the specific resource to fetch.",
        },
      },
      required: ["server", "uri"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
    },
  });
}

/**
 * 输入编译 + 严格校验：server / uri 必填且非空字符串。
 * 缺席 / 类型错 / 空串 → 全部 typed-error（read 必须精确指定 server + uri，
 * 缺席无默认值，与 list 的可选语义区分）。
 */
function compileReadInput(input: unknown): {
  readonly server: string;
  readonly uri: string;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError("[read_mcp_resource] input must be an object");
  }
  const raw = input as ReadMcpResourceInput;
  if (typeof raw.server !== "string" || raw.server.length === 0) {
    throw new ToolExecutionError(
      "[read_mcp_resource] server is required and must be a non-empty string"
    );
  }
  if (typeof raw.uri !== "string" || raw.uri.length === 0) {
    throw new ToolExecutionError(
      "[read_mcp_resource] uri is required and must be a non-empty string"
    );
  }
  return { server: raw.server, uri: raw.uri };
}

/**
 * 装配未完成 / 缺席 → 抛 typed-error（fail-fast；与 list-mcp-resources.ts
 * resolveManager 同形态）。T11 条件化装配保证 manager 在场时此调用才被
 * 路由到 handler。
 */
function resolveManager(getManager: () => McpManager): McpManager {
  const m = getManager();
  if (!m) {
    throw new ToolExecutionError(
      "[read_mcp_resource] manager not assembled (mcpManager absent)"
    );
  }
  return m;
}

/**
 * 字段投影：readResult → wire envelope。
 * text / blob 互斥（SDK 协议保证）；本投影只保留有值字段，避免 null 泄漏
 * （与 tool-search.ts D6 同纪律）。
 */
function projectReadResult(r: ReadResourceResult): {
  readonly server: string;
  readonly uri: string;
  readonly contents: ReadonlyArray<Record<string, unknown>>;
} {
  return {
    server: r.server,
    uri: r.uri,
    contents: r.contents.map(projectContent),
  };
}

function projectContent(c: McpResourceContent): Record<string, unknown> {
  const out: Record<string, unknown> = { uri: c.uri };
  if (c.mimeType !== undefined) out.mimeType = c.mimeType;
  // text / blob 互斥：只设有的那一项。
  if (c.text !== undefined) {
    out.text = c.text;
  } else if (c.blob !== undefined) {
    out.blob = c.blob;
  }
  return out;
}
