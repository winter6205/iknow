/**
 * #49 host-smoke: a real MCP Host over stdio.
 *
 * Proves (per wayfinder map #33 / ticket #49, partial):
 *   (a) stdio JSON-RPC handshake: initialize / initialized under a real
 *       MCP client (v2 @modelcontextprotocol/client's Client +
 *       StdioClientTransport spawning our dist/index.js).
 *   (b) tool discovery: tools/list returns the registered MVP tool set.
 *   (c) tool call: tools/call round-trips the documented text shape.
 *   (d) negative input: empty message -> isError:true result (v2 wraps
 *       input-validation failures as a tool result, not a JSON-RPC error).
 *   (e) concurrent clients: two clients against one server each complete.
 *   (f) zod4 JSON Schema: the echo inputSchema carries minLength:1 (zod
 *       v4 maps .min(1) to minLength, not the v3 minimum), proving the
 *       3.25 -> 4.2 upgrade did not silently drop the constraint.
 *   (g) host-agnostic decoupling (negative check): the dist artifact's
 *       runtime imports do NOT include anything from the iknow repo.
 *
 * NOT proven yet (gated on T-005 / #36): the HTTP transport equivalent of
 * every stdio check above. The stdio end-to-end round-trip (a4) is covered
 * once stage 1 wires ingest + retrieve.
 *
 * Why v2 lets the transport own the child process: in v1 we hand-spawned
 * the server and handed its stdio to StdioClientTransport, but the v1
 * transport's close() did not manage the externally-spawned child, so
 * the server never exited (5s SIGKILL safety net). v2's
 * StdioClientTransport takes command/args/env and runs the child
 * internally with a proper close lifecycle (stdin.end -> SIGTERM ->
 * SIGKILL + explicit pipe-handle disposal).
 *
 * Why spawn the compiled dist/index.js (not `tsx src/index.ts`): the
 * compiled artifact is what Claude Code launches in production per
 * .mcp.json. Exercising it exercises the wire contract end-to-end.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { afterEach, describe, expect, test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const distEntry = path.join(pkgRoot, "dist", "index.js");

/**
 * Env-var keys whose presence can switch the spawned server to a mode that
 * is unsafe for the host-smoke harness (pgvector needs a live Postgres,
 * NINE_ROUTER_KEY triggers paid network calls). The host-smoke suite must
 * always run in memory + FakeEmbedder mode.
 */
const HOST_SMOKE_ENV_KEYS = [
  "GRAPHRAG_MEMORY_STORAGE",
  "GRAPHRAG_MEMORY_DB_URL",
  "GRAPHRAG_MEMORY_EMBED_BASE_URL",
  "GRAPHRAG_MEMORY_EMBED_MODEL",
  "NINE_ROUTER_KEY",
] as const;

/**
 * Build the child-process env: pinned to memory storage with FakeEmbedder,
 * inheriting everything else from the parent. Without this, a developer
 * machine with `NINE_ROUTER_KEY` exported would silently pay for embeddings
 * during `npm test`, and an accidental `GRAPHRAG_MEMORY_STORAGE=pgvector`
 * would crash with "no Postgres available" instead of running deterministically.
 */
function hostSmokeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env["GRAPHRAG_MEMORY_STORAGE"] = "memory";
  delete env["GRAPHRAG_MEMORY_DB_URL"];
  delete env["NINE_ROUTER_KEY"];
  // Keep BASE_URL / MODEL if the parent set them — they are inert without
  // a key, and a custom value shouldn't surprise the operator by being
  // silently overridden during smoke tests.
  return env;
}

/**
 * Parameters a real reference host (Claude Code, per .mcp.json) would
 * use to launch this server. v2's StdioClientTransport takes these and
 * owns the child process for its full lifecycle.
 */
function serverParams() {
  if (!existsSync(distEntry)) {
    throw new Error(
      `dist entry not found: ${distEntry} - run \`npm run build --workspace graphrag-memory\` first`
    );
  }
  return {
    command: process.execPath,
    args: [distEntry],
    env: hostSmokeEnv(),
    stderr: "pipe" as const,
  };
}

/**
 * Connect a fresh client to a freshly-spawned server. Each test owns its
 * own (client, transport) pair so failures in one cannot leak into the
 * next; afterEach closes them.
 */
