import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  createQueryTraceTool,
  QueryTraceValidationError,
} from "../../../../src/harness/aci/tools/query-trace.ts";
import {
  ACI_TOOLSET_NAMES,
  createDefaultAciRegistry,
} from "../../../../src/harness/aci/tools/registry.ts";
import { TRACE_BACKSTOP_MARKER } from "../../../../src/traceserver/output-backstop.ts";

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

function makeTraceDirWithRecordPastScanCap(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-query-trace-scan-"));
  scratchPaths.push(dir);
  const rows = Array.from({ length: 10_001 }, (_, index) => ({
    conversation_id: "c1",
    record_type: "llm_call",
    llm_call_id: index === 10_000 ? "past-scan-cap" : `llm-${index}`,
    started_at: "2026-08-28T00:00:00.000Z",
    status: "ok",
    messages: [],
  }));
  writeFileSync(
    join(dir, "c1.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
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
      "detail",
    ]) {
      assert.ok(key in schema.properties, `missing query parameter ${key}`);
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
      truncated: boolean;
    };

    // T6 退役了工具面自己的字符帽（plan item 5 点名的四处 4000 残值之一）。
    // 原来这句 `output.length <= 4_000` 钉的是「响应被压进帽内」，而这个主张
    // 现在没有任何一方再持有：截断与 marker 归 executor 独有（契约 X，
    // ADR-0004:23），行轴自身的分页元字段留到 T7。所以改钉这条页真正要保证
    // 的事——整页原样回来，不带任何截断告知。
    assert.equal(body.truncated, false);
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
    assert.ok(!("messages" in body.records[0]!));
    assert.deepEqual(body.records[0]?.tool_results, [
      {
        tool_use_id: "toolu-1",
        name: "lookup",
        is_error: false,
        chars: "tool output secret".length,
        preview: "tool output secret",
      },
    ]);
  });

  it("returns full messages only when detail=messages", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    const output = (await tool.handler({
      conversation_id: "c1",
      record_id: "llm-error",
      detail: "messages",
    })) as string;
    const body = JSON.parse(output) as {
      records: Array<Record<string, unknown>>;
    };

    assert.equal(body.records.length, 1);
    assert.ok(Array.isArray(body.records[0]?.messages));
    assert.ok(!("tool_results" in body.records[0]!));
  });

  it("rejects an invalid detail with a typed validation error", async () => {
    const tool = createQueryTraceTool(makeTraceDir());
    await assert.rejects(
      () =>
        tool.handler({
          conversation_id: "c1",
          record_id: "llm-error",
          detail: "everything",
        }),
      (error: unknown) =>
        error instanceof QueryTraceValidationError &&
        error.field === "detail" &&
        error.message ===
          "query_trace: detail must be one of: messages, tool_results"
    );
  });

  it("distinguishes a missing record_id from an exhausted record_id scan", async () => {
    const missingOutput = (await createQueryTraceTool(makeTraceDir()).handler({
      conversation_id: "c1",
      record_id: "not-present",
    })) as string;
    const missingBody = JSON.parse(missingOutput) as {
      records: Array<Record<string, unknown>>;
      total: number;
    };

    assert.equal(missingBody.records.length, 0);
    assert.equal(missingBody.total, 0);

    const tool = createQueryTraceTool(makeTraceDirWithRecordPastScanCap());
    await assert.rejects(
      () =>
        tool.handler({
          conversation_id: "c1",
          record_id: "past-scan-cap",
        }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message ===
          "query_trace: record_id scan exhausted after 10000 records before finding 'past-scan-cap'"
    );
    // scan-exhausted 分支要求写满并扫完 QUERY_TRACE_MAX_RECORD_ID_SCAN+1 行：
    // 单跑实测 3.8 s，多文件并发下实测 5.6 s > vitest 默认 5 s。超时只加在这一条，
    // 不动 vitest.config.ts 的全局 testTimeout（那会放宽所有测的挂死检测）。
  }, 120_000);

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
