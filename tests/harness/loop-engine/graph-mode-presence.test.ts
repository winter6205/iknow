/**
 * ADR-0080 / specs/graph-mode-presence.md — "每跳短现势" 注入缝集成测试。
 *
 * 钉死不变式:
 *   SC1 holder on 连续两次即将调模型 → messages 尾两次都贴短 `<graph_mode>`
 *        (含 run_graph + spawn 指引),且短句短于长 ON。
 *   SC2 holder off / 从未开过 → 零短现势。
 *   SC3 ask/worker(seam 缺席)→ 零短现势、零长翻转句。
 *   SC4 同 round 中途翻 holder 不出现新短现势;下一次 run() 才按新值。
 *   SC5 同拍长 ON 与短现势不并存。
 *   SC6 短句不出现在 system 字符串、不进 <agent_status> 栏正文。
 *   SC7 compact 之后(无 compact 专用追加),下一跳仍 on → 再贴。
 *   SC8 关 overlay 时 tools 面仍列 run_graph(回归即可,本文件复检一份)。
 *
 * 形态镜像 `tests/harness/loop-engine/graph-mode-reconnect.test.ts`:
 * stub adapter + 空 executor + 空 registry。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { run, step } from "../../../src/harness/loop-engine.ts";
import type { LoopEngineDeps } from "../../../src/harness/loop-engine.ts";
import {
  IKNOW_GRAPH_MODE_ON_NOTIFICATION,
  IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
} from "../../../src/harness/graph/notification.ts";
import { createGraphAssembly } from "../../../src/harness/graph/assembly.ts";
import type { GraphModeContext } from "../../../src/harness/graph/mode.ts";
import type {
  AssistantTurnResult,
  AnthropicNativeMessage,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";
import type { LoopAdapter } from "../../../src/harness/loop-engine.ts";
import type {
  Executor,
  Registry,
  ToolDef,
} from "../../../src/harness/tools/types.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeUserMsg(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function makeAssistantMsg(text: string): AnthropicNativeMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/** 纯文本 stub adapter:每次 step 返回一条 assistant 文本(无工具调用)。 */
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
      const native = makeAssistantMsg(text);
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

/** 单布尔 graph mode holder。 */
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

/** 收 role=user 的所有消息文本。 */
function collectUserTexts(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) {
      if (b.type === "text") out.push(b.text);
    }
  }
  return out;
}

/** 收含 `<graph_mode>` 标记的 user 消息文本。 */
function presenceHits(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string[] {
  return collectUserTexts(messages).filter((t) => t.includes("<graph_mode>"));
}

/** 同时装 graphModeChange 与 graphModePresence 的标准 seam。 */
function buildDeps(opts: {
  adapter: LoopAdapter;
  assembly: ReturnType<typeof createGraphAssembly>;
  lastSeenEnabled: { value: boolean | undefined };
  maxTurns?: number;
  compress?: { contextWindow: number; thresholdTokens: number | undefined };
}): LoopEngineDeps {
  const deps: LoopEngineDeps = {
    adapter: opts.adapter,
    executor: emptyExecutor,
    registry: emptyRegistry,
    maxTurns: opts.maxTurns ?? 5,
    graphModeChange: {
      assembly: opts.assembly,
      lastSeenEnabled: opts.lastSeenEnabled,
    },
    graphModePresence: { assembly: opts.assembly },
    ...(opts.compress ? { compress: opts.compress } : {}),
  };
  return deps;
}

// =========================================================================
// SC2 / SC3 — 关着 / 缺席 → 零短现势
// =========================================================================

describe("loop engine ADR-0080 SC2: holder off → 零短现势", () => {
  it("初始即 off,跑两 step:零 `<graph_mode>` 短句,零长翻转句", async () => {
    const holder = makeGraphModeHolder();
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: undefined,
    };
    const adapter = makeTextAdapter(["a1", "a2", "a3"]);
    const deps = buildDeps({ adapter, assembly, lastSeenEnabled });

    const { result } = await run("Q", deps);
    assert.equal(result.stopReason, "completed");
    // 零 `<graph_mode>` user 消息。
    assert.equal(presenceHits(result.messages).length, 0);
  });

  it("会话从未开过 graph:零短现势", async () => {
    const holder = makeGraphModeHolder();
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: undefined,
    };
    const adapter = makeTextAdapter(["a1"]);
    const deps = buildDeps({ adapter, assembly, lastSeenEnabled });

    const { result } = await run("Q", deps);
    assert.equal(result.stopReason, "completed");
    // 只有用户首条 Q,没有任何 graph_mode 文本。
    const userTexts = collectUserTexts(result.messages);
    assert.equal(userTexts.length, 1);
    assert.equal(userTexts[0], "Q");
  });
});

