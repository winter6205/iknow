/**
 * list_mcp_resources 工具 — wayfinder #440 Stream B T9（M1 / M2 决议）。
 *
 * 形态：两个显式工具的 list 侧（read 侧见 read-mcp-resource.ts）。
 * 模型按 list → read 两步式访问 MCP server 暴露的 resources。
 *
 * 依赖注入形态（lazy self-reference）：list 工具需要的是"已装配完成的
 * McpManager 实例"。McpManager 在 build-engine.ts 装配路径下由
 * `getMcpManager` 惰性闭包提供，故 deps 收 `getManager: () => McpManager`，
 * 调用期才解引用。装配期不持有 manager 引用，避免循环。
 *
 * 输出 wire 形态（p04 同形 + plan 决议）：
 *   - 每条 resource 一行 JSON（显式字段投影）
 *   - 空行（视觉分隔）
 *   - `--- perServer ---` 标记行
 *   - 随后每行一个 perServer state JSON（server / state / nextCursor?）
 *   - 空资源集合 → 单独返回 `(no resources)` 中性占位（合法空值）
 *
 * ACI 元数据（M2 决议）：
 *   category: "read-only"      （iknow 自写 meta 工具，行为透明）
 *   isConcurrencySafe: true    （list 不改状态）
 *   interruptBehavior: cancel  （与 web_fetch 同形态）
 *   timeoutTier: "default"     （30s — 聚合 N 个 server 不可 fast）
 *
 * description（D9 / M2 决议）：仅写正面引导条件，不写负面禁令词。
 * 触发条件：需要访问 MCP server 暴露的资源前，先 list 拿到 server+uri 配对。
 */

import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError, errorMessage } from "../../errors.js";
import type {
  ListResourcesResult,
  McpManager,
  McpResource,
  McpPerServerState,
} from "../../mcp/manager.js";

/**
 * 依赖注入：`getManager` 惰性解引用已装配 McpManager。
 * 装配未完成 → 抛 ToolExecutionError（与 tool_search 同形态的 fail-fast）。
 */
export interface ListMcpResourcesToolDeps {
  readonly getManager: () => McpManager;
}

interface ListMcpResourcesInput {
  readonly server?: unknown;
  readonly cursor?: unknown;
}

const EMPTY_PLACEHOLDER = "(no resources)";

/**
 * 工厂：createListMcpResourcesTool(deps) — list MCP resources 工具（第 26 件）。
 *
 * 返回的 AciToolDef 满足：
 *   - name === "list_mcp_resources"
 *   - inputSchema: { server? 字符串 / cursor? 字符串 }，additionalProperties:false
 *   - aci 元数据：read-only / concurrency-safe / cancel / default tier
 */
export function createListMcpResourcesTool(
  deps: ListMcpResourcesToolDeps
): AciToolDef {
  const getManager = deps.getManager;

  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<string> => {
    const parsed = compileListInput(input);
    const manager = resolveManager(getManager);

    let result: ListResourcesResult;
    try {
      result = await manager.listResources({
        ...(parsed.server ? { server: parsed.server } : {}),
        ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
        signal: ctx?.signal,
      });
    } catch (err) {
      if (err instanceof ToolExecutionError) throw err;
      throw new ToolExecutionError(
        `[list_mcp_resources] list failed: ${errorMessage(err)}`
      );
    }

    if (result.resources.length === 0) {
      // 资源为空时仍展示 perServer（诊断价值），perServer 也为空 → 单独占位。
      if (result.perServer.length === 0) return EMPTY_PLACEHOLDER;
      // 仅资源为空 / perServer 有内容：仍展示 perServer 头部
      return formatWire([], result.perServer);
    }
    return formatWire(result.resources, result.perServer);
  };

  return Object.freeze({
    name: "list_mcp_resources",
    description:
      "list_mcp_resources: list resources exposed by connected MCP servers; use this when you need to know which servers expose resources and which URIs are available before reading content. Returns one JSON object per resource (server, uri, name, description?, mimeType?), followed by a per-server state tail; returns `(no resources)` when no servers expose any resources. Pass `server` to scope the listing to one server; pass `cursor` to continue pagination. Read a resource afterwards with `read_mcp_resource` once you have the `server` and `uri`.",
    inputSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          minLength: 1,
          description:
            "Optional MCP server name to scope the listing; omit to aggregate across all connected servers.",
        },
        cursor: {
          type: "string",
          minLength: 1,
          description:
            "Optional pagination cursor returned by a previous listing on the same server.",
        },
      },
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
    },
  });
}

