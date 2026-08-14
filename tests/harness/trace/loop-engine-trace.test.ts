/**
 * T4 LoopEngine instrumentation tests (GH #64).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../../../src/harness/loop-engine.ts";
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
  SessionRecord,
  SandboxCmdRecord,
  VerificationRecord,
} from "../../../src/harness/trace/types.ts";
import { assistantResult } from "../../cli/_fixtures.ts";
import { parseJsonl } from "./_fixtures.ts";
import type { TokenUsage } from "../../../src/harness/model-adapter/types.ts";

describe("T4 criterion 5: byte-level consistency", () => {
  it("pure-text run: result is identical with undefined trace vs NoopTraceService", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model1 = createStubModel({
      responses: [
        assistantResult({
          texts: ["hello"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const model2 = createStubModel({
      responses: [
        assistantResult({
          texts: ["hello"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t1", name: "echo", input: { value: "ping" } }],
      }),
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ];
    const model1 = createStubModel({ responses });
    const model2 = createStubModel({ responses });
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
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "ping" } }],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const trace = createJsonlTraceService({
      filePath: tmpDir,
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
    const lines = parseJsonl(join(tmpDir, "test-conv-1.jsonl"));
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
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["hi"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const trace = createJsonlTraceService({
      filePath: tmpDir,
      conversationId: "test-conv-2",
    });
    await run("hello", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace,
    });
    const lines = parseJsonl(join(tmpDir, "test-conv-2.jsonl"));
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
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "1" } }],
        }),
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t2", name: "echo", input: { value: "2" } }],
        }),
        assistantResult({
          texts: ["final"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const trace = createJsonlTraceService({
      filePath: tmpDir,
      conversationId: "test-conv-3",
    });
    await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace,
    });
    const lines = parseJsonl(join(tmpDir, "test-conv-3.jsonl"));
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
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "ping" } }],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
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
      async recordSession(_record: SessionRecord): Promise<string | undefined> {
        return "mock-session-id";
      },
      async recordSandboxCmd(
        _record: SandboxCmdRecord
      ): Promise<string | undefined> {
        return "mock-cmd-id";
      },
      async recordVerification(
        _record: VerificationRecord
      ): Promise<string | undefined> {
        return _record.id;
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
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["never arrives"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      delayMs: 200,
    });
    const trace = createJsonlTraceService({
      filePath: tmpDir,
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
    const lines = parseJsonl(join(tmpDir, "test-conv-cancel.jsonl"));
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
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["never"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      delayMs: 200,
    });
    const trace = createJsonlTraceService({
      filePath: tmpDir,
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
    const lines = parseJsonl(join(tmpDir, "test-conv-timeout.jsonl"));
    // plan T4 / ADR-0011:异常停后跑一轮 best-effort 收尾摘要,usage 照落
    // 一条独立的 status=ok llm_call(stub 无 usage → 不抄 *_tokens,Postel)。
    assert.equal(lines.length, 3);
    assert.equal(lines[0]!["status"], "error");
    const llmError = lines[0]!["error"] as { type: string };
    assert.equal(llmError.type, "timeout");
    assert.equal(lines[1]!["decision"], "timeout");
    assert.equal(lines[1]!["status"], "error");
    assert.equal(lines[2]!["record_type"], "llm_call");
    assert.equal(lines[2]!["status"], "ok");
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
describe("T3 (#160): token fields — ok-branch projection vs error-branch absence", () => {
  it("ok branch with usage: llm_call JSONL row carries snake_case *_tokens keys", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t3-ok-"));
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const usage: TokenUsage = {
      inputTokens: 111,
      outputTokens: 22,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 44,
    };
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["hi"],
          toolCalls: [],
          supplierStop: "success",
          usage,
        }),
      ],
    });
    const trace = createJsonlTraceService({
      filePath: tmpDir,
      conversationId: "test-conv-t3-ok",
    });
    await run("hello", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace,
    });
    const lines = parseJsonl(join(tmpDir, "test-conv-t3-ok.jsonl"));
    assert.equal(lines.length, 2);
    const llmRecord = lines[0]!;
    assert.equal(llmRecord["record_type"], "llm_call");
    assert.equal(llmRecord["input_tokens"], 111);
    assert.equal(llmRecord["output_tokens"], 22);
    assert.equal(llmRecord["cache_creation_input_tokens"], 3);
    assert.equal(llmRecord["cache_read_input_tokens"], 44);
    assert.equal(llmRecord["inputTokens"], undefined);
    assert.equal(llmRecord["outputTokens"], undefined);
    assert.equal(llmRecord["cacheCreationInputTokens"], undefined);
    assert.equal(llmRecord["cacheReadInputTokens"], undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("error branch (cancelled): llm_call JSONL row carries NO *_tokens keys (Postel)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t3-cancel-"));
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    // 即使 stub 自带 usage,error 分支 recordLlmCall 不抄入(ADR-0008 Decision 3)。
    const usage: TokenUsage = {
      inputTokens: 999,
      outputTokens: 888,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["never arrives"],
          toolCalls: [],
          supplierStop: "success",
          usage,
        }),
      ],
      delayMs: 200,
    });
    const trace = createJsonlTraceService({
      filePath: tmpDir,
      conversationId: "test-conv-t3-cancel",
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
    const lines = parseJsonl(join(tmpDir, "test-conv-t3-cancel.jsonl"));
    assert.equal(lines.length, 2);
    const llmRecord = lines[0]!;
    assert.equal(llmRecord["record_type"], "llm_call");
    assert.equal(llmRecord["status"], "error");
    const keys = Object.keys(llmRecord);
    for (const k of keys) {
      assert.ok(
        !k.endsWith("_tokens"),
        `error-branch llm_call row must not carry *_tokens keys; found ${k}: ${JSON.stringify(llmRecord)}`
      );
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ok branch with usage: byte-level result consistency holds (trace vs NoopTraceService)", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const usage: TokenUsage = {
      inputTokens: 7,
      outputTokens: 3,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    const responses = [
      assistantResult({
        texts: ["hello"],
        toolCalls: [],
        supplierStop: "success",
        usage,
      }),
    ];
    const model1 = createStubModel({ responses });
    const model2 = createStubModel({ responses });
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
});
describe("T3 (v2): session L1 root record (recordSession instrumentation)", () => {
  it("run with agentVersion + trace writes exactly 1 session root record", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t3-sess-"));
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
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "ping" } }],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const trace = createJsonlTraceService({
      filePath: tmpDir,
      conversationId: "sess-root",
    });
    const { result } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace,
      agentVersion: "0.22.0",
    });
    assert.equal(result.stopReason, "completed");
    const lines = parseJsonl(join(tmpDir, "sess-root.jsonl"));
    // 1 session 根 + 2 llm_call + 1 tool_call + 2 turn = 6 行。
    assert.equal(lines.length, 6);
    const sessions = lines.filter((l) => l["record_type"] === "session");
    assert.equal(sessions.length, 1, "exactly one session root record per run");
    // session 根记录在 run 末尾写盘(endedAt/durationMs/status 需 run 完成后
    // 才诚实确定,红线禁估算值),故物理上是文件最后一行;断言其存在且含
    // agentVersion 即可,不锁定物理位置。
    const root = sessions[0]!;
    assert.equal(root["record_type"], "session");
    assert.equal(root["agent_version"], "0.22.0");
    assert.equal(root["status"], "ok");
    assert.ok(typeof root["started_at"] === "string");
    assert.ok(typeof root["ended_at"] === "string");
    assert.ok(typeof root["duration_ms"] === "number");
    assert.equal(root["error"], undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("error stop (timeout): session root record has status=error + error.type", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t3-sess-err-"));
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["never"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      delayMs: 200,
    });
    const trace = createJsonlTraceService({
      filePath: tmpDir,
      conversationId: "sess-err",
    });
    const { result } = await run("x", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      modelTimeoutMs: 20,
      trace,
      agentVersion: "0.22.0",
    });
    assert.equal(result.stopReason, "timeout");
    const lines = parseJsonl(join(tmpDir, "sess-err.jsonl"));
    const sessions = lines.filter((l) => l["record_type"] === "session");
    assert.equal(sessions.length, 1);
    const root = sessions[0]!;
    assert.equal(root["record_type"], "session");
    assert.equal(root["agent_version"], "0.22.0");
    assert.equal(root["status"], "error");
    const sessErr = root["error"] as { type: string };
    assert.equal(sessErr.type, "timeout");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("agentVersion absent (legacy deps): NO session record written, byte-identical", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t3-sess-none-"));
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["hi"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const trace = createJsonlTraceService({
      filePath: tmpDir,
      conversationId: "sess-none",
    });
    await run("hello", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace,
    });
    const lines = parseJsonl(join(tmpDir, "sess-none.jsonl"));
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!["record_type"], "llm_call");
    assert.equal(lines[1]!["record_type"], "turn");
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
