/**
 * PROTOTYPE（throwaway）— ACI 原型工具层：延迟加载 registry。
 *
 * 验证问题：延迟加载（lazy 工具默认不进 prompt schema，需 discover() 注入）
 * 能否以加法式装饰层实现，不修改冻结 Registry 接口。
 * inner = createRegistry(tools)：AciToolDef 结构上是 ToolDef，spread 多带
 * aci 字段对 ajv 编译无害（additionalProperties 约束在 inputSchema 内，不在顶层）。
 */

import { createRegistry } from "../tools/registry.js";
import type { RegistryImpl } from "../tools/registry.js";
import type { ToolDef } from "../tools/types.js";
import type { AciCatalog, AciToolDef } from "./types.js";
import { RegistryConstructionError } from "../errors.js";

export interface AciRegistry {
  /** 冻结协议 registry（交给 createExecutor）。 */
  readonly inner: RegistryImpl;
  readonly catalog: AciCatalog;
  /** 核心（非 lazy）工具 schema —— 默认进 prompt 的集合。 */
  readonly visibleSchemas: () => ReadonlyArray<ToolDef>;
  /** 延迟加载：按需检索某工具 schema（含 lazy 的），未注册返回 undefined。 */
  readonly discover: (name: string) => ToolDef | undefined;
}

/**
 * 构造 ACI registry：
 *   - inner = createRegistry(tools)（协议 registry，交给 createExecutor）；
 *   - catalog 持有 AciToolDef 全量（权限层与延迟加载共用）；
 *   - visibleSchemas 过滤 !lazy + discovered 名录中命中的 lazy（按 tools
 *     顺序插入，去重）；discover() 调用即标记，下一轮起进入 promptTools()
 *     （#224 discovered set 状态 — 闭包于 createAciRegistry，不跨 session
 *     持久化，与 spec Boundaries Never 守门）；
 *   - discover 按名返回（含 lazy 工具），命中时记 discovered 标记；
 *     未注册返回 undefined。
 *
 * **装配期 fail-fast 三闸门（spec § Boundaries Always）**：
 *   - Gate 1 自举守卫：tool_search 是发现工具自身,不允许标 lazy
 *     （否则它把自身标记为待发现,自举死锁）。
 *   - Gate 2 命名空间防撞:mcp__ 前缀预留给未来 MCP 工具(spec 决策
 *     点 2 ⑤);ACI 工具不能占用,装配期即抛。
 *   两闸门共用同一 for 循环前置校验(createRegistry 未调用,失败时无
 *     部分状态)。
 */
export function createAciRegistry(
  tools: ReadonlyArray<AciToolDef>
): AciRegistry {
  // #224 闸门 1 + 2：装配期 fail-fast，在 createRegistry 调用前完成，
  // 失败不留部分状态。复用 tools 单次遍历，避免双重扫描。
  for (const t of tools) {
    // 自举守卫 — tool_search 是发现工具自身,不允许标 lazy（否则它把
    // 自身标记为待发现,自举死锁）。
    if (t.name === "tool_search" && t.aci.lazy === true) {
      throw new RegistryConstructionError(
        "tool_search is the bootstrap discovery tool — lazy=true is forbidden"
      );
    }
    // 命名空间防撞 — mcp__ 前缀预留给未来 MCP 工具（spec 决策点 2 ⑤）；
    // ACI 工具不能占用。
    if (t.name.startsWith("mcp__")) {
      throw new RegistryConstructionError(
        `tool name '${t.name}' uses reserved mcp__ namespace`
      );
    }
  }

  const inner = createRegistry(tools);

  const byName = new Map<string, AciToolDef>();
  for (const t of tools) {
    byName.set(t.name, t);
  }
  const allList = Object.freeze([...tools]) as ReadonlyArray<AciToolDef>;

  const catalog: AciCatalog = Object.freeze({
    get: (name: string) => byName.get(name),
    all: () => allList,
  });

  // #224 discovered set：本 run 内被检索过的工具名（闭包状态，不跨 session
  // 持久化）。discover() 命中时 add；visibleSchemas() 按 tools 顺序拼
  // 非 lazy + 已发现的 lazy（含去重），从下一轮起进入 promptTools()。
  const discovered = new Set<string>();

  const visibleSchemas = (): ReadonlyArray<ToolDef> =>
    tools.filter((t) => !t.aci.lazy || discovered.has(t.name));

  const discover = (name: string): ToolDef | undefined => {
    const hit = byName.get(name);
    if (hit !== undefined) {
      discovered.add(name);
    }
    return hit;
  };

  return Object.freeze({ inner, catalog, visibleSchemas, discover });
}
