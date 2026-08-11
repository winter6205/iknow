/**
 * src/tui/slash.ts
 *
 * #343 T6-A 迁移：从 archive/tui-ink/src/slash.ts 迁回 src/tui/。逻辑与原版
 * 一致（#146 TUI 自建 slash 词表 + 解析 + Tab 补全 + hint 行）；仅文件头注释
 * 更新为本次迁移说明。纯 TS 模块，无 ink / OpenTUI 依赖。
 *
 * 词表 9 条：/sessions /new /quit /exit /help /info /thinking /profile /compact。
 * /reset 不在词表内即天然不可达（Q5c 废除）。
 *
 * 解析规则：输入 trim 后以 "/" 开头先过词表；未命中 → unknown（UI 提示）；
 * 不以 "/" 开头 → message（普通消息）。
 *
 * Tab 补全 + 候选提示词（live filtering）：
 *  - slashSuggestions：按当前输入前缀过滤并保持词表原顺序。
 *  - slashComplete：唯一匹配 → `/{cmd} `；0 或 ≥2 匹配 → null。
 *  - slashHintLines：渲染用一行短描述，便于在输入框下方紧凑展示。
 *
 * #337 Phase C（slash 扩展 + skill 加载发送）：
 *  - 判别联合 `SlashCandidate` = 静态命令 | skill（Phase D 复用）；
 *  - `slashSuggestions(input, skills?)` 混显静态命令（词表前缀过滤，保持在前）
 *    与 skill 名（大小写不敏感前缀过滤，在后）——确定性顺序；
 *  - `slashComplete(input, skills?)` 跨「静态命令 + skill」唯一匹配补全；
 *  - `parseSkillLoad(raw, skills)` 精确命中 skill 名 → {name, remainder}，
 *    命中静态命令 / 不匹配 → undefined（静态命令优先）。发送语义见 app.tsx。
 *    SkillEntryLike = {name, description?} 最小投影，slash.ts 不依赖 harness
 *    catalog 类型（解耦，便于单测注入扁平对象）。
 */

export type TuiSlashCommand =
  | "sessions"
  | "new"
  | "quit"
  | "exit"
  | "help"
  | "info"
  | "thinking"
  | "profile"
  | "compact";

export type SlashParseResult =
  | { kind: "command"; command: TuiSlashCommand }
  | { kind: "unknown"; raw: string }
  | { kind: "message"; text: string };

/** skill 最小投影（避免 slash.ts 强依赖 harness catalog 类型；调用方传入
 *  skillCatalog.available() 同形扁平对象即可）。 */
export interface SkillEntryLike {
  readonly name: string;
  readonly description?: string;
}

/** slash 候选判别联合：静态命令 | skill（Phase C 引入，Phase D 复用）。
 *  顺序约定：静态命令在前、skill 在后（slashSuggestions 确定性输出）。 */
export type SlashCandidate =
  | { kind: "command"; command: TuiSlashCommand }
  | { kind: "skill"; name: string; description?: string };

const VOCABULARY: ReadonlySet<string> = new Set<TuiSlashCommand>([
  "sessions",
  "new",
  "quit",
  "exit",
  "help",
  "info",
  "thinking",
  "profile",
  "compact",
]);

/** 解析输入框内容；空/纯空白 → message（调用方按空输入忽略）。 */
export function parseTuiInput(raw: string): SlashParseResult {
  const text = raw.trim();
  if (!text.startsWith("/")) return { kind: "message", text };
  const head = text.split(/\s+/, 1)[0] ?? text;
  const name = head.slice(1).toLowerCase();
  if (VOCABULARY.has(name)) {
    return { kind: "command", command: name as TuiSlashCommand };
  }
  return { kind: "unknown", raw: text };
}

/** /help 词表文案（无 emoji；中文与仓库 usage 文案风格一致）。
 *  #337 Phase C：/mcp 占位描述 + `/<skill-name>  加载技能`（Phase D 若未接
 *  /mcp，此处先作占位文案；skill 名由调用方动态拼入，不参与静态词表）。 */
export function helpLines(
  skillNames?: ReadonlyArray<string>
): ReadonlyArray<string> {
  const skillLines =
    skillNames !== undefined && skillNames.length > 0
      ? skillNames.map((name) => `/${name}  加载技能`)
      : [];
  return [
    "/sessions  打开会话列表（↑↓ 选择，Enter 打开，Esc 返回）",
    "/new       新建会话",
    "/info      当前会话元信息",
    "/help      本词表",
    "/thinking  切换思考过程折叠/展开",
    "/profile   标记首启引导完成（先在外侧填好 ~/.iknow/user.md）",
    "/compact   压缩上下文（保留尾部，裁剪早期消息）",
    "/mcp       查看/重载 MCP 服务器连接状态（Phase D 接线）",
    "/quit      退出（别名 /exit）",
    ...skillLines,
    "Ctrl+C     打断前台运行中的 turn",
    "Ctrl+O     展示思考内容（只展开；折叠回 /thinking）",
    "鼠标拖选    选中文本 → 右键复制到剪贴板",
  ];
}

/** 一行短描述（用于输入框下方紧凑提示）。 */
const HINT_DESCRIPTIONS: Record<TuiSlashCommand, string> = {
  sessions: "打开会话列表",
  new: "新建会话",
  info: "当前会话元信息",
  help: "本词表",
  thinking: "切换思考过程折叠/展开",
  profile: "标记首启引导完成",
  compact: "压缩上下文",
  quit: "退出（别名 /exit）",
  exit: "同 /quit",
};

