/**
 * tool_search 工具（ACI 第 9 件，#224 工具扩展之路）：按名/子串检索已注册
 * 工具并返回完整 ToolDef JSON。
 *
 * 行为真值：spec 224-tool-extension-path.md § Code Style（与 OpenHarness
 * tool_search 同语义，非移植）：
 *   - 输入 `query`（名字/描述大小写不敏感子串）或 `names`（精确工具名列表），
 *     两字段均可选；"至少一个" 语义由 handler 入口判定 —— 空参 =
 *     `"(no matches)"`（合法返回，非错误），不交给 ajv（D9）。
 *   - 匹配 = 遍历 catalog.all()：`names` 非空 → 精确名 includes；否则 →
 *     name/description 子串 contains（大小写不敏感）。
 *   - 命中后逐名调 `getRegistry().discover(name)` 副作用：标记被检索过的
 *     lazy 工具从下一轮起进入 promptTools()（引擎消费 discovered set）。
 *   - wire 形态（D6）：每行一个 JSON，显式三字段投影
 *     `{ name, description, inputSchema }` —— 不把 `aci` 元数据或 handler
 *     泄漏进 wire JSON（契约 Y1 plain-string 守门）。
 *
 * **依赖注入形态（lazy self-reference）**：tool_search 需要的是"已装配完成的
 * registry 的 catalog（检索对象）+ discover（标记副作用）"。由于 registry
 * 本身包含 tool_search，直接持有 registry 引用会造成自引用循环，故 deps 收
 * `getRegistry: () => AciRegistry` 惰性闭包 —— 装配期只存函数，调用期（模型
 * 实际 tool_search 时）才解引用，此时 createDefaultAciRegistry 已把
 * `assembled.reg` 赋值完毕。装配未完成即被调用 → 抛 ToolExecutionError
 * （fail-fast，不静默）。
 *
 * ACI 元数据（D8）：read-only / concurrency-safe / cancel / fast tier（5s，
 * 纯内存 catalog 扫描）。**不显式设 lazy**（默认 false；自举守卫是 fail-safe
 * —— 本期零工具 lazy，tool_search 常驻 prompt）。
 */

import type { AciToolDef } from "../types.js";
import type { AciRegistry } from "../aci-registry.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";

/**
 * 依赖注入：`getRegistry` 惰性解引用已装配 registry。
 * 装配完成前调用 → 抛 ToolExecutionError（自引用循环的 fail-fast）。
 */
export interface ToolSearchDeps {
  readonly getRegistry: () => AciRegistry;
}

interface ToolSearchInput {
  readonly query?: unknown;
  readonly names?: unknown;
}

/** 无匹配 / 空参的合法返回（与 OpenHarness 同语义：缺参 = 无结果）。 */
const NO_MATCHES = "(no matches)";

/**
 * 工厂：createToolSearchTool(deps) — 工具检索工具（第 9 件）。
 *
 * 返回的 AciToolDef 满足：
 *   - name === "tool_search"
 *   - inputSchema: { query? 子串 + names? 精确名 }，均可选，additionalProperties:false
 *   - aci 元数据：read-only / concurrency-safe / cancel / fast tier
 */
export function createToolSearchTool(deps: ToolSearchDeps): AciToolDef {
  const handler = (input: unknown, _ctx?: ToolExecutionContext): string => {
    const { query, names } = (input ?? {}) as ToolSearchInput;
    const q = typeof query === "string" ? query : "";
    const nameList = Array.isArray(names) ? names : [];

    // "至少一个" 语义：query 非空字符串 或 names 非空数组，否则无结果。
    if (q.length === 0 && nameList.length === 0) {
      return NO_MATCHES;
    }

    const registry = resolveRegistry(deps);
    const all = registry.catalog.all();

    const matches =
      nameList.length > 0
        ? all.filter((t) => nameList.includes(t.name))
        : (() => {
            const norm = q.toLowerCase();
            return all.filter(
              (t) =>
                t.name.toLowerCase().includes(norm) ||
                t.description.toLowerCase().includes(norm)
            );
          })();

    if (matches.length === 0) {
      return NO_MATCHES;
    }

    // 副作用：标记被检索工具为 discovered（lazy 工具从下一轮进 promptTools）。
    for (const m of matches) {
      registry.discover(m.name);
    }

    // wire 形态（D6）：显式三字段投影，不泄漏 aci 元数据 / handler。
    return matches
      .map((t) =>
        JSON.stringify({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })
      )
      .join("\n");
  };

  return Object.freeze({
    name: "tool_search",
    description:
      "Discover tools beyond the current prompt — pass `query` (case-insensitive substring on tool name / description) or `names` (exact list) to pull ToolDef JSON. Returns one JSON object per line `(name, description, inputSchema)`; empty input or no match → `(no matches)`. Side effect: marks retrieved tools as discovered so they surface in the next prompt.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description:
            "case-insensitive substring matched against tool name and description",
        },
        names: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "exact tool names to retrieve",
        },
      },
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
      // lazy 不显式设（默认 false）—— tool_search 常驻 prompt，自举守卫兜底。
    },
  });
}

/** 解引用已装配 registry；装配未完成 → 抛 ToolExecutionError（fail-fast）。 */
function resolveRegistry(deps: ToolSearchDeps): AciRegistry {
  const reg = deps.getRegistry();
  if (!reg) {
    throw new ToolExecutionError("tool_search: registry not assembled");
  }
  return reg;
}
