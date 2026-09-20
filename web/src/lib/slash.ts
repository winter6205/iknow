/**
 * web/src/lib/slash.ts
 *
 * Slash-command surface for the web composer. The vocabulary mirrors the TUI
 * `src/tui/slash.ts` (13 commands + mixed-in skills, incl. serve-workspace's
 * /workspace and continue_pending's /continue); browsers have no process to
 * exit, so /quit /exit stay in the vocabulary and App maps the capability.
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
   * Human-side skills may have no description (spec
   * skill-index-increment). Absent ≠ empty string: candidate rendering shows the
   * "no description" form accordingly.
   */
  readonly description?: string;
  /**
   * Bare-name aliases (catalog keeps only unique aliases; colliding ones are
   * already dropped by the catalog). `parseSkillLoad` uses them to resolve
   * typed bare names and to take the **typed token length**.
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
 * Commands that accept an argument. `graph` is listed here but deliberately
 * NOT in `ARG_COMMAND_SPECS` — its value domain and rejection reasons are
 * decided server-side by `applyGraphCommand` (a frontend copy would drift).
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
  // continue is not in ARG_COMMANDS (no value domain); args still match and the handler emits the usage EXIT.
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
      // Canonical name or any bare alias hitting the prefix admits the
      // skill, but only one canonical candidate is emitted (aliases are not
      // second candidates).
      if (skillHeadLowers(skill).some((head) => head.startsWith(prefix))) {
        out.push({
          kind: "skill",
          name: skill.name,
          // Entries without a description still enter the candidates:
          // absence keeps undefined, no placeholder text — a placeholder
          // would disguise "no description" as one.
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

/** All lowercase first-token forms a skill can match: canonical name + unique bare aliases.
 *  SSOT semantics mirror the TUI `skillHeadLowers` (src/tui/slash.ts) — a
 *  tsconfig boundary separates web from `../src/` (include is `src` only, no
 *  path map), so this is a local mirror; sync it when the TUI side changes. */
function skillHeadLowers(skill: SkillEntryLike): ReadonlyArray<string> {
  return [skill.name, ...(skill.aliases ?? [])].map((head) =>
    head.toLowerCase()
  );
}

/**
 * Cut the remainder by the **typed first-token length**, mirroring the TUI
 * SSOT `slashRemainder` (src/tui/slash.ts:445). Do NOT combine
 * `skill.name.length` / `text.indexOf("/")`: a bare-name input (typed
 * `/echo` hitting canonical `plugin:echo`) would then over- or under-eat
 * characters by the canonical length (explicitly forbidden by the spec).
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
    // Exact hit on canonical name or a bare alias (case-insensitive);
    // return canonical `skill.name` so the persisted envelope is always canonical.
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
