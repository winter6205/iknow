/**
 * review-fix (L-sc15): SC15 full-vs-blob 投影逐字段 deepEqual 对照。
 *
 * fixture `full-mode-baseline.trace.jsonl` 固化了 T3 full 模式的历史
 * ground truth（本目录 full-mode-baseline.test.ts 已逐字段固化其读侧投影）。
 * 本文件用**当前 blob-only 写侧**（`createJsonlTraceService`，SC9 已退役
 * full 分支）写出**同内容**的 trace，再跑同一读侧投影，断言两形态的
 * 投影值逐字段相等 —— 「投影对存储形态不敏感」由真实双形态数据钉死，
 * 而不是由单侧 fixture 推断。
 *
 * 会话内容与 full fixture 相同（4 行：llm-1 → tool-1 → llm-2 → turn-1），
 * 记录 id 由写侧生成后回读（recordLlmCall 返回 id），不预置确定性 id ——
 * 对照键是投影标量值，不是 id 字符串。
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";

import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import {
  createQueryTraceCore,
  type QueryTraceCoreHandler,
} from "../../src/traceserver/query-trace-core.ts";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "_fixtures",
  "full-mode-baseline.trace.jsonl"
);

const traceDirs: string[] = [];
const TEST_PROJECT_SLUG = "test-project-blob-baseline";

afterEach(() => {
  for (const dir of traceDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Page {
  records: Array<Record<string, unknown>>;
  limit: number;
  offset: number;
}

function queryCoreFor(traceDir: string): QueryTraceCoreHandler {
  return createQueryTraceCore({ traceDir });
}

async function queryPage(
  core: QueryTraceCoreHandler,
  conversationId: string,
  input: Record<string, unknown>
): Promise<Page> {
  return JSON.parse(
    await core({ conversation_id: conversationId, ...input })
  ) as Page;
}

/** 把 trace 文件复刻进两级树落点，保持与 full fixture 相同的目录形状。 */
function makeTraceDir(): string {
  const traceDir = mkdtempSync(join(tmpdir(), "iknow-blob-baseline-"));
  traceDirs.push(traceDir);
  mkdirSync(join(traceDir, "projects", TEST_PROJECT_SLUG, "baseline-conv"), {
    recursive: true,
  });
  return traceDir;
}

