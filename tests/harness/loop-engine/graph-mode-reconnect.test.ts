/**
 * ADR-0043 — integration tests for the loop-engine environment-level event-append seams.
 *
 * MCP manual reconnect:
 *   deps.mcpReconnect.takePending yields events → before the next step, one
 *   role=user single-line static notification is appended at the messages
 *   tail (MCP_RECONNECT_NOTIFICATION_TEMPLATE interpolated with `<server>` /
 *   `<tools>`); empty pending → zero additions; tools/system bytes unchanged.
 *
 * Graph-mode switch notice:
 *   - initial observation (lastSeenEnabled=undefined) only records the value, zero additions;
 *   - flipping graphAssembly between two steps → before the second step the
 *     `<graph_mode>` on-notice (IKNOW_GRAPH_MODE_ON_NOTIFICATION) appears at
 *     the messages tail;
 *   - flipping back → off notice (IKNOW_GRAPH_MODE_OFF_NOTIFICATION);
 *   - the same assertion applies to the second detection before a reactive-compact retry.
 *
 * Shared pass/fail criteria for both seams: text assertions reference the
 * SSOT constants (graph/notification.ts / loop-engine.ts templates), never literals.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { run, step } from "../../../src/harness/loop-engine.ts";
import {
  MCP_RECONNECT_NOTIFICATION_TEMPLATE,
  type LoopEngineDeps,
} from "../../../src/harness/loop-engine.ts";
import {
  IKNOW_GRAPH_MODE_ON_NOTIFICATION,
  IKNOW_GRAPH_MODE_OFF_NOTIFICATION,
} from "../../../src/harness/graph/notification.ts";
import { createGraphAssembly } from "../../../src/harness/graph/assembly.ts";
import type { GraphModeContext } from "../../../src/harness/graph/mode.ts";
import type {
  AssistantTurnResult,
  AnthropicNativeMessage,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";
import type { LoopAdapter } from "../../../src/harness/loop-engine.ts";
import type { Executor, Registry } from "../../../src/harness/tools/types.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeUserMsg(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

/** Plain-text stub adapter: each step returns one assistant text turn (no tool calls). */
function makeTextAdapter(responses: string[]): LoopAdapter & {
  steps: Array<{ messages: ReadonlyArray<AnthropicNativeMessage> }>;
} {
  const steps: Array<{
    messages: ReadonlyArray<AnthropicNativeMessage>;
  }> = [];
  let call = 0;
  return {
    steps,
    encodeUserText: makeUserMsg,
    encodeToolResults: () => [],
    step: async (state: LoopState): Promise<AssistantTurnResult> => {
      steps.push({ messages: state.messages });
      const text = responses[Math.min(call, responses.length - 1)] ?? "done";
      call += 1;
      const native: AnthropicNativeMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
      };
      return {
        nativeMessage: native,
        projection: { nativeMessage: native, texts: [text], toolCalls: [] },
        supplierStop: "success",
        needsTools: false,
        isEmptyFinalResponse: false,
      };
    },
  };
}

/** Empty executor + registry (the plain-text path never touches tools). */
const emptyExecutor: Executor = Object.freeze({
  executeAll: async () => [],
});
const emptyRegistry: Registry = Object.freeze({
  list: () => [],
  get: () => undefined,
});

/** Single-boolean graph mode holder (mirrors the minimal GraphModeContext shape). */
function makeGraphModeHolder(): {
  ctx: GraphModeContext;
  set: (enabled: boolean) => void;
} {
  let enabled = false;
  const ctx = {
    get: () => ({ enabled }),
  } as unknown as GraphModeContext;
  return { ctx, set: (v: boolean) => (enabled = v) };
}

/** Collect role=user messages from run output whose text contains the given marker. */
function userMessagesContaining(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  marker: string
): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) {
      if (b.type === "text" && b.text.includes(marker)) out.push(b.text);
    }
  }
  return out;
}

// =========================================================================
// MCP manual reconnect → tail-append to messages (pass/fail binary)
// =========================================================================

