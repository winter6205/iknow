/**
 * spec agent-status-instruction-echo T3（instruction 半边）/ plan 子弹 3:
 * `appendAgentStatusBar` 消费 T2 提取器 —— 最新真实用户指令首行逐字回显进
 * 每条 `<agent_status>` 栏,`agent_status` 流事件字段随同一份 snapshot 加性
 * 扩(SC6 同源)。reconcile 结算归子弹 4,本套件只钉「透传不结算」形态。
 *
 * 双轨 assert(仓规):
 *   - trace 轨:createJsonlTraceService 落盘 + createJsonlTraceReader 回读
 *     event sequence(llm_call / tool_call / turn 计数与终态);
 *   - 基线轨:no-trace vs NoopTraceService(真 trace 同理)messages / result
 *     deepEqual —— trace 观测不改变注入行为。
 *
 * 验收映射(plan 子弹 3 逐字):
 *   ① prior 含真实指令 → 该指令首行在每条栏的 `instruction:` 行(逐字、
 *      非摘要、第二行不进);append-only 每跳一条新栏照常;
 *   ② 同回合多跳每跳在场且不进 `deps.system`(request.system 恒等 provider
 *      返回值);
 *   ③ 流事件与栏文本同一 snapshot 派生(SC6):事件数据字段重放
 *      buildAgentStatusText === 当次请求尾栏逐字节;
 *   ④ 无真实用户消息时段(prior 全注入 + 不追加新 user 文本)→ `instruction:`
 *      段整段缺席(F1),事件字段退回旧三件;旧注入栏里的 instruction 行
 *      不被当指令复读;
 *   ⑤ todo 读取路径零变化(既有 agent-status-bar / stream / fields 套件
 *      全绿承担,本文件不重复其断言)。
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

/** 栏 body 里的 `instruction:` 行(至多一条);无 → undefined。 */
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
// ① + trace 双轨:真实指令逐字进每条栏;trace 观测不改变行为
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

    // 基线轨:no-trace vs NoopTraceService vs 真 trace —— 注入行为不受观测影响。
    assert.deepEqual(runNoop.result.messages, runNoTrace.result.messages);
    assert.deepEqual(runJsonl.result.messages, runNoTrace.result.messages);
    assert.deepEqual(runNoop.result, runNoTrace.result);
    assert.deepEqual(runJsonl.result, runNoTrace.result);

    // ① 每条栏(append-only 全量)都含指令首行的 `instruction:` 行,逐字回显。
    const bars = barTexts(runNoTrace.result.messages);
    assert.equal(bars.length, 2, "一跳一条栏 × 2 跳");
    for (const bar of bars) {
      assert.deepEqual(instructionLinesOf(bar), [
        `instruction: ${PIVOT_FIRST_LINE}`,
      ]);
      assert.ok(!bar.includes("第二行说明保留"), "只回显首行,非全文");
      // todo 段次序纪律:todos: 头仍在标量段之后(读取路径零变化的形态面)。
      assert.ok(bar.includes("todos:\n- [ ] [t1] alpha task"));
    }

    // trace 轨:reader 回读 event sequence(消费面 SSOT,不手解 JSONL)。
    const reader = createJsonlTraceReader({ filePath: traceFile });
    assert.equal(reader.query({ recordType: "llm_call" }).total, 2);
    assert.equal(reader.query({ recordType: "tool_call" }).total, 1);
    const turns = reader.query({ recordType: "turn" });
    // 一跳一条 turn 记录(step 级),末条 decision = completed。
    assert.equal(turns.total, 2);
    assert.equal(turns.records[0]!["decision"], "completed");
  });
});

// ---------------------------------------------------------------------------
// ② 同回合多跳每跳在场 + 不进 deps.system
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
    // 不进 deps.system:模型面 system 恒等 provider 原文,零附加。
    assert.deepEqual(systemsCaptured, [
      "BASE SYSTEM TEXT",
      "BASE SYSTEM TEXT",
      "BASE SYSTEM TEXT",
    ]);
  });
});

// ---------------------------------------------------------------------------
// ③ SC6:流事件与栏文本同一 snapshot 派生
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
      // 事件数据字段(即 snapshot 数据字段)重放 T1 构造器 === 当次尾栏。
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
// ④ F1:无真实用户消息时段 → 整段缺席
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
      // 当次注入的新栏(末条)整段无 instruction(F1:空槽不广告)。
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
