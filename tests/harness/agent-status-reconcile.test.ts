/**
 * agent-status-instruction-echo (settlement half): run-scoped one-shot
 * reconcile settlement. Inside `appendAgentStatusBar`, settlement goes through
 * a run-scoped box (`reconcileRef.stamped`, mirroring the `lastToolRef`
 * shape): the NEXT bar after a new real user message carries the fixed marker
 * line, gone from the second hop on; the presence condition is exactly one
 * (invariant 3) — independent of todo_write call history, todo section
 * presence, or bar changes. The reactive-compact retry call site and the
 * normal step call site share the same box, so settlement behaves identically:
 * compact's re-freeze clone of the kept tail does not fake a "new message
 * arrived" signal (the clone's frozen message equals the stamped one →
 * treated as the same message, no re-mark).
 *
 * Double-track asserts (repo rule):
 *   - trace track: createJsonlTraceService writes to disk + createJsonlTraceReader
 *     reads back the event sequence (llm_call / turn counts and final state);
 *   - baseline track: no-trace vs NoopTraceService vs real trace, three-way
 *     messages / result deepEqual — the settlement box does not change injection behavior.
 *
 * Acceptance mapping:
 *   - the first-hop bar after a new message carries the reconcile line, gone from
 *     the next hop on (constant-line bytes === the exported AGENT_STATUS_RECONCILE_LINE);
 *   - a second wave of messages (new run) marks once more, gone from that run's next hop;
 *   - with an empty todo section the marker is still independently present (invariant 3:
 *     the condition has nothing to do with todos);
 *   - both call sites (incl. reactive-compact retry) settle alike: the compact retry
 *     does not re-mark, and the instruction is still there;
 *   - no judgment target (prior fully injected) → reconcile does not settle: no marker
 *     line in the bar, no reconcile key in the event (same contract as the legacy
 *     field-set fallback on the echo side).
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

/** The reconcile marker line(s) in a bar body (the constant line, verbatim). */
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
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Present on the first hop, gone from the next hop on + double-track (repo-rule baseline).
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

    // Baseline track: the settlement box does not change injection behavior — three-way messages / result deepEqual.
    assert.deepEqual(runNoop.result.messages, runNoTrace.result.messages);
    assert.deepEqual(runJsonl.result.messages, runNoTrace.result.messages);
    assert.deepEqual(runNoop.result, runNoTrace.result);
    assert.deepEqual(runJsonl.result, runNoTrace.result);

    const bars = barTexts(runNoTrace.result.messages);
    assert.equal(bars.length, 3, "一跳一条栏 × 3 跳");
    // The constant line is byte-identical across turns (=== the exported AGENT_STATUS_RECONCILE_LINE, verbatim).
    assert.deepEqual(reconcileLinesOf(bars[0]!), [AGENT_STATUS_RECONCILE_LINE]);
    assert.deepEqual(reconcileLinesOf(bars[1]!), [], "次跳起消失");
    assert.deepEqual(reconcileLinesOf(bars[2]!), [], "三跳仍消失");
    // Presence is independent of bar contents: the instruction line stays on every hop even after the marker disappears.
    for (const bar of bars) {
      assert.ok(bar.includes("instruction: 先做A"));
    }

    // Trace track: read the event sequence back via the reader (consumer-side SSOT).
    const reader = createJsonlTraceReader({ filePath: traceFile });
    assert.equal(reader.query({ recordType: "llm_call" }).total, 3);
    assert.equal(reader.query({ recordType: "tool_call" }).total, 2);
    const turns = reader.query({ recordType: "turn" });
    assert.equal(turns.total, 3);
    assert.equal(turns.records[0]!["decision"], "completed");
  });
});

// ---------------------------------------------------------------------------
// A second wave of messages (new run) marks once more.
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
    assert.deepEqual(
      reconcileLinesOf(newBars[0]!),
      [AGENT_STATUS_RECONCILE_LINE],
      "第二波进场 → 新 run 首跳再标记"
    );
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
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// With an empty todo section the marker is still independently present (invariant 3).
// ---------------------------------------------------------------------------

describe("reconcile T4: 在场条件独立于 todo 段", () => {
  it("③ 无 todos.md(todo 段缺席)→ 首跳栏仍含标记行且无 `todos:` 头", async () => {
    const todoDir = await makeTodoDir(); // empty dir: no todos.md written
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
    assert.deepEqual(
      reconcileLinesOf(bars[0]!),
      [AGENT_STATUS_RECONCILE_LINE],
      "todo 段为空时标记独立在场"
    );
    assert.ok(!bars[0]!.includes("todos:"), "空 todo 段不广告");
    assert.deepEqual(reconcileLinesOf(bars[1]!), []);
  });
});

// ---------------------------------------------------------------------------
// The reactive-compact retry call site settles alike (shares the same box).
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
        result: assistantResult({
          texts: ["done after compact"],
          toolCalls: [],
        }),
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
    // First attempt's tail bar: marker present (the next bar after the new instruction arrived).
    assert.deepEqual(reconcileLinesOf(barTexts(captured[0]!).at(-1)!), [
      AGENT_STATUS_RECONCILE_LINE,
    ]);
    // Retry request's tail bar: the same instruction (compact's re-freeze clone of the kept tail)
    // fakes no arrival — both call sites share one box and settle alike; instruction echo is unaffected.
    const retryBar = barTexts(captured[1]!).at(-1)!;
    assert.deepEqual(reconcileLinesOf(retryBar), []);
    assert.ok(retryBar.includes("instruction: Q 指令"));
    // Event side shares the source: derived from the same snapshot → true → false (key present, not absent).
    assert.equal(events.length, 2);
    assert.equal(events[0]!.reconcile, true);
    assert.equal(events[1]!.reconcile, false);
  });
});

// ---------------------------------------------------------------------------
// No judgment target → no settlement (no marker line in bars, no reconcile key in events).
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
    // An old bar's own marker line is never re-read: the newly injected bars (the last two) carry no marker line.
    const injected = bars.slice(1);
    assert.equal(injected.length, 2);
    for (const bar of injected) {
      assert.deepEqual(reconcileLinesOf(bar), [], "F1 无判定对象不结算");
    }
    assert.equal(events.length, 2);
    for (const ev of events) {
      assert.ok(!("reconcile" in ev), "F1 事件 reconcile 键缺席而非 false");
    }
  });
});
