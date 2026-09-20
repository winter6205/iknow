/**
 * ADR-0081 — post the short presence line once per run() (replacing the old per-hop design).
 *
 * Pinned invariants:
 *   - holder already on → one run / two hops (two step() calls sharing deps,
 *     or a multi-hop run) → only the first hop posts one short
 *     `<graph_mode>` line (with run_graph + spawn guidance); the second hop
 *     adds nothing. The short line is shorter than the long ON notice.
 *   - holder off / graph never opened → zero short presence lines.
 *   - ask/worker (seam absent) → zero presence, zero long flip notices.
 *   - flipping the holder mid-round adds no new presence line; only the next
 *     run() sees the new value.
 *   - long ON notice already posted in this run → that hop does not stack the
 *     short line, nor do later hops in the same run; a fresh run() (the latch
 *     resets at run() entry) may post one short line when lastSeen=true.
 *   - the short line never appears in the system string, nor in the
 *     <agent_status> bar body.
 *   - PromptTooLong compact retry is the same run → no second presence line
 *     (no compact-specific re-injection); the retry must still happen.
 *   - with the overlay off, the tools list still includes run_graph (regression check).
 *
 * Two consecutive step() calls sharing one deps = two hops of the same run()
 * (the implementation keeps the run-scoped latch on deps.graphModePresence and
 * resets it at run() entry).
 *
 * Shape mirrors `tests/harness/loop-engine/graph-mode-reconnect.test.ts`:
 * stub adapter + empty executor + empty registry.
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

/** Plain-text stub adapter: each step returns one assistant text (no tool calls). */
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

/** Empty executor + registry (the text-only path never touches tools). */
const emptyExecutor: Executor = Object.freeze({
  executeAll: async () => [],
});
const emptyRegistry: Registry = Object.freeze({
  list: () => [],
  get: () => undefined,
});

/** Single-boolean graph mode holder. */
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

/** Collect the text of all role=user messages. */
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

/** Collect user message texts containing the `<graph_mode>` marker. */
function presenceHits(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string[] {
  return collectUserTexts(messages).filter((t) => t.includes("<graph_mode>"));
}

/** Standard deps wiring both graphModeChange and graphModePresence seams. */
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
    graphModePresence: {
      assembly: opts.assembly,
      appendedThisRun: { value: false },
    },
    ...(opts.compress ? { compress: opts.compress } : {}),
  };
  return deps;
}

// =========================================================================
// Off / never opened / seam absent → zero short presence lines
// =========================================================================

describe("loop engine ADR-0081 SC2: holder off → 零短现势", () => {
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
    // Zero `<graph_mode>` user messages.
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
    // Only the user's initial Q; no graph_mode text at all.
    const userTexts = collectUserTexts(result.messages);
    assert.equal(userTexts.length, 1);
    assert.equal(userTexts[0], "Q");
  });
});

describe("loop engine ADR-0081 SC3: ask/worker(seam 缺席)→ 零短现势、零长翻转句", () => {
  it("seam 全部缺席 → run 行为 byte-identical(无 graph_mode 任何形态)", async () => {
    const adapter = makeTextAdapter(["a1", "a2"]);
    const deps: LoopEngineDeps = {
      adapter,
      executor: emptyExecutor,
      registry: emptyRegistry,
      maxTurns: 5,
      // graphModeChange / graphModePresence both absent.
    };

    const { result } = await run("Q", deps);
    assert.equal(result.stopReason, "completed");
    assert.equal(presenceHits(result.messages).length, 0);
  });

  it("graphModePresence 在场但 graphModeChange 缺席(装配错配)→ 保守零注入", async () => {
    // build-engine always wires the two seams from one gated source, so a
    // mismatch (presence present / change absent) can only come from an
    // assembly bug. There the presence seam stays conservative: overlay
    // absent = zero-injection posture, never flip semantics acting alone.
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
      // Only presence wired, change absent — assembly mismatch; must add nothing instead of panicking.
      graphModePresence: { assembly, appendedThisRun: { value: false } },
    };

    const { result } = await run("Q", deps);
    assert.equal(result.stopReason, "completed");
    // Truly zero additions: holder on still posts nothing; no user text beyond the initial Q.
    assert.equal(presenceHits(result.messages).length, 0);
    assert.deepEqual(collectUserTexts(result.messages), ["Q"]);
  });
});

// =========================================================================
// Holder on: one run / two hops → exactly one short `<graph_mode>` at the first hop
// =========================================================================

