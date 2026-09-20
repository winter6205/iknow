/**
 * ADR-0028: the `agent_status` stream event — same computation point and same
 * snapshot data as the `<agent_status>` bar (harness → TUI reads only the
 * latest live state through this surface; the UI never keeps its own ledger).
 *
 * Acceptance mapping:
 *   - one `agent_status` event before each upcoming model call, fields matching
 *     the bar injected for that call (same live state, cross-asserted within one run);
 *   - no unchecked items → the event is still emitted (openTodoLines empty + lastTool), consistent with the bar;
 *   - deps.agentStatus absent (ask / worker shape) → no bar and no event;
 *   - bar purity: the event carries exactly the bar's data fields (lastTool /
 *     openTodoLines / conditionally-present instruction; no text, no in-flight),
 *     and the bar text is byte-identical to the buildAgentStatusText output;
 *   - observer throws do not backflow (safeEmitStream contract) — the turn
 *     completes as usual and the bar is still injected;
 *   - the event is also emitted before a reactive-compact retry call (the same
 *     computation point where the bar lands after compact).
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
// This file's private fixtures; shared parts (makeTodoDir / makeSpyAdapter /
// okEchoTool / bar text extraction & parsing) live in
// tests/harness/_agent-status-fixtures.ts — the shared makeSpyAdapter's
// sampleAtEntry seam is exactly this suite's eventsAtEntry sampling.
// ---------------------------------------------------------------------------

/** Event collector: records only agent_status events (other types are counted, never interpreted). */
interface EventProbe {
  readonly onStream: (event: HarnessStreamEvent) => void;
  /** agent_status event objects as-is, in arrival order (for field-level asserts). */
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
// Events and bars share one live state: one event before each model call,
// fields identical to the bar injected for that call.
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
    // Each event arrives before the model call it serves (call #k already sees k events at entry).
    assert.equal(entrySamples[0], 1);
    assert.equal(entrySamples[1], 2);

    // Cross-assertion (same live state): event fields === parsed tail bar of that request.
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
    // After echo succeeds → last_tool becomes echo; todos.md unchanged → same unchecked lines.
    assert.equal(ev2.lastTool, "echo");
    assert.deepEqual(ev2.openTodoLines, ev1.openTodoLines);
    assert.deepEqual(parseBar(tailBar(captured[1]!)), {
      lastTool: ev2.lastTool,
      todoLines: [...ev2.openTodoLines],
    });
  });
});

// ---------------------------------------------------------------------------
// No unchecked items: the event is still emitted (openTodoLines empty + lastTool), consistent with the bar.
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
// deps.agentStatus absent (ask / worker shape) → no bar and no event.
// ---------------------------------------------------------------------------

describe("agent_status stream event T3: gating follows the bar", () => {
  it("③ 无 agentStatus 字段 → onStream 在场也不发任何 agent_status 事件", async () => {
    // This is deps-absence semantics: whether the file exists is irrelevant, so no todos fixture is built.
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
// Bar purity: the event carries exactly the bar's data fields; bar text is
// byte-identical to the builder output.
// ---------------------------------------------------------------------------

describe("agent_status stream event T3: bar purity", () => {
  it("④ 事件恰带 {type,lastTool,openTodoLines,instruction,reconcile}(无 text / in-flight);栏文本 === buildAgentStatusText(事件字段)", async () => {
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
      // run("go")'s prompt is the latest real user instruction, so the event additively
      // carries the instruction field; reconcile settles one-shot (true on the first hop,
      // false after) — the fields are exactly the bar's data fields (no bar text, no in-flight).
      assert.equal(ev.instruction, "go");
      assert.equal(ev.reconcile, i === 0, "reconcile 一次性结算同源同形");
      assert.deepEqual(
        Object.keys(ev).sort(),
        ["instruction", "lastTool", "openTodoLines", "reconcile", "type"],
        "event carries exactly the bar's data fields"
      );
      // Bar text byte-for-byte === replaying the same event fields through the bar builder.
      const rebuilt = buildAgentStatusText({
        lastTool: ev.lastTool,
        openTodoLines: ev.openTodoLines,
        instruction: ev.instruction,
        reconcile: ev.reconcile,
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
// Reactive compact retry: the event is emitted at the same computation point
// where the bar lands after compact.
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
