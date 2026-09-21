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
    // The gate probes exactly the message array it evaluates; no onStream
    // host means no display triple probe (sharing stays forbidden).
    assert.equal(adapter.countTokensCalls.length, 1);
    assert.equal(adapter.countTokensCalls[0]!.messages?.length, 3);
    assert.equal(adapter.countTokensCalls[0]!.tools, undefined);
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
