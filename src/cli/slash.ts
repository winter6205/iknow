/**
 * CLI-side slash-command parsing + dispatch.
 *
 * Divergences from the parallel legacy module:
 * - No mode-related symbols are exported (the CLI has no agent-mode
 *   concept; the `/mode` case and its handlers are gone). The Session API
 *   still consumes the old fork, untouched.
 * - State types converge here: only the host-required `messages` /
 *   `jsonMode` / `session` fields remain.
 * - Field renames: `json_mode` -> `jsonMode`, `turns.length` ->
 *   `messages.length`; the legacy `last_priors` line is gone.
 * - `/reset` clears messages, keeps the session.
 *
 * This file is the single home of `CliChatState` on the CLI side
 * (`chat-session.ts` and `cli.ts` import it from here).
 */
import type { AnthropicNativeMessage } from "../harness/index.js";
import type { SessionContext } from "../shared/schema.js";
import { parseGoalPinInput } from "../session-api/goal-auto.js";

/**
 * Minimal conversation state maintained by the CLI host.
 *
 * Whole-chain rule: `ReadonlyArray` + `Object.freeze`. The host maintains
 * append-only history by wholesale replacement plus freezing; in-place
 * mutation is banned — this is how append-only discipline lands at the host
 * layer. `jsonMode` picks which ask/chat output projection runs; `session`
 * passes through to the harness (SessionContext assembled by the Session API).
 *
 * `conversationId` — generated once by runChatSession at entry
 * (`randomUUID`) as this REPL session's session-folder name
 * (`<pool root>/projects/<slug>/<id>/`, ADR-0071/0087). `--resume` reuses
 * the same field to anchor the same file across restarts. Tests /
 * makeState default to `null`, meaning "no checkpoint persistence path";
 * processChatLine skips the persistence branch accordingly.
 */
export type CliChatState = {
  messages: ReadonlyArray<AnthropicNativeMessage>;
  jsonMode: boolean;
  session: SessionContext;
  conversationId: string | null;
};

export type ParsedChatLine =
  | { kind: "empty" }
  | { kind: "query"; text: string }
  | { kind: "slash"; command: string; args: string[] };

export type SlashContext = { state: CliChatState };

export type SlashEffect =
  | { type: "quit" }
  | { type: "help"; text: string }
  | { type: "info"; text: string }
  | { type: "error"; text: string }
  | { type: "reset"; message: string }
  /** Host runs skip-append continue; never a user task sentence. */
  | { type: "continue" }
  /**
   * Permission-mode query/toggle. args[0] ∈ {"", "status", "default", "plan",
   * "full_auto", "help"}. Empty / "status" -> host shows the current mode;
   * otherwise host calls modeContext.set(args[0]).
   */
  | { type: "permissions"; args: string[] }
  /**
   * Session-level goal surface. /goal <text> is persisted by the host as
   * session.goal (source=user_pin); /goal status shows the current goal;
   * /goal clear empties it. All three dispatch from the host-side
   * processSlash "goal" case on `action`.
   * Empty args / "status" -> status; "clear" -> clear; anything else ->
   * pin <text> (join+trim). Case-sensitive ("CLEAR" ≠ clear -> pin).
   *
   * Note: the taskFocus segment has been retired entirely; status / clear
   * only echo / clear the goal.
   */
  | {
      type: "goal";
      action: "status" | "clear" | "pin";
      text: string;
      maxTurns?: number;
    }
  /**
   * Graph-mode orchestration overlay query/toggle. args pass through
   * verbatim — parsing and copy live in one place, `applyGraphCommand` in
   * `harness/graph/mode.ts` (chat / TUI / serve share that semantics). The
   * host holds the GraphModeContext.
   */
  | { type: "graph"; args: string[] }
  /**
   * ADR-0092: filesystem isolation tier query/toggle. args pass through
   * verbatim — parsing and copy live in one place, `applyFsModeCommand` in
   * `harness/sandbox/fs-mode.ts` (chat / TUI / serve share that value
   * domain). The host holds the FsModeContext.
   */
  | { type: "config"; args: string[] };

/**
 * Strip C0 control chars (incl. ESC) and DEL so reflected command text
 * cannot inject terminal escape sequences when printed.
 */
function sanitizeCommandForDisplay(command: string): string {
  // eslint-disable-next-line no-control-regex -- intentional control-char strip
  return command.replace(/[\u0000-\u001F\u007F]/g, "");
}

export const HELP_TEXT = `命令 / Commands:
  /help                       显示帮助 · show this help
  /status                     会话状态 · json / messages
  /quit  /exit                退出 · leave chat
  /json on|off                切换 JSON 输出 · toggle machine JSON
  /reset                      清空会话 · clear messages (session kept)
  /continue                   续跑未完成工具环 · continue pending (no args)
  /permissions [mode]         查看/切换权限模式(default|plan|full_auto)
  /graph [on|off|status]      查看/切换 graph 编排模式(下一次 run() 生效)
  /config [status|fs global|fs workspace]  查看/切换文件系统隔离档(下一次 bash 调用生效)
  /goal status                查看会话目标 · show session goal
  /goal clear                 清空会话目标 · clear session goal
  /goal [--max-turns <n>] <text>  钉目标（可选轮次上限）· pin goal

其他输入视为问题 · anything else is a question for the agent.`;