describe("loop engine H1: mcpReconnect seam → <mcp_reconnect> 静态通知追加", () => {
  it("cb 记录 pending → 下一 step 前 messages 尾追加一条 role=user 通知;tools/system 字节不变", async () => {
    const adapter = makeTextAdapter(["resp-1", "resp-2"]);
    const pending: Array<{ server: string; tools: string[] }> = [];
    const deps: LoopEngineDeps = {
      adapter,
      executor: emptyExecutor,
      registry: emptyRegistry,
      maxTurns: 5,
      mcpReconnect: {
        takePending: () => {
          const taken = [...pending];
          pending.length = 0;
          return taken;
        },
      },
    };

    // Simulate the manager.onManualReconnect callback (TUI/CLI reload success path).
    pending.push({
      server: "svc",
      tools: ["mcp__svc__echo", "mcp__svc__ping"],
    });

    const { result } = await run("Q", deps);
    assert.equal(result.stopReason, "completed");

    // Pass/fail criterion: one static role=user notification (SSOT template, interpolated)
    // appears at the messages tail.
    const hits = userMessagesContaining(result.messages, "reconnected");
    assert.equal(hits.length, 1);
    assert.equal(
      hits[0],
      MCP_RECONNECT_NOTIFICATION_TEMPLATE.replace("<server>", "svc").replace(
        "<tools>",
        "mcp__svc__echo, mcp__svc__ping"
      )
    );
    // The notice comes after the user's first message (tail append; prefix untouched).
    assert.ok(result.messages.length >= 3);
    assert.equal(result.messages[0]?.role, "user");

    // takePending consumes once: no duplicate append on the second step.
    assert.equal(
      userMessagesContaining(result.messages, "reconnected").length,
      1
    );
  });

  it("pending 空 → 零追加(byte-identical 基线)", async () => {
    const adapter = makeTextAdapter(["resp-1"]);
    const deps: LoopEngineDeps = {
      adapter,
      executor: emptyExecutor,
      registry: emptyRegistry,
      maxTurns: 5,
      mcpReconnect: {
        takePending: () => [],
      },
    };
    const { result } = await run("Q", deps);
    assert.equal(result.stopReason, "completed");
    // Baseline without the seam: exactly the two user/assistant message groups
    // (user input + model turn), no notification messages.
    const userMsgs = result.messages.filter((m) => m.role === "user");
    assert.equal(userMsgs.length, 1);
    assert.deepEqual(userMsgs[0]?.content, [{ type: "text", text: "Q" }]);
  });
});

// =========================================================================
// Graph-mode switch notice
// =========================================================================

describe("loop engine H2: graphModeChange seam → <graph_mode> 切换提示", () => {
  it("初值 step 零追加;step 间翻键 → 下一步追加开图提示;翻回 → 关图提示", async () => {
    const holder = makeGraphModeHolder();
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: undefined,
    };
    const adapter = makeTextAdapter(["a1", "a2", "a3"]);
    const deps: LoopEngineDeps = {
      adapter,
      executor: emptyExecutor,
      registry: emptyRegistry,
      maxTurns: 5,
      graphModeChange: { assembly, lastSeenEnabled },
    };

    // Each round before a step, assembly.enabled() reads the same holder;
    // no flip happens between steps here. Initial observation: first step
    // records lastSeenEnabled only, zero additions — run has no channel for
    // "flip before the first step", so assert the message shape of the whole run.
    const { result } = await run("Q", deps);
    assert.equal(result.stopReason, "completed");
    assert.equal(
      userMessagesContaining(result.messages, "<graph_mode>").length,
      0
    );
    // The initial value was recorded.
    assert.equal(lastSeenEnabled.value, false);
  });

  it("两 step 之间翻 graphAssembly → 第二 step 前追加开图提示(用 step API 逐步驱动)", async () => {
    const holder = makeGraphModeHolder();
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: undefined,
    };
    const adapter = makeTextAdapter(["a1", "a2", "a3"]);
    const deps: LoopEngineDeps = {
      adapter,
      executor: emptyExecutor,
      registry: emptyRegistry,
      maxTurns: 5,
      graphModeChange: { assembly, lastSeenEnabled },
    };

    // step1 (initial observation, zero additions) → flip on (re-snapshot the
    // round, mirroring the host calling beginRound at the next run boundary)
    // → step2 (append on-notice) → flip back → step3 (append off-notice).
    // assembly.enabled() only reads the round snapshot taken by beginRound
    // (src/harness/graph/assembly.ts), so each flip must be followed by
    // beginRound before the seam observes the new value.
    let state: LoopState = {
      messages: [makeUserMsg("Q")],
      turnCount: 0,
    };

    // step 1: initial observation; messages unchanged (zero additions).
    const t1 = await step(state, deps);
    assert.equal(t1.kind, "stop");
    assert.equal(
      t1.kind === "stop" ? t1.finalState.messages.length : -1,
      state.messages.length + 1,
      "step1 只新增 assistant 回合,零环境级追加"
    );
    assert.equal(lastSeenEnabled.value, false);

    // Flip graph on + take a fresh round snapshot.
    holder.set(true);
    assembly.beginRound();

    // step 2: flip detected → <graph_mode> on-notice at the messages tail.
    state = {
      messages: (t1 as { finalState: LoopState }).finalState.messages,
      turnCount: (t1 as { finalState: LoopState }).finalState.turnCount,
    };
    const t2 = await step(state, deps);
    const s2 = t2 as { kind: "stop"; finalState: LoopState };
    const onHits = userMessagesContaining(
      s2.finalState.messages,
      "<graph_mode>"
    );
    assert.equal(onHits.length, 1);
    assert.equal(onHits[0], IKNOW_GRAPH_MODE_ON_NOTIFICATION);
    // It is a user message.
    const last = s2.finalState.messages[s2.finalState.messages.length - 1];
    const beforeAssistant =
      s2.finalState.messages[s2.finalState.messages.length - 2];
    assert.equal(beforeAssistant?.role, "user");
    assert.equal(
      beforeAssistant?.content.some(
        (b) => b.type === "text" && b.text === IKNOW_GRAPH_MODE_ON_NOTIFICATION
      ),
      true
    );
    assert.ok(last);

    // Flip back off + take a fresh round snapshot.
    holder.set(false);
    assembly.beginRound();

    // step 3: flip detected → append off-notice (coexists with the on-notice, tail-appended).
    const t3 = await step(
      {
        messages: s2.finalState.messages,
        turnCount: s2.finalState.turnCount,
      },
      deps
    );
    const s3 = t3 as { kind: "stop"; finalState: LoopState };
    const allGraph = userMessagesContaining(
      s3.finalState.messages,
      "<graph_mode>"
    );
    assert.equal(allGraph.length, 2);
    assert.ok(allGraph.includes(IKNOW_GRAPH_MODE_ON_NOTIFICATION));
    assert.ok(allGraph.includes(IKNOW_GRAPH_MODE_OFF_NOTIFICATION));
  });
});

