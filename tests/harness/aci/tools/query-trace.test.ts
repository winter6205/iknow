import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createQueryTraceTool } from "../../../../src/harness/aci/tools/query-trace.ts";
import {
  ACI_TOOLSET_NAMES,
  createDefaultAciRegistry,
} from "../../../../src/harness/aci/tools/registry.ts";

const scratchPaths: string[] = [];

function makeTraceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-query-trace-"));
  scratchPaths.push(dir);
  writeFileSync(
    join(dir, "c1.jsonl"),
    [
      {
        conversation_id: "c1",
        record_type: "llm_call",
        llm_call_id: "llm-ok",
        started_at: "2026-08-28T00:00:01.000Z",
        status: "ok",
        messages: [{ role: "user", content: "normal" }],
      },
      {
        conversation_id: "c1",
        record_type: "llm_call",
        llm_call_id: "llm-error",
        started_at: "2026-08-28T00:00:02.000Z",
        status: "error",
        error: { type: "execution_failed", message: "provider failed" },
        messages: [
          { role: "user", content: "first secret prompt" },
          { role: "assistant", content: "last secret response" },
        ],
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n"
  );
  return dir;
}

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("query_trace ACI tool", () => {
  it("is read-only, fast, and exposes the requested query parameters", () => {
    const tool = createQueryTraceTool(makeTraceDir());
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };

    assert.equal(tool.name, "query_trace");
    assert.equal(tool.aci.category, "read-only");
    assert.equal(tool.aci.timeoutTier, "fast");
    assert.equal(tool.aci.interruptBehavior, "cancel");
    assert.equal(schema.additionalProperties, false);
    for (const key of [
      "conversation_id",
      "record_type",
      "status",
      "task_id",
      "parent_turn_id",
      "turn_id",
      "limit",
      "record_id",
      "resume_offset",
    ]) {
      assert.ok(key in schema.properties, `missing query parameter ${key}`);
    }
  });

  it("projects llm_call messages for status=error and caps the response", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    const output = (await tool.handler({
      conversation_id: "c1",
      status: "error",
    })) as string;
    const body = JSON.parse(output) as {
      records: Array<Record<string, unknown>>;
    };

    assert.ok(output.length <= 4_000);
    assert.equal(body.records.length, 1);
    assert.equal(body.records[0]?.llm_call_id, "llm-error");
    assert.equal(body.records[0]?.messages_count, 2);
    assert.ok("first_message_preview" in body.records[0]!);
    assert.ok("last_message_preview" in body.records[0]!);
    assert.deepEqual(body.records[0]?.error, {
      type: "execution_failed",
      message: "provider failed",
    });
    assert.ok(!("messages" in body.records[0]!));
  });

  it("uses record_id for one-record drill-down", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    const output = (await tool.handler({
      conversation_id: "c1",
      record_id: "llm-error",
    })) as string;
    const body = JSON.parse(output) as {
      records: Array<Record<string, unknown>>;
    };

    assert.equal(body.records.length, 1);
    assert.equal(body.records[0]?.llm_call_id, "llm-error");
    assert.ok(Array.isArray(body.records[0]?.messages));
  });

  it("rejects an unknown record_type with a typed validation error", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    await assert.rejects(
      () => tool.handler({ record_type: "not-a-trace-record" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        (error as { kind?: string }).kind === "validation" &&
        error.message.includes("record_type must be one of")
    );
  });

  it("rejects conversation_id path traversal", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    await assert.rejects(
      () => tool.handler({ conversation_id: "../outside" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        (error as { field?: string }).field === "conversation_id"
    );
  });

  it("registers query_trace as the append-only SSOT member", () => {
    assert.equal(ACI_TOOLSET_NAMES.at(-1), "query_trace");
    const registry = createDefaultAciRegistry({
      env: { web: { searchUrl: undefined, proxy: undefined } },
      sandboxRoot: makeTraceDir(),
    });
    assert.equal(registry.catalog.get("query_trace")?.name, "query_trace");
    assert.equal(registry.inner.list().at(-1)?.name, "query_trace");
  });
});