describe("loop engine ADR-0080 SC3: ask/worker(seam 缺席)→ 零短现势、零长翻转句", () => {
  it("seam 全部缺席 → run 行为 byte-identical(无 graph_mode 任何形态)", async () => {
    const adapter = makeTextAdapter(["a1", "a2"]);
    const deps: LoopEngineDeps = {
      adapter,
      executor: emptyExecutor,
      registry: emptyRegistry,
      maxTurns: 5,
      // graphModeChange / graphModePresence 全缺席。
    };

    const { result } = await run("Q", deps);
    assert.equal(result.stopReason, "completed");
    assert.equal(presenceHits(result.messages).length, 0);
  });

  it("graphModePresence 在场但 graphModeChange 缺席(装配错配)→ 保守零注入", async () => {
    // build-engine 永远同 gate 同源接线两缝;presence 在场 / change 缺席的
    // 错配只能来自装配 bug。此时 presence 缝保守零注入(overlay 缺席 =
    // 零注入姿态),而不是脱离 change 的翻转语义独立生效。
    const holder = makeGraphModeHolder();
    const assembly = createGraphAssembly(holder.ctx);
    holder.set(true);
    assembly.beginRound();
    const adapter = makeTextAdapter(["a1", "a2"]);
    const deps: LoopEngineDeps = {
      adapter,
      executor: emptyExecutor,
      registry: emptyRegistry,
      maxTurns: 5,
      // 仅装 presence 不装 change —— 装配错配,必须零追加而非 panic。
      graphModePresence: { assembly },
    };

    const { result } = await run("Q", deps);
    assert.equal(result.stopReason, "completed");
    // 真零追加:holder on 也不贴短句;除首条 Q 外无任何 user 文本。
    assert.equal(presenceHits(result.messages).length, 0);
    assert.deepEqual(collectUserTexts(result.messages), ["Q"]);
  });
});

// =========================================================================
// SC1 — 开着连续两拍:两次 messages 尾都有短 `<graph_mode>`
// =========================================================================

