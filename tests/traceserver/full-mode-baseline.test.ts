/**
 * SC15 / SC17 历史基线（plans/session-folder-consolidation.md T4 实施注意第 2 条）。
 *
 * fixture `full-mode-baseline.trace.jsonl` 在 T3 HEAD（blob 仍是 opt-in、默认
 * full）用**真实写侧** `createJsonlTraceService` 生成，随机 UUID 后处理为
 * 确定性 id（llm-1 / llm-2 / tool-1 / turn-1）。它固定的是旧 full 模式
 * 「模型实际所见」逐字节形状，是 T6 读侧改造时 blob 模式逐字段相等的对照物
 * （specs/session-folder-consolidation.md SC15 / SC17）。
 *
 * 本文件的断言值全部从该 fixture 用 T3 时的读侧投影**实测**得出后固化 ——
 * 不从写侧或读侧源码派生（改实现不可能悄悄翻转这些值）。fixture 与本测试
 * 随 T4 写侧改造**不再漂移**：它们描述的是历史 ground truth，不是当前行为。
 *
 * 会话内容（4 行）：llm-1（system 字符串 content + user block 数组 content）
 * → tool-1（bash 调用 + result）→ llm-2（累计重复 messages，含 assistant
 * tool_use + user tool_result）→ turn-1。
 */
import { readFileSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createQueryTraceCore,
  type QueryTraceCoreHandler,
} from "../../src/traceserver/query-trace-core.ts";
import { createGetRecordCore } from "../../src/traceserver/get-record-core.ts";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "_fixtures",
  "full-mode-baseline.trace.jsonl"
);

const traceDirs: string[] = [];

