/**
 * src/tui/slash.ts
 *
 * #146 TUI 自建 slash 词表（SC 12：不复用 chat 的 processChatLine）。
 * 词表 6 条（Q3/Q5c 裁决）：/sessions /new /quit /exit /help /info。
 * `/reset` 不在词表内即天然不可达（Q5c 废除）。
 *
 * 解析规则：输入 trim 后以 "/" 开头先过词表；未命中 → unknown（UI 提示）；
 * 不以 "/" 开头 → message（普通消息）。
 *
 * Tab 补全 + 候选提示词（live filtering）：
 *  - slashSuggestions：按当前输入前缀过滤并保持词表原顺序。
 *  - slashComplete：唯一匹配 → `/{cmd} `；0 或 ≥2 匹配 → null。
 *  - slashHintLines：渲染用一行短描述，便于在输入框下方紧凑展示。
 */

export type TuiSlashCommand =
  "sessions" | "new" | "quit" | "exit" | "help" | "info" | "thinking";

export type SlashParseResult =
  | { kind: "command"; command: TuiSlashCommand }
  | { kind: "unknown"; raw: string }
  | { kind: "message"; text: string };

const VOCABULARY: ReadonlySet<string> = new Set<TuiSlashCommand>([
  "sessions",
  "new",
  "quit",
  "exit",
  "help",
  "info",
  "thinking",
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

/** /help 词表文案（无 emoji；中文与仓库 usage 文案风格一致）。 */
export function helpLines(): ReadonlyArray<string> {
  return [
    "/sessions  打开会话列表（↑↓ 选择，Enter 打开，Esc 返回）",
    "/new       新建会话",
    "/info      当前会话元信息",
    "/help      本词表",
    "/thinking  切换思考过程折叠",
    "/quit      退出（别名 /exit）",
    "Ctrl+C     打断前台运行中的 turn",
  ];
}

/** 一行短描述（用于输入框下方紧凑提示）。 */
const HINT_DESCRIPTIONS: Record<TuiSlashCommand, string> = {
  sessions: "打开会话列表",
  new: "新建会话",
  info: "当前会话元信息",
  help: "本词表",
  thinking: "切换思考过程折叠",
  quit: "退出（别名 /exit）",
  exit: "同 /quit",
};

export interface SlashHintLine {
  readonly command: TuiSlashCommand;
  readonly description: string;
}

/**
 * 给定当前输入，返回所有匹配前缀的候选命令（按词表原顺序）。
 * 空 / 非 "/" 开头 / 未命中 → 空数组。
 */
export function slashSuggestions(
  input: string
): ReadonlyArray<TuiSlashCommand> {
  const text = input.trim();
  if (!text.startsWith("/")) return [];
  const head = text.slice(1).split(/\s+/, 1)[0] ?? "";
  const prefix = head.toLowerCase();
  const out: TuiSlashCommand[] = [];
  for (const cmd of VOCABULARY) {
    if (cmd.startsWith(prefix)) out.push(cmd as TuiSlashCommand);
  }
  return out;
}

/**
 * 给定当前输入，给出一个 Tab 补全候选：唯一匹配 → `/{cmd} `（带尾随空格 +
 * 小写），0 或 ≥2 匹配 → null（让候选 UI 自然展示）。
 */
export function slashComplete(input: string): string | null {
  const matches = slashSuggestions(input);
  if (matches.length !== 1) return null;
  const cmd = matches[0]!;
  return `/${cmd} `;
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
