/**
 * spec agent-status-instruction-echo T3 结算半边 / plan 子弹 4:
 * reconcile run 作用域一次性结算 —— `appendAgentStatusBar` 内经 run 作用域
 * 装箱(`reconcileRef.stamped`,照 `lastToolRef` 形态)结算:新真实用户消息
 * 进场后的**下一条栏**附固定标记行,次跳起消失;标记在场条件只有一个
 * (invariant 3)——与 todo_write 调用史 / todo 段在场 / 栏变化无关。
 * reactive-compact 重试调用点与正常 step 调用点共享同一装箱,结算行为同形:
 * compact 对 kept 尾的 re-freeze 克隆不伪造「新消息进场」信号(clone 的
 * frozen 消息与 stamped 同内容 → 视作同一条,不重复标记)。
 *
 * 双轨 assert(仓规):
 *   - trace 轨:createJsonlTraceService 落盘 + createJsonlTraceReader 回读
 *     event sequence(llm_call / turn 计数与终态);
 *   - 基线轨:no-trace vs NoopTraceService vs 真 trace 三方 messages /
 *     result deepEqual —— 结算装箱不改变注入行为。
 *
 * 验收映射(plan 子弹 4 逐字):
 *   ① 新消息进场首跳栏含 reconcile 行、次跳起消失(常量行字节一致 =
 *      T1 AGENT_STATUS_RECONCILE_LINE);
 *   ② 第二波消息(新 run)再标记一次、该 run 次跳起消失;
 *   ③ todo 段为空时标记独立在场(invariant 3:条件与 todo 无关);
 *   ④ 两处调用点(含 reactive-compact 重试)结算行为同形(同一装箱:
 *      compact 重试栏不再重复标记、instruction 仍在);
 *   ⑤ F1 无判定对象(prior 全注入)→ reconcile 不结算:栏无标记行、
 *      事件无 reconcile key(与 T3 ④ 的旧字段集退回形态同一契约)。
 */
import { describe, it, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../../src/harness/loop-engine.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import { createJsonlTraceReader } from "../../src/traceserver/reader.ts";
import { AGENT_STATUS_RECONCILE_LINE } from "../../src/harness/agent-status.ts";
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

/** 栏 body 里的 reconcile 标记行(常量行逐字)。 */
function reconcileLinesOf(barText: string): string[] {
  return barText
    .split("\n")
    .slice(1, -1)
    .filter((l) => l === AGENT_STATUS_RECONCILE_LINE);
}

const FIRST_TEXT = "先做A\n附注";
const SECOND_TEXT = "改成做B";

function threeHopModel(): LoopEngineDeps["adapter"] {
  return createStubModel({
    responses: [
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
      }),
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t2", name: "echo", input: { value: "b" } }],
      }),
      assistantResult({ texts: ["done"], toolCalls: [], supplierStop: "success" }),
    ],
  });
}

// ---------------------------------------------------------------------------
// ① 首跳在场、次跳起消失 + 双轨(仓规基线)
// ---------------------------------------------------------------------------

