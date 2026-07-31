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
 *   - visibleSchemas 过滤 !lazy（默认进 prompt 的核心集合）；
 *   - discover 按名返回（含 lazy 工具），未注册返回 undefined。
 */
export function createAciRegistry(
  tools: ReadonlyArray<AciToolDef>,
): AciRegistry {
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

  const visibleSchemas = (): ReadonlyArray<ToolDef> =>
    tools.filter((t) => !t.aci.lazy);

  const discover = (name: string): ToolDef | undefined => byName.get(name);

  return Object.freeze({ inner, catalog, visibleSchemas, discover });
}
