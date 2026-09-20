/**
 * Fixture stdio MCP server exposing **resources** only.
 *
 * Paired with tests/fixtures/mcp-server/server.ts (same shape, tools only):
 * that server exposes 4 tools (echo / fail / slow / added-on-listchange),
 * this one exposes 4 resources (small / large / empty / blob) — the two
 * fixtures cover the tools and resources MCP protocol paths separately.
 *
 * Usage:
 *   1. spawn this fixture → createMcpManager → list_mcp_resources aggregate
 *      contains at least 1 fixture resource;
 *   2. read_mcp_resource on small://fixture → real text content returned;
 *   3. large://fixture triggers executor truncation (50_000 chars > 20000 threshold);
 *   4. blob://fixture returns base64 content;
 *   5. empty://fixture boundary (content length 0);
 *   6. SIGTERM shutdown — the process must really exit.
 *
 * Protocol implementation (minimal MCP stdio subset):
 *   - initialize → declare capabilities including resources:{}
 *   - notifications/initialized → silent ack
 *   - resources/list → return the fixed 4 fixture resources
 *   - resources/read → route by uri to content (text / blob)
 *   - resources/templates/list → empty (fixture exposes no templates)
 *   - ping → ok({})
 *   - any other method → -32601 MethodNotFound
 *
 * Exit semantics: SIGTERM/SIGINT/SIGPIPE listeners → process.exit.
 *
 * Framing: newline-delimited JSON (MCP stdio spec). The framing loop mirrors
 * tests/fixtures/mcp-server/server.ts; this fixture is kept separate so a
 * failure in the resources path cannot pollute the tools path (fixture
 * isolation = debug isolation).
 */
import process from "node:process";

// ---------------------------------------------------------------------------
// Resource inventory
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
// Resource content — static and fixed; routed by uri.
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
      // 50000 chars -> hits the executor's 20000 truncation (reuses existing discipline)
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

  // Notification (no id) — server must not respond
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

  // resources/templates/list — not exposed by this fixture
  if (method === "resources/templates/list") {
    return ok(id, { resourceTemplates: [] });
  }

  // tools/* — this fixture exposes no tools, fully isolated from the tools fixture
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
// Signal handling — a stdio child process must exit on SIGTERM
// ---------------------------------------------------------------------------

process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));
process.on("SIGPIPE", () => process.exit(0));

// Startup stderr line aids debugging; keeps the stdout protocol stream clean
process.stderr.write(
  `[fixture-mcp-resources] started pid=${process.pid} resources=${FIXTURE_RESOURCES.length}\n`
);
