/**
 * T3 (#647) / ADR-0028 / plans/agent-status-bar.md bullet T3: `agent_status`
 * 流事件 —— 与 `<agent_status>` 栏同一计算点、同一份快照数据(harness → TUI
 * 只读最新现势的读口;UI 不另建账本)。
 *
 * 验收映射:
 *   ① 每次即将调用模型前发出 `agent_status` 事件,字段与当次注入的栏内容
 *      一致(同一份现势,同 run 内交叉断言);
 *   ② 无未勾项 → 事件仍发(openTodoLines 空 + lastTool),与栏一致;
 *   ③ deps.agentStatus 缺席(ask / worker 形状)→ 无栏也无事件;
 *   ④ 栏纯度:事件恰带栏的数据字段(lastTool / openTodoLines,无 text、无
 *      in-flight),栏文本与 T1 构造器 buildAgentStatusText 逐字节一致;
 *   ⑤ 观察者 throw 不反流(safeEmitStream 契约),回合照常完成、栏照常注入;
 *   ⑥ reactive compact 后的重试调用前同样发事件(栏在 compact 后落位的
 *      同一计算点)。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { run } from "../../src/harness/loop-engine.ts";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import { buildAgentStatusText } from "../../src/harness/agent-status.ts";
import {
  barTexts,
  makeSpyAdapter,
  makeTodoDir,
  okEchoTool,
  parseBar,
} from "./_agent-status-fixtures.ts";

// ---------------------------------------------------------------------------
// 本文件私有 fixtures(makeTodoDir / makeSpyAdapter / okEchoTool / bar 文本
// 提取与解析等共享部分见 tests/harness/_agent-status-fixtures.ts;共享
// makeSpyAdapter 的 sampleAtEntry 扩展缝即本套件的 eventsAtEntry 采样)
// ---------------------------------------------------------------------------

/** 事件收集器:只记 agent_status 事件(其余类型计数,不解读)。 */
interface EventProbe {
  readonly onStream: (event: HarnessStreamEvent) => void;
  /** 按到达序的 agent_status 事件原样对象(供字段级断言)。 */
  readonly agentStatusEvents: HarnessStreamEvent &
    {
      type: "agent_status";
    }[];
}

function makeEventProbe(): EventProbe {
  const agentStatusEvents: (HarnessStreamEvent & { type: "agent_status" })[] =
    [];
  const onStream = (event: HarnessStreamEvent): void => {
    if (event.type === "agent_status") agentStatusEvents.push(event);
  };
  return { onStream, agentStatusEvents };
}

function tailBar(messages: ReadonlyArray<AnthropicNativeMessage>): string {
  const texts = barTexts(messages);
  const tail = texts[texts.length - 1];
  assert.ok(tail !== undefined, "request must contain a bar message");
  return tail;
}

// ---------------------------------------------------------------------------
// AC ① 事件与栏同一份现势:每次模型调用前各一条,字段与当次注入的栏一致
// ---------------------------------------------------------------------------

describe("agent_status stream event T3: same snapshot as the injected bar", () => {
  it("① 每次模型调用前发一条事件(先于调用到达),字段 === 当次请求尾栏内容", async () => {
    const todoDir = await makeTodoDir(
      "- [ ] alpha task\n- [x] done task\n- [ ] beta task\n"
    );
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const probe = makeEventProbe();
    const { adapter, captured, entrySamples } = makeSpyAdapter(
      [
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
      ],
      { sampleAtEntry: () => probe.agentStatusEvents.length }
    );

    const { result } = await run(
      "go",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        agentStatus: { todoDir },
      },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(result.stopReason, "completed");
    assert.equal(captured.length, 2);
    assert.equal(
      probe.agentStatusEvents.length,
      2,
      "one agent_status event per model call"
    );
    // 事件先于它所服务的模型调用到达(第 k 次调用入口已见 k 条)。
    assert.equal(entrySamples[0], 1);
    assert.equal(entrySamples[1], 2);

    // 交叉断言(同一份现势):事件字段 === 当次请求尾栏解析结果。
    const ev1 = probe.agentStatusEvents[0]!;
    const ev2 = probe.agentStatusEvents[1]!;
    assert.equal(ev1.lastTool, "idle");
    assert.deepEqual(ev1.openTodoLines, [
      "- [ ] [t1] alpha task",
      "- [ ] [t3] beta task",
    ]);
    assert.deepEqual(parseBar(tailBar(captured[0]!)), {
      lastTool: ev1.lastTool,
      todoLines: [...ev1.openTodoLines],
    });
    // echo 工具成功后 → last_tool 更新为 echo;todos.md 未变 → 未勾行同前。
    assert.equal(ev2.lastTool, "echo");
    assert.deepEqual(ev2.openTodoLines, ev1.openTodoLines);
    assert.deepEqual(parseBar(tailBar(captured[1]!)), {
      lastTool: ev2.lastTool,
      todoLines: [...ev2.openTodoLines],
    });
  });
});

