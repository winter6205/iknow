// `skill` 工具（第 22 件 ACI，#337 T5/T6）— 按名取已安装 skill 的正文。
//
// 行为真值（spec 337-skill-mcp-extension.md § Code Style + T6 acceptance）：
//   - input `{ name: string required }` —— 直呼命中已索引 skill 名；
//     叫错名返回引导文本（"Use skill_search to find available skills."）。
//   - output：装配正文（T6 起，frontmatter 剥离 + `Base directory` 行 +
//     `<skill_files>` 段（采样 ≤10 / 绝对路径 / sampled 提示；references/ 不递归））。
//     T5 阶段返回 SKILL.md 原文；T6 改走 `src/harness/skill/body.ts` 的
//     `createSkillBody({ entry, dir })`（SC6）。
//   - aci 元数据（G1 Q1 决策）：read-only / lazy:false / timeoutTier:fast。
//
// **依赖注入形态**：`createSkillTool(deps)` 收 catalog（装配层
// `createDefaultAciRegistry` 经由 `skillCatalog` opts 传入）。catalog 由
// T2 `createSkillCatalog(entries)` 创建；T5 阶段 catalog 缺席时（未到 T8
// 装配），本工厂仍可被测试与未来迁移路径调用。T8 装配时缺席即不注册。
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import type { SkillCatalog } from "../../skill/catalog.js";
import { createSkillBody } from "../../skill/body.js";

/**
 * 依赖注入：`catalog` 索引层（T2 提供），本工具经其
 * `get(name)` 拿 SkillEntry（body 装配模块吃 entry + dir）。
 */
export interface SkillToolDeps {
  readonly catalog: SkillCatalog;
}

/**
 * 工厂：createSkillTool(deps) — 直呼取 skill 正文（第 22 件）。
 *
 * 命中：createSkillBody({ entry, dir }) → 返回 frontmatter 剥离 + Base
 * directory 行 + `<skill_files>` 采样的装配正文。
 * 未命中：返回引导回检索的文本（不抛，向模型传达"用 skill_search 找"）。
 */
export function createSkillTool(deps: SkillToolDeps): AciToolDef {
  return Object.freeze({
    name: "skill",
    description:
      "Load the full body of a skill you've already chosen via skill_search; pair with skill_search first to pick the right name. Returns the assembled skill body (frontmatter stripped, `Base directory` line, sampled `<skill_files>`), or a hint pointing back to skill_search when the name is unknown.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async (
      input: unknown,
      _ctx?: ToolExecutionContext
    ): Promise<string> => {
      const name = parseName(input);
      const entry = deps.catalog.get(name);
      if (!entry) {
        return `skill '${name}' not found. Use skill_search to find available skills.`;
      }
      // T6: 装配正文 (frontmatter 剥离 + Base directory 行 + skill_files 段)。
      // entry.dir 即 SKILL.md 所在目录（catalog.getBodyPath 内部 join(dir, "SKILL.md")）。
      return await createSkillBody({ entry, dir: entry.dir });
    },
    aci: {
      category: "read-only",
      // T6 装配前无需 lazy;skill 工具常驻 prompt（T6 不改此项）。
      lazy: false,
      timeoutTier: "fast",
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
    } as const,
  });
}

/** 解析 name 字段；非 string / 缺字段 → 视为未命中(返回引导文本)。 */
function parseName(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "";
  }
  const raw = input as Record<string, unknown>;
  return typeof raw.name === "string" ? raw.name : "";
}
