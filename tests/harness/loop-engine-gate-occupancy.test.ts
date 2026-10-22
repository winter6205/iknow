/**
 * ADR-0118: the proactive gate beats with a this-beat `countTokens`
 * measurement and always feeds the occupancy chain
 * (this beat → previous usage → estimate) into `evaluateCompactTrigger`.
 *
 * Certified contract:
 *  - a tool-heavy history whose chars estimate sits below the threshold but
 *    whose measured occupancy sits above it must still compact;
 *  - countTokens throw / NaN / 0 = "no measurement this beat", never a
 *    `below_token_threshold` collapse — the previous usage keeps the gate alive;
 *  - a host without onStream still gets the gate evaluation and the this-beat
 *    measurement;
 *  - an adapter without countTokens falls to previous → estimate with a
 *    one-time warn (no per-beat spam) and no crash.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { run } from "../../src/harness/loop-engine.ts";
import type {
  LoopAdapter,
  LoopEngineDeps,
} from "../../src/harness/loop-engine.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  CountTokensInput,
  LoopState,
  TokenUsage,
} from "../../src/harness/model-adapter/types.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import type { ToolExecutionResult } from "../../src/harness/tools/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { toAnthropicToolResults } from "../../src/harness/tools/tool-result.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../cli/_fixtures.ts";

function makeNative(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function usageOf(input: number): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: 1,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };
}

/** countTokens behaviors under test: all three mean "no real measurement". */
type CountTokensFailure = "throw" | "nan" | "zero";

/** Gate fixture adapter: scripted normal steps + full-summary detection,
 *  optional countTokens probe recorded per call. Mirrors the
 *  makeFullSummaryAdapter seam in loop-engine.test.ts. */
function makeGateAdapter(opts: {
  readonly stepScripts: ReadonlyArray<AssistantTurnResult>;
  readonly countTokens?: (
    beat: number,
    input: CountTokensInput
  ) => Promise<number> | number;
}): LoopAdapter & {
  readonly compactCalls: { value: number };
  readonly countTokensCalls: CountTokensInput[];
  readonly normalStepMessages: AnthropicNativeMessage[][];
} {
  const queue = opts.stepScripts.slice();
  const compactCalls = { value: 0 };
  const countTokensCalls: CountTokensInput[] = [];
  const normalStepMessages: AnthropicNativeMessage[][] = [];
  let probeBeat = 0;
  const adapter: LoopAdapter & {
    readonly compactCalls: { value: number };
    readonly countTokensCalls: CountTokensInput[];
    readonly normalStepMessages: AnthropicNativeMessage[][];
  } = {
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    encodeToolResults: (
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] => toAnthropicToolResults(results),
    step: async (
      state: LoopState,
      request: { readonly tools?: unknown }
    ): Promise<AssistantTurnResult> => {
      if (request.tools === undefined) {
        const lastUserText = [...state.messages]
          .reverse()
          .find((m) => m.role === "user")
          ?.content.filter(
            (b): b is { type: "text"; text: string } => b.type === "text"
          )
          .map((b) => b.text)
          .join("");
        if (
          lastUserText?.includes(
            "Your task is to create a detailed summary of the conversation so far"
          ) === true
        ) {
          compactCalls.value += 1;
          return assistantResult({
            texts: [
              "<analysis>scratch</analysis><summary>GATE-SUMMARY</summary>",
            ],
            toolCalls: [],
            supplierStop: "success",
          });
        }
      }
      normalStepMessages.push([...state.messages]);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("makeGateAdapter: scripted step responses exhausted");
      }
      return next;
    },
    compactCalls,
    countTokensCalls,
    normalStepMessages,
  };
  if (opts.countTokens !== undefined) {
    const probe = opts.countTokens;
    return Object.freeze({
      ...adapter,
      async countTokens(input: CountTokensInput) {
        countTokensCalls.push(input);
        return { inputTokens: await probe(++probeBeat, input) };
      },
    });
  }
  return Object.freeze(adapter);
}

function echoTool() {
  const echo = createStubTool({
    name: "echo",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    next: (input: unknown) => input,
  });
  const reg = createRegistry([echo]);
  return { reg, exec: createExecutor(reg) };
}

function gateDeps(
  adapter: LoopAdapter,
  reg: ReturnType<typeof echoTool>["reg"],
  exec: ReturnType<typeof echoTool>["exec"]
): LoopEngineDeps {
  return {
    adapter,
    executor: exec,
    registry: reg,
    maxTurns: 5,
    // chars estimates below stay ≪ 10_000; only measured occupancy crosses.
    compress: { contextWindow: 100_000, thresholdTokens: 10_000 },
  };
}

