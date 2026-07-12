/**
 * Pure slash-command parse/apply for chat REPL (design §4.1).
 * No I/O — host CLI owns readline and agent rebuild.
 */
import { CALLER_ROLES, parseCallerRole, type CallerRole } from "../shared/schema.js";
import { resetConversation } from "./conversation.js";
import type { ConversationState } from "./types.js";

export const AGENT_MODES = ["deterministic", "llm"] as const;
export type AgentModeCli = (typeof AGENT_MODES)[number];

export type ParsedChatLine =
  | { kind: "empty" }
  | { kind: "query"; text: string }
  | { kind: "slash"; command: string; args: string[] };

export type SlashContext = {
  state: ConversationState;
  mode: AgentModeCli;
};

export type SlashEffect =
  | { type: "quit" }
  | { type: "help"; text: string }
  | { type: "info"; text: string }
  | { type: "error"; text: string }
  | { type: "mode_change"; mode: AgentModeCli; message: string }
  | { type: "reset"; message: string };

const HELP_TEXT = `Commands:
  /help                 Show this help
  /quit  /exit          Leave chat
  /json on|off          Toggle machine JSON output
  /role <role>          Set caller role (${CALLER_ROLES.join("|")})
  /mode <mode>          Set agent mode (${AGENT_MODES.join("|")})
  /reset                Clear turns/priors/history (keep store + session)

Anything else is a question for the agent.`;

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

/**
 * Apply a slash command. Mutates ctx.state for /json, /role, /reset.
 * Mode changes are reported via mode_change; host rebuilds the agent.
 */
export function applySlashCommand(
  command: string,
  args: string[],
  ctx: SlashContext,
): SlashEffect {
  switch (command) {
    case "quit":
    case "exit":
      return { type: "quit" };

    case "help":
    case "?":
      return { type: "help", text: HELP_TEXT };

    case "json":
      return applyJson(args, ctx);

    case "role":
      return applyRole(args, ctx);

    case "mode":
      return applyMode(args, ctx);

    case "reset":
      resetConversation(ctx.state);
      return { type: "reset", message: "Session cleared (store kept)." };

    case "":
      return {
        type: "error",
        text: "Empty command. Type /help for commands.",
      };

    default:
      return {
        type: "error",
        text: `Unknown command /${command}. Type /help for commands.`,
      };
  }
}

function applyJson(args: string[], ctx: SlashContext): SlashEffect {
  const raw = (args[0] ?? "").toLowerCase();
  if (raw !== "on" && raw !== "off") {
    return {
      type: "error",
      text: "Usage: /json on|off",
    };
  }
  ctx.state.json_mode = raw === "on";
  return {
    type: "info",
    text: `JSON output: ${ctx.state.json_mode ? "on" : "off"}`,
  };
}

function applyRole(args: string[], ctx: SlashContext): SlashEffect {
  const raw = args[0];
  if (raw === undefined || raw === "") {
    return {
      type: "error",
      text: `Usage: /role <${CALLER_ROLES.join("|")}>`,
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

function applyMode(args: string[], ctx: SlashContext): SlashEffect {
  const raw = (args[0] ?? "").toLowerCase();
  if (!(AGENT_MODES as readonly string[]).includes(raw)) {
    return {
      type: "error",
      text: `Usage: /mode <${AGENT_MODES.join("|")}>`,
    };
  }
  const next = raw as AgentModeCli;
  if (next === ctx.mode) {
    return {
      type: "info",
      text: `Mode already ${next}`,
    };
  }
  return {
    type: "mode_change",
    mode: next,
    message: `Mode set to ${next}`,
  };
}

export function parseAgentModeCli(value: unknown): AgentModeCli {
  if (
    typeof value === "string" &&
    (AGENT_MODES as readonly string[]).includes(value.toLowerCase())
  ) {
    return value.toLowerCase() as AgentModeCli;
  }
  throw new Error(
    `Invalid mode: ${JSON.stringify(value)}; expected one of: ${AGENT_MODES.join("|")}`,
  );
}
