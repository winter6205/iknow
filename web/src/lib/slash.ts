/**
 * web/src/lib/slash.ts
 *
 * Web Composer 的 slash 命令面（核心 5 子集，命令名对齐 TUI src/tui/slash.ts
 * 真值；不照搬全集）。纯函数模块：Composer 只消费本模块，便于 tests/web/
 * 直接断言。
 *
 * 解析规则：输入 trim 后以 "/" 开头先过词表；无参命令（compact/new/help）
 * 携带多余参数视为非法（matchSlash 返回 null，slashSubmitDecision 裁决为
 * notice 提示用户）；带参命令（thinking/effort）参数缺失时仍匹配（arg 为
 * 空串），合法性由 App 层裁决并给出用法提示。不以 "/" 开头的输入永不出
 * 现在本模块的匹配路径上。
 */

export type SlashCommandName =
  | "compact"
  | "new"
  | "help"
  | "thinking"
  | "effort";

export type SlashCommand = {
  readonly name: SlashCommandName;
  readonly description: string;
  /** 命令 + 参数形态（补全菜单与 help 共用），如 `/thinking on|off`。 */
  readonly hint: string;
};

export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: "compact", description: "压缩上下文", hint: "/compact" },
  { name: "new", description: "新建会话", hint: "/new" },
  { name: "help", description: "命令帮助", hint: "/help" },
  { name: "thinking", description: "思考开关", hint: "/thinking on|off" },
  {
    name: "effort",
    description: "思考强度",
    hint: "/effort low|medium|high",
  },
];

const BY_NAME = new Map<SlashCommandName, SlashCommand>(
  SLASH_COMMANDS.map((c) => [c.name, c])
);

/** 携带参数的命令；其余为无参命令（多余参数 → 非法）。 */
const ARG_COMMANDS = new Set<SlashCommandName>(["thinking", "effort"]);

export type SlashMatch = {
  readonly name: SlashCommandName;
  /** 首 token 之后的剩余段（trim 后）；无参命令恒为 ""。 */
  readonly arg: string;
};

/**
 * 解析完整命令：仅当输入以 "/" 开头且首 token 命中词表时返回匹配。
 * 无参命令带多余参数 / 未知命令 / 非 "/" 开头 → null。
 */
export function matchSlash(input: string): SlashMatch | null {
  const text = input.trim();
  if (!text.startsWith("/")) return null;
  const head = text.split(/\s+/, 1)[0] ?? text;
  const name = head.slice(1).toLowerCase();
  const cmd = BY_NAME.get(name as SlashCommandName);
  if (cmd === undefined) return null;
  const rest = text.slice(head.length).trim();
  if (!ARG_COMMANDS.has(cmd.name) && rest !== "") return null;
  return { name: cmd.name, arg: rest };
}

/** 前缀过滤候选（供补全菜单）；空 / 非 "/" 开头 / 未命中 → 空数组。 */
export function slashCandidates(input: string): ReadonlyArray<SlashCommand> {
  const text = input.trim();
  if (!text.startsWith("/")) return [];
  const prefix = (text.slice(1).split(/\s+/, 1)[0] ?? "").toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}

export type SlashEnterAction =
  | { kind: "execute"; name: SlashCommandName; arg: string }
  | { kind: "accept"; text: string }
  | { kind: "none" };

/**
 * 补全菜单打开时的 Enter 裁决：完整命令 → execute；否则选中候选 → accept
 * （带参命令补全形带尾随空格，等待参数输入）；无有效选中 → none。
 */
export function slashEnterAction(
  input: string,
  selectedIndex: number
): SlashEnterAction {
  const matched = matchSlash(input);
  if (matched !== null) return { kind: "execute", ...matched };
  const candidates = slashCandidates(input);
  if (selectedIndex < 0 || selectedIndex >= candidates.length) {
    return { kind: "none" };
  }
  const cmd = candidates[selectedIndex]!;
  const text = ARG_COMMANDS.has(cmd.name) ? `/${cmd.name} ` : `/${cmd.name}`;
  return { kind: "accept", text };
}

