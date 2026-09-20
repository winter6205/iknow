/**
 * agent-status-instruction-echo spec (instruction half):
 * `appendAgentStatusBar` consumes the extractor from the prior layer — the
 * first line of the latest real user instruction is echoed verbatim into
 * every `<agent_status>` bar, and the `agent_status` stream-event fields grow
 * additively from the same snapshot (single source). Reconcile settlement is a
 * separate concern; this suite pins only the pass-through-without-settlement shape.
 *
 * Double-track asserts (repo rule):
 *   - trace track: createJsonlTraceService writes to disk + createJsonlTraceReader
 *     reads back the event sequence (llm_call / tool_call / turn counts and final state);
 *   - baseline track: no-trace vs NoopTraceService (real trace likewise) messages /
 *     result deepEqual — trace observation does not change injection behavior.
 *
 * Acceptance mapping:
 *   - prior contains a real instruction → its first line appears in every bar's
 *     `instruction:` line (verbatim, not a summary, the second line never enters);
 *     append-only still adds one new bar per hop;
 *   - present on every hop of a multi-hop turn and never in `deps.system`
 *     (request.system stays identical to the provider's return value);
 *   - stream events and bar text derive from the same snapshot: replaying the
 *     event data fields through buildAgentStatusText === that request's tail bar
 *     byte for byte;
 *   - windows with no real user messages (prior fully injected + no new user text
 *     appended) → the `instruction:` section is absent entirely, event fields
 *     revert to the legacy trio; instruction lines inside old injected bars are
 *     never re-read as instructions;
 *   - the todo read path is unchanged (held by the existing agent-status-bar /
 *     stream / fields suites going green; not re-asserted here).
 */
import { describe, it, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../../src/harness/loop-engine.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import { createJsonlTraceReader } from "../../src/traceserver/reader.ts";
import { buildAgentStatusText } from "../../src/harness/agent-status.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import {
  barTexts,
  makeSpyAdapter,
  makeTodoDir,
  okEchoTool,
} from "./_agent-status-fixtures.ts";

const tempDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The `instruction:` line(s) in a bar body (at most one); absent → empty list. */
function instructionLinesOf(barText: string): string[] {
  return barText
    .split("\n")
    .slice(1, -1)
    .filter((l) => l.startsWith("instruction: "));
}

const PIVOT_TEXT = "重写报告标题为 Q3\n第二行说明保留";
const PIVOT_FIRST_LINE = "重写报告标题为 Q3";

