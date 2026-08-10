/**
 * T10 (#344) — fixture stdio MCP server for integration tests.
 *
 * 手写最小 JSON-RPC MCP stdio server（Node 子进程）。`@modelcontextprotocol/client`
 * 的 SDK 只提供 Client 端,没有 Server 类;此处实现 MCP 协议的最小子集:
 *
 *   - initialize → 返回 protocolVersion + capabilities({tools:{}})+ serverInfo
 *   - notifications/initialized → 静默 ack (无 response)
 *   - tools/list → 返回 [echo / fail / slow / listchanged] 四件
 *   - tools/call → 返回三种形态(text / structuredContent / isError),
 *     覆盖 adapter wire 三分支
 *   - notifications/tools/list_changed → 触发 onListChanged
 *     (本 server 自身不发,等客户端 polling)
 *
 * **触发 list_changed 的方式**:server 监听一个 "list_changed 触发文件"
 * (默认 `<tmp>/iknow-mcp-listchanged-<pid>.flag`,由 env LISTCHANGED_FILE
 * 覆盖)。测试 touch 这个文件 → server 立即给 client 发一条
 * `notifications/tools/list_changed` notification。新工具
 * (`added-on-listchange`) 在 list_changed 之后才出现在 tools/list 响应里,
 * 实现"重读工具"的契约。
 *
 * **退出语义**:监听 SIGTERM/SIGINT,收到立刻 process.exit(0) 退出,
 * 满足 SC11 (stdio 子孙收到 SIGTERM 必须退出)。
 *
 * **Framing**:newline-delimited JSON (MCP stdio spec — 参考 SDK
 * stdio.mjs ReadBuffer:buf.indexOf("\n") 拆行 + JSON.parse)。
 *
 * **Status codes** (MCP spec, error code 保留区间):
 *   - ParseError(-32700) / InvalidRequest(-32600) / MethodNotFound(-32601)
 *   - InvalidParams(-32602) / InternalError(-32603)
 */
import { watch } from "node:fs";
import process from "node:process";

// ---------------------------------------------------------------------------
// 工具清单
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
 * 只在 list_changed 之后才出现的"新工具"。
 * 设计:测试触发 list_changed → 期待工具清单多了这个。
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

/** 主动发 notification (无 id,服务端→客户端)。 */
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
 * 客户端 (test) touch triggerFile → server 立刻给 client 发
 * notifications/tools/list_changed,且内部 toolsAfterListChanged 翻为 true,
 * 后续 tools/list 返回 BASE_TOOLS + LISTCHANGED_ADDED_TOOL。
 */
function installListChangedWatcher(): void {
  try {
    triggerWatcher = watch(triggerFile, { persistent: false }, () => {
      if (toolsAfterListChanged) return; // 单次切换,避免重复
      toolsAfterListChanged = true;
      try {
        notify("notifications/tools/list_changed", {});
      } catch {
        /* stdout 关闭,忽略 */
      }
    });
    triggerWatcher.on("error", () => {
      /* 文件不存在/不可读 — 忽略 */
    });
  } catch {
    // fs.watch 抛 — 忽略,list_changed 测试会自己跳过
  }
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function handleRequest(msg: Readonly<Record<string, unknown>>): string | null {
  const id = (msg["id"] ?? null) as number | string | null;
  const method = typeof msg.method === "string" ? msg.method : "";
  const params = (msg["params"] ?? {}) as Readonly<Record<string, unknown>>;

  // 通知类 (id 缺失) — 服务端不回应
  if (id === null && !("id" in msg)) {
    // notifications/initialized → 静默
    if (method === "notifications/initialized") return null;
    if (method === "notifications/cancelled") return null;
    // ping 作为通知接收 → 静默
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
    // 异步执行 — 但 respond 仍同步(本 fixture 工具都是同步的或 setTimeout 内部处理)
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
    // 响应通过 stdout.write 异步发出;此处不返回
    return null;
  }

  // resources/list / prompts/list — 本 fixture 不实现
  if (method === "resources/list" || method === "prompts/list") {
    return ok(id, { resources: [], prompts: [] });
  }

  return err(id, -32601, `method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// Framing loop — 读 stdin 按 \n 切分 JSON
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
    try {
      const msg = JSON.parse(line) as Readonly<Record<string, unknown>>;
      const response = handleRequest(msg);
      if (response !== null) {
        process.stdout.write(response);
      }
    } catch (e) {
      // ParseError → 用 -32700 回复;若 id 缺失则服务端发 notification 风格的 error
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
// 信号处理 — SC11 (stdio 子孙收到 SIGTERM 必须退出)
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
// 启动 — 装 trigger watcher
// ---------------------------------------------------------------------------

installListChangedWatcher();

// 启动 stderr 行便于调试;不污染 stdout 协议流
process.stderr.write(
  `[fixture-mcp] started pid=${process.pid} trigger=${triggerFile}\n`
);
