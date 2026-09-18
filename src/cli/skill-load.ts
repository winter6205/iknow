/**
 * src/cli/skill-load.ts
 *
 * CLI 人侧 skill-load 面（spec skill-index-increment T3）：CLI 与 TUI / Web
 * 共用**同一 slash 入口语义** —— 可加载技能全集（含无 description、含
 * `disable-model-invocation`）、catalog 解析、remainder 按输入 token 长度、
 * 静态词表优先、agents 不进 slash。
 *
 * 与 TUI 的关系：TUI 的 `src/tui/slash.ts::parseSkillLoad` 是同语义实现，
 * 但 `src/cli` 与 `src/tui` 是并列 host，不互相 import（架构分层：两者都
 * 是宿主面，谁 import 谁都会造出假依赖）。本模块只依赖纯函数面
 * （`harness/skill/body.ts` 的装配 SSOT + 极小的解析/投影），不依赖 readline
 * / React / OpenTUI，可被 chat-session 与测试直接消费。
 *
 * 信封形态单点在 `buildSkillLoadText`（src/harness/skill/body.ts）—— 本模块
 * 不自行拼字符串，三入口（TUI / Web / CLI）byte 级一致由该函数保证。
 */
import { buildSkillLoadText, createSkillBody } from "../harness/skill/body.js";
import {
  projectSlashEntries,
  slashHeadPrefix,
  slashTailRemainder,
} from "../harness/skill/catalog.js";
import type { SkillCatalog, SkillEntry } from "../harness/skill/catalog.js";

/**
 * skill 最小投影（与 TUI `SkillEntryLike` 同形 —— 两个 host 各自持有本地
 * 类型，解耦 slash 解析与 harness catalog 类型）。
 *
 * `aliases` 是插件技能的**唯一**裸名别名（catalog 已丢冲突者）；调用方从
 * catalog 投影后塞入。本模块只消费，不自行拆 `:`（spec
 * tui-skill-slash-catalog invariant 1）。
 */
export interface CliSkillEntryLike {
  readonly name: string;
  readonly description?: string;
  readonly aliases?: ReadonlyArray<string>;
}

/**
 * CLI 静态词表（与 `src/cli/slash.ts` 的 `applySlashCommand` 分派表同源）。
 * 这里只列**命令名**用于「静态优先」判定 —— 值论文案不进本模块（那是
 * slash.ts 的 HELP_TEXT / 各 apply* 的职责）。
 *
 * 不 import `src/cli/slash.ts` 的 switch：那是 dispatch 实现，不是可判定的
 * 名集；从 switch 反推名字集会在未来新增命令时静默漏判。本集合是显式
 * 声明，新增 CLI 命令时**必须**同步（测试 `静态词表优先` 钉住该契约）。
 */
export const CLI_STATIC_COMMANDS: ReadonlySet<string> = new Set([
  "help",
  "?",
  "status",
  "quit",
  "exit",
  "json",
  "reset",
  "continue",
  "permissions",
  "graph",
  "config",
  "goal",
]);

/** 首 token 小写形（`/Echo` 与 `/echo` 同判）。算法 SSOT 在 harness
 *  （`slashHeadPrefix`）；本名是 CLI 宿主的既有出口（tests 消费）。 */
export function slashPrefix(text: string): string {
  return slashHeadPrefix(text);
}

/**
 * remainder = 首 token 之后的剩余段（trim）。**按 typed token 长度切** ——
 * 用 `skill.name.length` 会在裸名输入里吃掉 remainder 前缀（spec SC9 明令
 * 禁止）。算法 SSOT 在 harness（`slashTailRemainder`）。
 */
export function slashRemainder(raw: string): string {
  return slashTailRemainder(raw);
}

/** 可匹配的全部首 token 小写形：规范名 + 唯一裸名别名。 */
function headLowers(skill: CliSkillEntryLike): ReadonlyArray<string> {
  return [skill.name, ...(skill.aliases ?? [])].map((head) =>
    head.toLowerCase()
  );
}

/**
 * 精确命中技能名 → `{name, remainder}`；静态词表命中 / 未命中 → undefined。
 *
 * `name` 恒返回**规范名**（catalog entry 的 `name`），不是用户 typed 的裸名
 * —— 后续 `catalog.get` / 落盘信封都据此收敛到同一形态。
 */
export function parseSkillLoad(
  raw: string,
  skills: ReadonlyArray<CliSkillEntryLike>
): { name: string; remainder: string } | undefined {
  const text = raw.trim();
  const prefix = slashPrefix(text);
  if (prefix === "") return undefined;
  if (CLI_STATIC_COMMANDS.has(prefix)) return undefined;
  for (const skill of skills) {
    if (headLowers(skill).includes(prefix)) {
      return { name: skill.name, remainder: slashRemainder(text) };
    }
  }
  return undefined;
}

/**
 * catalog 投影：可加载技能面 + **唯一裸名别名**。算法本体收敛在 harness
 * （`projectSlashEntries` —— plan T3「harness 可复用的 slash 投影」，TUI /
 * CLI / hub 同一实现）；本函数只保留 CLI 宿主的名字与形状。
 */
export function toCliSkillEntries(
  catalog: SkillCatalog
): ReadonlyArray<CliSkillEntryLike> {
  return projectSlashEntries(catalog);
}

/**
 * 装配一条 skill-load 发送文本。`entry === undefined`（catalog miss）→
 * `undefined`；正文读失败向上抛（不吞 —— 与 TUI / hub 同档：读盘失败是
 * 真实故障，不伪装成成功）。
 */
export async function buildCliSkillLoad(opts: {
  readonly name: string;
  readonly remainder: string;
  readonly entry: SkillEntry;
}): Promise<string> {
  const { name, remainder, entry } = opts;
  const body = await createSkillBody({ entry, dir: entry.dir });
  return buildSkillLoadText(
    name,
    body,
    remainder.length > 0 ? remainder : undefined
  );
}
