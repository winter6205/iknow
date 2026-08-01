/**
 * CLI 端 slash-command 解析 + dispatch。
 *
 * 与并行旧模块的差异(Q1 + Q3 决议收口):
 * - 不再导任何 mode 相关符号(CLI 不再有 mode 概念;`/mode` case + 对应
 *   处理函数已删);Session API 仍消费旧 fork,020 一字不动。
 * - 状态类型收敛到本文件维护:仅保留 host 必需的 `messages` /
 *   `jsonMode` / `session` 三字段。
 * - 命令字段名更新:`json_mode` → `jsonMode`,`turns.length` →
 *   `messages.length`,旧 `last_priors` 行删除。
 * - `/reset` 改清 messages,不动 session。
 *
 * 此文件是 `CliChatState` 类型在 CLI 端的唯一 home(后续 `chat-session.ts`
 * 与 `cli.ts` 共引此类型,避免重复定义)。
 */
import type { AnthropicNativeMessage } from "../harness/index.js";
import {
  CALLER_ROLES,
  parseCallerRole,
  type CallerRole,
  type SessionContext,
} from "../shared/schema.js";

/**
 * CLI host 维护的最小对话状态。
 *
 * `messages` 维护最近 run 的 append-only 历史(由 host 决定续传策略,
 * slash 模块仅在 `/reset` 时清空)。字段类型是 `AnthropicNativeMessage[]`
 * (可变)而不是 `ReadonlyArray<...>`:host 会在续传/重置时整体重新赋值,
 * 旧 `ReadonlyArray` 强制每次赋值都做 `as unknown as` 双强转,撒谎说"只读"。
 * `jsonMode` 决定 ask/chat 输出走哪一支投影;`session` 透传 harness
 * (SessionContext 由 Session API 装配)。
 */
export type CliChatState = {
  messages: AnthropicNativeMessage[];
  jsonMode: boolean;
  session: SessionContext;
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
  | { type: "reset"; message: string };

/** Pipe-joined allowed caller-role list for `/role` usage text. */
function allowedRolesList(): string {
  return CALLER_ROLES.join("|");
}

/**
 * Strip C0 control chars (incl. ESC) and DEL so reflected command text
 * cannot inject terminal escape sequences when printed.
 */
function sanitizeCommandForDisplay(command: string): string {
  // eslint-disable-next-line no-control-regex -- intentional control-char strip
  return command.replace(/[\u0000-\u001F\u007F]/g, "");
}

const HELP_TEXT = `命令 / Commands:
  /help                 显示帮助 · show this help
  /status               会话状态 · role / json / messages
  /quit  /exit          退出 · leave chat
  /json on|off          切换 JSON 输出 · toggle machine JSON
  /role <role>          设置角色 · set role (${allowedRolesList()})
  /reset                清空会话 · clear messages (session kept)

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
 * Apply a slash command. Mutates `ctx.state` for `/json`, `/role`, `/reset`.
 *
 * No `mode_change` variant — CLI no longer has an agent-mode concept (Q3).
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

    case "role":
      return applyRole({ args, ctx });

    case "reset":
      // Mutate in place so agents holding this state reference see the cleared
      // messages. Session is intentionally preserved — `/role` survives reset.
      ctx.state.messages = [];
      return { type: "reset", message: "Session cleared." };

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

function formatStatus(ctx: SlashContext): string {
  const { state } = ctx;
  return [
    `role=${state.session.caller_role}`,
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

function applyRole(opts: {
  readonly args: string[];
  readonly ctx: SlashContext;
}): SlashEffect {
  const { args, ctx } = opts;
  const raw = args[0];
  if (raw === undefined || raw === "") {
    return {
      type: "error",
      text: `Usage: /role <${allowedRolesList()}>`,
    };
  }
  let role: CallerRole;
  try {
    role = parseCallerRole(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "error", text: msg };
  }
  // Mutate in place so agents holding this session reference see the new role.
  ctx.state.session.caller_role = role;
  return {
    type: "info",
    text: `Role set to ${role}`,
  };
}
