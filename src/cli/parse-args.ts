/**
 * Pure CLI argument parsing (no I/O).
 */
import {
  CALLER_ROLES,
  parseCallerRole,
  type CallerRole,
} from "../shared/schema.js";

export type CliCommand = "chat" | "ask" | "oneshot" | "help" | "serve";

export type ParsedCli = {
  command: CliCommand;
  query: string;
  role: CallerRole;
  degrade: boolean;
  embeddings: boolean;
  json: boolean;
  /**
   * ask/oneshot with empty query text.
   * Host should print usage and exit 1 (no default demo query).
   */
  missingQuery: boolean;
  /**
   * True when argv was `-V` / `--version` (host prints version only).
   */
  versionOnly: boolean;
  /**
   * HTTP listen port for `serve` (default 8787 when command is serve).
   */
  port: number;
  /**
   * HTTP bind host for `serve` (default 127.0.0.1).
   */
  host: string;
  /**
   * Trace output file path for ask/serve (--trace-out flag).
   * Resolution: flag > IKNOW_TRACE_OUT env > "./trace.jsonl" (ADR-0003 D3/D4).
   */
  traceOut?: string;
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
export function parseArgs(argv: string[], opts?: ParseArgsOptions): ParsedCli {
  const interactive = opts?.interactive ?? false;
  let role: CallerRole = "employee";
  let degrade = false;
  let embeddings = false;
  let json = false;
  let port = 8787;
  let host = "127.0.0.1";
  let traceOut: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      return baseParsed("help", {
        role,
        degrade,
        embeddings,
        json,
        port,
        host,
        traceOut,
        query: "",
        missingQuery: false,
        versionOnly: false,
      });
    }
    if (a === "--role") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error(
          `Missing value for --role; expected one of: ${CALLER_ROLES.join("|")}`
        );
      }
      role = parseCallerRole(raw);
    } else if (a === "--governance-timeout") {
      degrade = true;
    } else if (a === "--embeddings") {
      embeddings = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--port") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error("Missing value for --port");
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`Invalid --port: ${raw}`);
      }
      port = n;
    } else if (a === "--host") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error("Missing value for --host");
      }
      host = raw;
    } else if (a === "--trace-out") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error("--trace-out requires a file path argument");
      }
      traceOut = raw;
    } else if (a === "--version" || a === "-V") {
      return baseParsed("help", {
        role,
        degrade,
        embeddings,
        json,
        port,
        host,
        traceOut,
        query: "",
        missingQuery: false,
        versionOnly: true,
      });
    } else {
      rest.push(a);
    }
  }

  const flags = {
    role,
    degrade,
    embeddings,
    json,
    port,
    host,
    traceOut,
    versionOnly: false,
  };
  const head = rest[0];

  if (head === "chat") {
    return baseParsed("chat", {
      ...flags,
      query: "",
      missingQuery: false,
    });
  }

  if (head === "serve") {
    return baseParsed("serve", {
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
  fields: Omit<ParsedCli, "command">
): ParsedCli {
  return { command, ...fields };
}