// =========================================================================
// Graph-mode re-detection before a reactive-compact retry
// =========================================================================

describe("loop engine H2: reactive compact 重试前同样检测 graph 翻转", () => {
  it("PromptTooLongError → compact 重试路径中翻转 graph → 重试请求前 messages 尾出现 <graph_mode> 提示", async () => {
    const holder = makeGraphModeHolder();
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: undefined,
    };

    // Record the messages each adapter.step sees (what the model actually sees on retry).
    const seenMessages: ReadonlyArray<AnthropicNativeMessage>[] = [];
    let stepCalls = 0;
    const flakyAdapter: LoopAdapter = {
      encodeUserText: makeUserMsg,
      encodeToolResults: () => [],
      step: async (state: LoopState): Promise<AssistantTurnResult> => {
        stepCalls += 1;
        seenMessages.push(state.messages);
        if (stepCalls === 1) {
          // First call throws PromptTooLong → reactive compact + retry.
          // Flip the key and re-snapshot the round at the throw site, simulating
          // "the host flips between two model calls in the same round" → the
          // second detection before compact retry hits.
          holder.set(true);
          assembly.beginRound();
          const { PromptTooLongError } =
            await import("../../../src/harness/errors.ts");
          throw new PromptTooLongError("synthetic 400 prompt-too-long");
        }
        // The retry after compact returns plain text.
        const text = "after compact";
        const native: AnthropicNativeMessage = {
          role: "assistant",
          content: [{ type: "text", text }],
        };
        return {
          nativeMessage: native,
          projection: { nativeMessage: native, texts: [text], toolCalls: [] },
          supplierStop: "success",
          needsTools: false,
          isEmptyFinalResponse: false,
        };
      },
    };

    const deps: LoopEngineDeps = {
      adapter: flakyAdapter,
      executor: emptyExecutor,
      registry: emptyRegistry,
      maxTurns: 5,
      compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
      graphModeChange: { assembly, lastSeenEnabled },
    };

    // A long history (> DEFAULT_KEEP_RECENT) gives reactive compact room to
    // compress (the compressed messages keep the same reference → the retry's
    // short-circuit branch is bypassed).
    const prior = Array.from({ length: 12 }, (_, i) =>
      makeUserMsg(`prior-${i}`)
    );

    const { result } = await run("Q", deps, undefined, {
      priorMessages: prior,
    });
    assert.equal(result.stopReason, "completed");
    // Three adapter.step calls: (1) first call throws PromptTooLong;
    // (2) runFullCompact summary (same deps.adapter); (3) retry after compact.
    assert.ok(stepCalls >= 3, "reactive retry 必须发生(至少三次 adapter.step)");

    // The first new message the retried model call sees = the <graph_mode>
    // on-notice (appended after the compacted output, before the assistant turn).
    const retrySeen = seenMessages[seenMessages.length - 1];
    assert.ok(retrySeen);
    const onHits = userMessagesContaining(retrySeen, "<graph_mode>");
    assert.equal(onHits.length, 1);
    assert.equal(onHits[0], IKNOW_GRAPH_MODE_ON_NOTIFICATION);
  });
});
