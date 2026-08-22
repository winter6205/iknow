/**
 * PROTOTYPE（throwaway）— ACI 原型工具层：延迟加载 registry。
 *
 * 验证问题：延迟加载（lazy 工具默认不进 prompt schema，需 discover() 注入）
 * 能否以加法式装饰层实现，不修改冻结 Registry 接口。
 * inner = createRegistry(tools)：AciToolDef 结构上是 ToolDef，spread 多带
 * aci 字段对 ajv 编译无害（additionalProperties 约束在 inputSchema 内，不在顶层）。
 */

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createRegistry } from "../tools/registry.js";
import type { RegistryImpl } from "../tools/registry.js";
import type { ToolDef } from "../tools/types.js";
import type { AciCatalog, AciToolDef } from "./types.js";
import { RegistryConstructionError } from "../errors.js";

export interface AciRegistry {
  /** 冻结协议 registry（交给 createExecutor）。 */
  readonly inner: RegistryImpl;
  readonly catalog: AciCatalog;
  /** 动态追加 MCP 扩展源工具，不改变 inner 的构造期快照。 */
  readonly registerExternal: (defs: ReadonlyArray<AciToolDef>) => void;
  /**
   * 按名移除动态扩展源工具（reload 时先 unregister 再 register）。
   * 仅操作 externalByExt Map；不动 inner 冻结快照、不动 Gate2 防撞
   * （同名 register 仍报错）。未注册的名字静默忽略（幂等 — reload
   * 路径对陈旧 config 名不抛）。
   */
  readonly unregisterExternal: (names: ReadonlyArray<string>) => void;
  /**
   * 进 prompt 的集合：非 lazy 全量（注册序）+ 已发现 lazy（discovery 序
   * 尾部追加，保前缀稳定）。
   */
  readonly visibleSchemas: () => ReadonlyArray<ToolDef>;
  /** 延迟加载：按需检索某工具 schema（含 lazy 的），未注册返回 undefined。 */
  readonly discover: (name: string) => ToolDef | undefined;
}

/**
 * 构造 ACI registry：
 *   - inner = createRegistry(tools)（协议 registry，交给 createExecutor）；
 *   - catalog 持有 AciToolDef 全量（权限层与延迟加载共用）；
 *   - visibleSchemas = 非 lazy 全量（注册序，逐位稳定）+ 已发现 lazy 按
 *     discovery 顺序尾部追加（尾部追加保 KV cache 前缀，#631）；discover()
 *     调用即标记，下一轮起进入 promptTools()
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
  const externalAjv = new Ajv.default({ strict: true, allErrors: true });
  addFormats.default(externalAjv);

  const byName = new Map<string, AciToolDef>();
  for (const t of tools) {
    byName.set(t.name, t);
  }
  const allList = Object.freeze([...tools]) as ReadonlyArray<AciToolDef>;
  const externalByExt = new Map<string, AciToolDef>();

  const catalog: AciCatalog = Object.freeze({
    get: (name: string) => byName.get(name) ?? externalByExt.get(name),
    all: () =>
      Object.freeze([
        ...allList,
        ...externalByExt.values(),
      ]) as ReadonlyArray<AciToolDef>,
  });

  const registerExternal = (defs: ReadonlyArray<AciToolDef>): void => {
    const pending = new Map<string, AciToolDef>();
    for (const def of defs) {
      if (!def.name.startsWith("mcp__")) {
        throw new RegistryConstructionError(
          `external tool name '${def.name}' must use mcp__ namespace`
        );
      }
      if (
        byName.has(def.name) ||
        externalByExt.has(def.name) ||
        pending.has(def.name)
      ) {
        throw new RegistryConstructionError(`duplicate tool name: ${def.name}`);
      }
      try {
        externalAjv.compile(def.inputSchema);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new RegistryConstructionError(
          `validator compile failed for ${def.name}: ${msg}`
        );
      }
      pending.set(def.name, def);
    }
    for (const [name, def] of pending) {
      externalByExt.set(name, def);
    }
  };

  // reload 缝：把外部工具按名撤回；不在此处跑 ajv 编译（已被
  // registerExternal 编译过）。catalog / visibleSchemas / discover
  // 都从 externalByExt live 读，因此删除后下游视图自动收敛。
  const unregisterExternal = (names: ReadonlyArray<string>): void => {
    for (const name of names) {
      externalByExt.delete(name);
    }
  };

  // #224 discovered set：本 run 内被检索过的工具名（闭包状态，不跨 session
  // 持久化）。discover() 命中时 add；visibleSchemas() = 非 lazy 全量（注册
  // 序，逐位稳定）+ 已发现的 lazy 按 discovery 顺序尾部追加。尾部追加而非
  // 插回注册序：相邻轮无新 discovery 时可见前缀逐位不变，保 KV cache 前缀
  // 命中（#631）。
  const discovered = new Set<string>();

  const visibleSchemas = (): ReadonlyArray<ToolDef> => {
    const all = [...tools, ...externalByExt.values()];
    const discoveredTail = [...discovered].flatMap((name) => {
      const def = byName.get(name) ?? externalByExt.get(name);
      return def !== undefined ? [def] : [];
    });
    // discovered 名单里的工具统一走尾部追加（含非 lazy 的已发现外部工具，
    // 防前缀段重复）；未发现的保持注册序过滤视图。
    const prefix = all.filter((t) => !t.aci.lazy && !discovered.has(t.name));
    return [...prefix, ...discoveredTail];
  };

  const discover = (name: string): ToolDef | undefined => {
    const hit = byName.get(name) ?? externalByExt.get(name);
    if (hit !== undefined) {
      discovered.add(name);
    }
    return hit;
  };

  return Object.freeze({
    inner,
    catalog,
    registerExternal,
    unregisterExternal,
    visibleSchemas,
    discover,
  });
}
