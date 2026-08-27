/**
 * tool_search 工具（ACI 第 9 件，#224 工具扩展之路）：按名/子串检索已注册
 * 工具并返回完整 ToolDef JSON。
 *
 * 行为真值：spec 224-tool-extension-path.md § Code Style：
 *   - 输入 `query`（名字/描述大小写不敏感子串，**trim 后**判空）或 `names`
 *     （精确工具名列表），两字段均可选；"至少一个" 语义由 handler 入口判定
 *     —— 空参 / 空白-only `query` = `"(no matches) Rephrase ..."`（合法返回，
 *     非错误；带换词引导），不交给 ajv（D9）。
 *   - 匹配 = 遍历 catalog.all()：`names` 非空 → 精确名 includes；否则 →
 *     name/description 子串 contains（大小写不敏感）。
 *   - 命中后逐名调 `getRegistry().discover(name)` 副作用：标记被检索过的
 *     lazy 工具从下一轮起进入 promptTools()（引擎消费 discovered set）。
 *     discover 与输出同界 —— 被封顶丢弃的命中不进 discovered set。
 *   - wire 形态（D6）：每行一个 JSON，显式三字段投影
 *     `{ name, description, inputSchema }` —— 不把 `aci` 元数据或 handler
 *     泄漏进 wire JSON（契约 Y1 plain-string 守门）。
 *   - 有界输出：可选 `limit`（默认 20，上界 100，非法值由 ajv 拒收）+ 字符
 *     自限（`OUTPUT_SELF_CAP`）。超出部分**整行**丢弃（每行永远可 JSON.parse），
 *     并追加一条纯文本引导行。契约 X：executor 仍是截断唯一权威，本工具输出
 *     少于封顶是遵守而非绕开（spec 224:172），引导行是 plain data 而非
 *     truncated/total 元字段（spec 224:208）—— 复用 `NO_MATCHES` 非 JSON 行
 *     的 S5 carve-out 先例。
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
  readonly limit?: unknown;
}

/**
 * 无匹配 / 空参的合法返回：缺参 = 无结果。
 * T3：沿用 `skill.ts` "Use skill_search to find available skills." 先例 ——
 * 返回不是裸标记,而是带换词引导（换词重搜 / `names` 精确取名）。
 */
export const NO_MATCHES =
  "(no matches) Rephrase `query` with a different keyword, or pass exact tool names via `names`.";

/** 缺省命中条数封顶；显式 `limit` 覆盖，上界 MAX_LIMIT。 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * 字符自限阈值，镜像 `tools/executor.ts` 的 OUTPUT_HARD_CAP（20000）。
 * 契约 X：executor 是截断唯一权威；本工具自限坐在其之下，让 executor 的
 * 兜底截断在本工具输出上恒为 no-op（`memory/tools/recall.ts` 同形先例）。
 */
const OUTPUT_SELF_CAP = 20_000;

/**
 * 工厂：createToolSearchTool(deps) — 工具检索工具（第 9 件）。
 *
 * 返回的 AciToolDef 满足：
 *   - name === "tool_search"
 *   - inputSchema: { query? 子串 + names? 精确名 + limit? 条数封顶 }，均可选，
 *     additionalProperties:false
 *   - aci 元数据：read-only / concurrency-safe / cancel / fast tier
 */
export function createToolSearchTool(deps: ToolSearchDeps): AciToolDef {
  const handler = (input: unknown, _ctx?: ToolExecutionContext): string => {
    const { query, names, limit } = (input ?? {}) as ToolSearchInput;
    const q = typeof query === "string" ? query.trim() : "";
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

    const kept = takeWithinBudget(matches, resolveLimit(limit));

    // 副作用：标记被检索工具为 discovered（lazy 工具从下一轮进 promptTools）。
    // 只覆盖真正输出的命中 —— 模型没看到的工具不该占下一轮 prompt 预算。
    for (const m of kept) {
      registry.discover(m.name);
    }

    const lines = kept.map(projectLine);
    if (kept.length === matches.length) return lines.join("\n");
    return [...lines, guidanceLine(kept.length, matches.length)].join("\n");
  };

  return Object.freeze({
    name: "tool_search",
    description:
      "Discover tools beyond the current prompt — search scope covers all registered tools, including `mcp__`-prefixed MCP tools. Search first, then use: pass `query` (case-insensitive substring on tool name / description) or `names` (exact list) to pull ToolDef JSON. Returns one JSON object per line `(name, description, inputSchema)`, at most `limit` hits (default 20, max 100) plus a trailing plain-text line when hits are left out; empty or whitespace-only input, or no match → `(no matches)` with guidance to rephrase `query` or pass exact `names`. Side effect: marks returned tools as discovered so they surface in the next prompt.",
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
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          default: DEFAULT_LIMIT,
          description: "max hits to return (default 20)",
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

/** wire 形态（D6）：显式三字段投影，不泄漏 aci 元数据 / handler。 */
function projectLine(t: AciToolDef): string {
  return JSON.stringify({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  });
}

/**
 * 封顶引导行（纯文本，非 JSON —— S5 line-parseable carve-out 先例同
 * `NO_MATCHES`）。只报 plain data，不带 truncated/total 元字段（契约 X）。
 */
function guidanceLine(shown: number, matched: number): string {
  return `(showing ${shown} of ${matched} matches) Narrow \`query\`, pass exact tool names via \`names\`, or raise \`limit\` (max ${MAX_LIMIT}).`;
}

/**
 * ajv 是 `limit` 的拒收层（0 / 负数 / 非整数在 schema 层被拒）；handler 侧
 * 只做宽松兜底（直调 handler 的非法值退回缺省），不新增失败路径。
 */
function resolveLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(value, MAX_LIMIT);
}

/**
 * 有界投影：按条数封顶 + 字符预算取前缀，整行丢弃（永不吐半行 JSON）。
 * 预算里预留引导行长度，保证含引导行的总输出仍 ≤ OUTPUT_SELF_CAP。
 */
function takeWithinBudget(
  matches: ReadonlyArray<AciToolDef>,
  limit: number
): ReadonlyArray<AciToolDef> {
  // 预留按 shown = matched 估（shown ≤ matched，位数不会更多）。
  const reserve = guidanceLine(matches.length, matches.length).length + 1;
  const kept: AciToolDef[] = [];
  let used = 0;
  for (const t of matches) {
    if (kept.length >= limit) break;
    const next = used + projectLine(t).length + (kept.length > 0 ? 1 : 0);
    if (next + reserve > OUTPUT_SELF_CAP) break;
    kept.push(t);
    used = next;
  }
  return kept;
}

/** 解引用已装配 registry；装配未完成 → 抛 ToolExecutionError（fail-fast）。 */
function resolveRegistry(deps: ToolSearchDeps): AciRegistry {
  const reg = deps.getRegistry();
  if (!reg) {
    throw new ToolExecutionError("tool_search: registry not assembled");
  }
  return reg;
}