describe("loop engine ADR-0081 SC1: holder on 一 run 两 hop → 恰好一条短现势", () => {
  it("用同 deps 连续两次 step() → 仅第一 hop 贴短 <graph_mode>", async () => {
    const holder = makeGraphModeHolder();
    holder.set(true); // on from the start — createGraphAssembly's internal beginRound snapshots true
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: true, // on already observed → skip initial-value observation; step1 should post presence
    };
    const adapter = makeTextAdapter(["a1", "a2", "a3"]);
    const deps = buildDeps({ adapter, assembly, lastSeenEnabled });

    // Two steps on the same deps = two hops of one run; posted only at the first hop.
    let state: LoopState = { messages: [makeUserMsg("Q")], turnCount: 0 };
    const t1 = await step(state, deps);
    assert.equal(t1.kind, "stop");
    const s1 = t1 as { kind: "stop"; finalState: LoopState };
    state = s1.finalState;
    const t2 = await step(state, deps);
    assert.equal(t2.kind, "stop");
    const s2 = t2 as { kind: "stop"; finalState: LoopState };

    // One presence line ends step1; step2 adds nothing (cumulative still 1).
    const hits1 = presenceHits(s1.finalState.messages);
    const hits2 = presenceHits(s2.finalState.messages);
    assert.equal(hits1.length, 1, "step1 末尾贴一条短现势");
    assert.equal(hits2.length, 1, "同 run 第二 hop 不得再贴短现势");

    // Content shape: static text, byte-constant.
    for (const t of hits2) {
      assert.equal(t, IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION);
      assert.ok(t.includes("<graph_mode>"));
      assert.ok(t.includes("run_graph"));
      assert.ok(t.includes("spawn_subagent"));
    }
    // The presence line must be shorter than the long ON notice.
    assert.ok(
      IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION.length <
        IKNOW_GRAPH_MODE_ON_NOTIFICATION.length,
      `短现势(${IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION.length}) 必须短于长 ON(${IKNOW_GRAPH_MODE_ON_NOTIFICATION.length})`
    );
  });

  it("连续两次 run()(holder on + lastSeen=true)→ 各贡献恰好一条短现势", async () => {
    const holder = makeGraphModeHolder();
    holder.set(true);
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = { value: true };
    const adapter = makeTextAdapter(["a1", "a2", "a3"]);
    const deps = buildDeps({ adapter, assembly, lastSeenEnabled });

    const first = await run("Q1", deps);
    assert.equal(first.result.stopReason, "completed");
    assert.equal(
      presenceHits(first.result.messages).length,
      1,
      "第一次 run() 恰好一条短现势"
    );

    const second = await run("Q2", deps, undefined, {
      priorMessages: first.result.messages,
    });
    assert.equal(second.result.stopReason, "completed");
    assert.equal(
      presenceHits(second.result.messages).length,
      2,
      "两次 run() 各贡献一条,累计恰好两条"
    );
  });

  it("短现势在 messages 尾出现,但不进 system 字符串(SC6)", async () => {
    const holder = makeGraphModeHolder();
    holder.set(true);
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: true, // already observed → step1 posts directly, no initial-value path
    };
    const adapter = makeTextAdapter(["a1", "a2"]);
    let seenSystem: string | undefined;
    const deps: LoopEngineDeps = {
      adapter,
      executor: emptyExecutor,
      registry: emptyRegistry,
      maxTurns: 5,
      graphModeChange: { assembly, lastSeenEnabled },
      graphModePresence: { assembly, appendedThisRun: { value: false } },
      system: async () => {
        seenSystem = "<system-static-stub>";
        return seenSystem;
      },
    };

    const state: LoopState = { messages: [makeUserMsg("Q")], turnCount: 0 };
    const t1 = await step(state, deps);
    assert.equal(t1.kind, "stop");
    const s1 = t1 as { kind: "stop"; finalState: LoopState };
    // The system string must not contain the short line.
    assert.equal(seenSystem?.includes("<graph_mode>"), false);
    assert.equal(
      seenSystem?.includes(IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION),
      false
    );
    // The short line is still a standalone user message.
    const hits = presenceHits(s1.finalState.messages);
    assert.equal(hits.length, 1, "单 hop 恰好一条短现势");
  });
});

// =========================================================================
// Flipping the holder mid-round adds nothing; only the next run() sees the new value
// =========================================================================