async function connectClient(): Promise<Client> {
  const transport = new StdioClientTransport(serverParams());
  const client = new Client(
    { name: "host-smoke", version: "0.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

describe("host-smoke: real stdio MCP client against built server", () => {
  // Each test registers its client here so afterEach can close it even on
  // assertion failure (otherwise the spawned server would leak).
  const clients: Client[] = [];
  afterEach(async () => {
    while (clients.length > 0) {
      await clients.pop()!.close();
    }
  });

  test(
    "handshake returns graphrag-memory serverInfo",
    { timeout: 30_000 },
    async () => {
      const client = await connectClient();
      clients.push(client);

      const serverInfo = client.getServerVersion();
      expect(serverInfo?.name).toBe("graphrag-memory");
      expect(serverInfo?.version).toBeDefined();
    }
  );

  test(
    "tools/list returns echo with an object inputSchema",
    { timeout: 30_000 },
    async () => {
      const client = await connectClient();
      clients.push(client);

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("echo");

      const echo = tools.find((t) => t.name === "echo")!;
      expect(echo.description).toMatch(/placeholder|stage/i);
      expect((echo.inputSchema as { type?: string }).type).toBe("object");
    }
  );

  test(
    "tools/call round-trips the message as text content",
    { timeout: 30_000 },
    async () => {
      const client = await connectClient();
      clients.push(client);

      const message = "ping from host-smoke @ " + new Date().toISOString();
      const result = await client.callTool({
        name: "echo",
        arguments: { message },
      });
      expect(result.isError).not.toBe(true);

      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      expect(text).toBe(message);
    }
  );

  test(
    "empty message returns isError:true result (v2 semantics)",
    { timeout: 30_000 },
    async () => {
      const client = await connectClient();
      clients.push(client);

      // v2 wraps input-validation failures as a CallToolResult with
      // isError:true (tool-result semantics), NOT a JSON-RPC error that
      // rejects the promise. v1 rejected; the schema's min(1) still fires.
      const bad = await client.callTool({
        name: "echo",
        arguments: { message: "" },
      });
      expect(bad.isError).toBe(true);

      const badText = (bad.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      expect(badText).toMatch(/non-empty|validation/i);
    }
  );

  test(
    "concurrent clients each complete a tools/call",
    { timeout: 30_000 },
    async () => {
      // Two independent clients against two independent server processes,
      // both calling echo in parallel. A transport/event-loop regression
      // (the v1 teardown-hang class) would surface as a hang or timeout.
      const [a, b] = await Promise.all([connectClient(), connectClient()]);
      clients.push(a, b);

      const [ra, rb] = await Promise.all([
        a.callTool({ name: "echo", arguments: { message: "from-A" } }),
        b.callTool({ name: "echo", arguments: { message: "from-B" } }),
      ]);
      expect(ra.isError).not.toBe(true);
      expect(rb.isError).not.toBe(true);
    }
  );

  test(
    "zod4 emits minLength:1 on echo inputSchema (3.25 -> 4.2 regression guard)",
    { timeout: 30_000 },
    async () => {
      // zod v3 mapped .min(1) on a string to `minimum` (wrong keyword for
      // strings); zod v4 maps it to `minLength`. If the 3.25 -> 4.2 upgrade
      // silently downgraded the schema, this catches it. We read the wire
      // shape the server actually advertises (the SDK converts the Zod
      // object to JSON Schema on tools/list), not the Zod object directly.
      const client = await connectClient();
      clients.push(client);

      const { tools } = await client.listTools();
      const echo = tools.find((t) => t.name === "echo")!;
      const messageProp = (
        echo.inputSchema as { properties?: Record<string, unknown> }
      ).properties?.message as
        { minLength?: number; type?: string } | undefined;
      expect(messageProp?.type).toBe("string");
      expect(messageProp?.minLength).toBe(1);
    }
  );

  test(
    "a4: ingest -> retrieve round-trips Chinese content through the real stdio transport",
    { timeout: 60_000 },
    async () => {
      // Closes the remaining gate on #49 (per the file header): a real
      // reference host (Claude Code per .mcp.json) drives the server, so
      // the transport-layer protocol survives the full ingest -> retrieve
      // round-trip. The Chinese text exercises UTF-8 end-to-end: chunker,
      // FakeEmbedder (char-code-driven), JSON wire framing, and the chunk
      // content round-trip through the retrieve response.
      const client = await connectClient();
      clients.push(client);

      const content = "张三于2024年创办了公司A，公司位于北京。";
      const sourceRef = "test-bio.md";

      const ingested = await client.callTool({
        name: "ingest",
        arguments: { content, source_ref: sourceRef },
      });
      expect(ingested.isError).not.toBe(true);
      const ingestBody = (
        ingested.content as Array<{ type: string; text?: string }>
      )
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      const ingestPayload = JSON.parse(ingestBody) as { chunk_ids: string[] };
      expect(Array.isArray(ingestPayload.chunk_ids)).toBe(true);
      expect(ingestPayload.chunk_ids.length).toBeGreaterThan(0);

      const retrieved = await client.callTool({
        name: "retrieve",
        arguments: { query: "张三创办了什么公司" },
      });
      expect(retrieved.isError).not.toBe(true);
      const retrieveBody = (
        retrieved.content as Array<{ type: string; text?: string }>
      )
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      const retrievePayload = JSON.parse(retrieveBody) as {
        chunks: Array<{
          id: string;
          content: string;
          source_ref: string;
          valid_window: [string, string | null];
          score: number;
        }>;
      };
      expect(Array.isArray(retrievePayload.chunks)).toBe(true);
      expect(retrievePayload.chunks.length).toBeGreaterThan(0);

      const topHit = retrievePayload.chunks[0]!;
      // The ingested Chinese text (or, for longer inputs, the chunked
      // window containing 公司A / 张三) must surface as a retrieved chunk.
      // Either the top hit's content carries the original phrases, or one
      // of the other hits does — accept any that mention the substance.
      const allContent = retrievePayload.chunks
        .map((c) => c.content)
        .join("\n");
      expect(allContent).toMatch(/公司A|张三/);
      expect(topHit.score).toBeGreaterThan(0);
      expect(topHit.source_ref).toBe(sourceRef);
    }
  );

  test("host-agnostic: built artifact does not import from iknow runtime", () => {
    // Imports survive tsc into `from "..."` / `require("...")` statements,
    // so a literal grep is sufficient proof. Anchor on the import/require
    // keyword to avoid matching string literals that merely MENTION a
    // forbidden path in comments (a bare /shared\/schema/ regex did that,
    // false-positive-matching the doc comment in dist/index.js).
    const src = readFileSync(distEntry, "utf8");
    expect(src).not.toMatch(/from\s+["']\.\.\/\.\.\/src\b/);
    expect(src).not.toMatch(/from\s+["']\.\.\/\.\.\/\.\.\/src\b/);
    expect(src).not.toMatch(/require\(["']\.\.\/\.\.\/src\b/);
    expect(src).not.toMatch(/from\s+["'][^"']*shared\/schema/);
    expect(src).not.toMatch(/from\s+["'][^"']*config\/env/);
  });
});
