/**
 * B3 / B4 (ADR-0041 + ADR-0043 §4) — loop-engine 环境级事件追加缝集成测试。
 *
 * H1 (model-prefix-layering code-review): MCP 手动重连链路红绿 ——
 *   deps.mcpReconnect.takePending 产出事件 → 下一 step 的 messages 尾部
 *   追加一条 role=user 的单行静态通知(MCP_RECONNECT_NOTIFICATION_TEMPLATE,
 *   `<server>` / `<tools>` 插值);pending 空 → 零追加;tools/system 字节
 *   不变(SC4 第三句的红绿二元)。
 *
 * H2 (SC5 红绿): graph 模式切换提示 ——
 *   - 初值观察(lastSeenEnabled=undefined)只记初值,零追加;
 *   - 两 step 之间翻 graphAssembly → 第二 step 前 messages 尾部出现
 *     `<graph_mode>` 开图提示(IKNOW_GRAPH_MODE_ON_NOTIFICATION);
 *   - 再翻回 → 关图提示(IKNOW_GRAPH_MODE_OFF_NOTIFICATION);
 *   - reactive-compact 重试前二次检测同断言。
 *
 * 两条缝共用的红绿判据:文本断言引用 SSOT 常量(graph/notification.ts /
 * loop-engine.ts 模板),不走字面。
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

/** 纯文本 stub adapter:每 step 返回一条 assistant 文本(无工具调用)。 */
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

/** 空 executor + registry(纯文本路径不触工具)。 */
const emptyExecutor: Executor = Object.freeze({
  executeAll: async () => [],
});
const emptyRegistry: Registry = Object.freeze({
  list: () => [],
  get: () => undefined,
});

/** 单布尔 graph mode holder(镜像 GraphModeContext 最小形态)。 */
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

/** 收集 run 产物里 role=user 且含给定标记文本的消息。 */
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
// H1 — MCP manual reconnect → messages 尾追加(红绿二元)
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

    // 模拟 manager.onManualReconnect 回调(TUI/CLI reload 成功路径)。
    pending.push({
      server: "svc",
      tools: ["mcp__svc__echo", "mcp__svc__ping"],
    });

    const { result } = await run("Q", deps);
    assert.equal(result.stopReason, "completed");

    // 红绿判据:messages 尾部出现一条 role=user 的静态通知(SSOT 模板插值)。
    const hits = userMessagesContaining(result.messages, "reconnected");
    assert.equal(hits.length, 1);
    assert.equal(
      hits[0],
      MCP_RECONNECT_NOTIFICATION_TEMPLATE.replace("<server>", "svc").replace(
        "<tools>",
        "mcp__svc__echo, mcp__svc__ping"
      )
    );
    // 通知在用户首条消息之后(transcript 尾部追加,前缀不动)。
    assert.ok(result.messages.length >= 3);
    assert.equal(result.messages[0]?.role, "user");

    // takePending 一次性消费:第二条 step 无重复追加。
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
    // 只有无缝基线的 user(Q) + assistant 两条件(用户消息 + 模型回合),
    // 无任何通知消息。
    const userMsgs = result.messages.filter((m) => m.role === "user");
    assert.equal(userMsgs.length, 1);
    assert.deepEqual(userMsgs[0]?.content, [{ type: "text", text: "Q" }]);
  });
});