describe("loop engine ADR-0080 SC1: holder on 连续两拍 → 两次短现势", () => {
  it("用 step() 驱动连续两拍 → 两次 messages 尾都贴短 <graph_mode>", async () => {
    const holder = makeGraphModeHolder();
    holder.set(true); // 初始即 on —— createGraphAssembly 内部 beginRound 拍快照 = true
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: true, // 已观察过 on,跳过初值观察 → step1 就该贴短现势
    };
    const adapter = makeTextAdapter(["a1", "a2", "a3"]);
    const deps = buildDeps({ adapter, assembly, lastSeenEnabled });

    // 驱动两次 step(初值 step 已观察过 → step1 直接贴;step2 同 round → 再贴)。
    let state: LoopState = { messages: [makeUserMsg("Q")], turnCount: 0 };
    const t1 = await step(state, deps);
    assert.equal(t1.kind, "stop");
    const s1 = t1 as { kind: "stop"; finalState: LoopState };
    state = s1.finalState;
    const t2 = await step(state, deps);
    assert.equal(t2.kind, "stop");
    const s2 = t2 as { kind: "stop"; finalState: LoopState };

    // step1 末尾一条短现势;step2 末尾第二条。
    const hits1 = presenceHits(s1.finalState.messages);
    const hits2 = presenceHits(s2.finalState.messages);
    assert.equal(hits1.length, 1, "step1 末尾贴一条短现势");
    assert.equal(hits2.length, 2, "step2 末尾累计两条短现势");

    // 内容形态:每次都是同一份静态文本,字节级恒定。
    for (const t of hits2) {
      assert.equal(t, IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION);
      assert.ok(t.includes("<graph_mode>"));
      assert.ok(t.includes("run_graph"));
      assert.ok(t.includes("spawn_subagent"));
    }
    // SC1:短句短于长 ON。
    assert.ok(
      IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION.length <
        IKNOW_GRAPH_MODE_ON_NOTIFICATION.length,
      `短现势(${IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION.length}) 必须短于长 ON(${IKNOW_GRAPH_MODE_ON_NOTIFICATION.length})`
    );
  });

  it("短现势在 messages 尾出现,但不进 system 字符串(SC6)", async () => {
    const holder = makeGraphModeHolder();
    holder.set(true);
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: true, // 已观察过 → step1 直接贴,无需走初值路径
    };
    const adapter = makeTextAdapter(["a1", "a2"]);
    let seenSystem: string | undefined;
    const deps: LoopEngineDeps = {
      adapter,
      executor: emptyExecutor,
      registry: emptyRegistry,
      maxTurns: 5,
      graphModeChange: { assembly, lastSeenEnabled },
      graphModePresence: { assembly },
      system: async () => {
        seenSystem = "<system-static-stub>";
        return seenSystem;
      },
    };

    const state: LoopState = { messages: [makeUserMsg("Q")], turnCount: 0 };
    const t1 = await step(state, deps);
    assert.equal(t1.kind, "stop");
    const s1 = t1 as { kind: "stop"; finalState: LoopState };
    // SC6:system 不含短句。
    assert.equal(seenSystem?.includes("<graph_mode>"), false);
    assert.equal(
      seenSystem?.includes(IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION),
      false
    );
    // 短句仍是独立 user 消息。
    const hits = presenceHits(s1.finalState.messages);
    assert.ok(hits.length >= 1);
  });
});

// =========================================================================
// SC4 — 同 round 中途翻 holder 不出现新短现势;下一 run() 才按新值
// =========================================================================

describe("loop engine ADR-0080 SC4: 同 round 中途翻 holder 不出现新短现势", () => {
  it("step1 期间翻 holder(但不 beginRound)→ step1 messages 尾仍按旧值;后续 step 也不热更新", async () => {
    const holder = makeGraphModeHolder();
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: undefined,
    };
    const adapter = makeTextAdapter(["a1", "a2", "a3"]);
    const deps = buildDeps({ adapter, assembly, lastSeenEnabled });

    // 用 step API 逐步驱动:
    // step1 期间 holder.set(true)(模拟 Shift+Tab 翻键),
    // 但**不**调 beginRound —— 同 round 冻结旧快照(assembly.enabled() === false)。
    let state: LoopState = { messages: [makeUserMsg("Q")], turnCount: 0 };
    const t1 = await step(state, deps);
    assert.equal(t1.kind, "stop");
    const s1 = t1 as { kind: "stop"; finalState: LoopState };
    // step1:零短现势(holder 初始关,即便中途翻也不改 round 快照)。
    assert.equal(presenceHits(s1.finalState.messages).length, 0);

    // 同 round:翻 holder,但不 beginRound → enabled() 仍是 false。
    holder.set(true);
    assert.equal(assembly.enabled(), false);

    // step2 同样零短现势 —— enabled() 仍为 false。
    state = s1.finalState;
    const t2 = await step(state, deps);
    const s2 = t2 as { kind: "stop"; finalState: LoopState };
    assert.equal(presenceHits(s2.finalState.messages).length, 0);
    // 重要:lastSeenEnabled 仍为 false(step1 只观察不写翻转)。
    assert.equal(lastSeenEnabled.value, false);

    // 下一轮(beginRound 拍新快照)→ enabled() === true,后续 step 才出现短现势。
    assembly.beginRound();
    state = s2.finalState;
    const t3 = await step(state, deps);
    const s3 = t3 as { kind: "stop"; finalState: LoopState };
    assert.ok(
      presenceHits(s3.finalState.messages).length >= 1,
      "下一 run() / beginRound 之后 holder on 才生效"
    );
  });
});

