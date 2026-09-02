import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createTraceMcpServer } from "../../src/trace-mcp/server.js";
import { createListSessionsTool } from "../../src/harness/aci/tools/list-sessions.js";
import { LIST_SESSIONS_MAX_LIMIT } from "../../src/traceserver/list-sessions-core.js";
import { createTraceFixture, type TraceFixture } from "./fixtures.js";

/** Either face's JSON Schema, narrowed to what SC18 compares. */
type FaceSchema = {
  properties: Record<
    string,
    { type?: string; minimum?: number; maximum?: number }
  >;
  additionalProperties?: unknown;
};

const fixtures: TraceFixture[] = [];
const scratchPaths: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

async function connectFixture(traceDir?: string): Promise<{
  readonly client: Client;
  readonly close: () => Promise<void>;
  readonly fixture: TraceFixture;
}> {
  const fixture = createTraceFixture();
  fixtures.push(fixture);
  const server = createTraceMcpServer({
    traceDir: traceDir ?? fixture.traceDir,
  });
  const client = new Client({
    name: "trace-mcp-test-client",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    fixture,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("trace MCP server", () => {
  it("registers the read-side faces in axis order and marks both read-only", async () => {
    // 目录轴先、行轴后（specs/trace-mcp-server.md Assumption 4 的三轴顺序）。
    // get_record joins this list in T6.
    const connected = await connectFixture();
    try {
      const result = await connected.client.listTools();

      expect(result.tools).toHaveLength(2);
      expect(result.tools.map((tool) => tool.name)).toEqual([
        "list_sessions",
        "query_trace",
      ]);
      expect(result.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(
        true
      );
    } finally {
      await connected.close();
    }
  });

  it("returns a capped projection without list-level messages", async () => {
    const connected = await connectFixture();
    try {
      const result = await connected.client.callTool({
        name: "query_trace",
        arguments: { conversation_id: "conversation-1" },
      });
      const text = result.content[0];

      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");
      expect(text.text.length).toBeLessThanOrEqual(4_000);
      expect(text.text).toContain("llm-2");
      const body = JSON.parse(text.text) as {
        records: Array<Record<string, unknown>>;
      };
      expect(body.records.every((record) => !("messages" in record))).toBe(
        true
      );
      expect(text.text).not.toContain('"messages":[');
    } finally {
      await connected.close();
    }
  });

  it("uses tool_results for record drill-down unless messages are requested", async () => {
    const connected = await connectFixture();
    try {
      const toolResults = await connected.client.callTool({
        name: "query_trace",
        arguments: {
          conversation_id: "conversation-1",
          record_id: "llm-2",
        },
      });
      const messages = await connected.client.callTool({
        name: "query_trace",
        arguments: {
          conversation_id: "conversation-1",
          record_id: "llm-2",
          detail: "messages",
        },
      });

      const toolResultsText = toolResults.content[0];
      const messagesText = messages.content[0];
      assert.equal(toolResultsText?.type, "text");
      assert.equal(messagesText?.type, "text");
      if (toolResultsText?.type !== "text" || messagesText?.type !== "text") {
        throw new Error("expected text content");
      }
      expect(toolResultsText.text).toContain("tool_results");
      expect(toolResultsText.text).not.toContain("private prompt");
      expect(messagesText.text).toContain("private prompt");
      expect(messagesText.text).toContain("toolu-1");
    } finally {
      await connected.close();
    }
  });

  it("returns an MCP error for invalid tool arguments without closing the server", async () => {
    const connected = await connectFixture();
    try {
      const invalid = await connected.client.callTool({
        name: "query_trace",
        arguments: { limit: 0 },
      });
      const valid = await connected.client.callTool({
        name: "query_trace",
        arguments: { conversation_id: "conversation-1", limit: 1 },
      });

      expect(invalid.isError).toBe(true);
      expect(valid.isError).not.toBe(true);
    } finally {
      await connected.close();
    }
  });

  it("names the tool on an error the core rejects past the transport schema", async () => {
    // The core's own message carries no tool name, so a caller can only tell
    // which tool rejected the call if this face prefixes it. `a/b` passes the
    // zod transport schema and is rejected by the core, which is the route
    // through the face's catch arm rather than transport-level schema rejection.
    const connected = await connectFixture();
    try {
      const rejected = await connected.client.callTool({
        name: "query_trace",
        arguments: { conversation_id: "a/b" },
      });

      expect(rejected.isError).toBe(true);
      const text = rejected.content[0];
      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");
      expect(text.text).toBe(
        "query_trace: conversation_id must not contain path separators"
      );
    } finally {
      await connected.close();
    }
  });
});

describe("trace MCP server — list_sessions", () => {
  function parsePage(text: string): {
    sessions: Array<Record<string, unknown>>;
    limit: number;
    offset: number;
  } {
    return JSON.parse(text) as {
      sessions: Array<Record<string, unknown>>;
      limit: number;
      offset: number;
    };
  }

  it("lists the session the record axis cannot reach by name, agent_version absent", async () => {
    // The shared fixture writes two llm_call rows and no session root record —
    // exactly what a crashed or in-progress run leaves behind (the root lands at
    // run end). query_trace on the same directory reports records; only the
    // directory axis reports the session itself, with agent_version absent.
    const connected = await connectFixture();
    try {
      const result = await connected.client.callTool({
        name: "list_sessions",
        arguments: {},
      });
      const text = result.content[0];
      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");

      const page = parsePage(text.text);
      expect(Object.keys(page)).toEqual(["sessions", "limit", "offset"]);
      expect(page.sessions.map((s) => s["conversation_id"])).toEqual([
        "conversation-1",
      ]);
      expect(page.sessions[0]).not.toHaveProperty("agent_version");
      expect(typeof page.sessions[0]?.["mtime"]).toBe("number");
      expect(typeof page.sessions[0]?.["size"]).toBe("number");
    } finally {
      await connected.close();
    }
  });

  it("honours caller paging and answers an empty page past the end", async () => {
    const connected = await connectFixture();
    try {
      const first = await connected.client.callTool({
        name: "list_sessions",
        arguments: { limit: 1 },
      });
      const past = await connected.client.callTool({
        name: "list_sessions",
        arguments: { offset: 40 },
      });
      assert.equal(first.content[0]?.type, "text");
      assert.equal(past.content[0]?.type, "text");

      const firstPage = parsePage(first.content[0]!.text!);
      expect(firstPage.sessions).toHaveLength(1);
      expect(firstPage.limit).toBe(1);
      const pastPage = parsePage(past.content[0]!.text!);
      expect(pastPage.sessions).toEqual([]);
      expect(pastPage.offset).toBe(40);
    } finally {
      await connected.close();
    }
  });

  it("prefixes its own tool name on the read failure both faces share (SC16)", async () => {
    // Why this is the route SC16 is pinned with: `limit` / `offset` bounds are
    // declared on both face schemas, so zod (here) and ajv (ACI) reject an
    // out-of-range page before the core's own re-check can be reached — a bad
    // `limit` cannot demonstrate a `<tool>: ` prefix on this face. A traceDir
    // pointing at a regular file reaches TraceReadError instead, deterministically
    // and on both faces, without root or chmod.
    const scratch = mkdtempSync(join(tmpdir(), "iknow-trace-mcp-filedir-"));
    scratchPaths.push(scratch);
    const asFile = join(scratch, "not-a-dir.jsonl");
    writeFileSync(asFile, '{"record_type":"session"}\n', "utf8");

    const connected = await connectFixture(asFile);
    try {
      const failed = await connected.client.callTool({
        name: "list_sessions",
        arguments: {},
      });
      const text = failed.content[0];
      assert.equal(text?.type, "text");
      if (text?.type !== "text") throw new Error("expected text content");

      expect(failed.isError).toBe(true);
      expect(text.text).toBe("list_sessions: trace file read failed: ENOTDIR");
    } finally {
      await connected.close();
    }
  });

  it("shows the SDK's own schema-rejection shape, which is not the core route", async () => {
    // The other caller-visible error path on this face: zod rejects before the
    // face's catch arm runs, so the SDK writes the text. It names the tool, just
    // in `... for tool list_sessions: ...` form rather than `list_sessions: ...`.
    // Both bound edges are pinned with zod's own measured wording (`Too small` /
    // `Too big` are the SDK's strings, and this face produces the same shape for
    // query_trace). Pinned separately so nobody "fixes" it into the prefixed shape
    // (which would mean relaxing the schema or double-prefixing SDK text).
    const connected = await connectFixture();
    try {
      const tooSmall = await connected.client.callTool({
        name: "list_sessions",
        arguments: { limit: 0 },
      });
      const tooLarge = await connected.client.callTool({
        name: "list_sessions",
        arguments: { limit: LIST_SESSIONS_MAX_LIMIT + 1 },
      });

      expect(tooSmall.isError).toBe(true);
      expect(tooLarge.isError).toBe(true);
      expect(tooSmall.content[0]).toEqual({
        type: "text",
        text: "Input validation error: Invalid arguments for tool list_sessions: limit: Too small: expected number to be >=1",
      });
      expect(tooLarge.content[0]).toEqual({
        type: "text",
        text: "Input validation error: Invalid arguments for tool list_sessions: limit: Too big: expected number to be <=200",
      });
    } finally {
      await connected.close();
    }
  });
});

describe("list_sessions faces agree on the parameter plane (SC18)", () => {
  it("publishes the same bounds through MCP that the ACI registry declares", async () => {
    // spec SC18: one diff assertion per tool, so neither face can quietly move a
    // page-size bound. The bridge lives in a test on purpose — `src/trace-mcp/`
    // must not import the ACI registry (SC12), yet only a caller-visible
    // comparison can say the two declarations still match.
    //
    // Two deltas are legitimate and are named here rather than smoothed over:
    // the ACI side carries a `default` for each axis (a hint this SDK does not
    // surface), and zod attaches an implicit Number.MAX_SAFE_INTEGER maximum to
    // an `.int()` that declares no upper bound. That cap only shows up on
    // `offset`, so a maximum is compared where the ACI side declares one.
    const connected = await connectFixture();
    try {
      const tools = await connected.client.listTools();
      const mcpSchema = tools.tools.find(
        (tool) => tool.name === "list_sessions"
      )?.inputSchema as FaceSchema;
      const aciSchema = createListSessionsTool("/iknow-sc18-schema-only")
        .inputSchema as FaceSchema;

      expect(Object.keys(mcpSchema.properties).sort()).toEqual(
        Object.keys(aciSchema.properties).sort()
      );
      expect(mcpSchema.additionalProperties).toBe(false);
      expect(aciSchema.additionalProperties).toBe(false);
      for (const [name, aciField] of Object.entries(aciSchema.properties)) {
        const mcpField = mcpSchema.properties[name]!;
        expect(mcpField.type).toEqual(aciField.type);
        expect(mcpField.minimum).toEqual(aciField.minimum);
        if ("maximum" in aciField) {
          expect(mcpField.maximum).toEqual(aciField.maximum);
        }
      }
      // The bound this loop would silently skip if both sides dropped it.
      expect(aciSchema.properties["limit"]?.maximum).toBe(
        LIST_SESSIONS_MAX_LIMIT
      );
    } finally {
      await connected.close();
    }
  });
});
