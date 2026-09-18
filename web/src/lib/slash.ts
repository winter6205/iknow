/**
 * web/src/lib/slash.ts
 *
 * Web Composer 的 slash 命令面。词表对齐 TUI `src/tui/slash.ts`（13 条 +
 * skill 混显，含 serve-workspace 的 /workspace 与 continue_pending 的
 * /continue）；浏览器无进程退出时 /quit /exit 仍进词表，由 App 做能力映射。
 */

export type SlashCommandName =
  | "sessions"
  | "new"
  | "quit"
  | "exit"
  | "help"
  | "info"
  | "thinking"
  | "effort"
  | "compact"
  | "continue"
  | "rewind"
  | "mcp"
  | "workspace"
  | "graph";

export type SlashCommand = {
  readonly name: SlashCommandName;
  readonly description: string;
  readonly hint: string;
};

export interface SkillEntryLike {
  readonly name: string;
  /**
   * 人侧技能可以没有 description（spec skill-index-increment SC5/SC9）。
   * 缺席 ≠ 空串：候选渲染据此走「无描述」形态。
   */
  readonly description?: string;
  /**
   * 裸名别名（catalog 只保留唯一别名，冲突者已被 catalog 丢弃）。
   * `parseSkillLoad` 用它解析 typed 裸名，并据此取 **typed token 长度**。
   */
  readonly aliases?: ReadonlyArray<string>;
}

export type SlashCandidate =
  | {
      kind: "command";
      name: SlashCommandName;
      description: string;
      hint: string;
    }
  | { kind: "skill"; name: string; description?: string; hint: string };

export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: "sessions", description: "打开会话列表", hint: "/sessions" },
  { name: "new", description: "新建会话", hint: "/new" },
  { name: "quit", description: "退出（浏览器：关闭标签页）", hint: "/quit" },
  { name: "exit", description: "同 /quit", hint: "/exit" },
  { name: "help", description: "本词表", hint: "/help" },
  { name: "info", description: "当前会话元信息", hint: "/info" },
  { name: "thinking", description: "思考开关", hint: "/thinking on|off" },
  {
    name: "effort",
    description: "思考强度",
    hint: "/effort low|medium|high|xhigh|max",
  },
  { name: "compact", description: "压缩上下文", hint: "/compact" },
  { name: "continue", description: "续跑未完成的工具环", hint: "/continue" },
  { name: "rewind", description: "回退到更早的回合", hint: "/rewind" },
  { name: "mcp", description: "查看 MCP 服务看板", hint: "/mcp" },
  { name: "workspace", description: "选择工作空间根", hint: "/workspace" },
  {
    name: "graph",
    description: "图模式开关（下一次 run() 装配生效）",
    hint: "/graph on|off|status",
  },
];

const BY_NAME = new Map<SlashCommandName, SlashCommand>(
  SLASH_COMMANDS.map((c) => [c.name, c])
);

/**
 * 接受参数的命令。`graph` 在表内但**不**进 `ARG_COMMAND_SPECS` —— 值域
 * 与拒绝理由都由服务端 `applyGraphCommand` 裁决（前端复制一份就会漂移）。
 */
const ARG_COMMANDS = new Set<SlashCommandName>(["thinking", "effort", "graph"]);

export type SlashMatch = {
  readonly name: SlashCommandName;
  readonly arg: string;
};

export function matchSlash(input: string): SlashMatch | null {
  const text = input.trim();
  if (!text.startsWith("/")) return null;
  const head = text.split(/\s+/, 1)[0] ?? text;
  const name = head.slice(1).toLowerCase();
  const cmd = BY_NAME.get(name as SlashCommandName);
  if (cmd === undefined) return null;
  const rest = text.slice(head.length).trim();
  // continue 不进 ARG_COMMANDS（无值域）；带参仍 match，handler 发 usage EXIT。
  if (rest !== "" && !ARG_COMMANDS.has(cmd.name) && cmd.name !== "continue") {
    return null;
  }
  return { name: cmd.name, arg: rest };
}

function slashPrefix(text: string): string {
  if (!text.startsWith("/")) return "";
  return (text.slice(1).split(/\s+/, 1)[0] ?? "").toLowerCase();
}

export function slashCandidates(
  input: string,
  skills?: ReadonlyArray<SkillEntryLike>
): ReadonlyArray<SlashCandidate> {
  const text = input.trim();
  if (!text.startsWith("/")) return [];
  const prefix = slashPrefix(text);
  const out: SlashCandidate[] = [];
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.name.startsWith(prefix)) {
      out.push({
        kind: "command",
        name: cmd.name,
        description: cmd.description,
        hint: cmd.hint,
      });
    }
  }
  if (skills !== undefined && prefix.length > 0) {
    for (const skill of skills) {
      // 规范名或任一裸名别名命中前缀即入场，但只发一条 canonical 候选
      // （别名不是第二条候选）。
      if (skillHeadLowers(skill).some((head) => head.startsWith(prefix))) {
        out.push({
          kind: "skill",
          name: skill.name,
          // 无 description 的条目**仍进候选**（SC9）：缺席保留 undefined，
          // 不补占位文案 —— 占位文案会把「无描述」伪装成有描述。
          ...(skill.description !== undefined
            ? { description: skill.description }
            : {}),
          hint: `/${skill.name}`,
        });
      }
    }
  }
  return out;
}