function scriptedModel(): LoopEngineDeps["adapter"] {
  return createStubModel({
    responses: [
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
      }),
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Real instructions enter every bar verbatim; trace observation changes
// nothing (double-track).
// ---------------------------------------------------------------------------

describe("instruction echo T3: prior 含真实指令 → 每条栏 instruction: 行", () => {
  it("① 多跳 run:result.messages 每条栏含指令首行(逐字、不含第二行);双轨 = reader event sequence + no-trace/noop/jsonl messages deepEqual", async () => {
    const todoDir = await makeTodoDir("- [ ] alpha task\n");
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);

    const runNoTrace = await run(PIVOT_TEXT, {
      adapter: scriptedModel(),
      executor: exec,
      registry: reg,
      maxTurns: 5,
      agentStatus: { todoDir },
    });
    const runNoop = await run(PIVOT_TEXT, {
      adapter: scriptedModel(),
      executor: exec,
      registry: reg,
      maxTurns: 5,
      agentStatus: { todoDir },
      trace: createNoopTraceService(),
    });
    const traceDir = makeTmpDir("iknow-instruction-trace-");
    const traceFile = join(traceDir, "conv-t3.jsonl");
    const runJsonl = await run(PIVOT_TEXT, {
      adapter: scriptedModel(),
      executor: exec,
      registry: reg,
      maxTurns: 5,
      agentStatus: { todoDir },
      trace: createJsonlTraceService({
        traceFilePath: traceFile,
        conversationId: "conv-t3",
      }),
    });

    // Baseline track: no-trace vs NoopTraceService vs real trace — injection behavior is unaffected by observation.
    assert.deepEqual(runNoop.result.messages, runNoTrace.result.messages);
    assert.deepEqual(runJsonl.result.messages, runNoTrace.result.messages);
    assert.deepEqual(runNoop.result, runNoTrace.result);
    assert.deepEqual(runJsonl.result, runNoTrace.result);

    // Every bar (full append-only set) carries the instruction's first line as an `instruction:` row, echoed verbatim.
    const bars = barTexts(runNoTrace.result.messages);
    assert.equal(bars.length, 2, "一跳一条栏 × 2 跳");
    for (const bar of bars) {
      assert.deepEqual(instructionLinesOf(bar), [
        `instruction: ${PIVOT_FIRST_LINE}`,
      ]);
      assert.ok(!bar.includes("第二行说明保留"), "只回显首行,非全文");
      // Todo-section ordering discipline: the `todos:` header still follows the scalar sections (read path shape unchanged).
      assert.ok(bar.includes("todos:\n- [ ] [t1] alpha task"));
    }

    // Trace track: read the event sequence back via the reader (consumer-side SSOT, no manual JSONL parsing).
    const reader = createJsonlTraceReader({ filePath: traceFile });
    assert.equal(reader.query({ recordType: "llm_call" }).total, 2);
    assert.equal(reader.query({ recordType: "tool_call" }).total, 1);
    const turns = reader.query({ recordType: "turn" });
    // One turn record per hop (step level); the last record's decision = completed.
    assert.equal(turns.total, 2);
    assert.equal(turns.records[0]!["decision"], "completed");
  });
});

// ---------------------------------------------------------------------------
// Present on every hop of a multi-turn hop sequence + never enters deps.system.
// ---------------------------------------------------------------------------

describe("instruction echo T3: 每跳在场且不进 system", () => {
  it("② 三跳请求的尾栏都含 instruction 行;request.system 恒等 provider 返回值", async () => {
    const todoDir = await makeTodoDir("- [ ] alpha task\n");
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const { adapter, captured, systemsCaptured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
        }),
      },
      {
        kind: "reply",
        result: assistantResult({
          texts: [],
          toolCalls: [{ id: "t2", name: "echo", input: { value: "b" } }],
        }),
      },
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);

    const { result } = await run(
      PIVOT_TEXT,
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        agentStatus: { todoDir },
        system: async () => "BASE SYSTEM TEXT",
      },
      undefined,
      {
        priorMessages: [
          { role: "user", content: [{ type: "text", text: "更早的一条指令" }] },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ],
      }
    );

    assert.equal(result.stopReason, "completed");
    assert.equal(captured.length, 3, "同回合三跳");
    for (let i = 0; i < captured.length; i++) {
      const bars = barTexts(captured[i]!);
      assert.equal(
        bars.length,
        i + 1,
        `第 ${i + 1} 跳请求含 ${i + 1} 条栏(append-only)`
      );
      for (const bar of bars) {
        assert.deepEqual(instructionLinesOf(bar), [
          `instruction: ${PIVOT_FIRST_LINE}`,
        ]);
      }
    }
    // Never in deps.system: the model-facing system stays byte-identical to the provider's original text, zero additions.
    assert.deepEqual(systemsCaptured, [
      "BASE SYSTEM TEXT",
      "BASE SYSTEM TEXT",
      "BASE SYSTEM TEXT",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Stream events and bar text derive from the same snapshot.
// ---------------------------------------------------------------------------

describe("instruction echo T3: 流事件与栏同源", () => {
  it("③ 事件数据字段重放 buildAgentStatusText === 当次请求尾栏逐字节;事件带 instruction 字段", async () => {
    const todoDir = await makeTodoDir("- [ ] alpha task\n");
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
        }),
      },
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);
    const events: (HarnessStreamEvent & { type: "agent_status" })[] = [];

    await run(
      PIVOT_TEXT,
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        agentStatus: { todoDir },
      },
      undefined,
      {
        onStream: (event) => {
          if (event.type === "agent_status") events.push(event);
        },
      }
    );

    assert.equal(events.length, 2);
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      assert.equal(ev.instruction, PIVOT_FIRST_LINE, "事件字段 = 栏同源指令");
      // Replaying the event data fields (i.e. the snapshot data fields) through the bar builder === that hop's tail bar.
      const snapshotFields = {
        lastTool: ev.lastTool,
        openTodoLines: ev.openTodoLines,
        ...(ev.instruction !== undefined && ev.instruction !== null
          ? { instruction: ev.instruction }
          : {}),
        ...(ev.reconcile !== undefined ? { reconcile: ev.reconcile } : {}),
      };
      const tailBar = barTexts(captured[i]!).at(-1)!;
      assert.equal(
        buildAgentStatusText(snapshotFields),
        tailBar,
        `事件 #${i + 1} 数据字段重放 === 当次尾栏(同一 snapshot)`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Windows with no real user messages → the instruction section is absent.
// ---------------------------------------------------------------------------

describe("instruction echo T3: F1 全注入 prior → instruction 段整段缺席", () => {
  it("④ prior 只含宿主注入(旧栏自带 instruction 行 + MCP 重连)且不追加新 user 文本 → 栏退回旧字段集形态、事件零新字段", async () => {
    const todoDir = await makeTodoDir("- [ ] alpha task\n");
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
        }),
      },
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);
    const priorMessages: AnthropicNativeMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<agent_status>\nlast_tool: echo\ninstruction: 旧指令不应被复读\n</agent_status>",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "MCP server 'demo' reconnected." }],
      },
    ];
    const events: (HarnessStreamEvent & { type: "agent_status" })[] = [];

    const { result } = await run(
      "",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        agentStatus: { todoDir },
      },
      undefined,
      {
        priorMessages,
        appendUserText: false,
        onStream: (event) => {
          if (event.type === "agent_status") events.push(event);
        },
      }
    );

    assert.equal(result.stopReason, "completed");
    assert.equal(captured.length, 2);
    for (const messages of captured) {
      const bars = barTexts(messages);
      // The bar injected this hop (the last one) has no instruction section at all (empty slots are not advertised).
      const tail = bars.at(-1)!;
      assert.deepEqual(instructionLinesOf(tail), []);
      assert.ok(!tail.includes("旧指令不应被复读"), "旧注入栏不进指令源");
    }
    assert.equal(events.length, 2);
    for (const ev of events) {
      assert.deepEqual(
        Object.keys(ev).sort(),
        ["lastTool", "openTodoLines", "type"],
        "F1 事件字段 = 旧三件(instruction 键缺席而非 null)"
      );
    }
  });
});
