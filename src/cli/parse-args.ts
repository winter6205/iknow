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
   * #356 subagent worker headless 重入 (双下划线前缀区别产品形态,spec
   * Boundaries Never)。本命令不暴露在 printUsage / getVersion 公共展示路径;
   * 仅由父代理通过 child_process.spawn 触发,operator 不直调。
   * argv 早 flag `--subagent-worker` 在 parseArgs for-loop 最前面检测,
   * 一旦命中立即返回 baseParsed,不再走任何产品分支。
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
   * Resolution: flag > IKNOW_TRACE_OUT env > "./trace/" (ADR-0003 D3/D4).
   * T2 后语义为目录：实际写 <traceOut>/<conversationId>.jsonl。
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
  /**
   * plan T5: 单次会话最大循环轮数上限(可选正整数)。
   * `undefined`(默认)= 无限;
   * 显式配置时由 host(loop-engine 等)按需解释。
   * 缺失值 / 非整数 / < 1 抛错。
   */
  maxTurns?: number;
  /**
   * T7: `--no-open` 关闭 `iknow trace` 启动后的自动开浏览器（CI/headless）。
   * 缺省 false = 默认自动 open。
   */
  noOpen: boolean;
  /**
   * T4: `iknow chat --resume <id>` 锚定既有 conversationId 续跑。解析保持
   * command-agnostic(后续 ask/serve/tui 可独立决策是否消费);仅 chat 入口
   * 实际消费。`undefined`(默认)= 新开会话(随机 UUID)。
   */
  resumeId?: string;
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
 * #356 early flag: `--subagent-worker` 在 for-loop 最前面检测(早于
 * `-h` / `--version` / 既有 flag 分支)。一旦命中立即返回
 * `baseParsed({command:"__subagent_worker__", fields:{...defaults}})`,
 * 不进入任何产品形态分支。子代理由父进程 spawn 后 stdin 喂 envelope,
 * CLI argv 不再包含 chat/ask/serve/tui 等 sub-command。
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
  let maxTurns: number | undefined;
  let noOpen = false;
  let resumeId: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // #356 early flag:在 for-loop 最前面检测,一旦命中 → 立即返回 worker
    // command。早 flag 语义覆盖后续任何 argv 项(即便用户同时塞了
    // chat/ask/serve/tui 也以 worker 优先,operator 不直调,只为父进程 spawn)。
    // 不在 printUsage / getVersion 公共展示路径露出。
    if (a === "--subagent-worker") {
      return baseParsed({
        command: "__subagent_worker__",
        fields: {
          json: false,
          port: 8787,
          host: "127.0.0.1",
          traceOut: undefined,
          dataDir: undefined,
          maxBytes: undefined,
          maxTurns: undefined,
          noOpen: false,
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
          maxBytes,
          maxTurns,
          noOpen,
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
      // T7: 布尔 flag（无实参），关闭 trace 自动开浏览器（CI/headless）。
      noOpen = true;
    } else if (a === "--resume") {
      // T4: 值式 flag —— 缺失 / 空串 / 纯空白均拒绝（镜像 --port 风格）。
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
          maxTurns,
          noOpen,
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
    maxBytes,
    maxTurns,
    noOpen,
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