/** Empty tool set → the gate must omit the `tools` field entirely, exactly as
 *  the display probe's `tools.length > 0` conditional spread does. */
function emptyToolSet() {
  const reg = createRegistry([]);
  return { reg, exec: createExecutor(reg) };
}

function messageText(m: AnthropicNativeMessage): string {
  return m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

const toolCallScript = (): AssistantTurnResult =>
  assistantResult({
    texts: [],
    toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
    usage: usageOf(50_000),
  });

const doneScript = (): AssistantTurnResult =>
  assistantResult({ texts: ["done"], toolCalls: [], supplierStop: "success" });

function failingProbe(behavior: CountTokensFailure) {
  return (beat: number): number => {
    if (behavior === "throw") throw new Error("countTokens upstream 5xx");
    if (behavior === "nan") return Number.NaN;
    void beat;
    return 0;
  };
}

describe("proactive gate this-beat occupancy wiring (ADR-0118 T3)", () => {
  it("measured occupancy over threshold while chars estimate is under → compaction fires before first step", async () => {
    const { reg, exec } = echoTool();
    const adapter = makeGateAdapter({
      stepScripts: [doneScript()],
      countTokens: () => 50_000,
    });
    const longPrior = [makeNative("prior-1"), makeNative("prior-2")];
    const { result } = await run("Q", gateDeps(adapter, reg, exec), undefined, {
      priorMessages: longPrior,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(adapter.compactCalls.value, 1);
    assert.equal(adapter.normalStepMessages.length, 1);
    const firstCall = adapter.normalStepMessages[0]!;
    assert.equal(firstCall.length, 1, "首呼必须已是压缩产物");
    assert.ok(
      messageText(firstCall[0]!).startsWith("This session is being continued")
    );
    // The gate probes the same triple the usage bar displays (ADR-0118 scope
    // parity); no onStream host means no *display* probe runs — the two
    // functions stay separate, but they now measure the same scope.
    assert.equal(adapter.countTokensCalls.length, 1);
    assert.equal(adapter.countTokensCalls[0]!.messages?.length, 3);
    // tools now measured (the gate must not under-count by their share)…
    assert.equal(adapter.countTokensCalls[0]!.tools?.length, 1);
    // …while the frozen system prefix is still unresolved on the run's first
    // step, so `system` is legitimately absent there (see the gate comment).
    assert.equal(adapter.countTokensCalls[0]!.system, undefined);
  });

  for (const behavior of ["throw", "nan", "zero"] as const) {
    it(`countTokens ${behavior}: no this-beat measurement → previous usage keeps the gate alive`, async () => {
      const { reg, exec } = echoTool();
      const adapter = makeGateAdapter({
        stepScripts: [toolCallScript(), doneScript()],
        countTokens: failingProbe(behavior),
      });
      const { result } = await run("go", gateDeps(adapter, reg, exec));
      // The failed probe must not break the turn…
      assert.equal(result.stopReason, "completed");
      // …and must not collapse the gate to below_token_threshold: beat-2
      // evaluates with previous occupancy 50_000 ≥ 10_000 → compact fires.
      assert.equal(adapter.compactCalls.value, 1);
      assert.equal(adapter.countTokensCalls.length, 2, "每个闸拍都尝试测量");
      const postCompactStep = adapter.normalStepMessages.at(-1)!;
      assert.ok(
        messageText(postCompactStep[0]!).startsWith(
          "This session is being continued"
        ),
        "压缩后的普通 step 必须看到摘要轮开头"
      );
    });
  }

  it("no host onStream: gate still measures and this beat outranks a lower previous usage", async () => {
    const { reg, exec } = echoTool();
    const adapter = makeGateAdapter({
      stepScripts: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
          usage: usageOf(100), // previous occupancy far below threshold
        }),
        doneScript(),
      ],
      countTokens: (beat) => (beat === 1 ? 300 : 50_000),
    });
    const { result } = await run("go", gateDeps(adapter, reg, exec));
    assert.equal(result.stopReason, "completed");
    assert.equal(adapter.compactCalls.value, 1, "本拍实测优先于低的上一拍");
    assert.equal(adapter.countTokensCalls.length, 2);
  });

  it("adapter without countTokens: gate falls to previous → estimate with a single warn, no crash", async () => {
    const { reg, exec } = echoTool();
    const adapter = makeGateAdapter({
      stepScripts: [toolCallScript(), doneScript()],
    });
    assert.equal(
      (adapter as { readonly countTokens?: unknown }).countTokens,
      undefined
    );
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const { result } = await run("go", gateDeps(adapter, reg, exec));
      assert.equal(result.stopReason, "completed");
      assert.equal(adapter.compactCalls.value, 1, "上一拍 usage 仍驱动闸");
      assert.equal(warnings.length, 1, "每 adapter 实例只 warn 一次，不刷屏");
      assert.match(warnings[0]!, /countTokens/);
    } finally {
      console.warn = originalWarn;
    }
  });
});

