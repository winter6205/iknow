import assert from "node:assert/strict";
import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createTraceMcpServer } from "../../src/trace-mcp/server.js";
import { createTraceFixture, type TraceFixture } from "./fixtures.js";

const fixtures: TraceFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function connectFixture(): Promise<{
  readonly client: Client;
  readonly close: () => Promise<void>;
  readonly fixture: TraceFixture;
}> {
  const fixture = createTraceFixture();
  fixtures.push(fixture);
  const server = createTraceMcpServer({ traceDir: fixture.traceDir });
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
  it("registers only query_trace and marks it read-only", async () => {
    const connected = await connectFixture();
    try {
      const result = await connected.client.listTools();

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]?.name).toBe("query_trace");
      expect(result.tools[0]?.annotations?.readOnlyHint).toBe(true);
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