/** skill 的全部可匹配首 token 小写形：规范名 + 唯一裸名别名。
 *  SSOT 语义对齐 TUI `skillHeadLowers`（src/tui/slash.ts）—— web 与
 *  `../src/` 之间有 tsconfig 边界（include 仅 `src`，无 path map），
 *  故本地镜像；改 TUI 侧时同步此处。 */
function skillHeadLowers(skill: SkillEntryLike): ReadonlyArray<string> {
  return [skill.name, ...(skill.aliases ?? [])].map((head) =>
    head.toLowerCase()
  );
}

/**
 * remainder 按 **typed 首 token 长度** 切，SSOT 对齐 TUI `slashRemainder`
 * （src/tui/slash.ts:445）。**禁止**用 `skill.name.length` /
 * `text.indexOf("/")` 组合：裸名输入（typed `/echo` 命中 canonical
 * `plugin:echo`）会按 canonical 长度多吃/少吃字符（SC9 明确禁止）。
 */
function slashRemainder(text: string): string {
  const firstTok = text.split(/\s+/, 1)[0] ?? text;
  return text.slice(firstTok.length).trim();
}

export function parseSkillLoad(
  raw: string,
  skills: ReadonlyArray<SkillEntryLike>
): { name: string; remainder: string } | undefined {
  const text = raw.trim();
  const prefix = slashPrefix(text);
  if (prefix === "") return undefined;
  if (BY_NAME.has(prefix as SlashCommandName)) return undefined;
  for (const skill of skills) {
    // 精确命中规范名或裸名别名（大小写不敏感）；返回 canonical
    // `skill.name`，保证落盘信封恒 canonical。
    if (skillHeadLowers(skill).includes(prefix)) {
      return { name: skill.name, remainder: slashRemainder(text) };
    }
  }
  return undefined;
}

export type SlashEnterAction =
  | { kind: "execute"; name: SlashCommandName; arg: string }
  | { kind: "skill"; name: string; remainder: string }
  | { kind: "accept"; text: string }
  | { kind: "none" };

export function slashEnterAction(
  input: string,
  selectedIndex: number,
  skills?: ReadonlyArray<SkillEntryLike>
): SlashEnterAction {
  const matched = matchSlash(input);
  if (matched !== null) return { kind: "execute", ...matched };
  const loaded = parseSkillLoad(input, skills ?? []);
  if (loaded !== undefined) return { kind: "skill", ...loaded };
  const candidates = slashCandidates(input, skills);
  if (selectedIndex < 0 || selectedIndex >= candidates.length) {
    return { kind: "none" };
  }
  const cmd = candidates[selectedIndex]!;
  if (cmd.kind === "skill") return { kind: "accept", text: `/${cmd.name}` };
  const text = ARG_COMMANDS.has(cmd.name) ? `/${cmd.name} ` : `/${cmd.name}`;
  return { kind: "accept", text };
}

export function slashHelpText(skillNames?: ReadonlyArray<string>): string {
  const skillLines =
    skillNames !== undefined && skillNames.length > 0
      ? skillNames.map((name) => `/${name} — 加载技能`)
      : [];
  return [
    ...SLASH_COMMANDS.map((c) => `${c.hint} — ${c.description}`),
    ...skillLines,
  ].join("\n");
}

export const UNKNOWN_SLASH_NOTICE = "未知命令，/help 查看可用命令";

export type SlashSubmitDecision =
  | { kind: "execute"; name: SlashCommandName; arg: string }
  | { kind: "skill"; name: string; remainder: string }
  | { kind: "notice"; text: string }
  | { kind: "send" };

export function slashSubmitDecision(
  input: string,
  skills?: ReadonlyArray<SkillEntryLike>
): SlashSubmitDecision {
  const text = input.trim();
  if (!text.startsWith("/")) return { kind: "send" };
  const matched = matchSlash(text);
  if (matched !== null) return { kind: "execute", ...matched };
  const loaded = parseSkillLoad(text, skills ?? []);
  if (loaded !== undefined) return { kind: "skill", ...loaded };
  return { kind: "notice", text: UNKNOWN_SLASH_NOTICE };
}

export type MenuKeyEvent =
  | { kind: "move"; index: number }
  | { kind: "dismiss" }
  | { kind: "accept"; name: string }
  | { kind: "enter"; action: SlashEnterAction }
  | { kind: "ignore" };

export type MenuKeyState = {
  readonly value: string;
  readonly selectedIndex: number;
  readonly candidates: ReadonlyArray<SlashCandidate>;
  readonly skills?: ReadonlyArray<SkillEntryLike>;
};

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
    return {
      kind: "enter",
      action: slashEnterAction(state.value, state.selectedIndex, state.skills),
    };
  }
  return { kind: "ignore" };
}

export const ARG_COMMAND_SPECS = {
  thinking: { values: ["on", "off"] as const, usage: "用法：/thinking on|off" },
  effort: {
    values: ["low", "medium", "high", "xhigh", "max"] as const,
    usage: "用法：/effort low|medium|high|xhigh|max",
  },
} as const;

export type ArgCommandName = keyof typeof ARG_COMMAND_SPECS;

export type ArgCommandResolution =
  { ok: true; value: string } | { ok: false; notice: string };

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

export function commandTakesArg(name: string): boolean {
  return ARG_COMMANDS.has(name as SlashCommandName);
}
