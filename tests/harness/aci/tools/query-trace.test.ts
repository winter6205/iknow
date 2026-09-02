import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import {
  createQueryTraceTool,
  QueryTraceSessionNotFoundError,
  QueryTraceValidationError,
} from "../../../../src/harness/aci/tools/query-trace.ts";
import {
  ACI_TOOLSET_NAMES,
  createDefaultAciRegistry,
} from "../../../../src/harness/aci/tools/registry.ts";
import { TRACE_BACKSTOP_MARKER } from "../../../../src/traceserver/output-backstop.ts";

/**
 * plan `trace-mcp-read-side-split` T7: drill-down (`record_id` / `detail`) is
 * gone — `get_record` owns the content axis. The byte-pagination `resume_offset`
 * left with the panel, leaving `query_trace` a row axis: filter + page. The
 * `additionalProperties: false` gate is the per-face contract (SC18) that
 * prevents the three retired names from sneaking back in.
 */

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
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu-1",
                name: "lookup",
                input: { query: "secret" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu-1",
                content: "tool output secret",
              },
            ],
          },
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

describe("query_trace ACI tool (T7)", () => {
  it("is read-only, fast, exposes the slimmed schema, and rejects the retired parameters", () => {
    const tool = createQueryTraceTool(makeTraceDir());
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
      required: ReadonlyArray<string>;
    };

    assert.equal(tool.name, "query_trace");
    assert.equal(tool.aci.category, "read-only");
    assert.equal(tool.aci.timeoutTier, "fast");
    assert.equal(tool.aci.interruptBehavior, "cancel");
    assert.equal(schema.additionalProperties, false);
    // Slimmed schema: row axis = filter + page, conversation_id required.
    for (const key of [
      "conversation_id",
      "record_type",
      "status",
      "task_id",
      "parent_turn_id",
      "turn_id",
      "limit",
      "offset",
    ]) {
      assert.ok(key in schema.properties, `missing query parameter ${key}`);
    }
    assert.deepEqual(schema.required, ["conversation_id"]);
    // Retired names must not slip back in via an untyped extension: SC18's
    // additionalProperties: false is the gate that catches a future
    // "let it through" refactor.
    for (const retired of ["record_id", "detail", "resume_offset"]) {
      assert.ok(
        !(retired in schema.properties),
        `${retired} must no longer be a query_trace property`
      );
    }
  });

  it("projects llm_call messages for status=error and returns the page whole", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    const output = (await tool.handler({
      conversation_id: "c1",
      status: "error",
    })) as string;
    const body = JSON.parse(output) as {
      records: Array<Record<string, unknown>>;
      limit: number;
      offset: number;
    };

    // T6 retired the per-tool character cap; T7 stripped the panel-paging
    // metadata. The page returns whole, and the tool face echoes the
    // effective limit/offset so callers can resume.
    assert.ok(!output.includes(TRACE_BACKSTOP_MARKER));
    assert.equal(body.records.length, 1);
    assert.equal(body.records[0]?.llm_call_id, "llm-error");
    assert.equal(body.records[0]?.messages_count, 3);
    assert.equal(body.records[0]?.tool_result_count, 1);
    assert.deepEqual(body.records[0]?.tool_result_previews, [
      "tool output secret",
    ]);
    assert.ok(!("tool_results" in body.records[0]!));
    assert.ok(!("messages" in body.records[0]!));
    assert.ok("first_message_preview" in body.records[0]!);
    assert.ok("last_message_preview" in body.records[0]!);
    assert.deepEqual(body.records[0]?.error, {
      type: "execution_failed",
      message: "provider failed",
    });
    // Tool face keys: only `records` + `limit` + `offset` — no `total` /
    // `truncated` / `skipped_lines` from the panel's byte-paging world.
    assert.deepEqual(Object.keys(body).sort(), ["limit", "offset", "records"]);
  });

  it("echoes the caller's offset so resume is just offset + records.length", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    const output = (await tool.handler({
      conversation_id: "c1",
      status: "error",
      limit: 1,
      offset: 5,
    })) as string;
    const body = JSON.parse(output) as {
      records: Array<Record<string, unknown>>;
      limit: number;
      offset: number;
    };

    // Two rows match status=error in the fixture, so offset 5 lands past
    // them: `records.length < limit` is the implicit end-of-data signal.
    assert.equal(body.limit, 1);
    assert.equal(body.offset, 5);
    assert.equal(body.records.length, 0);
  });

  it("raises session_not_found (not the panel's empty envelope) when conversation_id has no file", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    await assert.rejects(
      async () => tool.handler({ conversation_id: "no-such-session" }),
      (error: unknown) =>
        error instanceof QueryTraceSessionNotFoundError &&
        error.kind === "session_not_found" &&
        error.conversationId === "no-such-session" &&
        error.message ===
          "query_trace: no trace session file for conversation_id 'no-such-session'"
    );
  });

  it("requires conversation_id on the tool face", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    await assert.rejects(
      async () => tool.handler({}),
      (error: unknown) =>
        error instanceof QueryTraceValidationError &&
        error.field === "conversation_id"
    );
  });

  it("rejects an unknown record_type with a typed validation error", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    await assert.rejects(
      async () =>
        tool.handler({
          conversation_id: "c1",
          record_type: "not-a-trace-record",
        }),
      (error: unknown) =>
        error instanceof QueryTraceValidationError &&
        error.field === "record_type" &&
        error.message.includes("record_type must be one of")
    );
  });

  it("rejects conversation_id path traversal", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    await assert.rejects(
      async () => tool.handler({ conversation_id: "../outside" }),
      (error: unknown) =>
        error instanceof QueryTraceValidationError &&
        error.field === "conversation_id"
    );
  });

  it("rejects an unknown additional property as additionalProperties=false (SC18)", () => {
    // The ACI ajv gate runs through the executor's compiled validator, not
    // directly through `tool.handler` (a thin wrapper that the executor wraps).
    // Compile the schema the same way the executor does and assert each
    // retired name fails it.
    const tool = createQueryTraceTool(makeTraceDir());
    const registry = createDefaultAciRegistry({
      env: { web: { searchUrl: undefined, proxy: undefined } },
      sandboxRoot: makeTraceDir(),
    });
    const validator = registry.inner.getValidator(tool.name);
    assert.ok(validator, "executor must compile query_trace's schema");
    for (const stale of [
      { conversation_id: "c1", record_id: "x" },
      { conversation_id: "c1", detail: "messages" },
      { conversation_id: "c1", resume_offset: 0 },
    ]) {
      assert.equal(
        validator(stale),
        false,
        `additionalProperties: false must reject ${JSON.stringify(stale)}`
      );
    }
  });

  it("registers query_trace as an append-only SSOT member (followed by 3 worktree isolation per ADR-0037 + 10 symbol-query + 5 symbol-mutate tools per T2+T4 + 1 list_sessions + 1 get_record)", () => {
    // ADR-0037 在末位追加 3 件 worktree 隔离工具,symbol-primary-aci T2
    // 接着追加 10 件符号查询工具 → query_trace 不再是末位。T4 又在末尾
    // append 5 件符号改工具,trace-mcp-read-side-split T5b 再 append 1 件
    // 目录轴读工具 list_sessions,T6 最后 append 1 件内容轴读工具
    // get_record → query_trace 之后共 20 件(3 worktree + 10 查询 + 5 改
    // + 2 读)。append-only:query_trace 自身位置仍是 idx 21。
    assert.equal(ACI_TOOLSET_NAMES[21], "query_trace");
    assert.equal(ACI_TOOLSET_NAMES.at(-1), "get_record");
    const queryTraceIndex = ACI_TOOLSET_NAMES.indexOf("query_trace");
    assert.ok(queryTraceIndex >= 0, "query_trace 仍在 ACI_TOOLSET_NAMES");
    // query_trace 之后正好 20 件（3 worktree + 10 查询 + 5 改 + 2 读轴）
    assert.equal(ACI_TOOLSET_NAMES.length - queryTraceIndex - 1, 20);
    const registry = createDefaultAciRegistry({
      env: { web: { searchUrl: undefined, proxy: undefined } },
      sandboxRoot: makeTraceDir(),
    });
    assert.equal(registry.catalog.get("query_trace")?.name, "query_trace");
    // 两件读轴工具都无装配条件 → 常驻;末位是 T6 追加的 get_record。
    assert.equal(registry.inner.list().at(-1)?.name, "get_record");
  });
});
