/**
 * T13 (#440 Stream B) — fixture stdio MCP server exposing **resources** only.
 *
 * 与 tests/fixtures/mcp-server/server.ts（同形但只暴露 tools）配对：
 * 那个 server 暴露 4 个 tool (echo / fail / slow / added-on-listchange)，
 * 本 server 暴露 4 个 resource（small / large / empty / blob）—— 双 fixture
 * 分别覆盖 tools 和 resources 两条 MCP 协议路径。
 *
 * 用途（acceptance of plan T13）：
 *   1. spawn fixture server → createMcpManager → list_mcp_resources 聚合含
 *      至少 1 条 fixture 资源；
 *   2. read_mcp_resource 读 small://fixture → 真实 text 内容返回；
 *   3. large://fixture 触发 executor 截断行为（50_000 字符 > 20000 阈值）；
 *   4. blob://fixture 返回 base64 内容；
 *   5. empty://fixture 边界（content 长度 0）；
 *   6. shutdown SIGTERM — 子孙必须真正退出（SC11）。
 *
 * 协议实现（MCP stdio 最小子集）：
 *   - initialize → 声明 capabilities 含 resources:{}
 *   - notifications/initialized → 静默 ack
 *   - resources/list → 返回固定 4 个 fixture resource
 *   - resources/read → 按 uri 路由到对应内容(text / blob)
 *   - resources/templates/list → 空（fixture 不暴露模板）
 *   - ping → ok({})
 *   - 任何其他方法 → -32601 MethodNotFound
 *
 * 退出语义：SIGTERM/SIGINT/SIGPIPE 监听 → process.exit。SC11 守门。
 *
 * Framing：newline-delimited JSON (MCP stdio spec)。Framing loop 与
 * tests/fixtures/mcp-server/server.ts 同形(本 fixture 拆开是为了让 T13
 * 端到端链路失败时不污染 T10 tools 链路,fixture 隔离 = 调试隔离)。
 */
import process from "node:process";

// ---------------------------------------------------------------------------
// Resource 清单
// ---------------------------------------------------------------------------

interface ResourceDef {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

const FIXTURE_RESOURCES: readonly ResourceDef[] = [
  {
    uri: "small://fixture",
    name: "small-fixture",
    description: "Short text resource for happy-path read tests.",
    mimeType: "text/plain",
  },
  {
    uri: "large://fixture",
    name: "large-fixture",
    description:
      "Large text resource (~50000 chars) to exercise executor 20000 truncation downstream.",
    mimeType: "text/plain",
  },
  {
    uri: "blob://fixture",
    name: "blob-fixture",
    description: "Binary content (base64-encoded) for text/blob mutex branch.",
    mimeType: "application/octet-stream",
  },
  {
    uri: "empty://fixture",
    name: "empty-fixture",
    description: "Empty content resource for zero-length boundary.",
    mimeType: "text/plain",
  },
];

// ---------------------------------------------------------------------------
// Resource content — 静态固定;按 uri 路由。
// ---------------------------------------------------------------------------

function resourceContent(uri: string): {
  readonly uri: string;
  readonly mimeType: string;
  readonly text?: string;
  readonly blob?: string;
} {
  switch (uri) {
    case "small://fixture":
      return {
        uri,
        mimeType: "text/plain",
        text: "hello from fixture resource server",
      };
    case "large://fixture": {
      // 50000 字符 → executor 20000 截断兜底（M3 决议：复用现有纪律）
      const chunk = "ABCDEFGHIJ".repeat(5_000); // 50_000 chars
      return { uri, mimeType: "text/plain", text: chunk };
    }
    case "blob://fixture": {
      const bytes = Buffer.from("binary-fixture-data", "utf8");
      return {
        uri,
        mimeType: "application/octet-stream",
        blob: bytes.toString("base64"),
      };
    }
    case "empty://fixture":
      return { uri, mimeType: "text/plain", text: "" };
    default:
      throw new Error(`resource not found: ${uri}`);
  }
}

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

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function handleRequest(msg: Readonly<Record<string, unknown>>): string | null {
  const id = (msg["id"] ?? null) as number | string | null;
  const method = typeof msg.method === "string" ? msg.method : "";
  const params = (msg["params"] ?? {}) as Readonly<Record<string, unknown>>;

  // 通知类 (id 缺失) — 服务端不回应
  if (id === null && !("id" in msg)) {
    if (
      method === "notifications/initialized" ||
      method === "notifications/cancelled" ||
      method === "ping"
    ) {
      return null;
    }
    return null;
  }

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: "2024-11-05",
      capabilities: { resources: {} },
      serverInfo: { name: "iknow-fixture-mcp-resources", version: "0.0.0" },
    });
  }

  if (method === "ping") {
    return ok(id, {});
  }

  if (method === "resources/list") {
    // Map to MCP wire shape (uri / name / description / mimeType)
    return ok(id, {
      resources: FIXTURE_RESOURCES.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    });
  }

  if (method === "resources/read") {
    const uri = typeof params["uri"] === "string" ? params["uri"] : "";
    if (!uri) {
      return err(id, -32602, "resources/read: uri is required");
    }
    try {
      const content = resourceContent(uri);
      return ok(id, { contents: [content] });
    } catch (e) {
      // -32002 = ResourceNotFound (MCP spec reserved range)
      return err(id, -32002, e instanceof Error ? e.message : String(e));
    }
  }

  // resources/templates/list — 本 fixture 不暴露
  if (method === "resources/templates/list") {
    return ok(id, { resourceTemplates: [] });
  }

  // tools/* — 本 fixture 不暴露工具,与 tools fixture 完全隔离
  if (
    method === "tools/list" ||
    method === "tools/call" ||
    method === "prompts/list" ||
    method === "prompts/get"
  ) {
    return ok(id, { tools: [], prompts: [] });
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
  process.exit(0);
});

// ---------------------------------------------------------------------------
// 信号处理 — SC11 (stdio 子孙收到 SIGTERM 必须退出)
// ---------------------------------------------------------------------------

process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));
process.on("SIGPIPE", () => process.exit(0));

// 启动 stderr 行便于调试;不污染 stdout 协议流
process.stderr.write(
  `[fixture-mcp-resources] started pid=${process.pid} resources=${FIXTURE_RESOURCES.length}\n`
);