export interface SlashHintLine {
  readonly command: TuiSlashCommand;
  readonly description: string;
}

/** 首 token 的小写前缀（`/xxx...` → `xxx`；空 / 非 "/" 开头 → ""）。 */
function slashPrefix(text: string): string {
  if (!text.startsWith("/")) return "";
  return (text.slice(1).split(/\s+/, 1)[0] ?? "").toLowerCase();
}

/**
 * 给定当前输入，返回所有匹配前缀的候选（静态命令在前、skill 在后，确定性
 * 顺序）。skill 名匹配为大小写不敏感前缀过滤。空 / 非 "/" 开头 / 未命中
 * → 空数组。静态命令仍按词表原顺序（slashHintLines 等既有契约不变）。
 */
export function slashSuggestions(
  input: string,
  skills?: ReadonlyArray<SkillEntryLike>
): ReadonlyArray<SlashCandidate> {
  const text = input.trim();
  if (!text.startsWith("/")) return [];
  const prefix = slashPrefix(text);
  const out: SlashCandidate[] = [];
  for (const cmd of VOCABULARY) {
    // 空前缀（输入恰为 "/"）→ 全部命令（cmd.startsWith("") 恒真）。
    if (cmd.startsWith(prefix)) {
      out.push({ kind: "command", command: cmd as TuiSlashCommand });
    }
  }
  if (skills !== undefined) {
    for (const skill of skills) {
      if (skill.name.toLowerCase().startsWith(prefix)) {
        out.push({
          kind: "skill",
          name: skill.name,
          description: skill.description,
        });
      }
    }
  }
  return out;
}

/**
 * 给定当前输入，给出一个 Tab 补全候选：跨「静态命令 + skill」唯一匹配 →
 * `/{cmd} ` / `/{skillName} `（带尾随空格；skill 名可能有连字符/点，无需
 * 转义），0 或 ≥2 匹配 → null（让候选 UI 自然展示）。
 */
export function slashComplete(
  input: string,
  skills?: ReadonlyArray<SkillEntryLike>
): string | null {
  const matches = slashSuggestions(input, skills);
  if (matches.length !== 1) return null;
  const only = matches[0]!;
  return only.kind === "command" ? `/${only.command} ` : `/${only.name} `;
}

/**
 * #337 Phase C：`/skill-name [提示词]` 解析。
 * 输入 trim 后以 "/" 开头，首 token `/xxx` 中 `xxx` **精确命中** skill 名 →
 * 返回 `{ name, remainder }`（remainder = 去掉首 token 后的剩余部分，可能
 * 为空）。命中静态 slash 命令 / 不匹配 → undefined（静态命令优先，C1 语义）。
 * 与 parseTuiInput 的 command/unknown/message 判别正交：skill 名不属于静态
 * 词表，parseTuiInput 只会把它判为 unknown——调用方在 parseTuiInput **之前**
 * 先调本函数分流。
 */
export function parseSkillLoad(
  raw: string,
  skills: ReadonlyArray<SkillEntryLike>
): { name: string; remainder: string } | undefined {
  const text = raw.trim();
  const prefix = slashPrefix(text);
  if (prefix === "") return undefined;
  if (VOCABULARY.has(prefix)) return undefined;
  for (const skill of skills) {
    // 精确命中 skill 名（大小写不敏感，与 slashSuggestions 前缀过滤同语义；
    // 返回原始 skill.name 作为 name，保留声明大小写）。
    if (skill.name.toLowerCase() === prefix) {
      const rest = text.slice(text.indexOf("/") + 1 + skill.name.length).trim();
      return { name: skill.name, remainder: rest };
    }
  }
  return undefined;
}

/**
 * 任务 B：按候选列表 + 选中索引补全（PromptInput 内部 hintCursor 用）。
 * cursor 越界 / suggestions 为空 → null。返回 `/{cmd} ` 形式与
 * slashComplete 一致，调用方可直接覆盖 inputValue。
 */
export function slashCompleteFromList(
  suggestions: ReadonlyArray<TuiSlashCommand>,
  cursor: number
): string | null {
  if (suggestions.length === 0) return null;
  if (cursor < 0 || cursor >= suggestions.length) return null;
  const cmd = suggestions[cursor]!;
  return `/${cmd} `;
}

/** #337 Phase C：SlashCandidate 版按 cursor 补全（静态命令 | skill 通用）。
 *  语义与 slashCompleteFromList 一致；skill 名原样保留（含连字符/点）。 */
export function slashCompleteFromCandidates(
  suggestions: ReadonlyArray<SlashCandidate>,
  cursor: number
): string | null {
  if (suggestions.length === 0) return null;
  if (cursor < 0 || cursor >= suggestions.length) return null;
  const candidate = suggestions[cursor]!;
  return candidate.kind === "command"
    ? `/${candidate.command} `
    : `/${candidate.name} `;
}

/** 给候选生成一行短描述的「补全提示行」（调用方负责渲染）。 */
export function slashHintLines(
  suggestions: ReadonlyArray<TuiSlashCommand>
): ReadonlyArray<SlashHintLine> {
  const desc = HINT_DESCRIPTIONS satisfies Record<TuiSlashCommand, string>;
  return suggestions.map((command) => ({
    command,
    description: desc[command],
  }));
}

/**
 * 任务 B：暴露候选短描述（PromptInput 内部渲染 hint 时用；保持外部
 * 调用方仍可走 slashHintLines 自渲）。
 */
export const SLASH_HINT_DESCRIPTIONS: Readonly<
  Record<TuiSlashCommand, string>
> = HINT_DESCRIPTIONS;
