/**
 * Pure CLI argument parsing (no I/O).
 */
import {
  CALLER_ROLES,
  parseCallerRole,
  type CallerRole,
} from "../shared/schema.js";
import {
  AGENT_MODES,
  parseAgentModeCli,
  type AgentModeCli,
} from "../interaction/slash.js";

export type CliCommand = "chat" | "ask" | "oneshot" | "help";

export type ParsedCli = {
  command: CliCommand;
  query: string;
  role: CallerRole;
  degrade: boolean;
  mode: AgentModeCli;
  embeddings: boolean;
  json: boolean;
  /**
   * ask/oneshot with empty query text.
   * Host should print usage and exit 1 (no default demo query).
   */
  missingQuery: boolean;
};

export type ParseArgsOptions = {
  /** When true, bare invocation (no query) defaults to chat. */
  interactive?: boolean;
};

/**
 * Parse process.argv.slice(2)-style argv into a structured CLI request.
 *
 * Defaults:
 * - no positionals + interactive → chat
 * - no positionals + !interactive → help
 * - ask / bare query with empty text → missingQuery (caller exits 1)
 */
export function parseArgs(
  argv: string[],
  opts?: ParseArgsOptions,
): ParsedCli {
  const interactive = opts?.interactive ?? false;
  let role: CallerRole = "employee";
  let degrade = false;
  let mode: AgentModeCli = "deterministic";
  let embeddings = false;
  let json = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      return baseParsed("help", {
        role,
        degrade,
        mode,
        embeddings,
        json,
        query: "",
        missingQuery: false,
      });
    }
    if (a === "--role") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error(
          `Missing value for --role; expected one of: ${CALLER_ROLES.join("|")}`,
        );
      }
      role = parseCallerRole(raw);
    } else if (a === "--governance-timeout") {
      degrade = true;
    } else if (a === "--mode") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error(
          `Missing value for --mode; expected one of: ${AGENT_MODES.join("|")}`,
        );
      }
      mode = parseAgentModeCli(raw);
    } else if (a === "--embeddings") {
      embeddings = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--version" || a === "-V") {
      // Treat as help-adjacent; host may print version-only if desired.
      return baseParsed("help", {
        role,
        degrade,
        mode,
        embeddings,
        json,
        query: "",
        missingQuery: false,
      });
    } else {
      rest.push(a);
    }
  }

  const flags = { role, degrade, mode, embeddings, json };
  const head = rest[0];

  if (head === "chat") {
    return baseParsed("chat", {
      ...flags,
      query: "",
      missingQuery: false,
    });
  }

  if (head === "ask") {
    const query = rest.slice(1).join(" ").trim();
    return baseParsed("ask", {
      ...flags,
      query,
      missingQuery: query.length === 0,
    });
  }

  if (head === "help") {
    return baseParsed("help", {
      ...flags,
      query: "",
      missingQuery: false,
    });
  }

  const query = rest.join(" ").trim();
  if (query.length === 0) {
    if (interactive) {
      return baseParsed("chat", {
        ...flags,
        query: "",
        missingQuery: false,
      });
    }
    return baseParsed("help", {
      ...flags,
      query: "",
      missingQuery: false,
    });
  }

  return baseParsed("oneshot", {
    ...flags,
    query,
    missingQuery: false,
  });
}

function baseParsed(
  command: CliCommand,
  fields: Omit<ParsedCli, "command">,
): ParsedCli {
  return { command, ...fields };
}