/**
 * ADR-0118 scope parity: the gate probe measures the same
 * `tools` + `system` + `messages` triple the usage bar displays
 * (`docs/CONTEXT.md` §occupancy). Measuring messages alone under-counted the
 * request payload, so the gate and the bar disagreed about occupancy.
 *
 * Certified contract:
 *  - beat ≥2 carries `tools` and `system` alongside `messages`;
 *  - the gate never assembles `system` itself (read-only on the frozen box);
 *  - an empty tool set omits the `tools` field (conditional-spread contract);
 *  - the run's first step measures without `system` (box unresolved that early)
 *    and still yields a real measurement;
 *  - occupancy that only crosses the threshold once system/tools are counted
 *    now compacts — the regression this parity fix exists for.
 */
describe("proactive gate measurement scope parity (ADR-0118)", () => {
  it("beat 2 probes tools + system + messages, and never re-resolves deps.system", async () => {
    const { reg, exec } = echoTool();
    const adapter = makeGateAdapter({
      stepScripts: [toolCallScript(), doneScript()],
      // Far below threshold so the measured value short-circuits the chain and
      // the previous beat's 50_000 usage never reaches the gate.
      countTokens: () => 300,
    });
    let systemCalls = 0;
    const deps: LoopEngineDeps = {
      ...gateDeps(adapter, reg, exec),
      system: async () => {
        systemCalls += 1;
        return "SYS-PREFIX";
      },
    };
    const { result } = await run("go", deps);
    assert.equal(result.stopReason, "completed");
    assert.equal(adapter.compactCalls.value, 0, "实测 300 低于阈值 → 不压缩");
    assert.equal(adapter.countTokensCalls.length, 2, "两拍都探测");
    const beat2 = adapter.countTokensCalls[1]!;
    assert.equal(beat2.tools?.length, 1, "闸必须计入工具集");
    assert.equal(beat2.system, "SYS-PREFIX", "闸必须计入冻结的 system 前缀");
    assert.ok(beat2.messages !== undefined, "messages 仍在");
    // One assembly per model phase (2 steps), zero from the gate probe:
    // re-assembling per step would cost file I/O and could report bytes the
    // model never received.
    assert.equal(systemCalls, 2, "闸探针不得调用 deps.system");
  });

  it("empty tool set → no tools field in the gate probe call", async () => {
    const { reg, exec } = emptyToolSet();
    const adapter = makeGateAdapter({
      stepScripts: [doneScript()],
      countTokens: () => 300,
    });
    const deps: LoopEngineDeps = {
      ...gateDeps(adapter, reg, exec),
      system: async () => "SYS-PREFIX",
    };
    const { result } = await run("go", deps);
    assert.equal(result.stopReason, "completed");
    assert.equal(adapter.compactCalls.value, 0);
    assert.equal(adapter.countTokensCalls.length, 1);
    const call = adapter.countTokensCalls[0]!;
    assert.equal(
      Object.hasOwn(call, "tools"),
      false,
      "tools 为空时不得下发 tools 字段"
    );
    assert.ok(call.messages !== undefined);
  });

  it("first step: frozen prefix unresolved → no system field, gate still measures", async () => {
    const { reg, exec } = echoTool();
    const adapter = makeGateAdapter({
      stepScripts: [doneScript()],
      countTokens: () => 50_000,
    });
    const deps: LoopEngineDeps = {
      ...gateDeps(adapter, reg, exec),
      system: async () => "SYS-PREFIX",
    };
    const { result } = await run("Q", deps, undefined, {
      priorMessages: [makeNative("prior-1"), makeNative("prior-2")],
    });
    assert.equal(result.stopReason, "completed");
    const beat1 = adapter.countTokensCalls[0]!;
    assert.equal(beat1.system, undefined, "首拍冻结前缀尚未解析");
    assert.equal(beat1.tools?.length, 1, "首拍仍计入工具集");
    // The gap costs only the system share; the beat still produces a real
    // measurement, so the gate evaluates normally instead of skipping.
    assert.equal(adapter.compactCalls.value, 1, "首拍仍产出测量 → 闸照常触发");
  });

  it("regression: occupancy crosses only once system+tools are counted → compaction fires", async () => {
    const { reg, exec } = echoTool();
    // Mirrors a real trace: the messages-only payload sits under the threshold
    // while the full request payload (messages + system + tools) sits over it.
    const MESSAGES_ONLY = 500;
    const SYSTEM_PLUS_TOOLS = 49_500;
    const adapter = makeGateAdapter({
      stepScripts: [doneScript()],
      countTokens: (_beat, input) =>
        MESSAGES_ONLY +
        (input.tools === undefined && input.system === undefined
          ? 0
          : SYSTEM_PLUS_TOOLS),
    });
    const { result } = await run("Q", gateDeps(adapter, reg, exec), undefined, {
      priorMessages: [makeNative("prior-1"), makeNative("prior-2")],
    });
    assert.equal(result.stopReason, "completed");
    // The stub's messages-only branch is genuinely under threshold, so a
    // compaction here can only come from the tools/system share being counted.
    assert.ok(MESSAGES_ONLY < 10_000, "stub 的仅 messages 分支必须低于阈值");
    assert.equal(
      adapter.countTokensCalls[0]!.tools?.length,
      1,
      "闸必须带工具集进入探测"
    );
    assert.equal(adapter.compactCalls.value, 1, "整包占用过阈 → 必须压缩");
    assert.equal(adapter.normalStepMessages.length, 1);
    assert.ok(
      messageText(adapter.normalStepMessages[0]![0]!).startsWith(
        "This session is being continued"
      ),
      "首呼必须已是压缩产物"
    );
  });
});