/**
 * 输入编译 + 严格校验。
 *   - input 非对象 / null / array → typed-error。
 *   - server / cursor 仅当「类型正确且非空字符串」才外传；空串视为缺席（与
 *     model 偶尔漏填默认空值时仍能跑全量聚合的实用一致；不是错误信号）。
 *   - 类型错误（非 string 但存在）→ typed-error（区分「缺席」与「类型错」）。
 */
function compileListInput(input: unknown): {
  readonly server?: string;
  readonly cursor?: string;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError(
      "[list_mcp_resources] input must be an object"
    );
  }
  const raw = input as ListMcpResourcesInput;
  // server:缺席 → 不传；非字符串 → typed-error；空字符串 → 视为缺席（不外传）。
  let server: string | undefined;
  if (raw.server !== undefined) {
    if (typeof raw.server !== "string") {
      throw new ToolExecutionError(
        "[list_mcp_resources] server must be a string when present"
      );
    }
    if (raw.server.length > 0) server = raw.server;
  }
  // cursor：同 server 纪律。
  let cursor: string | undefined;
  if (raw.cursor !== undefined) {
    if (typeof raw.cursor !== "string") {
      throw new ToolExecutionError(
        "[list_mcp_resources] cursor must be a string when present"
      );
    }
    if (raw.cursor.length > 0) cursor = raw.cursor;
  }
  return { ...(server ? { server } : {}), ...(cursor ? { cursor } : {}) };
}

/**
 * 装配未完成 / 缺席 → 抛 typed-error（fail-fast；与 tool-search.ts 同形态）。
 * T11 条件化装配层会保证 manager 在场时此调用才被路由到 handler。
 */
function resolveManager(getManager: () => McpManager): McpManager {
  const m = getManager();
  if (!m) {
    throw new ToolExecutionError(
      "[list_mcp_resources] manager not assembled (mcpManager absent)"
    );
  }
  return m;
}

/**
 * Wire 拼装：每条 resource 一行 JSON + 空行 + `--- perServer ---` + perServer 行。
 * 字段投影只保留有值字段，避免 null 泄漏（与 tool-search.ts D6 同纪律）。
 */
function formatWire(
  resources: ReadonlyArray<McpResource>,
  perServer: ReadonlyArray<McpPerServerState>
): string {
  const resourceLines = resources.map((r) =>
    JSON.stringify(projectResource(r))
  );
  const perServerLines = perServer.map((s) =>
    JSON.stringify(projectPerServer(s))
  );
  return [...resourceLines, "", "--- perServer ---", ...perServerLines].join(
    "\n"
  );
}

/** McpResource 字段投影：缺席字段不出现。 */
function projectResource(r: McpResource): Record<string, unknown> {
  const out: Record<string, unknown> = { server: r.server, uri: r.uri };
  if (r.name !== undefined) out.name = r.name;
  if (r.description !== undefined) out.description = r.description;
  if (r.mimeType !== undefined) out.mimeType = r.mimeType;
  return out;
}

/** McpPerServerState 字段投影：nextCursor 缺席不出现。 */
function projectPerServer(s: McpPerServerState): Record<string, unknown> {
  const out: Record<string, unknown> = { server: s.server, state: s.state };
  if (s.nextCursor !== undefined) out.nextCursor = s.nextCursor;
  return out;
}