describe("reconcile T4: 新消息进场首跳标记、次跳起消失", () => {
  it("① 三跳 run:仅第一条栏含 reconcile 常量行;双轨 = reader event sequence + no-trace/noop/jsonl messages deepEqual", async () => {
    const todoDir = await makeTodoDir("- [ ] alpha task\n");
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);

    const runNoTrace = await run(FIRST_TEXT, {
      adapter: threeHopModel(),
      executor: exec,
      registry: reg,
      maxTurns: 5,
      agentStatus: { todoDir },
    });
    const runNoop = await run(FIRST_TEXT, {
      adapter: threeHopModel(),
      executor: exec,
      registry: reg,
      maxTurns: 5,
      agentStatus: { todoDir },
      trace: createNoopTraceService(),
    });
    const traceDir = makeTmpDir("iknow-reconcile-trace-");
    const traceFile = join(traceDir, "conv-t4.jsonl");
    const runJsonl = await run(FIRST_TEXT, {
      adapter: threeHopModel(),
      executor: exec,
      registry: reg,
      maxTurns: 5,
      agentStatus: { todoDir },
      trace: createJsonlTraceService({
        traceFilePath: traceFile,
        conversationId: "conv-t4",
      }),
    });

    // 基线轨:结算装箱不改变注入行为 —— 三方 messages / result deepEqual。
    assert.deepEqual(runNoop.result.messages, runNoTrace.result.messages);
    assert.deepEqual(runJsonl.result.messages, runNoTrace.result.messages);
    assert.deepEqual(runNoop.result, runNoTrace.result);
    assert.deepEqual(runJsonl.result, runNoTrace.result);

    const bars = barTexts(runNoTrace.result.messages);
    assert.equal(bars.length, 3, "一跳一条栏 × 3 跳");
    // ① 常量行跨回合字节一致(=== T1 导出常量,逐字)。
    assert.deepEqual(reconcileLinesOf(bars[0]!), [AGENT_STATUS_RECONCILE_LINE]);
    assert.deepEqual(reconcileLinesOf(bars[1]!), [], "次跳起消失");
    assert.deepEqual(reconcileLinesOf(bars[2]!), [], "三跳仍消失");
    // 在场条件与栏内容无关:标记消失时 instruction 行仍在(每跳在场)。
    for (const bar of bars) {
      assert.ok(bar.includes("instruction: 先做A"));
    }

    // trace 轨:reader 回读 event sequence(消费面 SSOT)。
    const reader = createJsonlTraceReader({ filePath: traceFile });
    assert.equal(reader.query({ recordType: "llm_call" }).total, 3);
    assert.equal(reader.query({ recordType: "tool_call" }).total, 2);
    const turns = reader.query({ recordType: "turn" });
    assert.equal(turns.total, 3);
    assert.equal(turns.records[0]!["decision"], "completed");
  });
});

// ---------------------------------------------------------------------------
// ② 第二波消息(新 run)再标记一次
// ---------------------------------------------------------------------------

describe("reconcile T4: 新 run 的第二波用户消息再标记一次", () => {
  it("② run1(result.messages 作 prior)+ 新 user 文本进 run2:run2 首跳栏含标记行、次跳消失;标记随 run 装箱重置", async () => {
    const todoDir = await makeTodoDir("- [ ] alpha task\n");
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);

    const run1 = await run(FIRST_TEXT, {
      adapter: twoHopModel(),
      executor: exec,
      registry: reg,
      maxTurns: 5,
      agentStatus: { todoDir },
    });
    assert.deepEqual(reconcileLinesOf(barTexts(run1.result.messages)[0]!), [
      AGENT_STATUS_RECONCILE_LINE,
    ]);

    const run2 = await run(
      SECOND_TEXT,
      {
        adapter: twoHopModel(),
        executor: exec,
        registry: reg,
        maxTurns: 5,
        agentStatus: { todoDir },
      },
      undefined,
      { priorMessages: run1.result.messages }
    );

    const newBars = barTexts(run2.result.messages).slice(
      barTexts(run1.result.messages).length
    );
    assert.equal(newBars.length, 2, "run2 两跳各一条新栏");
    assert.deepEqual(reconcileLinesOf(newBars[0]!), [
      AGENT_STATUS_RECONCILE_LINE,
    ], "第二波进场 → 新 run 首跳再标记");
    assert.deepEqual(reconcileLinesOf(newBars[1]!), []);
    assert.ok(newBars[0]!.includes(`instruction: ${SECOND_TEXT}`));
    assert.ok(newBars[1]!.includes(`instruction: ${SECOND_TEXT}`));
  });
});

function twoHopModel(): LoopEngineDeps["adapter"] {
  return createStubModel({
    responses: [
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
      }),
      assistantResult({ texts: ["done"], toolCalls: [], supplierStop: "success" }),
    ],
  });
}

// ---------------------------------------------------------------------------
// ③ todo 段为空时标记独立在场(invariant 3)
// ---------------------------------------------------------------------------

