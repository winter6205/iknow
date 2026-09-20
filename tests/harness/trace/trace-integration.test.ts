/**
 * Trace Service integration tests.
 *
 * 5 scenarios end-to-end (stub model + stub tool, full run):
 *   1. pure text turn
 *   2. single tool turn
 *   3. multi tool turn (parent chain)
 *   4. cancelled (abort mid-model)
 *   5. timeout (modelTimeoutMs extreme)
 *
 * Plus:
 *   - criterion 5: byte-level consistency (noop vs no-trace, 5 scenarios)
 *   - criterion 11: JSONL record order + parent_llm_call_id chain + real-time write
 *   - criterion 10: always-throw writer resilience (harness completes, console.warn)
 */

import { describe, it, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
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
import { assistantResult } from "../../cli/_fixtures.ts";
import { parseJsonl } from "./_fixtures.ts";

const tmpDirs: string[] = [];

function makeTmpTrace(conversationId: string): {
  traceDir: string;
  traceFile: string;
  trace: ReturnType<typeof createJsonlTraceService>;
} {
  const dir = mkdtempSync(join(tmpdir(), "iknow-trace-integration-"));
  tmpDirs.push(dir);
  // Per-session file layout: filePath is a directory; writes go to <dir>/<conversationId>.jsonl.
  const trace = createJsonlTraceService({
    filePath: dir,
    conversationId,
  });
  const traceFile = join(dir, `${conversationId}.jsonl`);
  return { traceDir: dir, traceFile, trace };
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function echoTool(): ToolDef {
  return createStubTool({
    name: "echo",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    next: (input: unknown) => input,
  });
}

function noopTool(): ToolDef {
  return createStubTool({ name: "noop", next: () => ({}) });
}
// ---------------------------------------------------------------------------
// Scenario 1: pure text turn
// ---------------------------------------------------------------------------

describe("T6 scenario 1: pure text turn", () => {
  it("JSONL has llm_call + turn records; run completes", async () => {
    const reg = createRegistry([noopTool()]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["hello"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { traceDir, traceFile, trace } = makeTmpTrace("conv-s1");

    const { result } = await run("hi", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace,
    });

    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 1);
    assert.equal(result.finalText, "hello");

    // Per-session files: <convId>.jsonl inside the dir, not a bare trace.jsonl.
    assert.equal(existsSync(traceFile), true, "per-session file must exist");
    assert.equal(
      existsSync(join(traceDir, "trace.jsonl")),
      false,
      "no bare trace.jsonl when per-session file semantics"
    );

    const lines = parseJsonl(traceFile);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!["record_type"], "llm_call");
    assert.equal(lines[0]!["status"], "ok");
    assert.equal(lines[1]!["record_type"], "turn");
    assert.equal(lines[1]!["decision"], "completed");
    assert.equal(lines[1]!["status"], "ok");
    for (const line of lines) {
      assert.equal(line["conversation_id"], "conv-s1");
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: single tool turn
// ---------------------------------------------------------------------------

describe("T6 scenario 2: single tool turn", () => {
  it("JSONL has llm_call + tool_call + turn + llm_call + turn", async () => {
    const reg = createRegistry([echoTool()]);
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
    const { traceFile, trace } = makeTmpTrace("conv-s2");

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

    assert.equal(lines[1]!["status"], "ok");
    assert.equal(lines[1]!["tool_name"], "echo");
    assert.equal(lines[2]!["decision"], "completed");
    assert.equal(lines[4]!["decision"], "completed");
  });
});
// ---------------------------------------------------------------------------
// Scenario 3: multi tool turn + parent chain
// ---------------------------------------------------------------------------

describe("T6 scenario 3: multi tool turn", () => {
  it("JSONL has multiple tool_call records; parent_llm_call_id all point to same llm_call", async () => {
    const reg = createRegistry([echoTool()]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            { id: "a", name: "echo", input: { value: "1" } },
            { id: "b", name: "echo", input: { value: "2" } },
            { id: "c", name: "echo", input: { value: "3" } },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { traceFile, trace } = makeTmpTrace("conv-s3");

    const { result } = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace,
    });

    assert.equal(result.stopReason, "completed");

    const lines = parseJsonl(traceFile);
    assert.equal(lines.length, 7);
    const types = lines.map((l) => l["record_type"]);
    assert.deepEqual(types, [
      "llm_call",
      "tool_call",
      "tool_call",
      "tool_call",
      "turn",
      "llm_call",
      "turn",
    ]);

    const llmCallId = lines[0]!["llm_call_id"] as string;
    assert.ok(typeof llmCallId === "string" && llmCallId.length > 0);
    for (let i = 1; i <= 3; i++) {
      assert.equal(lines[i]!["parent_llm_call_id"], llmCallId);
    }

    const turn0 = lines[4]!;
    assert.deepEqual(turn0["llm_call_ids"], [llmCallId]);
    const toolCallIds = (turn0["tool_call_ids"] as string[]) ?? [];
    assert.equal(toolCallIds.length, 3);
  });
});
// ---------------------------------------------------------------------------
// Scenario 4: cancelled (abort mid-model)
// ---------------------------------------------------------------------------

describe("T6 scenario 4: cancelled", () => {
  it("JSONL has error records with error.type cancelled", async () => {
    const reg = createRegistry([noopTool()]);
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
    const { traceFile, trace } = makeTmpTrace("conv-s4");

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
    assert.equal(result.turnCount, 0);

    const lines = parseJsonl(traceFile);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!["record_type"], "llm_call");
    assert.equal(lines[0]!["status"], "error");
    const llmErr = lines[0]!["error"] as { type: string; message: string };
    assert.equal(llmErr.type, "cancelled");
    assert.equal(lines[1]!["record_type"], "turn");
    assert.equal(lines[1]!["status"], "error");
    assert.equal(lines[1]!["decision"], "cancelled");
    const turnErr = lines[1]!["error"] as { type: string };
    assert.equal(turnErr.type, "cancelled");
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: timeout (extreme modelTimeoutMs)
// ---------------------------------------------------------------------------

describe("T6 scenario 5: timeout", () => {
  it("JSONL has error records with error.type timeout", async () => {
    const reg = createRegistry([noopTool()]);
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
    const { traceFile, trace } = makeTmpTrace("conv-s5");

    const { result } = await run("x", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      modelTimeoutMs: 1,
      trace,
    });

    assert.equal(result.stopReason, "timeout");
    assert.equal(result.turnCount, 0);

    const lines = parseJsonl(traceFile);
    // ADR-0011: abnormal-stop wrap-up adds one extra closing llm_call with status=ok.
    assert.equal(lines.length, 3);
    assert.equal(lines[0]!["record_type"], "llm_call");
    assert.equal(lines[0]!["status"], "error");
    const llmErr = lines[0]!["error"] as { type: string };
    assert.equal(llmErr.type, "timeout");
    assert.equal(lines[1]!["record_type"], "turn");
    assert.equal(lines[1]!["status"], "error");
    assert.equal(lines[1]!["decision"], "timeout");
    const turnErr = lines[1]!["error"] as { type: string };
    assert.equal(turnErr.type, "timeout");
    assert.equal(lines[2]!["record_type"], "llm_call");
    assert.equal(lines[2]!["status"], "ok");
  });
});
// ---------------------------------------------------------------------------
// Criterion 5: byte-level consistency (noop vs no-trace, all 5 scenarios)
// ---------------------------------------------------------------------------

describe("T6 criterion 5: byte-level consistency", () => {
  it("pure text: result identical with NoopTraceService vs undefined trace", async () => {
    const reg = createRegistry([noopTool()]);
    const exec = createExecutor(reg);
    const m1 = createStubModel({
      responses: [
        assistantResult({
          texts: ["hi"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const m2 = createStubModel({
      responses: [
        assistantResult({
          texts: ["hi"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const base = { executor: exec, registry: reg, maxTurns: 5 };

    const { result: withoutTrace } = await run("hello", {
      ...base,
      adapter: m1,
    });
    const { result: withNoop } = await run("hello", {
      ...base,
      adapter: m2,
      trace: createNoopTraceService(),
    });
    assert.deepEqual(withNoop, withoutTrace);
  });

  it("single tool: result identical with NoopTraceService vs undefined trace", async () => {
    const reg = createRegistry([echoTool()]);
    const exec = createExecutor(reg);
    const responses = [
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t1", name: "echo", input: { value: "p" } }],
      }),
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ];
    const m1 = createStubModel({ responses });
    const m2 = createStubModel({ responses });
    const base = { executor: exec, registry: reg, maxTurns: 5 };

    const { result: withoutTrace } = await run("go", { ...base, adapter: m1 });
    const { result: withNoop } = await run("go", {
      ...base,
      adapter: m2,
      trace: createNoopTraceService(),
    });
    assert.deepEqual(withNoop, withoutTrace);
  });

  it("multi tool: result identical with NoopTraceService vs undefined trace", async () => {
    const reg = createRegistry([echoTool()]);
    const exec = createExecutor(reg);
    const responses = [
      assistantResult({
        texts: [],
        toolCalls: [
          { id: "a", name: "echo", input: { value: "1" } },
          { id: "b", name: "echo", input: { value: "2" } },
        ],
      }),
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ];
    const m1 = createStubModel({ responses });
    const m2 = createStubModel({ responses });
    const base = { executor: exec, registry: reg, maxTurns: 5 };

    const { result: withoutTrace } = await run("go", { ...base, adapter: m1 });
    const { result: withNoop } = await run("go", {
      ...base,
      adapter: m2,
      trace: createNoopTraceService(),
    });
    assert.deepEqual(withNoop, withoutTrace);
  });

  it("cancelled: result identical with NoopTraceService vs undefined trace", async () => {
    const reg = createRegistry([noopTool()]);
    const exec = createExecutor(reg);
    const base = { executor: exec, registry: reg, maxTurns: 5 };

    const m1 = createStubModel({
      responses: [
        assistantResult({
          texts: ["x"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      delayMs: 200,
    });
    const c1 = new AbortController();
    const p1 = run("x", { ...base, adapter: m1 }, c1.signal);
    c1.abort();
    const { result: withoutTrace } = await p1;

    const m2 = createStubModel({
      responses: [
        assistantResult({
          texts: ["x"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      delayMs: 200,
    });
    const c2 = new AbortController();
    const p2 = run(
      "x",
      { ...base, adapter: m2, trace: createNoopTraceService() },
      c2.signal
    );
    c2.abort();
    const { result: withNoop } = await p2;

    assert.deepEqual(withNoop, withoutTrace);
  });

  it("timeout: result identical with NoopTraceService vs undefined trace", async () => {
    const reg = createRegistry([noopTool()]);
    const exec = createExecutor(reg);
    const base = {
      executor: exec,
      registry: reg,
      maxTurns: 5,
      modelTimeoutMs: 1,
    };

    const m1 = createStubModel({
      responses: [
        assistantResult({
          texts: ["x"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      delayMs: 200,
    });
    const { result: withoutTrace } = await run("x", { ...base, adapter: m1 });

    const m2 = createStubModel({
      responses: [
        assistantResult({
          texts: ["x"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      delayMs: 200,
    });
    const { result: withNoop } = await run("x", {
      ...base,
      adapter: m2,
      trace: createNoopTraceService(),
    });

    assert.deepEqual(withNoop, withoutTrace);
  });
});
// ---------------------------------------------------------------------------
// Criterion 11: JSONL record order + parent chain + real-time write
// ---------------------------------------------------------------------------

describe("T6 criterion 11: JSONL order, parent chain, real-time write", () => {
  it("multi-step run: llm -> tool(s) -> turn per step; turn precedes next llm", async () => {
    const reg = createRegistry([echoTool()]);
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
    const { traceFile, trace } = makeTmpTrace("conv-order");

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

    const llm0 = lines[0]!["llm_call_id"] as string;
    const llm1 = lines[3]!["llm_call_id"] as string;
    assert.equal(lines[1]!["parent_llm_call_id"], llm0);
    assert.equal(lines[4]!["parent_llm_call_id"], llm1);

    assert.deepEqual(lines[2]!["llm_call_ids"], [llm0]);
    assert.deepEqual(lines[5]!["llm_call_ids"], [llm1]);

    const turn0Idx = lines.findIndex(
      (l) => l["record_type"] === "turn" && l["turn_index"] === 0
    );
    const llm1Idx = lines.findIndex(
      (l, i) => i > turn0Idx && l["record_type"] === "llm_call"
    );
    assert.ok(turn0Idx >= 0);
    assert.ok(llm1Idx >= 0);
    assert.ok(turn0Idx < llm1Idx, "turn 0 must precede step 1 llm_call");

    const turnRecords = lines.filter((l) => l["record_type"] === "turn");
    assert.equal(turnRecords.length, 3);
    assert.equal(turnRecords[0]!["turn_index"], 0);
    assert.equal(turnRecords[1]!["turn_index"], 1);
    assert.equal(turnRecords[2]!["turn_index"], 2);
  });

  it("JSONL file is non-empty after run (appendFileSync real-time write)", async () => {
    const reg = createRegistry([echoTool()]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "x" } }],
        }),
        assistantResult({
          texts: ["ok"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { traceFile, trace } = makeTmpTrace("conv-realtime");

    await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace,
    });

    const lines = parseJsonl(traceFile);
    assert.ok(lines.length > 0, "JSONL must be non-empty after run");
    assert.equal(lines[0]!["record_type"], "llm_call");
  });
});
// ---------------------------------------------------------------------------
// Criterion 10: always-throw writer resilience
// ---------------------------------------------------------------------------

describe("T6 criterion 10: always-throw writer", () => {
  it("harness completes normally; console.warn is called", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const reg = createRegistry([echoTool()]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "p" } }],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });

    const throwingWriter = (): void => {
      throw new Error("disk full");
    };
    const trace = createJsonlTraceService({
      filePath: "/dev/null/does-not-matter",
      conversationId: "conv-throw",
      writer: throwingWriter,
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
    assert.equal(result.finalText, "done");

    assert.ok(warnSpy.mock.calls.length >= 1, "console.warn must be called");
  });

  it("pure text run also survives always-throw writer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const reg = createRegistry([noopTool()]);
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
      filePath: "/dev/null/does-not-matter",
      conversationId: "conv-throw-2",
      writer: () => {
        throw new Error("permission denied");
      },
    });

    const { result } = await run("hello", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace,
    });

    assert.equal(result.stopReason, "completed");
    assert.equal(result.finalText, "hi");
  });
});
