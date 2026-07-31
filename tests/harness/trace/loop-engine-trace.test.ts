/**
 * T4 LoopEngine instrumentation tests (GH #64).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../../../src/harness/loop-engine.ts";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
} from "../../../src/harness/model-adapter/types.ts";
import type { ToolDef } from "../../../src/harness/tools/types.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../../src/harness/stubs/stub-tool.ts";
import { createNoopTraceService } from "../../../src/harness/trace/noop.ts";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import type {
  TraceService,
  LlmCallRecord,
  ToolCallRecord,
  TurnRecord,
} from "../../../src/harness/trace/types.ts";

function assistantResult(
  texts: string[],
  toolCalls: Array<{ id: string; name: string; input: unknown }> = [],
  supplierStop: "success" | "truncation" | "refusal" | "other" = "success"
): AssistantTurnResult {
  const blocks: AnthropicNativeMessage["content"] = [];
  for (const t of texts) blocks.push({ type: "text", text: t });
  for (const c of toolCalls) {
    blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  }
  const native: AnthropicNativeMessage = { role: "assistant", content: blocks };
  return {
    nativeMessage: native,
    projection: { nativeMessage: native, texts, toolCalls },
    supplierStop,
    needsTools: toolCalls.length > 0,
    isEmptyFinalResponse:
      supplierStop === "success" &&
      texts.length === 0 &&
      toolCalls.length === 0,
  };
}

function parseJsonl(filePath: string): Array<Record<string, unknown>> {
  const content = readFileSync(filePath, "utf8");
  return content
    .split(String.fromCharCode(10))
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
describe("T4 criterion 5: byte-level consistency", () => {
  it("pure-text run: result is identical with undefined trace vs NoopTraceService", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model1 = createStubModel([assistantResult(["hello"], [], "success")]);
    const model2 = createStubModel([assistantResult(["hello"], [], "success")]);
    const depsBase = {
      adapter: model1,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    };
    const { result: resultA } = await run("hi", depsBase);
    const { result: resultB } = await run("hi", {
      ...depsBase,
      adapter: model2,
      trace: createNoopTraceService(),
    });
    assert.deepEqual(resultB, resultA);
  });

  it("tool-call run: result is identical with undefined trace vs NoopTraceService", async () => {
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
      assistantResult(
        [],
        [{ id: "t1", name: "echo", input: { value: "ping" } }]
      ),
      assistantResult(["done"], [], "success"),
    ];
    const model1 = createStubModel(responses);
    const model2 = createStubModel(responses);
    const depsBase = {
      adapter: model1,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    };
    const { result: resultA } = await run("go", depsBase);
    const { result: resultB } = await run("go", {
      ...depsBase,
      adapter: model2,
      trace: createNoopTraceService(),
    });
    assert.deepEqual(resultB, resultA);
  });
});
describe("T4 criterion 8/11: JsonlTraceService integration", () => {
  it("writes llm, tool, turn records in order with parent_llm_call_id chain", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t4-"));
    const traceFile = join(tmpDir, "trace.jsonl");
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
    const model = createStubModel([
      assistantResult(
        [],
        [{ id: "t1", name: "echo", input: { value: "ping" } }]
      ),
      assistantResult(["done"], [], "success"),
    ]);
    const trace = createJsonlTraceService({
      filePath: traceFile,
      conversationId: "test-conv-1",
    });
    const { result } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 2);
    const lines = parseJsonl(traceFile);
    assert.equal(lines.length, 5);
    const types = lines.map((l) => l["record_type"]);
    assert.deepEqual(types, [
      "llm_call",
      "tool_call",
      "turn",
      "llm_call",
      "turn",
    ]);
    for (const line of lines) {
      assert.equal(line["conversation_id"], "test-conv-1");
    }
    const turn0Llm = lines[0]!;
    const turn0Tool = lines[1]!;
    const turn0Turn = lines[2]!;
    const turn1Llm = lines[3]!;
    const turn1Turn = lines[4]!;
    const turn0LlmId = turn0Llm["llm_call_id"] as string;
    const turn0ToolId = turn0Tool["tool_call_id"] as string;
    const turn1LlmId = turn1Llm["llm_call_id"] as string;
    assert.equal(turn0Tool["parent_llm_call_id"], turn0LlmId);
    assert.deepEqual(turn0Turn["llm_call_ids"], [turn0LlmId]);
    assert.deepEqual(turn0Turn["tool_call_ids"], [turn0ToolId]);
    assert.deepEqual(turn1Turn["llm_call_ids"], [turn1LlmId]);
    assert.deepEqual(turn1Turn["tool_call_ids"], []);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pure-text run: writes llm and turn only", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t4-"));
    const traceFile = join(tmpDir, "trace.jsonl");
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel([assistantResult(["hi"], [], "success")]);
    const trace = createJsonlTraceService({
      filePath: traceFile,
      conversationId: "test-conv-2",
    });
    await run("hello", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace,
    });
    const lines = parseJsonl(traceFile);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!["record_type"], "llm_call");
    assert.equal(lines[1]!["record_type"], "turn");
    assert.equal(lines[1]!["decision"], "completed");
    assert.equal(lines[1]!["status"], "ok");
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
describe("T4 criterion 11: recordTurn writes at step end", () => {
  it("multi-turn run: each turn record precedes the next turn llm record", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t4-"));
    const traceFile = join(tmpDir, "trace.jsonl");
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
    const model = createStubModel([
      assistantResult([], [{ id: "t1", name: "echo", input: { value: "1" } }]),
      assistantResult([], [{ id: "t2", name: "echo", input: { value: "2" } }]),
      assistantResult(["final"], [], "success"),
    ]);
    const trace = createJsonlTraceService({
      filePath: traceFile,
      conversationId: "test-conv-3",
    });
    await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace,
    });
    const lines = parseJsonl(traceFile);
    assert.equal(lines.length, 8);
    const types = lines.map((l) => l["record_type"]);
    assert.deepEqual(types, [
      "llm_call",
      "tool_call",
      "turn",
      "llm_call",
      "tool_call",
      "turn",
      "llm_call",
      "turn",
    ]);
    const allTurns = lines.filter((l) => l["record_type"] === "turn");
    assert.equal(allTurns.length, 3);
    assert.equal(allTurns[0]!["turn_index"], 0);
    assert.equal(allTurns[1]!["turn_index"], 1);
    assert.equal(allTurns[2]!["turn_index"], 2);
    const turn0TurnIdx = lines.findIndex(
      (l) => l["record_type"] === "turn" && l["turn_index"] === 0
    );
    const turn1LlmIdx = lines.findIndex(
      (l, i) => i > turn0TurnIdx && l["record_type"] === "llm_call"
    );
    assert.ok(turn0TurnIdx >= 0);
    assert.ok(turn1LlmIdx >= 0);
    assert.ok(turn0TurnIdx < turn1LlmIdx);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
describe("T4 criterion 11/14: recordLlmCall returns undefined", () => {
  it("when recordLlmCall returns undefined, recordToolCall gets parentLlmCallId: undefined", async () => {
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
    const model = createStubModel([
      assistantResult(
        [],
        [{ id: "t1", name: "echo", input: { value: "ping" } }]
      ),
      assistantResult(["done"], [], "success"),
    ]);
    const llmCallIds: Array<string | undefined> = [];
    const toolCallRecords: ToolCallRecord[] = [];
    const mockTrace: TraceService = {
      async recordLlmCall(_record: LlmCallRecord): Promise<string | undefined> {
        llmCallIds.push(undefined);
        return undefined;
      },
      async recordToolCall(
        record: ToolCallRecord
      ): Promise<string | undefined> {
        toolCallRecords.push(record);
        return "mock-tool-id";
      },
      async recordTurn(_record: TurnRecord): Promise<string | undefined> {
        return "mock-turn-id";
      },
    };
    const { result } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace: mockTrace,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(llmCallIds.length, 2);
    assert.equal(llmCallIds[0], undefined);
    assert.equal(llmCallIds[1], undefined);
    assert.equal(toolCallRecords.length, 1);
    assert.equal(toolCallRecords[0]!.parentLlmCallId, undefined);
    assert.equal(toolCallRecords[0]!.toolName, "echo");
    assert.equal(toolCallRecords[0]!.toolKind, "ok");
  });
});
describe("T4 criterion 5/19: error paths", () => {
  it("cancelled mid-model: recordLlmCall and recordTurn have status=error, error.type=cancelled", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t4-"));
    const traceFile = join(tmpDir, "trace.jsonl");
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel(
      [assistantResult(["never arrives"], [], "success")],
      { delayMs: 200 }
    );
    const trace = createJsonlTraceService({
      filePath: traceFile,
      conversationId: "test-conv-cancel",
    });
    const controller = new AbortController();
    const p = run(
      "x",
      {
        adapter: model,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        trace,
      },
      controller.signal
    );
    controller.abort();
    const { result } = await p;
    assert.equal(result.stopReason, "cancelled");
    const lines = parseJsonl(traceFile);
    assert.equal(lines.length, 2);
    const llmRecord = lines[0]!;
    const turnRecord = lines[1]!;
    assert.equal(llmRecord["record_type"], "llm_call");
    assert.equal(llmRecord["status"], "error");
    const llmError = llmRecord["error"] as { type: string; message: string };
    assert.equal(llmError.type, "cancelled");
    assert.equal(turnRecord["record_type"], "turn");
    assert.equal(turnRecord["status"], "error");
    assert.equal(turnRecord["decision"], "cancelled");
    const turnError = turnRecord["error"] as { type: string; message: string };
    assert.equal(turnError.type, "cancelled");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("timeout mid-model: recordLlmCall and recordTurn have status=error, error.type=timeout", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t4-"));
    const traceFile = join(tmpDir, "trace.jsonl");
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel([assistantResult(["never"], [], "success")], {
      delayMs: 200,
    });
    const trace = createJsonlTraceService({
      filePath: traceFile,
      conversationId: "test-conv-timeout",
    });
    const { result } = await run("x", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      modelTimeoutMs: 20,
      trace,
    });
    assert.equal(result.stopReason, "timeout");
    const lines = parseJsonl(traceFile);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!["status"], "error");
    const llmError = lines[0]!["error"] as { type: string };
    assert.equal(llmError.type, "timeout");
    assert.equal(lines[1]!["decision"], "timeout");
    assert.equal(lines[1]!["status"], "error");
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
