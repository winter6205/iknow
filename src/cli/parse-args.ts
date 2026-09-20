/**
 * Pure CLI argument parsing (no I/O).
 */

export type CliCommand =
  | "chat"
  | "ask"
  | "oneshot"
  | "help"
  | "serve"
  | "trace"
  | "tui"
  /**
   * Subagent worker headless re-entry (double-underscore prefix separates it
   * from product forms). Not exposed in printUsage / getVersion public
   * paths; triggered only by the parent agent via child_process.spawn, never
   * called directly by the operator. The early flag `--subagent-worker` is
   * detected at the very top of the parseArgs for-loop: on a hit we return
   * baseParsed immediately, skipping every product branch.
   */
  | "__subagent_worker__";

export type ParsedCli = {
  command: CliCommand;
  query: string;
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
   * Trace read cap (bytes) for the `trace` subcommand (--max-bytes flag).
   * Defaults to 8 MiB (MAX_TRACE_BYTES) in the reader when unset.
   */
  maxBytes?: number;
  /**
   * Trace output directory for ask/serve/tui (--trace-out flag).
   * Resolution: flag > IKNOW_TRACE_OUT env > "./trace/" (ADR-0003).
   * Directory semantics: actual writes go to
   * <traceOut>/<conversationId>.jsonl.
   */
  traceOut?: string;
  /**
   * Session pool root for serve (--data-dir flag).
   * Undefined -> serve defaults to ~/.iknow.
   */
  dataDir?: string;
  /**
   * Workspace root for per-root state (--workspace-root flag).
   * Resolved by `resolveWorkspaceRoot({explicit, cwd, env})` in the
   * build-engine / tui-deps layer. CLI here only stores the raw flag
   * value; resolver applies priority chain + validation.
   */
  workspaceRoot?: string;
  /**
   * Optional positional parameter for `tui [session-id]` — resume that
   * session directly.
   */
  sessionId?: string;
  /**
   * Max loop turns for a single run (optional positive integer).
   * `undefined` (default) = unlimited; explicit values are interpreted by
   * the host (loop-engine etc.). Missing value / non-integer / < 1 throws.
   */
  maxTurns?: number;
  /**
   * `--no-open` disables the auto browser-open after `iknow trace` starts
   * (CI/headless). Default false = auto-open.
   */
  noOpen: boolean;
  /**
   * ADR-0020: `iknow trace --separate` escape hatch — keeps the
   * standalone-process mode (default port 24881). Default false = probe
   * `iknow serve` and point at the same-process /trace panel.
   */
  separate: boolean;
  /**
   * `iknow chat --resume <id>` anchors an existing conversationId to
   * continue. Parsing stays command-agnostic (ask/serve/tui may each decide
   * to consume it later); only the chat entry consumes it for now.
   * `undefined` (default) = new session (random UUID).
   */
  resumeId?: string;
  /**
   * `iknow tui --auto-mode`: launch in full_auto permission mode (skip
   * tool-ask prompts). Default false. Only the tui entry consumes it; other
   * commands keep the parsed field but never read it.
   */
  autoMode: boolean;
};

export type ParseArgsOptions = {
  readonly argv: string[];
  /** When true, bare invocation (no query) defaults to chat. */
  readonly interactive?: boolean;
};

/**
 * Parse process.argv.slice(2)-style argv into a structured CLI request.
 *
 * Defaults:
 * - no positionals + interactive → chat
 * - no positionals + !interactive → help
 * - ask / bare query with empty text → missingQuery (caller exits 1)
 *
 * Early flag: `--subagent-worker` is checked at the very top of the
 * for-loop (before `-h` / `--version` / existing flag branches). A hit
 * returns `baseParsed({command:"__subagent_worker__",
 * fields:{...defaults}})` immediately, entering no product branch. The
 * parent process spawns the worker and feeds the envelope over stdin, so
 * the worker argv carries no chat/ask/serve/tui sub-command.
 */
