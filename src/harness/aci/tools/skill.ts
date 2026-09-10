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
//
// ADR-0079 — skill 正文不再挂写根 trailer（与 #337 SC6 形态逐字节一致）：
// write root 的披露走 worker prior + chat-session rebind 一次性通知，
// 共用 `writeRootSegment` helper；本工具的 `SkillToolDeps` 不再需要
// `liveTaskRoot` / `isolationOn`。
//
// **二次短路**（spec skill-body-short-circuit.md SC2/SC3/SC5/SC7）：
// 模型再调同名 `skill()` 且可见 messages 仍有该名成功全文（337 装配形态
// 双标记齐全的非 error tool_result）→ 只回短回执，不重装正文；compact 丢掉
// 该条后自然再灌全文（判据是快照，不是只增不减的会话 Set）。快照缺席
// fail-closed 灌全文。同波内两次同名：tool_result 尚未入史，wave map
// （turnId → 已装配名集合）兜住 —— 同波首次装配即预记，Promise.all 并发
// 下两个 handler 同步批启动，后启动者读到预记即短路。闸只罩 ACI `skill()`
// handler（slash / Web 不经此路径）。
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import type { AnthropicNativeMessage } from "../../model-adapter/types.js";
import type { SkillCatalog } from "../../skill/catalog.js";
import { createSkillBody, SKILL_BODY_MARKERS } from "../../skill/body.js";

/**
 * 依赖注入：`catalog` 索引层（T2 提供），本工具经其
 * `get(name)` 拿 SkillEntry（body 装配模块吃 entry + dir）。
 */
export interface SkillToolDeps {
  readonly catalog: SkillCatalog;
}

/**
 * 短回执字面量（SC2）：非空、语义含「已在可见上下文 / 勿再调 / 按先前正文
 * 执行」。刻意**不含** 337 双标记任一 —— 回执绝不能被 recognizer 误认成全文。
 */
const SHORT_CIRCUIT_RECEIPT =
  "Skill body already in context. Do not call `skill` again — use the body fed earlier.";

/**
 * 判定可见历史里是否已有 skill 名 `name` 的成功全文 tool_result
 * （skill-body-short-circuit spec「成功全文」判据）：
 * assistant `tool_use(name === "skill", input.name === name)` 的 id 存在
 * 后续 `tool_result(tool_use_id 匹配, is_error !== true)`，且结果文本同时含
 * 337 装配形态双标记。引导句 / 短回执不含双标记，天然不匹配。
 */
export function hasVisibleFullSkillBody(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  name: string
): boolean {
  // 先收集所有（tool_use_id, 名）→ 需要全文的 skill 调用 id。
  const wantedIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (
        block.type === "tool_use" &&
        block.name === "skill" &&
        (block.input as { name?: unknown } | null | undefined)?.name === name
      ) {
        wantedIds.add(block.id);
      }
    }
  }
  if (wantedIds.size === 0) return false;
  for (const message of messages) {
    for (const block of message.content) {
      if (
        block.type === "tool_result" &&
        wantedIds.has(block.tool_use_id) &&
        block.is_error !== true
      ) {
        const text = resultBlockText(block.content);
        if (
          text.includes(SKILL_BODY_MARKERS.baseDirectory) &&
          text.includes(SKILL_BODY_MARKERS.skillFilesClose)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/** tool_result content 投影成纯文本（string 直取；blocks 拼 text 段）。 */
function resultBlockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: string }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : ""
      )
      .join("\n");
  }
  return "";
}

/**
 * 工厂：createSkillTool(deps) — 直呼取 skill 正文（第 22 件）。
 *
 * 命中且可见历史已有成功全文 → 短回执；否则装配正文（frontmatter 剥离 +
 * Base directory 行 + `<skill_files>` 采样，与 #337 SC6 逐字节一致）。
 * 未命中：返回引导文本（不抛，向模型传达"看 `<available_skills>` 清单
 * 或（操作员指路径时）用 `read_file`"）—— spec ADR-0046 删 `skill_search`
 * 后唯一的回退入口。
 *
 * Wave map 权衡：keyed by turnId，跨 turn 残留无害（判据仍以 messages
 * 快照为准，map 只覆盖「同波 tool_result 未入史」窗口）；factory 闭包
 * 持有、不清理 —— 键空间 = 会话内真实使用过的 turnId 数，量级小。
 * 预记先于装配（同波 Promise.all 并发下第二个 handler 读不到未完成的
 * 第一个），装配抛错时回滚预记 —— 正文从未入史就不得谎称已加载
 * （S2 exception 类 fail-closed）。
 */
export function createSkillTool(deps: SkillToolDeps): AciToolDef {
  // SC7:本 factory（每会话装配一个）内的同波已装配名集合。
  const assembledByTurn = new Map<string, Set<string>>();
  return Object.freeze({
    name: "skill",
    description:
      "Load the full body of a skill by its exact name from the `<available_skills>` catalog. Returns the assembled skill body (frontmatter stripped, `Base directory` line, sampled `<skill_files>`). When the name is unknown, points back to the `<available_skills>` list in the system prompt or, for paths outside the assembly scan root, to `read_file`. If the skill body was already loaded and is still visible in the conversation, returns a short receipt instead.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async (
      input: unknown,
      ctx?: ToolExecutionContext
    ): Promise<string> => {
      const name = parseName(input);
      const entry = deps.catalog.get(name);
      if (!entry) {
        // 引导句不算已加载：不进 wave map，再调仍引导（SC5）。
        return `skill '${name}' not found. Pick the name from the \`<available_skills>\` list in the system prompt, or — if the operator pointed at a file path outside the scan root — use \`read_file\`.`;
      }
      const messages = ctx?.messages;
      if (messages !== undefined && hasVisibleFullSkillBody(messages, name)) {
        return SHORT_CIRCUIT_RECEIPT;
      }
      let waveSet: Set<string> | undefined;
      if (ctx?.turnId !== undefined) {
        if (assembledByTurn.get(ctx.turnId)?.has(name)) {
          return SHORT_CIRCUIT_RECEIPT;
        }
        // 预记（同步，先于装配）：同波 Promise.all 并发启动的第二个 handler
        // 在本 handler 尚未返回时就能读到 —— tool_result 入史前 wave map
        // 是唯一可见判据。
        waveSet = assembledByTurn.get(ctx.turnId) ?? new Set<string>();
        waveSet.add(name);
        assembledByTurn.set(ctx.turnId, waveSet);
      }
      // T6: 装配正文 (frontmatter 剥离 + Base directory 行 + skill_files 段)。
      // entry.dir 即 SKILL.md 所在目录（catalog.getBodyPath 内部 join(dir, "SKILL.md")）。
      // ADR-0079 — 不再追加写根 trailer。
      try {
        return await createSkillBody({ entry, dir: entry.dir });
      } catch (err) {
        // 装配失败 → 回滚预记（fail-closed）：第二次同名调用重装配或让
        // 错误显形，不假装已加载。
        waveSet?.delete(name);
        throw err;
      }
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
