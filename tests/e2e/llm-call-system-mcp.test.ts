/**
 * ADR-0116 acceptance: one stub-model turn whose system seam
 * carries the usage lock sentence must land as a jsonl row that *references*
 * the system blob (never inlines it), and the MCP-readable face must be able
 * to read that body back — `get_record(detail=system)` returns the sentence,
 * `query_trace(contains=...)` hits the row through the blob. The trace
 * double-track discipline (AGENTS.md) is asserted on the same run shape:
 * NoopTraceService vs no trace produce identical results.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { run } from "../../src/harness/loop-engine.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { createTraceMcpServer } from "../../src/trace-mcp/server.js";
import { assistantResult } from "../cli/_fixtures.ts";
import { parseJsonl } from "../harness/trace/_fixtures.ts";

const USAGE_LOCK = "Use the symbol tools — do not start with grep.";
const SYSTEM_TEXT = `You are iknow. ${USAGE_LOCK}`;

let scratch: string;
let traceDir: string;
let conversationId: string;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-e2e-1077-"));
  traceDir = join(scratch, "traces");
  conversationId = "conv-1077";
  const traceFilePath = join(
    traceDir,
    "projects",
    "e2e-1077",
    conversationId,
    "trace.jsonl"
  );
  const echo = createStubTool({
    name: "echo",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    next: (input: unknown) => input,
  });
  const reg = createRegistry([echo]);
  const exec = createExecutor(reg);
  const responses = [
    assistantResult({
      texts: [],
      toolCalls: [{ id: "t1", name: "echo", input: { value: "ping" } }],
    }),
    assistantResult({ texts: ["done"], toolCalls: [], supplierStop: "success" }),
  ];
  const depsBase = {
    executor: exec,
    registry: reg,
    maxTurns: 5,
    system: async () => SYSTEM_TEXT,
  };
  const { result } = await run("go", {
    ...depsBase,
    adapter: createStubModel({ responses }),
    trace: createJsonlTraceService({ traceFilePath, conversationId }),
  });
  assert.equal(result.stopReason, "completed");
  // Double-track: the same shape with NoopTraceService equals the same shape
  // with no trace at all (recording adds nothing to the returned result).
  const { result: noopResult } = await run("go", {
    ...depsBase,
    adapter: createStubModel({ responses }),
    trace: createNoopTraceService(),
  });
  const { result: bareResult } = await run("go", {
    ...depsBase,
    adapter: createStubModel({ responses }),
  });
  assert.deepEqual(noopResult, bareResult);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function connectMcp(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createTraceMcpServer({ traceDir });
  const client = new Client({ name: "e2e-1077-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callToolText(
  client: Client,
  name: string,
  args: Record<string, unknown>
): string {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0];
  assert.equal(text?.type, "text");
  if (text?.type !== "text") throw new Error("expected text content");
  return text.text;
}

describe("ADR-0116 acceptance: writer row references the system blob; MCP read-back returns it", () => {
  it("jsonl 行引用 system blob 且携带 tool_names (不内联正文)", () => {
    const traceFilePath = join(
      traceDir,
      "projects",
      "e2e-1077",
      conversationId,
      "trace.jsonl"
    );
    const lines = parseJsonl(traceFilePath);
    const llmRows = lines.filter((l) => l["record_type"] === "llm_call");
    assert.equal(llmRows.length, 2);
    for (const row of llmRows) {
      const ref = row["system"] as { sha: string; bytes: number };
      assert.ok(ref && typeof ref.sha === "string");
      assert.equal("v" in ref, false, "row carries a ref, never the body");
      const blob = readFileSync(
        join(traceDir, "projects", "e2e-1077", conversationId, "blobs", ref.sha),
        "utf8"
      );
      assert.deepEqual(JSON.parse(blob), { kind: "str", v: SYSTEM_TEXT });
      assert.deepEqual(row["tool_names"], ["echo"]);
      const messages = row["messages"] as Array<{ role: string }>;
      assert.equal(messages.some((m) => m.role === "system"), false);
    }
    assert.equal(
      (llmRows[0]!.system as { sha: string }).sha,
      (llmRows[1]!.system as { sha: string }).sha
    );
  });

  it("MCP 面读回: query_trace contains 命中 blob 正文, get_record detail=system 返回句子", async () => {
    const { client, close } = await connectMcp();
    try {
      const traceFilePath = join(
        traceDir,
        "projects",
        "e2e-1077",
        conversationId,
        "trace.jsonl"
      );
      const firstId = (
        parseJsonl(traceFilePath).find(
          (l) => l["record_type"] === "llm_call"
        )! as Record<string, unknown>
      )["llm_call_id"] as string;

      const hits = JSON.parse(
        await callToolText(client, "query_trace", {
          conversation_id: conversationId,
          contains: "symbol tools",
        })
      ) as { records: Array<Record<string, unknown>> };
      assert.equal(hits.records.length, 2);
      assert.deepEqual(
        hits.records.map((r) => r["llm_call_id"]).sort(),
        parseJsonl(traceFilePath)
          .filter((l) => l["record_type"] === "llm_call")
          .map((l) => l["llm_call_id"] as string)
          .sort()
      );

      const window = JSON.parse(
        await callToolText(client, "get_record", {
          conversation_id: conversationId,
          record_id: firstId,
          detail: "system",
          part_index: 0,
          count: SYSTEM_TEXT.length,
        })
      ) as { text: string; part_chars: number; detail: string };
      assert.equal(window.detail, "system");
      assert.equal(window.part_chars, SYSTEM_TEXT.length);
      assert.equal(window.text, SYSTEM_TEXT);
      assert.ok(window.text.includes(USAGE_LOCK));

      const tools = JSON.parse(
        await callToolText(client, "get_record", {
          conversation_id: conversationId,
          record_id: firstId,
          detail: "tools",
        })
      ) as { parts: Array<Record<string, unknown>> };
      assert.deepEqual(tools.parts, [
        { part_index: 0, chars: "echo".length, name: "echo" },
      ]);
    } finally {
      await close();
    }
  });
});