describe("loop engine ADR-0081 SC4: 同 round 中途翻 holder 不出现新短现势", () => {
  it("step1 期间翻 holder(但不 beginRound)→ step1 messages 尾仍按旧值;后续 step 也不热更新", async () => {
    const holder = makeGraphModeHolder();
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: undefined,
    };
    const adapter = makeTextAdapter(["a1", "a2", "a3"]);
    const deps = buildDeps({ adapter, assembly, lastSeenEnabled });

    // Drive step-by-step via the step API:
    // during step1 holder.set(true) (simulating a Shift+Tab toggle),
    // but **no** beginRound — the round keeps its frozen old snapshot (assembly.enabled() === false).
    let state: LoopState = { messages: [makeUserMsg("Q")], turnCount: 0 };
    const t1 = await step(state, deps);
    assert.equal(t1.kind, "stop");
    const s1 = t1 as { kind: "stop"; finalState: LoopState };
    // step1: zero presence lines (holder starts off; a mid-round flip never changes the round snapshot).
    assert.equal(presenceHits(s1.finalState.messages).length, 0);

    // Same round: flip holder without beginRound → enabled() stays false.
    holder.set(true);
    assert.equal(assembly.enabled(), false);

    // step2 likewise zero presence — enabled() still false.
    state = s1.finalState;
    const t2 = await step(state, deps);
    const s2 = t2 as { kind: "stop"; finalState: LoopState };
    assert.equal(presenceHits(s2.finalState.messages).length, 0);
    // Key: lastSeenEnabled stays false (step1 only observes, never writes a flip).
    assert.equal(lastSeenEnabled.value, false);

    // Next round (beginRound takes a fresh snapshot) → enabled() === true; only later steps see presence.
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
// The long ON notice and the short presence line never coexist in one beat
// =========================================================================

describe("loop engine ADR-0081 SC5: 同 run 长 ON 后本 run 不再贴短现势", () => {
  it("初值关 → 翻 on + beginRound → 长 ON 当 hop 不叠短;同 run 后续 hop 也不贴;新 run 可贴一条", async () => {
    const holder = makeGraphModeHolder();
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = {
      value: undefined,
    };
    const adapter = makeTextAdapter(["a1", "a2", "a3"]);
    const deps = buildDeps({ adapter, assembly, lastSeenEnabled });

    // step1: initial-value observation, zero additions.
    let state: LoopState = { messages: [makeUserMsg("Q")], turnCount: 0 };
    const t1 = await step(state, deps);
    assert.equal(t1.kind, "stop");
    const s1 = t1 as { kind: "stop"; finalState: LoopState };
    assert.equal(presenceHits(s1.finalState.messages).length, 0);
    assert.equal(lastSeenEnabled.value, false);

    // Flip on + beginRound — toggling between two model calls of one round
    // is the condition for "this beat's long ON" (assembly.enabled() goes false→true).
    holder.set(true);
    assembly.beginRound();

    // step2: flip detected → long ON written; short presence is NOT stacked.
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

    // step3 (same deps = same run, enabled()=true, lastSeenEnabled=true) → still no short line.
    state = s2.finalState;
    const t3 = await step(state, deps);
    const s3 = t3 as { kind: "stop"; finalState: LoopState };
    const texts3 = collectUserTexts(s3.finalState.messages);
    const presenceCount3 = texts3.filter(
      (t) => t === IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION
    ).length;
    assert.equal(presenceCount3, 0, "同 run 已贴长 ON → 后续 hop 也不贴短现势");

    // A fresh run() resets the latch at entry; holder on + lastSeen=true → one short line may post.
    const { result: nextRun } = await run("Q2", deps);
    assert.equal(nextRun.stopReason, "completed");
    assert.equal(
      presenceHits(nextRun.messages).length,
      1,
      "新 run() 在 lastSeen=true 时可贴恰好一条短现势"
    );
  });
});

// =========================================================================
// Compact retry is the same run → no second injection
// =========================================================================

describe("loop engine ADR-0081 SC7: compact 重试属同一 run → 不追加第二句短现势", () => {
  it("PromptTooLongError → compact 重试发生,且全程至多一条短现势", async () => {
    const holder = makeGraphModeHolder();
    holder.set(true); // on from the start — session had graph enabled long ago
    const assembly = createGraphAssembly(holder.ctx);
    const lastSeenEnabled: { value: boolean | undefined } = { value: true };
    // on already observed (end of step 0 = true).

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
      graphModePresence: { assembly, appendedThisRun: { value: false } },
    };

    const prior = Array.from({ length: 12 }, (_, i) =>
      makeUserMsg(`prior-${i}`)
    );
    const { result } = await run("Q", deps, undefined, {
      priorMessages: prior,
    });
    assert.equal(result.stopReason, "completed");
    assert.ok(stepCalls >= 3, "reactive retry 必须发生");

    // Compact retry stays within the same run — no second line (no compact-specific re-injection).
    const retrySeen = seenMessages[seenMessages.length - 1];
    assert.ok(retrySeen);
    const retryHits = presenceHits(retrySeen);
    assert.ok(
      retryHits.length <= 1,
      "最后一次请求至多一条短现势(compact 不二次注入)"
    );
    assert.ok(
      presenceHits(result.messages).length <= 1,
      "终态 messages 至多一条短现势"
    );
    if (retryHits.length === 1) {
      assert.equal(retryHits[0], IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION);
    }
  });
});

// =========================================================================
// No forbidden-zone leakage; the tools list stays constant
// =========================================================================

describe("loop engine ADR-0081 SC6 / SC8: 不进禁区 + tools 常驻", () => {
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

    // The short line rides a standalone user message, never assistant content.
    for (const m of result.messages) {
      const texts = m.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .filter((t) => t.includes(IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION));
      if (texts.length > 0) {
        assert.equal(m.role, "user");
      }
    }
    // The agent_status bar uses the '<agent_status>' marker; '<graph_mode>' never overlaps it.
    // Simple defensive check: no reverse leak of agent_status inside the presence text.
    assert.equal(
      IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION.includes("<agent_status>"),
      false
    );
  });

  it("SC8: graphModePresence 缝在场 / 缺席,模型收到的 tools 面字节相同", async () => {
    // graphModePresence is a messages-only seam and never touches registry /
    // promptTools — run the same registry (containing run_graph) twice with
    // the seam present vs absent; the tools name sequence the adapter
    // actually receives must be identical (the tools face does not wobble).
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
              graphModePresence: {
                assembly,
                appendedThisRun: { value: false },
              },
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