// =========================================================================
// SC5 — 同一拍长 ON 与短现势不并存
// =========================================================================

describe("loop engine ADR-0080 SC5: 同一拍长 ON 与短现势不并存", () => {
  it("初值关 → step1 期间 holder.set(true) + beginRound → step2 messages 尾只见长 ON,不见短句", async () => {
    const holder = makeGraphModeHolder();
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: undefined,
    };
    const adapter = makeTextAdapter(["a1", "a2", "a3"]);
    const deps = buildDeps({ adapter, assembly, lastSeenEnabled });

    // step1:初值观察,零追加。
    let state: LoopState = { messages: [makeUserMsg("Q")], turnCount: 0 };
    const t1 = await step(state, deps);
    assert.equal(t1.kind, "stop");
    const s1 = t1 as { kind: "stop"; finalState: LoopState };
    assert.equal(presenceHits(s1.finalState.messages).length, 0);
    assert.equal(lastSeenEnabled.value, false);

    // 翻 on + beginRound —— 同 round 两次模型调用之间翻键,
    // 这是「当拍长 ON」的发生条件(assembly.enabled() 从 false→true)。
    holder.set(true);
    assembly.beginRound();

    // step2:翻检测 → 长 ON 写入 + 短现势不叠(SC5)。
    state = s1.finalState;
    const t2 = await step(state, deps);
    const s2 = t2 as { kind: "stop"; finalState: LoopState };
    const texts = collectUserTexts(s2.finalState.messages);
    const onCount = texts.filter(
      (t) => t === IKNOW_GRAPH_MODE_ON_NOTIFICATION
    ).length;
    const presenceCount = texts.filter(
      (t) => t === IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION
    ).length;
    assert.equal(onCount, 1, "当拍长 ON 出现一次");
    assert.equal(presenceCount, 0, "当拍已贴长 ON → 不叠短现势");

    // step3(同 round,enabled()=true,lastSeenEnabled=true)→ 出现短现势。
    state = s2.finalState;
    const t3 = await step(state, deps);
    const s3 = t3 as { kind: "stop"; finalState: LoopState };
    const texts3 = collectUserTexts(s3.finalState.messages);
    const presenceCount3 = texts3.filter(
      (t) => t === IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION
    ).length;
    assert.ok(
      presenceCount3 >= 1,
      "下一跳(同 round,enabled=true,lastSeen=true)该贴短现势"
    );
  });
});

// =========================================================================
// SC7 — compact 之后下一跳仍 on → 再贴
// =========================================================================