afterEach(() => {
  for (const dir of traceDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 把 fixture 复制进临时 traceDir，保持 `baseline-conv.jsonl` 会话名。 */
function makeTraceDirWithFixture(): string {
  const traceDir = mkdtempSync(join(tmpdir(), "iknow-full-baseline-"));
  traceDirs.push(traceDir);
  copyFileSync(FIXTURE_PATH, join(traceDir, "baseline-conv.jsonl"));
  return traceDir;
}

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
  input: Record<string, unknown>
): Promise<Page> {
  return JSON.parse(
    await core({ conversation_id: "baseline-conv", ...input })
  ) as Page;
}

describe("full-mode historical baseline (SC15/SC17 对照物)", () => {
  it("query_trace: rows come back newest-first with the exact base scalar fields", async () => {
    const core = queryCoreFor(makeTraceDirWithFixture());
    const page = await queryPage(core, {});
    // reader 按 started_at 降序 + 稳定序：turn-1 的 started_at 与 llm-1 相同
    // (00:00:00)，稳定序把 turn-1 排在其文件序位置（最后）。
    assert.deepEqual(
      page.records.map((r) => r.record_type),
      ["llm_call", "tool_call", "llm_call", "turn"]
    );
    assert.deepEqual(
      page.records.map((r) => r.llm_call_id ?? r.tool_call_id ?? r.turn_id),
      ["llm-2", "tool-1", "llm-1", "turn-1"]
    );
    assert.equal(page.limit, 100);
    assert.equal(page.offset, 0);
  });

  it("query_trace: llm-1 projection field-by-field (SC15 base)", async () => {
    const core = queryCoreFor(makeTraceDirWithFixture());
    const page = await queryPage(core, { record_type: "llm_call" });
    const llm1 = page.records.find((r) => r.llm_call_id === "llm-1")!;
    // 固化值：这些键与值是 full 模式 T3 读侧的实测输出。
    assert.equal(llm1["messages_count"], 2);
    assert.equal(
      llm1["first_message_preview"],
      '{"role":"system","content":"You are a helpful assistant."}'
    );
    assert.equal(
      llm1["last_message_preview"],
      '{"role":"user","content":[{"type":"text","text":"hello world"}]}'
    );
    // llm-1 无 assistant 消息 → 字段缺席（合法态，不是 empty string）。
    assert.ok(!("last_assistant_preview" in llm1));
    assert.equal(llm1["tool_result_count"], 0);
    assert.ok(!("tool_result_previews" in llm1));
    // 标量字段逐字段固化（reader 原样透传）。
    assert.equal(llm1["supplier_stop"], "tool_use");
    assert.equal(llm1["input_tokens"], 120);
    assert.equal(llm1["output_tokens"], 30);
    assert.equal(llm1["status"], "ok");
  });

  it("query_trace: llm-2 projection — accumulated history, assistant preview, tool results (SC15)", async () => {
    const core = queryCoreFor(makeTraceDirWithFixture());
    const page = await queryPage(core, { record_type: "llm_call" });
    const llm2 = page.records.find((r) => r.llm_call_id === "llm-2")!;
    assert.equal(llm2["messages_count"], 4);
    assert.equal(
      llm2["first_message_preview"],
      '{"role":"system","content":"You are a helpful assistant."}'
    );
    assert.equal(
      llm2["last_message_preview"],
      '{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu-1","content":"file-a\\nfile-b"}]}'
    );
    assert.equal(
      llm2["last_assistant_preview"],
      '{"role":"assistant","content":[{"type":"tool_use","id":"toolu-1","name":"bash","input":{"command":"ls"}}]}'
    );
    assert.equal(llm2["tool_result_count"], 1);
    assert.deepEqual(llm2["tool_result_previews"], ["file-a\nfile-b"]);
    assert.equal(llm2["input_tokens"], 260);
    assert.equal(llm2["output_tokens"], 45);
  });

  it("query_trace: tool_call projection keeps arguments/result verbatim (SC15)", async () => {
    const core = queryCoreFor(makeTraceDirWithFixture());
    const page = await queryPage(core, { record_type: "tool_call" });
    const tool = page.records[0]!;
    assert.equal(tool["parent_llm_call_id"], "llm-1");
    assert.deepEqual(tool["arguments"], { command: "ls" });
    assert.equal(tool["result"], "file-a\nfile-b");
    assert.equal(tool["tool_name"], "bash");
    // tool_call 投影不带 messages 计数键。
    assert.ok(!("messages_count" in tool));
  });

  it("query_trace: contains finds the inline message body (historical full-mode fact)", async () => {
    const core = queryCoreFor(makeTraceDirWithFixture());
    const page = await queryPage(core, { contains: "hello world" });
    // full 模式下正文内联在行上 —— 这是历史事实的固化；blob 模式的 contains
    // 语义（SC14 面）由 T6 另行判定，此处不预测。
    assert.deepEqual(
      page.records.map((r) => r.llm_call_id),
      ["llm-2", "llm-1"]
    );
  });

  it("get_record detail=messages: part coordinates, chars, and role labels (SC17)", async () => {
    const traceDir = makeTraceDirWithFixture();
    const core = createGetRecordCore({ traceDir });
    const manifest = JSON.parse(
      await core({
        conversation_id: "baseline-conv",
        record_id: "llm-2",
        detail: "messages",
      })
    ) as Record<string, unknown>;
    assert.deepEqual(manifest["matched_on"], "llm_call_id");
    assert.deepEqual(manifest["parts"], [
      {
        message_index: 0,
        part_index: 0,
        chars: "You are a helpful assistant.".length,
        role: "system",
      },
      {
        message_index: 1,
        part_index: 0,
        chars: JSON.stringify({ type: "text", text: "hello world" }).length,
        role: "user",
      },
      {
        message_index: 2,
        part_index: 0,
        chars: JSON.stringify({
          type: "tool_use",
          id: "toolu-1",
          name: "bash",
          input: { command: "ls" },
        }).length,
        role: "assistant",
      },
      {
        message_index: 3,
        part_index: 0,
        chars: JSON.stringify({
          type: "tool_result",
          tool_use_id: "toolu-1",
          content: "file-a\nfile-b",
        }).length,
        role: "user",
      },
    ]);
  });

  it("get_record detail=messages: window reads message 1 part 0 verbatim (SC17)", async () => {
    const traceDir = makeTraceDirWithFixture();
    const core = createGetRecordCore({ traceDir });
    const text = JSON.stringify({ type: "text", text: "hello world" });
    const window = JSON.parse(
      await core({
        conversation_id: "baseline-conv",
        record_id: "llm-2",
        detail: "messages",
        message_index: 1,
        part_index: 0,
        from_char: 0,
        count: text.length,
      })
    ) as Record<string, unknown>;
    assert.equal(window["text"], text);
    assert.equal(window["part_chars"], text.length);
    assert.equal(window["from_char"], 0);
    assert.equal(window["count"], text.length);
  });

  it("get_record detail=tool_results: one result with tool name identity (SC17)", async () => {
    const traceDir = makeTraceDirWithFixture();
    const core = createGetRecordCore({ traceDir });
    const manifest = JSON.parse(
      await core({
        conversation_id: "baseline-conv",
        record_id: "llm-2",
        detail: "tool_results",
      })
    ) as Record<string, unknown>;
    assert.deepEqual(manifest["parts"], [
      {
        part_index: 0,
        chars: "file-a\nfile-b".length,
        tool_use_id: "toolu-1",
        name: "bash",
        is_error: false,
      },
    ]);
  });
});