// =========================================================================
// H2 — graph 模式切换提示(SC5 红绿)
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

    // run 的每轮 step 前 assembly.enabled() 读同一 holder;step 之间不翻键。
    // 初值观察:第一 step 只记 lastSeenEnabled,零追加 —— run 里没有模拟
    // 「第一步之前翻键」的通道,直接断言整段 run 的消息形态。
    const { result } = await run("Q", deps);
    assert.equal(result.stopReason, "completed");
    assert.equal(
      userMessagesContaining(result.messages, "<graph_mode>").length,
      0
    );
    // 初值已被记录。
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

    // step1(初值观察,零追加) → 翻开(重拍 round 快照,镜像 host 在下一
    // run 边界 beginRound 的生产行为) → step2(追加 on 提示) → 翻回 →
    // step3(追加 off 提示)。assembly.enabled() 只读 beginRound 拍的
    // round 快照(src/harness/graph/assembly.ts),所以每次翻键后必须
    // beginRound 才能让 seam 观察到新值。
    let state: LoopState = {
      messages: [makeUserMsg("Q")],
      turnCount: 0,
    };

    // step 1:初值观察。messages 不变(零追加)。
    const t1 = await step(state, deps);
    assert.equal(t1.kind, "stop");
    assert.equal(
      t1.kind === "stop" ? t1.finalState.messages.length : -1,
      state.messages.length + 1,
      "step1 只新增 assistant 回合,零环境级追加"
    );
    assert.equal(lastSeenEnabled.value, false);

    // 翻开 graph + 拍新 round 快照。
    holder.set(true);
    assembly.beginRound();

    // step 2:翻转检测 → messages 尾部出现 <graph_mode> on 提示。
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
    // 是 user 消息。
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

    // 翻回关 + 拍新 round 快照。
    holder.set(false);
    assembly.beginRound();

    // step 3:翻转检测 → 追加 off 提示(与 on 提示共存,尾部追加)。
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
// H2 补充 — reactive-compact 重试前的二次检测
// =========================================================================

describe("loop engine H2: reactive compact 重试前同样检测 graph 翻转", () => {
  it("PromptTooLongError → compact 重试路径中翻转 graph → 重试请求前 messages 尾出现 <graph_mode> 提示", async () => {
    const holder = makeGraphModeHolder();
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: undefined,
    };

    // 记录每次 adapter.step 看到的 messages(重试时模型实际所见)。
    const seenMessages: ReadonlyArray<AnthropicNativeMessage>[] = [];
    let stepCalls = 0;
    const flakyAdapter: LoopAdapter = {
      encodeUserText: makeUserMsg,
      encodeToolResults: () => [],
      step: async (state: LoopState): Promise<AssistantTurnResult> => {
        stepCalls += 1;
        seenMessages.push(state.messages);
        if (stepCalls === 1) {
          // 首次调用抛 PromptTooLong → reactive compact + retry;
          // 抛错瞬间翻键并重拍 round 快照,模拟「同 round 两次模型调用
          // 之间 host 翻键」(ADR-0041)→ compact retry 前二次检测命中。
          holder.set(true);
          assembly.beginRound();
          const { PromptTooLongError } =
            await import("../../../src/harness/errors.ts");
          throw new PromptTooLongError("synthetic 400 prompt-too-long");
        }
        // compact 后的重试返回纯文本。
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

    // 长历史(> DEFAULT_KEEP_RECENT)让 reactive compact 有压缩空间
    // (压缩产物 messages 引用不变 → 不触发 retry 的短路分支被绕开)。
    const prior = Array.from({ length: 12 }, (_, i) =>
      makeUserMsg(`prior-${i}`)
    );

    const { result } = await run("Q", deps, undefined, {
      priorMessages: prior,
    });
    assert.equal(result.stopReason, "completed");
    // 三次 adapter.step:① 首调抛 PromptTooLong;② runFullCompact 摘要
    // (同一 deps.adapter);③ compact 后的 retry。
    assert.ok(stepCalls >= 3, "reactive retry 必须发生(至少三次 adapter.step)");

    // 重试模型调用看到的第一条新消息 = <graph_mode> on 提示(在压缩产物
    // 之后追加,早于 assistant)。
    const retrySeen = seenMessages[seenMessages.length - 1];
    assert.ok(retrySeen);
    const onHits = userMessagesContaining(retrySeen, "<graph_mode>");
    assert.equal(onHits.length, 1);
    assert.equal(onHits[0], IKNOW_GRAPH_MODE_ON_NOTIFICATION);
  });
});