// ---------------------------------------------------------------------------
// AC ② 无未勾项:事件仍发(openTodoLines 空 + lastTool),与栏一致
// ---------------------------------------------------------------------------

describe("agent_status stream event T3: empty slots still emit", () => {
  it("② todos.md 缺席 → 单条事件,openTodoLines 空 + lastTool=idle(栏无 todo 段)", async () => {
    const todoDir = await makeTodoDir();
    const noop = okEchoTool("noop");
    const reg = createRegistry([noop]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);
    const probe = makeEventProbe();

    await run(
      "hi",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        agentStatus: { todoDir },
      },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(probe.agentStatusEvents.length, 1);
    const ev = probe.agentStatusEvents[0]!;
    assert.equal(ev.lastTool, "idle");
    assert.deepEqual(ev.openTodoLines, []);
    assert.deepEqual(parseBar(tailBar(captured[0]!)), {
      lastTool: "idle",
      todoLines: [],
    });
  });
});

// ---------------------------------------------------------------------------
// AC ③ deps.agentStatus 缺席(ask / worker 形状)→ 无栏也无事件
// ---------------------------------------------------------------------------

describe("agent_status stream event T3: gating follows the bar", () => {
  it("③ 无 agentStatus 字段 → onStream 在场也不发任何 agent_status 事件", async () => {
    // AC③ 是 deps 缺席语义:文件是否在场无关,不建 todos fixture。
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
    const probe = makeEventProbe();

    const { result } = await run(
      "go",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
      },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(result.stopReason, "completed");
    assert.equal(probe.agentStatusEvents.length, 0, "no bar → no event");
    for (const messages of captured) {
      assert.deepEqual(barTexts(messages), []);
    }
  });
});

// ---------------------------------------------------------------------------
// AC ④ 栏纯度:事件恰带栏的数据字段;栏文本与 T1 构造器逐字节一致
// ---------------------------------------------------------------------------

describe("agent_status stream event T3: bar purity", () => {
  it("④ 事件恰带 {type,lastTool,openTodoLines}(无 text / in-flight);栏文本 === buildAgentStatusText(事件字段)", async () => {
    const todoDir = await makeTodoDir("- [ ] only open task\n");
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
    const probe = makeEventProbe();

    await run(
      "go",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        agentStatus: { todoDir },
      },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(captured.length, 2);
    assert.equal(probe.agentStatusEvents.length, 2);
    for (let i = 0; i < probe.agentStatusEvents.length; i++) {
      const ev = probe.agentStatusEvents[i]!;
      // 事件字段恰为栏的数据字段(不含栏 text、不含任何 in-flight 字段)。
      assert.deepEqual(
        Object.keys(ev).sort(),
        ["lastTool", "openTodoLines", "type"],
        "event carries exactly the bar's data fields"
      );
      // 栏文本逐字节 === T1 构造器对同一份事件字段的重放输出。
      const rebuilt = buildAgentStatusText({
        lastTool: ev.lastTool,
        openTodoLines: ev.openTodoLines,
      });
      assert.equal(
        tailBar(captured[i]!),
        rebuilt,
        `bar text must equal T1 builder output for event #${i + 1}`
      );
    }
  });

  it("⑤ 观察者 throw 不反流:agent_status 消费者抛错,回合照常完成、栏照常注入", async () => {
    const todoDir = await makeTodoDir("- [ ] survive observer fault\n");
    const noop = okEchoTool("noop");
    const reg = createRegistry([noop]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);
    const hostile = (event: HarnessStreamEvent): void => {
      if (event.type === "agent_status") {
        throw new Error("hostile agent_status observer");
      }
    };

    const { result } = await run(
      "hi",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        agentStatus: { todoDir },
      },
      undefined,
      { onStream: hostile }
    );

    assert.equal(result.stopReason, "completed");
    assert.equal(barTexts(captured[0]!).length, 1, "bar still injected");
  });
});

// ---------------------------------------------------------------------------
// AC ⑥ reactive compact 重试:栏在 compact 后落位的同一计算点同样发事件
// ---------------------------------------------------------------------------

describe("agent_status stream event T3: reactive compact retry", () => {
  it("⑥ 首试 + compact 重试各一条事件;重试事件的字段 === 重试请求尾栏", async () => {
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
    const probe = makeEventProbe();

    const { result } = await run(
      "Q",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
        agentStatus: { todoDir },
      },
      undefined,
      { priorMessages: longPrior, onStream: probe.onStream }
    );

    assert.equal(result.stopReason, "completed");
    assert.equal(captured.length, 2, "first attempt + one compacted retry");
    assert.equal(probe.agentStatusEvents.length, 2);
    const retryEv = probe.agentStatusEvents[1]!;
    assert.equal(retryEv.lastTool, "idle");
    assert.deepEqual(retryEv.openTodoLines, ["- [ ] [t1] survive compact"]);
    assert.deepEqual(parseBar(tailBar(captured[1]!)), {
      lastTool: retryEv.lastTool,
      todoLines: [...retryEv.openTodoLines],
    });
  });
});
