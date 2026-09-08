// `skill` 工具（第 22 件 ACI，#337 T5/T6 + #disclosure-index-align T2）—
// 按名取已安装 skill 的正文。
//
// 行为真值（spec 337-skill-mcp-extension.md § Code Style + T6 acceptance +
// spec disclosure-index-align.md SC5/SC6）：
//   - input `{ name: string required }` —— 直呼命中已索引 skill 名；
//     叫错名返回引导文本，引导回 `<available_skills>` 清单
//     （system 段）或（操作员指路径时）`read_file`；**禁止**再提到
//     已删除的 `skill_search`（spec ADR-0046 / disclosure-index-align T2）。
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
import type { LiveTaskRoot } from "../../session-roots.js";
import { createSkillBody } from "../../skill/body.js";
import { writeSituation } from "../../isolation/write-situation.js";

/**
 * 依赖注入：`catalog` 索引层（T2 提供），本工具经其
 * `get(name)` 拿 SkillEntry（body 装配模块吃 entry + dir）。
 * `liveTaskRoot`（可选）：活 taskRoot cell —— handler 调用时机读快照传给
 * `createSkillBody`（specs/skill-load-write-root.md：skill() 与 slash /
 * hub 同一装配口，正文末尾带当前写根）。缺席 → 无 trailer（legacy parity）。
 * `isolationOn`（可选，T4）：worktree isolation 档（build-engine 装配期
 * 一次性读取的 `isolationEnabled`，与门禁武装同源）。与 `liveTaskRoot` 配
 * 对算 `writeSituation(isolationOn, currentRoot)`，决定 trailer 是 `writable_*`
 * 还是 ③ 态 `no_writable_root` 披露。缺席 → 默认 false（`writable_main`，
 * 旧形态 byte-equal）。
 */
export interface SkillToolDeps {
  readonly catalog: SkillCatalog;
  readonly liveTaskRoot?: LiveTaskRoot;
  readonly isolationOn?: boolean;
}

/**
 * 工厂：createSkillTool(deps) — 直呼取 skill 正文（第 22 件）。
 *
 * 命中：createSkillBody({ entry, dir }) → 返回 frontmatter 剥离 + Base
 * directory 行 + `<skill_files>` 采样的装配正文。
 * 未命中：返回引导文本（不抛，向模型传达"看 `<available_skills>` 清单
 * 或（操作员指路径时）用 `read_file`"）—— spec ADR-0046 删 `skill_search`
 * 后唯一的回退入口。
 */
export function createSkillTool(deps: SkillToolDeps): AciToolDef {
  return Object.freeze({
    name: "skill",
    description:
      "Load the full body of a skill by its exact name from the `<available_skills>` catalog. Returns the assembled skill body (frontmatter stripped, `Base directory` line, sampled `<skill_files>`). When the name is unknown, points back to the `<available_skills>` list in the system prompt or, for paths outside the assembly scan root, to `read_file`.",
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
        return `skill '${name}' not found. Pick the name from the \`<available_skills>\` list in the system prompt, or — if the operator pointed at a file path outside the scan root — use \`read_file\`.`;
      }
      // T6: 装配正文 (frontmatter 剥离 + Base directory 行 + skill_files 段)。
      // entry.dir 即 SKILL.md 所在目录（catalog.getBodyPath 内部 join(dir, "SKILL.md")）。
      // 写根 trailer（specs/skill-load-write-root.md + T4 write-situation-
      // disclosure）：handler 调用时机读活 cell 快照算处境枚举，再以双参
      // 形态传给 `createSkillBody`。cell 缺席 → 无 trailer（legacy parity）。
      const taskRoot = deps.liveTaskRoot?.read();
      return await createSkillBody({
        entry,
        dir: entry.dir,
        ...(taskRoot !== undefined
          ? {
              taskRoot,
              writeSituation: writeSituation(
                deps.isolationOn ?? false,
                taskRoot
              ),
            }
          : {}),
      });
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
