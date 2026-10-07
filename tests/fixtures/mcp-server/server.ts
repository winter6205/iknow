/**
 * Fixture stdio MCP server for integration tests.
 *
 * Hand-written minimal JSON-RPC MCP stdio server (Node child process). The
 * `@modelcontextprotocol/client` SDK ships only a Client, no Server class, so
 * this implements the minimal MCP protocol subset:
 *
 *   - initialize → returns protocolVersion + capabilities({tools:{}})+ serverInfo
 *   - notifications/initialized → silent ack (no response)
 *   - tools/list → the four tools [echo / fail / slow / listchanged]
 *   - tools/call → three wire shapes (text / structuredContent / isError),
 *     covering the adapter's three branches
 *   - notifications/tools/list_changed → triggers onListChanged
 *     (this server does not emit it on its own; it waits for client polling)
 *
 * **How list_changed is triggered**: the server watches a trigger file
 * (default `<tmp>/iknow-mcp-listchanged-<pid>.flag`, overridable via env
 * LISTCHANGED_FILE). When the test touches this file the server immediately
 * sends the client a `notifications/tools/list_changed` notification. The new
 * tool (`added-on-listchange`) appears in tools/list only after list_changed,
 * implementing the "re-read tools" contract.
 *
 * **Exit semantics**: SIGTERM/SIGINT listeners call process.exit right away —
 * a stdio child must really exit on SIGTERM.
 *
 * **Framing**: newline-delimited JSON (MCP stdio spec — same read-buffer
 * approach as the SDK: split on "\n" then JSON.parse).
 *
 * **Status codes** (MCP spec reserved error-code range):
 *   - ParseError(-32700) / InvalidRequest(-32600) / MethodNotFound(-32601)
 *   - InvalidParams(-32602) / InternalError(-32603)
 */
import { watch } from "node:fs";
import process from "node:process";

// ---------------------------------------------------------------------------
// Tool inventory
// ---------------------------------------------------------------------------

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const BASE_TOOLS: readonly ToolDef[] = [
  {
    name: "echo",
    description:
      "Echo input text back as structuredContent (covers adapter structuredContent branch).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "text to echo" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "fail",
    description:
      "Always returns isError=true with a text content block (covers adapter isError branch).",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "reason text" },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "slow",
    description:
      "Sleeps then echoes; useful for timeout/cancel tests (returns structuredContent).",
    inputSchema: {
      type: "object",
      properties: {
        ms: { type: "number", description: "milliseconds to sleep" },
        text: { type: "string", description: "text to echo after sleep" },
      },
      required: ["ms", "text"],
      additionalProperties: false,
    },
  },
];

/**
 * The "new tool" that appears only after list_changed.
 * Design: the test triggers list_changed -> the tool list is expected to gain this entry.
 */
const LISTCHANGED_ADDED_TOOL: ToolDef = {
  name: "added-on-listchange",
  description:
    "Appears only after the server has emitted a list_changed notification (covers SC15 re-registration).",
  inputSchema: {
    type: "object",
    properties: {
      value: { type: "string" },
    },
    required: ["value"],
    additionalProperties: false,
  },
};

let toolsAfterListChanged = false;

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function ok(id: number | string | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
}

function err(
  id: number | string | null,
  code: number,
  message: string
): string {
  return (
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    }) + "\n"
  );
}

/** Proactively send a notification (no id, server -> client). */
function notify(method: string, params: unknown): void {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
  );
}

// ---------------------------------------------------------------------------
// tools/call dispatch
// ---------------------------------------------------------------------------

