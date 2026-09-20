/**
 * Historical baseline (ADR-0071 implementation note).
 *
 * The fixture `full-mode-baseline.trace.jsonl` was generated at the pre-blob-default
 * HEAD (blob still opt-in, default full) with the **real write side**
 * `createJsonlTraceService`, post-processing random UUIDs into deterministic ids
 * (llm-1 / llm-2 / tool-1 / turn-1). It freezes the byte shape of "what the model
 * actually saw" in legacy full mode, serving as the field-equality counterpart for the
 * blob mode when the read side was reshaped (ADR-0071 SC15 / SC17).
 *
 * Every assertion value here was **measured** from that fixture through the read-side
 * projection of that era, then frozen — never derived from write- or read-side source
 * (implementation changes cannot silently flip these values). The fixture and this test
 * no longer drift with later write-side changes: they describe historical ground truth, not current behavior.
 *
 * Conversation content (4 rows): llm-1 (system string content + user block-array content)
 * → tool-1 (bash call + result) → llm-2 (cumulative repeated messages, incl. assistant
 * tool_use + user tool_result) → turn-1.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
/** The fixture session lands in the two-level tree `<traceDir>/projects/<slug>/baseline-conv/trace.jsonl`. */
const TEST_PROJECT_SLUG = "test-project-full-baseline";

afterEach(() => {
  for (const dir of traceDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Copy the fixture into the two-level-tree spot of a temp traceDir, keeping the `baseline-conv` session name. */
function makeTraceDirWithFixture(): string {
  const traceDir = mkdtempSync(join(tmpdir(), "iknow-full-baseline-"));
  traceDirs.push(traceDir);
  mkdirSync(join(traceDir, "projects", TEST_PROJECT_SLUG, "baseline-conv"), {
    recursive: true,
  });
  copyFileSync(
    FIXTURE_PATH,
    join(
      traceDir,
      "projects",
      TEST_PROJECT_SLUG,
      "baseline-conv",
      "trace.jsonl"
    )
  );
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
    // The reader sorts by started_at descending with stable order: turn-1's started_at
    // equals llm-1's (00:00:00), and stable order keeps turn-1 at its file-order position (last).
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
    // Frozen values: these keys and values are the measured output of the legacy full-mode read side.
    assert.equal(llm1["messages_count"], 2);
    assert.equal(
      llm1["first_message_preview"],
      '{"role":"system","content":"You are a helpful assistant."}'
    );
    assert.equal(
      llm1["last_message_preview"],
      '{"role":"user","content":[{"type":"text","text":"hello world"}]}'
    );
    // llm-1 has no assistant message → field absent (legal state, not empty string).
    assert.ok(!("last_assistant_preview" in llm1));
    assert.equal(llm1["tool_result_count"], 0);
    assert.ok(!("tool_result_previews" in llm1));
    // Scalar fields frozen field by field (reader passes them through verbatim).
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
    // tool_call projection carries no messages count key.
    assert.ok(!("messages_count" in tool));
  });

  it("query_trace: contains finds the inline message body (historical full-mode fact)", async () => {
    const core = queryCoreFor(makeTraceDirWithFixture());
    const page = await queryPage(core, { contains: "hello world" });
    // In full mode the body is inline on the row — freezing a historical fact; the blob-mode
    // contains semantics were decided later with the read-side split, not predicted here.
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