describe("loop engine ADR-0080 SC7: compact 之后无特补;下一跳仍 on 则再贴", () => {
  it("PromptTooLongError → compact 重试 → 重试前按 enabled() 决定短现势", async () => {
    const holder = makeGraphModeHolder();
    holder.set(true); // 初始 on —— 模拟会话里早就开了 graph
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = { value: true };
    // 已观察过 on(step 0 末 = true)。

    const seenMessages: ReadonlyArray<AnthropicNativeMessage>[] = [];
    let stepCalls = 0;
    const flakyAdapter: LoopAdapter = {
      encodeUserText: makeUserMsg,
      encodeToolResults: () => [],
      step: async (state: LoopState): Promise<AssistantTurnResult> => {
        stepCalls += 1;
        seenMessages.push(state.messages);
        if (stepCalls === 1) {
          // 首调抛 PromptTooLong → reactive compact + retry。
          const { PromptTooLongError } =
            await import("../../../src/harness/errors.ts");
          throw new PromptTooLongError("synthetic 400 prompt-too-long");
        }
        const text = "after compact";
        const native = makeAssistantMsg(text);
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
      graphModePresence: { assembly },
    };

    const prior = Array.from({ length: 12 }, (_, i) =>
      makeUserMsg(`prior-${i}`)
    );
    const { result } = await run("Q", deps, undefined, {
      priorMessages: prior,
    });
    assert.equal(result.stopReason, "completed");
    assert.ok(stepCalls >= 3, "reactive retry 必须发生");

    // 重试请求看到的第一条含 <graph_mode> 的 user 消息 = 短现势(SC7:无 compact 特补)。
    const retrySeen = seenMessages[seenMessages.length - 1];
    assert.ok(retrySeen);
    const retryHits = presenceHits(retrySeen);
    assert.ok(retryHits.length >= 1, "compact 后的下一跳仍 on → 再贴短现势");
    // 注意:短现势是 appendGraphModePresence 路径(不是 appendGraphModeChange 翻转)。
    assert.equal(
      retryHits.some((t) => t === IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION),
      true
    );
  });
});

// =========================================================================
// SC6 / SC8 — 短句不进禁区;tools 常驻不变
// =========================================================================

describe("loop engine ADR-0080 SC6 / SC8: 不进禁区 + tools 常驻", () => {
  it("SC6: 短现势是独立 user 消息,不是 assistant content 的一部分,也不是 agent_status 文本", async () => {
    const holder = makeGraphModeHolder();
    holder.set(true);
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: undefined,
    };
    const adapter = makeTextAdapter(["a1", "a2"]);
    const deps = buildDeps({ adapter, assembly, lastSeenEnabled });

    const { result } = await run("Q", deps);
    assert.equal(result.stopReason, "completed");

    // SC6.a:短句所在 user 消息 ≠ assistant 回合(必须是独立 user 消息)。
    for (const m of result.messages) {
      const texts = m.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .filter((t) => t.includes(IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION));
      if (texts.length > 0) {
        assert.equal(m.role, "user");
      }
    }
    // SC6.b:agent_status 栏文本用 '<agent_status>' 标记;与 '<graph_mode>' 互不重叠。
    // 简单防御性检查:presence 文本不含 agent_status 反向泄漏。
    assert.equal(
      IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION.includes("<agent_status>"),
      false
    );
  });

  it("SC8: graphModePresence 缝在场 / 缺席,模型收到的 tools 面字节相同", async () => {
    // graphModePresence 是 messages 缝,不动 registry / promptTools ——
    // 用含 run_graph 的 registry 对比 presence 缝在场 vs 缺席两次 run,
    // adapter 实际收到的 tools 名称序列必须逐字相同(tools 面不随
    // presence 缝抖动)。
    const runGraphTool: ToolDef = {
      name: "run_graph",
      description: "run_graph stub",
      inputSchema: { type: "object" },
      handler: () => Promise.reject(new Error("not used")),
    };
    const registry: Registry = Object.freeze({
      list: () => [runGraphTool],
      get: (name: string) => (name === "run_graph" ? runGraphTool : undefined),
    });
    const runOnce = async (
      withPresence: boolean
    ): Promise<ReadonlyArray<unknown>> => {
      const seenTools: ReadonlyArray<unknown>[] = [];
      const holder = makeGraphModeHolder();
      holder.set(true);
      const assembly = createGraphAssembly(holder.ctx);
      const lastSeenEnabled: { value: boolean | undefined } = { value: true };
      const adapter = makeTextAdapter(["a1"]);
      const base = {
        step: adapter.step,
        encodeUserText: adapter.encodeUserText,
        encodeToolResults: adapter.encodeToolResults,
      };
      const wrapped: LoopAdapter = {
        ...base,
        step: async (state, request, signal) => {
          seenTools.push((request.tools ?? []) as ReadonlyArray<unknown>);
          return adapter.step(state, request, signal);
        },
      };
      const deps: LoopEngineDeps = {
        adapter: wrapped,
        executor: emptyExecutor,
        registry,
        maxTurns: 5,
        ...(withPresence
          ? {
              graphModeChange: { assembly, lastSeenEnabled },
              graphModePresence: { assembly },
            }
          : {}),
      };
      const { result } = await run("Q", deps);
      assert.equal(result.stopReason, "completed");
      assert.equal(seenTools.length, 1);
      return (seenTools[0] as Array<{ name: string }>).map((d) => d.name);
    };

    const withSeam = await runOnce(true);
    const withoutSeam = await runOnce(false);
    assert.deepEqual(withSeam, ["run_graph"]);
    assert.deepEqual(withSeam, withoutSeam);
  });
});