/** /help 输出：全部命令 + 说明（每行一条，notice 消息 whitespace-pre-line 渲染）。 */
export function slashHelpText(): string {
  return SLASH_COMMANDS.map((c) => `${c.hint} — ${c.description}`).join("\n");
}

/** 非法 slash 输入（未知命令 / 无参命令带多余参数）的提示文案。 */
export const UNKNOWN_SLASH_NOTICE = "未知命令，/help 查看可用命令";

export type SlashSubmitDecision =
  | { kind: "execute"; name: SlashCommandName; arg: string }
  | { kind: "notice"; text: string }
  | { kind: "send" };

/**
 * 提交裁决（Composer.submit 消费）："/" 开头 → 可解析则 execute，非法则
 * notice（不静默；输入框文本由 Composer 保留让用户修改）；非 "/" 开头 →
 * send（走正常发送）。
 */
export function slashSubmitDecision(input: string): SlashSubmitDecision {
  const text = input.trim();
  if (!text.startsWith("/")) return { kind: "send" };
  const matched = matchSlash(text);
  if (matched !== null) return { kind: "execute", ...matched };
  return { kind: "notice", text: UNKNOWN_SLASH_NOTICE };
}

export type MenuKeyEvent =
  | { kind: "move"; index: number }
  | { kind: "dismiss" }
  | { kind: "accept"; name: SlashCommandName }
  | { kind: "enter"; action: SlashEnterAction }
  | { kind: "ignore" };

export type MenuKeyState = {
  readonly value: string;
  /** 已钳制到候选范围内的高亮索引。 */
  readonly selectedIndex: number;
  readonly candidates: ReadonlyArray<SlashCommand>;
};

/**
 * 补全菜单打开时的键盘裁决（纯函数；Composer onKeyDown 只做路由与状态写回）。
 * ArrowUp/Down → move（钳制边界）；Escape → dismiss；Tab → accept 高亮项；
 * Enter（非 shift）→ enter（经 slashEnterAction）；其余键 → ignore（交还
 * 默认行为 / 提交流由）。
 */
export function menuKeyEvent(
  state: MenuKeyState,
  key: string,
  shiftKey = false
): MenuKeyEvent {
  if (key === "ArrowDown") {
    return {
      kind: "move",
      index: Math.min(state.selectedIndex + 1, state.candidates.length - 1),
    };
  }
  if (key === "ArrowUp") {
    return { kind: "move", index: Math.max(state.selectedIndex - 1, 0) };
  }
  if (key === "Escape") return { kind: "dismiss" };
  if (key === "Tab") {
    const cmd = state.candidates[state.selectedIndex];
    if (cmd === undefined) return { kind: "ignore" };
    return { kind: "accept", name: cmd.name };
  }
  if (key === "Enter" && !shiftKey) {
    return { kind: "enter", action: slashEnterAction(state.value, state.selectedIndex) };
  }
  return { kind: "ignore" };
}

/** 带参命令（thinking/effort）值域词表：合法值 + 用法文案 SSOT。 */
export const ARG_COMMAND_SPECS = {
  thinking: { values: ["on", "off"] as const, usage: "用法：/thinking on|off" },
  effort: {
    values: ["low", "medium", "high"] as const,
    usage: "用法：/effort low|medium|high",
  },
} as const;

export type ArgCommandName = keyof typeof ARG_COMMAND_SPECS;

export type ArgCommandResolution =
  | { ok: true; value: string }
  | { ok: false; notice: string };

/**
 * 带参命令的 arg 归一化（trim + 小写）→ 值域判定：命中 → ok 带归一值；
 * 未命中 / 缺参 → 用法 notice（App 层经 pushNotice 提示）。
 */
export function resolveArgCommand(
  name: ArgCommandName,
  arg: string | undefined
): ArgCommandResolution {
  const spec = ARG_COMMAND_SPECS[name];
  const value = (arg ?? "").trim().toLowerCase();
  if ((spec.values as readonly string[]).includes(value)) {
    return { ok: true, value };
  }
  return { ok: false, notice: spec.usage };
}
