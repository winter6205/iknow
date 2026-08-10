/**
 * `skill_search` 工具（第 23 件 ACI，#337 T5）— 按关键字检索已索引 skill 清单。
 *
 * 行为真值（spec 337-skill-mcp-extension.md § Code Style + T5 acceptance）：
 *   - input `{ query: string required }` —— 大小写不敏感子串匹配
 *     name/description。
 *   - output：每行 `JSON.stringify({name, description})` —— 仅显式两字段
 *     投影（不泄漏 aci 元数据 / handler / dir），对齐 tool_search wire 形态。
 *   - disabled 不出现（SC3）：catalog.search 已过滤 disabled，本工具不再做。
 *   - 空 query / 无匹配 → `"(no matches)"`(对齐 tool_search 语义)；
 *     handler 不抛，向模型传达"换关键词 / 直呼名"。
 *   - aci 元数据（G1 Q1 决策）：read-only / lazy:false / timeoutTier:fast。
 *
 * **依赖注入形态**：`createSkillSearchTool(deps)` 收 catalog；T8 装配期
 * 传入（catalog 由装配层在 build-engine 创建）。
 */
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import type { SkillCatalog } from "../../skill/catalog.js";

/** 无匹配 / 空 query 的合法返回（对齐 tool_search 契约）。 */
const NO_MATCHES = "(no matches)";

/**
 * 依赖注入：`catalog.search(query)` 已做大小写不敏感子串匹配 +
 * disabled/undocumented 过滤（T2 catalog SSOT），本工具不再做二次过滤。
 */
export interface SkillSearchToolDeps {
  readonly catalog: SkillCatalog;
}

/**
 * 工厂：createSkillSearchTool(deps) — skill 检索（第 23 件）。
 *
 * 返回的 AciToolDef 满足：
 *   - name === "skill_search"
 *   - inputSchema: `{ query: string required, additionalProperties:false }`
 *   - aci 元数据：read-only / lazy:false / timeoutTier:fast
 */
export function createSkillSearchTool(deps: SkillSearchToolDeps): AciToolDef {
  return Object.freeze({
    name: "skill_search",
    description:
      "Search installed skills by keyword (case-insensitive substring on name/description). Returns one JSON object {name, description} per line; returns '(no matches)' when nothing matches. Disabled and undocumented skills are excluded.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    handler: (input: unknown, _ctx?: ToolExecutionContext): string => {
      const query = parseQuery(input);
      if (query.length === 0) return NO_MATCHES;
      const hits = deps.catalog.search(query);
      if (hits.length === 0) return NO_MATCHES;
      return hits
        .map((s) =>
          JSON.stringify({ name: s.name, description: s.description })
        )
        .join("\n");
    },
    aci: {
      category: "read-only",
      // T6 装配前无需 lazy;skill_search 常驻 prompt（T6 不改此项）。
      lazy: false,
      timeoutTier: "fast",
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
    } as const,
  });
}

/** 解析 query 字段；非 string / 缺字段 → 空串(handler 走 NO_MATCHES)。 */
function parseQuery(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "";
  }
  const raw = input as Record<string, unknown>;
  return typeof raw.query === "string" ? raw.query : "";
}