interface CallResult {
  readonly content: ReadonlyArray<{
    readonly type: "text";
    readonly text: string;
  }>;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

async function callTool(
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<CallResult> {
  switch (name) {
    case "echo": {
      const text = typeof args.text === "string" ? args.text : "";
      return {
        content: [{ type: "text", text }],
        structuredContent: { text },
      };
    }
    case "fail": {
      const reason = typeof args.reason === "string" ? args.reason : "boom";
      return {
        content: [{ type: "text", text: reason }],
        isError: true,
      };
    }
    case "slow": {
      const ms = Number(args.ms) || 0;
      const text = typeof args.text === "string" ? args.text : "";
      await new Promise((r) => setTimeout(r, ms));
      return {
        content: [{ type: "text", text: text || "(no text)" }],
        structuredContent: { text: text || "(no text)", sleptMs: ms },
      };
    }
    case LISTCHANGED_ADDED_TOOL.name: {
      const value = typeof args.value === "string" ? args.value : "";
      return {
        content: [{ type: "text", text: value }],
        structuredContent: { value },
      };
    }
    default:
      return {
        content: [{ type: "text", text: `unknown tool: ${name}` }],
        isError: true,
      };
  }
}

// ---------------------------------------------------------------------------
// List-changed trigger file watcher
// ---------------------------------------------------------------------------

const triggerFile =
  process.env["LISTCHANGED_FILE"] ??
  `/tmp/iknow-mcp-listchanged-${process.pid}.flag`;

let triggerWatcher: ReturnType<typeof watch> | undefined;

/**
 * When the client (test) touches triggerFile, the server immediately sends
 * notifications/tools/list_changed and flips toolsAfterListChanged to true;
 * subsequent tools/list returns BASE_TOOLS + LISTCHANGED_ADDED_TOOL.
 */
function installListChangedWatcher(): void {
  try {
    triggerWatcher = watch(triggerFile, { persistent: false }, () => {
      if (toolsAfterListChanged) return; // one-shot switch, no repeats
      toolsAfterListChanged = true;
      try {
        notify("notifications/tools/list_changed", {});
      } catch {
        /* stdout closed, ignore */
      }
    });
    triggerWatcher.on("error", () => {
      /* file missing/unreadable — ignore */
    });
  } catch {
    // fs.watch threw — ignore; the list_changed test skips itself
  }
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function handleRequest(msg: Readonly<Record<string, unknown>>): string | null {
  const id = (msg["id"] ?? null) as number | string | null;
  const method = typeof msg.method === "string" ? msg.method : "";
  const params = (msg["params"] ?? {}) as Readonly<Record<string, unknown>>;

  // Notification (no id) — server must not respond
  if (id === null && !("id" in msg)) {
    // notifications/initialized -> silent
    if (method === "notifications/initialized") return null;
    if (method === "notifications/cancelled") return null;
    // ping received as notification -> silent
    if (method === "ping") return null;
    return null;
  }

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "iknow-fixture-mcp", version: "0.0.0" },
    });
  }

  if (method === "ping") {
    return ok(id, {});
  }

  if (method === "tools/list") {
    const tools = toolsAfterListChanged
      ? [...BASE_TOOLS, LISTCHANGED_ADDED_TOOL]
      : [...BASE_TOOLS];
    return ok(id, { tools });
  }

  if (method === "tools/call") {
    const name = typeof params["name"] === "string" ? params["name"] : "";
    const args = (params["arguments"] ?? {}) as Readonly<
      Record<string, unknown>
    >;
    // Runs async — but the response still goes out via stdout (all fixture tools are sync or handle setTimeout internally)
    void callTool(name, args).then(
      (result) => {
        try {
          process.stdout.write(ok(id, result));
        } catch {
          /* closed */
        }
      },
      (e: unknown) => {
        try {
          process.stdout.write(
            err(id, -32603, e instanceof Error ? e.message : String(e))
          );
        } catch {
          /* closed */
        }
      }
    );
    // The response is emitted asynchronously via stdout.write; nothing returned here
    return null;
  }

  // resources/list / prompts/list — not implemented by this fixture
  if (method === "resources/list" || method === "prompts/list") {
    return ok(id, { resources: [], prompts: [] });
  }

  return err(id, -32601, `method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// Framing loop — read stdin, split JSON on \n
// ---------------------------------------------------------------------------

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  let idx = buffer.indexOf("\n");
  while (idx >= 0) {
    const line = buffer.subarray(0, idx).toString("utf8").replace(/\r$/, "");
    buffer = buffer.subarray(idx + 1);
    idx = buffer.indexOf("\n");
    if (line.trim().length === 0) continue;
    // Hoisted out of the try: the catch below needs the parsed id to answer a
    // request whose *handler* threw (a failed JSON.parse leaves it undefined,
    // which is the notification-style no-id case).
    let msg: Readonly<Record<string, unknown>> | undefined;
    try {
      msg = JSON.parse(line) as Readonly<Record<string, unknown>>;
      const response = handleRequest(msg);
      if (response !== null) {
        process.stdout.write(response);
      }
    } catch (e) {
      // ParseError -> reply with -32700; if no id is present, emit an error in notification style
      const id =
        msg && typeof msg === "object" && "id" in msg
          ? ((msg as Record<string, unknown>)["id"] as number | string | null)
          : null;
      try {
        process.stdout.write(
          err(id, -32700, e instanceof Error ? e.message : String(e))
        );
      } catch {
        /* closed */
      }
    }
  }
});

process.stdin.on("end", () => {
  cleanup();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Signal handling — a stdio child process must exit on SIGTERM
// ---------------------------------------------------------------------------

let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  if (triggerWatcher) {
    try {
      triggerWatcher.close();
    } catch {
      /* ignore */
    }
  }
}

process.on("SIGTERM", () => {
  cleanup();
  process.exit(143); // 128 + SIGTERM(15)
});
process.on("SIGINT", () => {
  cleanup();
  process.exit(130); // 128 + SIGINT(2)
});
process.on("SIGPIPE", () => {
  cleanup();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Startup — install the trigger watcher
// ---------------------------------------------------------------------------

installListChangedWatcher();

// Startup stderr line aids debugging; keeps the stdout protocol stream clean
process.stderr.write(
  `[fixture-mcp] started pid=${process.pid} trigger=${triggerFile}\n`
);
