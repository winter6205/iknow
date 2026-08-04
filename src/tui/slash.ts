/**
 * src/tui/slash.ts
 *
 * #146 TUI 自建 slash 词表（SC 12：不复用 chat 的 processChatLine）。
 * 词表 6 条（Q3/Q5c 裁决）：/sessions /new /quit /exit /help /info。
 * `/reset` 不在词表内即天然不可达（Q5c 废除）。
 *
 * 解析规则：输入 trim 后以 "/" 开头先过词表；未命中 → unknown（UI 提示）；
 * 不以 "/" 开头 → message（普通消息）。
 */

export type TuiSlashCommand =
  "sessions" | "new" | "quit" | "exit" | "help" | "info";

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
    "/quit      退出（别名 /exit）",
    "Ctrl+C     打断前台运行中的 turn",
  ];
}