describe("L-sc15 — same-content full-vs-blob projection deepEqual", () => {
  it("blob-only 写侧同内容 trace 的投影与 full fixture 固化值逐字段相等 (SC15)", async () => {
    const traceDir = makeTraceDir();
    const convDir = join(
      traceDir,
      "projects",
      TEST_PROJECT_SLUG,
      "baseline-conv"
    );
    const trace = createJsonlTraceService({
      traceFilePath: join(convDir, "trace.jsonl"),
      conversationId: "baseline-conv",
    });

    // 与 full fixture 逐字节相同的 message 数组（deref 后投影应完全一致）。
    const systemMsg = {
      role: "system",
      content: "You are a helpful assistant.",
    };
    const userTextMsg = {
      role: "user",
      content: [{ type: "text", text: "hello world" }],
    };
    const assistantToolUseMsg = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu-1",
          name: "bash",
          input: { command: "ls" },
        },
      ],
    };
    const userToolResultMsg = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu-1",
          content: "file-a\nfile-b",
        },
      ],
    };

    const llm1 = await trace.recordLlmCall({
      startedAt: "2026-09-08T00:00:00.000Z",
      endedAt: "2026-09-08T00:00:01.000Z",
      durationMs: 1000,
      supplierStop: "tool_use",
      stream: false,
      messagesCaptured: true,
      messages: [systemMsg, userTextMsg],
      status: "ok",
      inputTokens: 120,
      outputTokens: 30,
    });
    const tool1 = await trace.recordToolCall({
      parentLlmCallId: llm1 ?? null,
      toolName: "bash",
      toolKind: "ok",
      startedAt: "2026-09-08T00:00:01.500Z",
      endedAt: "2026-09-08T00:00:02.000Z",
      durationMs: 500,
      argumentsCaptured: true,
      arguments: { command: "ls" },
      resultCaptured: true,
      result: "file-a\nfile-b",
      status: "ok",
    });
    const llm2 = await trace.recordLlmCall({
      startedAt: "2026-09-08T00:00:02.500Z",
      endedAt: "2026-09-08T00:00:03.500Z",
      durationMs: 1000,
      supplierStop: "success",
      stream: false,
      messagesCaptured: true,
      messages: [
        systemMsg,
        userTextMsg,
        assistantToolUseMsg,
        userToolResultMsg,
      ],
      status: "ok",
      inputTokens: 260,
      outputTokens: 45,
    });
    await trace.recordTurn({
      id: "turn-1",
      turnIndex: 0,
      startedAt: "2026-09-08T00:00:00.000Z",
      endedAt: "2026-09-08T00:00:04.000Z",
      durationMs: 4000,
      llmCallIds: [llm1!, llm2!],
      toolCallIds: [tool1!],
      decision: "completed",
      status: "ok",
    });

    // blob 形态落盘 sanity：行上 messages 是 {role, content:{sha,bytes}} 引用，
    // blobs/ 目录至少有一条内容。
    const lines = readFileSync(join(convDir, "trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const blobRow = lines.find(
      (l) => l.record_type === "llm_call" && l.llm_call_id === llm1
    );
    const rawMessages = blobRow?.messages as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(rawMessages), "llm-1 行应有 messages 数组");
    assert.ok(
      rawMessages.every(
        (m) =>
          typeof m.role === "string" &&
          typeof (m.content as Record<string, unknown>)?.sha === "string"
      ),
      "blob 模式 messages[i].content 必须是 {sha, bytes} 引用"
    );
    assert.ok(existsSync(join(convDir, "blobs")), "blobs/ 目录存在");

    // 读侧投影 —— 用与 full-mode-baseline.test.ts 相同的断言值。
    const core = queryCoreFor(traceDir);
    const page = await queryPage(core, "baseline-conv", {});
    assert.deepEqual(
      page.records.map((r) => r.record_type),
      ["llm_call", "tool_call", "llm_call", "turn"]
    );

    const llmRows = (
      await queryPage(core, "baseline-conv", { record_type: "llm_call" })
    ).records;
    const llm1Row = llmRows.find((r) => r.llm_call_id === llm1)!;
    const llm2Row = llmRows.find((r) => r.llm_call_id === llm2)!;

    // 与 full fixture 固化值逐字段对照（full-mode-baseline.test.ts 同值）。
    for (const [row, label, expected] of [
      [
        llm1Row,
        "llm-1",
        {
          messages_count: 2,
          tool_result_count: 0,
          input_tokens: 120,
          output_tokens: 30,
        },
      ],
      [
        llm2Row,
        "llm-2",
        {
          messages_count: 4,
          tool_result_count: 1,
          input_tokens: 260,
          output_tokens: 45,
        },
      ],
    ] as const) {
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(
          row[key],
          value,
          `${label}.${key} must match full fixture`
        );
      }
    }
    assert.equal(
      llm1Row["first_message_preview"],
      '{"role":"system","content":"You are a helpful assistant."}'
    );
    assert.equal(
      llm1Row["last_message_preview"],
      '{"role":"user","content":[{"type":"text","text":"hello world"}]}'
    );
    assert.ok(!("last_assistant_preview" in llm1Row));
    assert.ok(!("tool_result_previews" in llm1Row));
    assert.equal(llm1Row["supplier_stop"], "tool_use");
    assert.equal(llm1Row["status"], "ok");

    assert.equal(
      llm2Row["first_message_preview"],
      '{"role":"system","content":"You are a helpful assistant."}'
    );
    assert.equal(
      llm2Row["last_message_preview"],
      '{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu-1","content":"file-a\\nfile-b"}]}'
    );
    assert.equal(
      llm2Row["last_assistant_preview"],
      '{"role":"assistant","content":[{"type":"tool_use","id":"toolu-1","name":"bash","input":{"command":"ls"}}]}'
    );
    assert.deepEqual(llm2Row["tool_result_previews"], ["file-a\nfile-b"]);

    // tool_call 投影（full fixture 固化：arguments/result verbatim）。
    const toolPage = await queryPage(core, "baseline-conv", {
      record_type: "tool_call",
    });
    const toolRow = toolPage.records[0]!;
    assert.equal(toolRow["parent_llm_call_id"], llm1);
    assert.deepEqual(toolRow["arguments"], { command: "ls" });
    assert.equal(toolRow["result"], "file-a\nfile-b");
    assert.equal(toolRow["tool_name"], "bash");
    assert.ok(!("messages_count" in toolRow));

    // contains 原始行子串匹配 —— blob 模式下 messages 是 sha 引用, 正文不在行上,
    // 故 contains 不过滤(0 命中是真实事实,与 full fixture 的 2 命中形成两形态对照)。
    const containsPage = await queryPage(core, "baseline-conv", {
      contains: "hello world",
    });
    assert.deepEqual(containsPage.records.length, 0);
  });
});
