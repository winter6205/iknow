/**
 * #49 host-smoke: a real MCP Host over stdio.
 *
 * What this proves (per wayfinder map #33 / ticket #49, partial):
 *   (a) stdio JSON-RPC handshake: initialize / initialized notification work
 *       under a real MCP client (v2 `@modelcontextprotocol/client`'s Client
 *       + StdioClientTransport spawning our own dist/index.js).
 *   (b) tool discovery: tools/list returns the registered MVP tool set.
 *   (c) tool call: tools/call on the registered tool returns the
 *       documented text-content shape.
 *   (d) host-agnostic decoupling (negative check): the dist artifact's
 *       runtime imports do NOT include anything from the iknow repo.
 *
 * What this does NOT prove yet (gated on T-005 / #36):
 *   - The full ingest -> retrieve flow (valid_window slicing) — those
 *     tools only exist after stage 1 is built. #49 final acceptance
 *     Gate cannot close until T-005 lands.
 *
 * Why v2 lets the transport own the child process: in v1 we hand-spawned
 * the server and handed its stdio to StdioClientTransport, but the v1
 * transport's `close()` did not manage the externally-spawned child, so
 * the server never exited (we had to SIGKILL after a 5s safety net).
 * v2's StdioClientTransport takes `command`/`args`/`env` and runs the
 * child internally with a proper close lifecycle (stdin.end -> SIGTERM
 * -> SIGKILL), so we just point it at dist/index.js and let it run.
 *
 * Why spawn the compiled `dist/index.js` (not `tsx src/index.ts`): the
 * compiled artifact is what Claude Code would launch in production per
 * `.mcp.json`. Exercising it exercises the wire contract end-to-end.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { describe, expect, test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const distEntry = path.join(pkgRoot, "dist", "index.js");

/**
 * Parameters a real reference host (Claude Code, per `.mcp.json`) would
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
    env: { ...process.env, GRAPHRAG_MEMORY_TRANSPORT: "stdio" },
    // Pipe stderr so the test sees fatal output if the server crashes;
    // it's the same default Claude Code uses for diagnostics.
    stderr: "pipe" as const,
  };
}

describe("host-smoke: real stdio MCP client against built server", () => {
  test(
    "initialize -> tools/list -> tools/call happy path",
    { timeout: 30_000 },
    async () => {
      const transport = new StdioClientTransport(serverParams());
      const client = new Client(
        { name: "host-smoke", version: "0.0.0" },
        { capabilities: {} }
      );

      try {
        await client.connect(transport);

        // (a) handshake: serverInfo present.
        const serverInfo = client.getServerVersion();
        expect(serverInfo?.name).toBe("graphrag-memory");
        expect(serverInfo?.version).toBeDefined();

        // (b) tool discovery: MVP currently exposes only `echo` (stage 0).
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        expect(names).toContain("echo");

        const echo = tools.find((t) => t.name === "echo")!;
        expect(echo.description).toMatch(/placeholder|stage/i);
        expect(echo.inputSchema).toBeDefined();
        expect((echo.inputSchema as { type?: string }).type).toBe("object");

        // (c) tool call: round-trip the message.
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

        // (d) negative input: v2 wraps input-validation failures as a
        // CallToolResult with isError:true (a tool-result semantics, not a
        // JSON-RPC error that rejects the promise). v1 rejected instead.
        // The schema's `min(1)` still fires - we just observe it via the
        // result shape now.
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
      } finally {
        // v2 StdioClientTransport.close() drives the child's stdin.end ->
        // SIGTERM -> SIGKILL; we no longer hand-spawn or hand-kill.
        await client.close();
      }
    }
  );

  test("host-agnostic: built artifact does not import from iknow runtime", () => {
    // The decoupled scaffold (per #35) ships zero imports from iknow.
    // Check the compiled JS — imports survive tsc into `from "…"` /
    // `require("…")` statements, so a literal grep is sufficient proof.
    // We anchor on the import/require keyword to avoid matching string
    // literals that merely MENTION a forbidden path inside comments or
    // error messages (a bare /shared\/schema/ regex did that, producing
    // a false positive against the doc-comment block in dist/index.js).
    const src = readFileSync(distEntry, "utf8");
    expect(src).not.toMatch(/from\s+["']\.\.\/\.\.\/src\b/);
    expect(src).not.toMatch(/from\s+["']\.\.\/\.\.\/\.\.\/src\b/);
    expect(src).not.toMatch(/require\(["']\.\.\/\.\.\/src\b/);
    expect(src).not.toMatch(/from\s+["'][^"']*shared\/schema/);
    expect(src).not.toMatch(/from\s+["'][^"']*config\/env/);
  });
});