/**
 * Plan A T3 parity: the gate and the display consume one shared probe, so an
 * image-bearing request is never measured (the gateway prices base64 text)
 * and the gate uses the same projected numerator the bar shows.
 *
 * Certified contract:
 *  - image-bearing history with an inflated `countTokens` (base64/4) does not
 *    compact below the true threshold, and the gate never probes it;
 *  - image-free history with the same inflated stub still compacts (measured
 *    wins), proving the skip is shape-based, not a blanket disable;
 *  - the gate's numerator equals the display reading for the same beat.
 */
describe("gate/bar parity on image-bearing requests (Plan A T3)", () => {
  /** A real 200x200 PNG header, repeated to inflate the text charge. */
  function imageData(): string {
    const bytes = [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48,
      0x44, 0x52, 0, 0, 0, 200, 0, 0, 0, 200, 8, 6, 0, 0, 0,
    ];
    const header = Buffer.from(bytes).toString("base64");
    // Padding after the header keeps the IHDR readable and the text charge
    // enormous (the production inflation shape).
    return header + "A".repeat(120_000);
  }

  function imagePrior(): AnthropicNativeMessage[] {
    return [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "tool_result",
            tool_use_id: "img-1",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: imageData(),
                },
              },
            ],
          },
        ],
      },
    ];
  }

  /** Seven text messages + the image message, plus the run's own user message
   *  = 9 > DEFAULT_KEEP_RECENT: the windowed compaction keeps the final six
   *  and the image survives, so the whole run stays on the images-are-projected
   *  path. */
  function imageHeavyPrior(): AnthropicNativeMessage[] {
    return [
      ...Array.from({ length: 7 }, (_, i) => makeNative(`filler-${i}`)),
      ...imagePrior(),
    ];
  }

  it("inflated countTokens on image history: no compaction, first call sees the original history", async () => {
    const { reg, exec } = echoTool();
    const adapter = makeGateAdapter({
      stepScripts: [doneScript()],
      // The production gateway charge: base64 length / 4, far over threshold.
      countTokens: () => 40_000,
    });
    const { result } = await run("Q", gateDeps(adapter, reg, exec), undefined, {
      priorMessages: imagePrior(),
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(
      adapter.compactCalls.value,
      0,
      "图片历史绝不能被文本计价推过闸"
    );
    assert.equal(
      adapter.countTokensCalls.length,
      0,
      "闸对含图请求根本不发测量"
    );
    const firstCall = adapter.normalStepMessages[0]!;
    assert.equal(firstCall.length, 2, "首呼看到原始历史");
    assert.equal(firstCall[0]!.content[1]!.type, "tool_result");
  });

  it("image-free history with the same inflated stub still compacts", async () => {
    const { reg, exec } = echoTool();
    const adapter = makeGateAdapter({
      stepScripts: [doneScript()],
      countTokens: () => 40_000,
    });
    const { result } = await run("Q", gateDeps(adapter, reg, exec), undefined, {
      priorMessages: [makeNative("prior-1"), makeNative("prior-2")],
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(adapter.compactCalls.value, 1, "无图时实测仍是第一优先级");
    assert.equal(adapter.countTokensCalls.length, 1);
  });

  it("image-bearing beat: the gate's numerator is exactly the projected display reading", async () => {
    // Parity oracle. The projection P is captured from the bar's own
    // `context_usage` beat of a run whose gate threshold is far above it,
    // then two more runs bracket P with the gate threshold:
    //   - threshold = P + 1 → no compaction. A gate that measured the
    //     text-charged payload (40_000) would fire here, so this fails if the
    //     gate reverts to `countTokens` on an image-bearing request.
    //   - threshold = P → compaction. A gate whose numerator is lower than
    //     the display's projection (e.g. one that dropped the tool share)
    //     would not fire, so this fails if the two diverge.
    // Together they pin gate numerator == display projection for the beat.
    const { reg, exec } = echoTool();
    const captureProjected = async (
      thresholdTokens: number
    ): Promise<{ tokens: number; compactCalls: number }> => {
      const adapter = makeGateAdapter({
        stepScripts: [doneScript()],
        // The production gateway charge: base64 length / 4, far over the
        // bracketing thresholds. It must never drive an image-bearing beat.
        countTokens: () => 40_000,
      });
      const events: HarnessStreamEvent[] = [];
      const { result } = await run(
        "Q",
        {
          ...gateDeps(adapter, reg, exec),
          compress: { contextWindow: 100_000, thresholdTokens },
        },
        undefined,
        {
          priorMessages: imageHeavyPrior(),
          onStream: (e) => events.push(e),
        }
      );
      assert.equal(result.stopReason, "completed");
      assert.equal(
        adapter.countTokensCalls.length,
        0,
        "含图请求的闸与显示都不得调用 countTokens"
      );
      const projected = events.find(
        (e) => e.type === "context_usage" && e.phase === "projected"
      );
      assert.ok(
        projected !== undefined && projected.type === "context_usage",
        "含图镜头必须产出 projected 读数"
      );
      assert.ok(projected.phase === "projected");
      assert.equal(projected.occupancy.source, "projected");
      return {
        tokens: projected.occupancy.tokens,
        compactCalls: adapter.compactCalls.value,
      };
    };

    const above = await captureProjected(90_000);
    const P = above.tokens;
    assert.equal(above.compactCalls, 0, "投影远低于 90_000");

    const justAbove = await captureProjected(P + 1);
    assert.equal(
      justAbove.compactCalls,
      0,
      "闸阈值高于投影一个 token → 不得压缩（文本计价 40_000 会误触）"
    );

    const atProjection = await captureProjected(P);
    assert.equal(
      atProjection.compactCalls,
      1,
      "闸阈值等于投影 → 必须压缩（闸的分子就是显示投影）"
    );
  });

  it("gate numerator equals the display reading for the same beat", async () => {
    const { reg, exec } = echoTool();
    const adapter = makeGateAdapter({
      stepScripts: [doneScript()],
      countTokens: () => 500,
    });
    const events: HarnessStreamEvent[] = [];
    const { result } = await run(
      "Q",
      { ...gateDeps(adapter, reg, exec), compress: undefined },
      undefined,
      {
        priorMessages: [makeNative("same beat")],
        onStream: (e) => events.push(e),
      }
    );
    assert.equal(result.stopReason, "completed");
    const pre = events.find(
      (e) => e.type === "context_usage" && e.phase === "pre_call"
    );
    assert.ok(pre !== undefined && pre.type === "context_usage");
    assert.ok(pre.phase !== "projected");
    assert.equal(pre.usage.inputTokens, 500);
    // With compress absent the gate did not run, so assert the parity shape
    // on a run WITH the gate: the measured probe is the only countTokens call
    // and the display reading is its exact number.
    const withGate = makeGateAdapter({
      stepScripts: [doneScript()],
      countTokens: () => 500,
    });
    const events2: HarnessStreamEvent[] = [];
    const gateDeps2 = gateDeps(withGate, reg, exec);
    const out = await run(
      "Q",
      {
        ...gateDeps2,
        compress: { contextWindow: 1_000_000, thresholdTokens: 900_000 },
      },
      undefined,
      {
        priorMessages: [makeNative("same beat")],
        onStream: (e) => events2.push(e),
      }
    );
    assert.equal(out.result.stopReason, "completed");
    const pre2 = events2.find(
      (e) => e.type === "context_usage" && e.phase === "pre_call"
    );
    assert.ok(pre2 !== undefined && pre2.type === "context_usage");
    assert.ok(pre2.phase !== "projected");
    assert.equal(pre2.usage.inputTokens, 500);
    // Gate probe + display probe = exactly two measurements of the same value.
    assert.equal(withGate.countTokensCalls.length, 2);
  });
});