/**
 * Classify a raw readline line into empty / query / slash.
 * Slash body is lowercased command + remaining args (not lowercased).
 */
export function parseChatLine(line: string): ParsedChatLine {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: "empty" };
  }
  if (!trimmed.startsWith("/")) {
    return { kind: "query", text: trimmed };
  }

  const body = trimmed.slice(1).trim();
  if (!body) {
    return { kind: "slash", command: "", args: [] };
  }

  const parts = body.split(/\s+/);
  const command = (parts[0] ?? "").toLowerCase();
  const args = parts.slice(1);
  return { kind: "slash", command, args };
}

export interface ApplySlashCommandOpts {
  readonly command: string;
  readonly args: string[];
  readonly ctx: SlashContext;
}

/**
 * Apply a slash command. Mutates `ctx.state` for `/json` and `/reset`.
 *
 * No `mode_change` variant — CLI no longer has an agent-mode concept.
 */
export function applySlashCommand(opts: ApplySlashCommandOpts): SlashEffect {
  const { command, args, ctx } = opts;
  switch (command) {
    case "quit":
    case "exit":
      return { type: "quit" };

    case "help":
    case "?":
      return { type: "help", text: HELP_TEXT };

    case "status":
      return { type: "info", text: formatStatus(ctx) };

    case "json":
      return applyJson({ args, ctx });

    case "reset":
      // Mutate in place so agents holding this state reference see the cleared
      // messages. Session is intentionally preserved across reset.
      ctx.state.messages = Object.freeze([]);
      return { type: "reset", message: "Session cleared." };

    case "continue":
      if (args.length > 0) {
        return { type: "error", text: "Usage: /continue" };
      }
      return { type: "continue" };

    case "permissions":
      // Permission-mode query/toggle. Pure parsing here; the actual set
      // lands in the host (it holds PermissionModeContext).
      return { type: "permissions", args };

    case "graph":
      // Graph orchestration overlay query/toggle. args are not parsed here —
      // the value domain and copy are a single point shared by the three
      // entry points (harness/graph/mode.ts); the host holds GraphModeContext
      // and calls it.
      return { type: "graph", args };

    case "config":
      // ADR-0092: filesystem isolation tier query/toggle. args are not
      // parsed here — the value domain and copy are a single point shared by
      // the three entry points (harness/sandbox/fs-mode.ts); the host holds
      // FsModeContext and calls applyFsModeCommand.
      return { type: "config", args };

    case "goal":
      return applyGoalCommand(args);

    case "":
      return {
        type: "error",
        text: "Empty command. Type /help for commands.",
      };

    default:
      return {
        type: "error",
        text: `Unknown command /${sanitizeCommandForDisplay(command)}. Type /help for commands.`,
      };
  }
}

/**
 * /goal three faces — status / clear / pin(<text>).
 * status / clear are case-sensitive (lowercase only triggers; uppercase
 * pins as <text>, since user text may legitimately start uppercase).
 * Empty args -> status (echo); anything else -> pin with text = join+trim.
 * Pure parsing: real IO (read / clear / persist) happens in the host
 * (chat-session holds checkpointStore + validateGoalText).
 */
function applyGoalCommand(args: string[]): SlashEffect {
  const sub = args[0] ?? "";
  if (sub === "status") {
    return { type: "goal", action: "status", text: "" };
  }
  if (sub === "clear") {
    return { type: "goal", action: "clear", text: "" };
  }
  if (args.length === 0) {
    return { type: "goal", action: "status", text: "" };
  }
  const parsed = parseGoalPinInput(args.join(" "));
  if (!parsed.ok) {
    return { type: "error", text: parsed.error };
  }
  if (parsed.maxTurns === undefined) {
    return { type: "goal", action: "pin", text: parsed.text };
  }
  return {
    type: "goal",
    action: "pin",
    text: parsed.text,
    maxTurns: parsed.maxTurns,
  };
}

function formatStatus(ctx: SlashContext): string {
  const { state } = ctx;
  return [
    `json=${state.jsonMode ? "on" : "off"}`,
    `messages=${state.messages.length}`,
  ].join("  ");
}

function applyJson(opts: {
  readonly args: string[];
  readonly ctx: SlashContext;
}): SlashEffect {
  const { args, ctx } = opts;
  const raw = (args[0] ?? "").toLowerCase();
  if (raw !== "on" && raw !== "off") {
    return {
      type: "error",
      text: "Usage: /json on|off",
    };
  }
  ctx.state.jsonMode = raw === "on";
  return {
    type: "info",
    text: `JSON output: ${ctx.state.jsonMode ? "on" : "off"}`,
  };
}