export function parseArgs(opts: ParseArgsOptions): ParsedCli {
  const argv = opts.argv;
  const interactive = opts.interactive ?? false;
  let json = false;
  let port = 8787;
  let portSet = false;
  let host = "127.0.0.1";
  let traceOut: string | undefined;
  let dataDir: string | undefined;
  let workspaceRoot: string | undefined;
  let maxBytes: number | undefined;
  let maxTurns: number | undefined;
  let noOpen = false;
  let separate = false;
  let autoMode = false;
  let resumeId: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // Early flag: checked at the top of the for-loop; a hit returns the
    // worker command immediately. Early-flag semantics override every later
    // argv item (even if chat/ask/serve/tui are also present, worker wins —
    // the operator never calls it directly, it exists only for
    // parent-process spawn). Not shown in printUsage / getVersion.
    if (a === "--subagent-worker") {
      return baseParsed({
        command: "__subagent_worker__",
        fields: {
          json: false,
          port: 8787,
          host: "127.0.0.1",
          traceOut: undefined,
          dataDir: undefined,
          workspaceRoot: undefined,
          maxBytes: undefined,
          maxTurns: undefined,
          noOpen: false,
          separate: false,
          autoMode: false,
          query: "",
          missingQuery: false,
          versionOnly: false,
        },
      });
    }
    if (a === "-h" || a === "--help") {
      return baseParsed({
        command: "help",
        fields: {
          json,
          port,
          host,
          traceOut,
          dataDir,
          workspaceRoot,
          maxBytes,
          maxTurns,
          noOpen,
          separate,
          autoMode,
          resumeId,
          query: "",
          missingQuery: false,
          versionOnly: false,
        },
      });
    }
    if (a === "--json") {
      json = true;
    } else if (a === "--port") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error("Missing value for --port");
      }
      const n = Number(raw);
      // Port 0 is allowed → ephemeral (Node http.Server convention).
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new Error(`Invalid --port: ${raw}`);
      }
      port = n;
      portSet = true;
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
    } else if (a === "--max-bytes") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error("--max-bytes requires an integer argument");
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`Invalid --max-bytes: ${raw}`);
      }
      maxBytes = n;
    } else if (a === "--max-turns") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error("--max-turns requires an integer argument");
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`Invalid --max-turns: ${raw}`);
      }
      maxTurns = n;
    } else if (a === "--no-open") {
      // Boolean flag (no value): disables trace auto browser-open (CI/headless).
      noOpen = true;
    } else if (a === "--separate") {
      // Boolean flag (no value): trace keeps the standalone-process mode (ADR-0020).
      separate = true;
    } else if (a === "--auto-mode") {
      // TUI: start in full_auto (skip tool asks). Boolean flag, no value.
      autoMode = true;
    } else if (a === "--resume") {
      // Value flag — missing / empty / whitespace-only are rejected (mirrors --port style).
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error("--resume requires a conversation id argument");
      }
      if (raw.trim().length === 0) {
        throw new Error("--resume requires a non-empty conversation id");
      }
      resumeId = raw;
    } else if (a === "--data-dir") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error("--data-dir requires a directory argument");
      }
      dataDir = raw;
    } else if (a === "--workspace-root") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error("--workspace-root requires a directory argument");
      }
      workspaceRoot = raw;
    } else if (a === "--version" || a === "-V") {
      return baseParsed({
        command: "help",
        fields: {
          json,
          port,
          host,
          traceOut,
          dataDir,
          workspaceRoot,
          maxBytes,
          maxTurns,
          noOpen,
          separate,
          autoMode,
          resumeId,
          query: "",
          missingQuery: false,
          versionOnly: true,
        },
      });
    } else {
      rest.push(a);
    }
  }

  const flags = {
    json,
    port,
    host,
    traceOut,
    dataDir,
    workspaceRoot,
    maxBytes,
    maxTurns,
    noOpen,
    separate,
    autoMode,
    resumeId,
    versionOnly: false,
  };
  const head = rest[0];

  if (head === "chat") {
    return baseParsed({
      command: "chat",
      fields: {
        ...flags,
        query: "",
        missingQuery: false,
      },
    });
  }

  if (head === "serve") {
    return baseParsed({
      command: "serve",
      fields: {
        ...flags,
        query: "",
        missingQuery: false,
      },
    });
  }

  if (head === "trace") {
    // ADR-0020: default mode probes `iknow serve` → default port 8787
    // (serve's port); `--separate` keeps the standalone default 24881.
    // Sentinel-based: only override when the user did not pass --port, so
    // `iknow trace --port 9999` is honored verbatim.
    const tracePort = portSet ? port : separate ? 24881 : 8787;
    return baseParsed({
      command: "trace",
      fields: {
        ...flags,
        port: tracePort,
        query: "",
        missingQuery: false,
      },
    });
  }

  if (head === "tui") {
    const sessionId = rest[1];
    return baseParsed({
      command: "tui",
      fields: {
        ...flags,
        query: "",
        missingQuery: false,
        sessionId: sessionId !== undefined ? sessionId : undefined,
      },
    });
  }

  if (head === "ask") {
    const query = rest.slice(1).join(" ").trim();
    return baseParsed({
      command: "ask",
      fields: {
        ...flags,
        query,
        missingQuery: query.length === 0,
      },
    });
  }

  if (head === "help") {
    return baseParsed({
      command: "help",
      fields: {
        ...flags,
        query: "",
        missingQuery: false,
      },
    });
  }

  const query = rest.join(" ").trim();
  if (query.length === 0) {
    if (interactive) {
      return baseParsed({
        command: "chat",
        fields: {
          ...flags,
          query: "",
          missingQuery: false,
        },
      });
    }
    return baseParsed({
      command: "help",
      fields: {
        ...flags,
        query: "",
        missingQuery: false,
      },
    });
  }

  return baseParsed({
    command: "oneshot",
    fields: {
      ...flags,
      query,
      missingQuery: false,
    },
  });
}

function baseParsed(opts: {
  readonly command: CliCommand;
  readonly fields: Omit<ParsedCli, "command">;
}): ParsedCli {
  return { command: opts.command, ...opts.fields };
}