describe("reconcile T4: 在场条件独立于 todo 段", () => {
  it("③ 无 todos.md(todo 段缺席)→ 首跳栏仍含标记行且无 `todos:` 头", async () => {
    const todoDir = await makeTodoDir(); // 空目录:不写 todos.md
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);

    const { result } = await run(FIRST_TEXT, {
      adapter: twoHopModel(),
      executor: exec,
      registry: reg,
      maxTurns: 5,
      agentStatus: { todoDir },
    });
    const bars = barTexts(result.messages);
    assert.equal(bars.length, 2);
    assert.deepEqual(reconcileLinesOf(bars[0]!), [
      AGENT_STATUS_RECONCILE_LINE,
    ], "todo 段为空时标记独立在场");
    assert.ok(!bars[0]!.includes("todos:"), "空 todo 段不广告");
    assert.deepEqual(reconcileLinesOf(bars[1]!), []);
  });
});

// ---------------------------------------------------------------------------
// ④ reactive-compact 重试调用点结算同形(共享同一装箱)
// ---------------------------------------------------------------------------

describe("reconcile T4: compact 重试与正常 step 结算同形", () => {
  it("④ promptTooLong → compact 重试:首试栏标记、重试栏不重复标记(clone 不当新消息);事件同形 true→false", async () => {
    const todoDir = await makeTodoDir("- [ ] survive compact\n");
    const noop = okEchoTool("noop");
    const reg = createRegistry([noop]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      { kind: "promptTooLong" },
      {
        kind: "reply",
        result: assistantResult({ texts: ["done after compact"], toolCalls: [] }),
      },
    ]);
    const longPrior = Array.from({ length: 12 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `prior-${i}` }],
    }));
    const events: (HarnessStreamEvent & { type: "agent_status" })[] = [];

    const { result } = await run(
      "Q 指令",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
        agentStatus: { todoDir },
      },
      undefined,
      {
        priorMessages: longPrior,
        onStream: (event) => {
          if (event.type === "agent_status") events.push(event);
        },
      }
    );

    assert.equal(result.stopReason, "completed");
    assert.equal(captured.length, 2, "首试 + compact 重试各一跳");
    // 首试请求尾栏:标记在场(新指令进场后的下一条栏)。
    assert.deepEqual(reconcileLinesOf(barTexts(captured[0]!).at(-1)!), [
      AGENT_STATUS_RECONCILE_LINE,
    ]);
    // 重试请求尾栏:同一条指令(compact kept 尾 re-freeze 克隆)不伪造进场
    // —— 两处调用点共享同一装箱,结算同形;instruction 回显不受影响。
    const retryBar = barTexts(captured[1]!).at(-1)!;
    assert.deepEqual(reconcileLinesOf(retryBar), []);
    assert.ok(retryBar.includes("instruction: Q 指令"));
    // 事件面同源:同一 snapshot 派生 → true → false(键在场而非缺席)。
    assert.equal(events.length, 2);
    assert.equal(events[0]!.reconcile, true);
    assert.equal(events[1]!.reconcile, false);
  });
});

// ---------------------------------------------------------------------------
// ⑤ F1:无判定对象 → 不结算(栏无标记行、事件无 reconcile key)
// ---------------------------------------------------------------------------

describe("reconcile T4: F1 全注入 prior → reconcile 不结算", () => {
  it("⑤ prior 全宿主注入 + 不追加新 user 文本 → 新栏无标记行、事件 key 退回旧三件", async () => {
    const todoDir = await makeTodoDir("- [ ] alpha task\n");
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const { adapter } = makeSpyAdapter([
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
        priorMessages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `<agent_status>\nlast_tool: echo\n${AGENT_STATUS_RECONCILE_LINE}\n</agent_status>`,
              },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ],
        appendUserText: false,
        onStream: (event) => {
          if (event.type === "agent_status") events.push(event);
        },
      }
    );

    assert.equal(result.stopReason, "completed");
    const bars = barTexts(result.messages);
    // 旧栏自带标记行也不被复读:新注入栏(末两条)无标记行。
    const injected = bars.slice(1);
    assert.equal(injected.length, 2);
    for (const bar of injected) {
      assert.deepEqual(reconcileLinesOf(bar), [], "F1 无判定对象不结算");
    }
    assert.equal(events.length, 2);
    for (const ev of events) {
      assert.ok(
        !("reconcile" in ev),
        "F1 事件 reconcile 键缺席而非 false"
      );
    }
  });
});
