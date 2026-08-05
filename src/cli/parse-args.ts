/**
 * Pure CLI argument parsing (no I/O).
 */

export type CliCommand =
  "chat" | "ask" | "oneshot" | "help" | "serve" | "trace" | "tui";

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
   * Trace output file path for ask/serve (--trace-out flag).
   * Resolution: flag > IKNOW_TRACE_OUT env > "./trace.jsonl" (ADR-0003 D3/D4).
   */
  traceOut?: string;
  /**
   * Session pool root for serve (--data-dir flag).
   * Undefined → serve defaults to ~/.iknow (spec #120 SC 1).
   */
  dataDir?: string;
  /**
   * `tui [session-id]` 可选位置参数（#146 SC 2：直连 resume 该会话）。
   */
  sessionId?: string;
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
  let maxBytes: number | undefined;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      return baseParsed({
        command: "help",
        fields: {
          json,
          port,
          host,
          traceOut,
          dataDir,
          maxBytes,
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
    } else if (a === "--data-dir") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error("--data-dir requires a directory argument");
      }
      dataDir = raw;
    } else if (a === "--version" || a === "-V") {
      return baseParsed({
        command: "help",
        fields: {
          json,
          port,
          host,
          traceOut,
          dataDir,
          maxBytes,
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
    maxBytes,
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
    // iknow trace: default port 24881 (serve uses 8787). Sentinel-based: only
    // override when the user did not pass --port, so `iknow trace --port 8787`
    // is honored verbatim instead of silently bumped to 24881.
    const tracePort = portSet ? port : 24881;
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
