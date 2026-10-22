/**
 * ADR-0118 acceptance 5 — closing behavioral proof of the occupancy gate.
 *
 * These are end-to-end loop-engine runs (not unit probes): a history whose
 * chars estimate sits below the auto-compact gate but whose measured context
 * occupancy sits above it must actually compact before the over-gate context
 * is ever sent, and the occupancy signal the display reads must be lower
 * after the compaction than the value that fired the gate.
 *
 * Certified contract:
 *  - vision-heavy prior (base64 image inside tool_result): the chars
 *    estimator is blind to it (each image block ≈ 1 fallback token) while a
 *    measuring adapter sees it — the gate fires and the first real step
 *    already sees the summary artifact, not the raw over-gate history;
 *  - control: the same vision-heavy prior without any measurement falls to
 *    the estimate, which is genuinely under the gate → noop (compaction
 *    fires because of the measurement, never because the estimate guessed);
 *  - previous-beat cache-breakdown usage (input + cacheRead + cacheCreation,
 *    occupancyFromUsage sum) is alone enough to drive the next-beat gate;
 *  - the display-observable reading after the fire is lower than the
 *    pre-fire value. `lastUsage` / post_call only update on the next
 *    successful model call, so the proof asserts against that real seam:
 *    the post-compaction call's own reading, not an instant-at-fire value.
 *
 * The threshold is derived via getAutoCompactThreshold, never hardcoded.
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
import {
  estimateMessagesTokens,
  getAutoCompactThreshold,
  occupancyFromUsage,
  projectOccupancy,
} from "../../src/harness/compress/index.ts";
import { PromptTooLongError } from "../../src/harness/errors.ts";
import { assistantResult } from "../cli/_fixtures.ts";

// Policy budget window for the whole file; the gate is its derived default
// ratio (floor(0.9 × window), ADR-0100) — thresholdTokens stays unset so no
// magic threshold number appears anywhere.
const CONTEXT_WINDOW = 200_000;
const THRESHOLD = getAutoCompactThreshold(CONTEXT_WINDOW, undefined);

/** Sum of base64 chars across image blocks nested in tool_result content —
 *  the payload the chars estimator is blind to but a real countTokens sees. */
function imageDataChars(
  messages: ReadonlyArray<AnthropicNativeMessage>
): number {
  let chars = 0;
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) {
        continue;
      }
      for (const inner of block.content as Array<Record<string, unknown>>) {
        if (inner.type === "image") {
          const source = inner.source as { data?: string } | undefined;
          chars += source?.data?.length ?? 0;
        }
      }
    }
  }
  return chars;
}

/** A tool round whose result carries a big base64 image: assistant tool_use
 *  + user tool_result(image). One pair = 2 messages. */
function visionPair(
  index: number,
  dataLength: number
): AnthropicNativeMessage[] {
  const id = `v${index}`;
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "view_image", input: {} }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "A".repeat(dataLength),
              },
            },
          ],
        },
      ],
    },
  ];
}

/** countTokens probe mirroring the real API's input side: the image bytes
 *  dominate (≈ chars/4 tokens); anything else is cheap. */
function measureProbe(input: CountTokensInput): number {
  const messages = (input.messages ??
    []) as ReadonlyArray<AnthropicNativeMessage>;
  const imageChars = imageDataChars(messages);
  return imageChars > 0
    ? Math.ceil(imageChars / 4)
    : estimateMessagesTokens(messages) + 1;
}

/** Summary-aware scripted adapter (same seam as makeFullSummaryAdapter):
 *  compact prompt without tools → "summarized"; normal steps from the queue.
 *  Records the messages of every measurement and every normal step. */
function makeProbeAdapter(opts: {
  readonly stepScripts: ReadonlyArray<AssistantTurnResult>;
  readonly withCountTokens: boolean;
  /** 1-based index of the normal (non-summary) call that throws
   *  PromptTooLongError instead of consuming a script; exercises the reactive
   *  compaction backstop. The call's messages are still recorded. */
  readonly promptTooLongOnCall?: number;
}): LoopAdapter & {
  readonly compactCalls: { value: number };
  readonly measureCalls: CountTokensInput[];
  readonly normalStepMessages: AnthropicNativeMessage[][];
} {
  const queue = opts.stepScripts.slice();
  const compactCalls = { value: 0 };
  const measureCalls: CountTokensInput[] = [];
  const normalStepMessages: AnthropicNativeMessage[][] = [];
  const adapter: LoopAdapter & {
    readonly compactCalls: { value: number };
    readonly measureCalls: CountTokensInput[];
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
              "<analysis>scratch</analysis><summary>PROOF-SUMMARY</summary>",
            ],
            toolCalls: [],
            supplierStop: "success",
          });
        }
      }
      normalStepMessages.push([...state.messages]);
      if (opts.promptTooLongOnCall === normalStepMessages.length) {
        throw new PromptTooLongError("synthetic 400 prompt-too-long");
      }
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("makeProbeAdapter: scripted step responses exhausted");
      }
      return next;
    },
    compactCalls,
    measureCalls,
    normalStepMessages,
  };
  if (opts.withCountTokens) {
    return Object.freeze({
      ...adapter,
      async countTokens(input: CountTokensInput) {
        measureCalls.push(input);
        return { inputTokens: measureProbe(input) };
      },
    });
  }
  return Object.freeze(adapter);
}

// The image tool is only needed so the registry is non-empty for the loop;
// the prior is pre-existing history, no tool executes inside these runs'
// compaction path except the scripted steps.
function emptyToolRegistry() {
  const noop = createStubTool({
    name: "view_image",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    next: () => ({ ok: true }),
  });
  const reg = createRegistry([noop]);
  return { reg, exec: createExecutor(reg) };
}

function proofDeps(adapter: LoopAdapter): LoopEngineDeps {
  const { reg, exec } = emptyToolRegistry();
  return {
    adapter,
    executor: exec,
    registry: reg,
    maxTurns: 5,
    compress: { contextWindow: CONTEXT_WINDOW, thresholdTokens: undefined },
  };
}

function messageText(m: AnthropicNativeMessage): string {
  return m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function usageOf(
  input: number,
  cache: { cacheRead?: number; cacheCreate?: number } = {}
): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: 1,
    cacheCreationInputTokens: cache.cacheCreate ?? null,
    cacheReadInputTokens: cache.cacheRead ?? null,
  };
}

/** 2 vision pairs + the run's own user message = 5 messages ≤
 *  DEFAULT_KEEP_RECENT, so an over-gate verdict takes the full-summary path
 *  (kept tail empty → the post-compaction history really is image-free). */
function visionPrior(): AnthropicNativeMessage[] {
  const dataPerImage = Math.ceil(((THRESHOLD + 20_000) * 4) / 2);
  return [...visionPair(1, dataPerImage), ...visionPair(2, dataPerImage)];
}

describe("occupancy gate end-to-end: over-gate turns really compact (ADR-0118)", () => {
  it("vision 历史：inflated countTokens（base64/4）不再驱动闸 → 投影低于闸，首个真实调用看到原始历史", async () => {
    const prior = visionPrior();
    const inflatedTextCharge = Math.ceil(imageDataChars(prior) / 4);
    assert.ok(
      inflatedTextCharge >= THRESHOLD,
      `前提：文本计费 ${inflatedTextCharge} 必须超闸，才能证明它没有驱动决策`
    );

    const doneUsage = usageOf(8_000);
    const adapter = makeProbeAdapter({
      stepScripts: [
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
          usage: doneUsage,
        }),
      ],
      withCountTokens: true,
    });
    const events: HarnessStreamEvent[] = [];
    const { result } = await run("Q", proofDeps(adapter), undefined, {
      priorMessages: prior,
      onStream: (e) => events.push(e),
    });

    assert.equal(result.stopReason, "completed");
    // The image-bearing request skips the text-shaped measurement entirely,
    // for both the gate and the display.
    assert.equal(
      adapter.measureCalls.length,
      0,
      "图片请求绝不能走 countTokens（它按 base64 文本计价）"
    );
    assert.equal(
      adapter.compactCalls.value,
      0,
      "投影低于闸 → 不得在真实占用以下触发压缩"
    );
    // The first real step sees the original history, not a compaction product.
    assert.equal(adapter.normalStepMessages.length, 1);
    const firstCall = adapter.normalStepMessages[0]!;
    assert.equal(firstCall.length, prior.length + 1);
    assert.ok(
      !messageText(firstCall[0]!).startsWith("This session is being continued")
    );

    // The display's pre-call beat is the same projection and sits under the
    // gate: no raw alternation to a text-charged image cost.
    const preCall = events.find(
      (e) => e.type === "context_usage" && e.phase === "projected"
    );
    assert.ok(
      preCall !== undefined &&
        preCall.type === "context_usage" &&
        preCall.phase === "projected"
    );
    assert.ok(
      preCall.occupancy.tokens < THRESHOLD,
      `投影 ${preCall.occupancy.tokens} 必须低于闸 ${THRESHOLD}`
    );
    assert.equal(preCall.occupancy.source, "projected");
    assert.deepEqual(result.lastUsage, doneUsage);
  });

  it("control: 同一 vision 历史但无 countTokens 且无上拍 usage → 估算确实低于闸 → noop，绝不因图片体积误压", async () => {
    const prior = visionPrior();
    const adapter = makeProbeAdapter({
      stepScripts: [
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      withCountTokens: false,
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    let result;
    try {
      ({ result } = await run("Q", proofDeps(adapter), undefined, {
        priorMessages: prior,
      }));
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(result!.stopReason, "completed");
    assert.equal(
      adapter.compactCalls.value,
      0,
      "无实测时闸按估算判定，低则 noop"
    );
    const firstCall = adapter.normalStepMessages[0]!;
    assert.equal(firstCall.length, prior.length + 1, "首呼看到原始超预算历史");
    assert.ok(
      !messageText(firstCall[0]!).startsWith("This session is being continued")
    );
  });

  it("无 countTokens 时，上一拍 cache 三类 usage（input+cacheRead+cacheCreate 合计超闸、各类单独低于闸）仍驱动次拍闸压缩；post_call 显示读数压缩后低于压缩前，lastUsage 契约在下一拍成功调用处更新", async () => {
    // The pre-fire display signal is call #1's post_call correction; usage /
    // lastUsage only update on a successful model call, so the post-fire
    // value is asserted against call #2's correction — the real seam.
    const overUsage = usageOf(5_000, {
      cacheRead: 150_000,
      cacheCreate: 60_000,
    });
    const underUsage = usageOf(8_000);
    assert.ok(
      occupancyFromUsage(overUsage) >= THRESHOLD &&
        overUsage.inputTokens < THRESHOLD &&
        (overUsage.cacheReadInputTokens ?? 0) < THRESHOLD &&
        (overUsage.cacheCreationInputTokens ?? 0) < THRESHOLD,
      "前提：合计超闸、各类单独低于闸"
    );
    const adapter = makeProbeAdapter({
      stepScripts: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "view_image", input: {} }],
          usage: overUsage,
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
          usage: underUsage,
        }),
      ],
      withCountTokens: false,
    });
    const events: HarnessStreamEvent[] = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    let result;
    try {
      ({ result } = await run("go", proofDeps(adapter), undefined, {
        onStream: (e) => events.push(e),
      }));
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(result.stopReason, "completed");
    assert.equal(
      adapter.compactCalls.value,
      1,
      "上拍 usage 合计超闸必须驱动压缩"
    );
    const postCompactStep = adapter.normalStepMessages.at(-1)!;
    assert.ok(
      messageText(postCompactStep[0]!).startsWith(
        "This session is being continued"
      ),
      "压缩后的普通 step 必须看到摘要轮开头"
    );
    const post = events.filter(
      (e) => e.type === "context_usage" && e.phase === "post_call"
    );
    assert.equal(post.length, 2);
    const preFire = occupancyFromUsage(
      (post[0] as { usage: TokenUsage }).usage
    );
    const postFire = occupancyFromUsage(
      (post[1] as { usage: TokenUsage }).usage
    );
    assert.ok(postFire < preFire, `显示读数必须回落：${postFire} < ${preFire}`);
    assert.ok(postFire < THRESHOLD, "压缩后读数回落到闸下");
    assert.deepEqual(
      result.lastUsage,
      underUsage,
      "call-beat 契约：末次成功调用 usage 出站"
    );
  });
});

/**
 * Plan A T3: the first beat after a compaction with images in history.
 *
 * Compaction resets the run anchor to null, so the next request's numerator
 * degrades to the unanchored full estimate. The emitted value must be exactly
 * that estimate (not `base + delta` from the stale anchor, which would
 * overcount the whole history), the beat must not crash, and the reactive
 * PromptTooLongError backstop must still be reachable on that same beat.
 */
describe("first beat after a compaction with images in history (Plan A T3)", () => {
  function isProjectedUsage(
    e: HarnessStreamEvent
  ): e is Extract<
    HarnessStreamEvent,
    { type: "context_usage"; phase: "projected" }
  > {
    return e.type === "context_usage" && e.phase === "projected";
  }

  it("emits the unanchored projection and keeps the reactive backstop reachable", async () => {
    const { reg, exec } = emptyToolRegistry();
    // Small window so the anchored beat-2 projection crosses the gate while
    // the unanchored beat-1 estimate (~one image = 3072 raw) does not.
    const contextWindow = 10_000;
    const threshold = getAutoCompactThreshold(contextWindow, undefined);
    const anchoredUsage = usageOf(12_000);
    assert.ok(
      occupancyFromUsage(anchoredUsage) + anchoredUsage.outputTokens >=
        threshold,
      "前提：beat 1 的锚定投影（usage + output）必须过闸"
    );

    const adapter = makeProbeAdapter({
      // Beat 1: a tool round so the run continues; its usage becomes the
      // anchor. Beat 3 (after the reactive retry): terminal.
      stepScripts: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "view_image", input: {} }],
          usage: anchoredUsage,
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
          usage: usageOf(8_000),
        }),
      ],
      withCountTokens: false,
      // Beat 2 (the first beat after the proactive compaction) overflows and
      // must still reach the reactive-compaction backstop.
      promptTooLongOnCall: 2,
    });
    const deps: LoopEngineDeps = {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      compress: { contextWindow, thresholdTokens: undefined },
    };

    // The prior is image-bearing from the start; the image pair sits inside
    // the last DEFAULT_KEEP_RECENT messages, so both compactions keep it and
    // the post-compaction requests stay on the projections-only path.
    const prior: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "filler-1" }] },
      { role: "user", content: [{ type: "text", text: "filler-2" }] },
      { role: "user", content: [{ type: "text", text: "filler-3" }] },
      { role: "user", content: [{ type: "text", text: "filler-4" }] },
      ...visionPair(1, 4_000),
    ];

    const events: HarnessStreamEvent[] = [];
    const { result } = await run("Q", deps, undefined, {
      priorMessages: prior,
      onStream: (e) => events.push(e),
    });

    // No crash, and both compactions ran: the proactive gate + the reactive
    // backstop. The 2nd normal call was the throwing one, the 3rd the retry.
    assert.equal(result.stopReason, "completed");
    assert.equal(adapter.compactCalls.value, 2, "主动 + 反应式压缩都触发");
    assert.equal(adapter.normalStepMessages.length, 3);
    assert.equal(
      adapter.measureCalls.length,
      0,
      "含图历史（含压缩后的第一拍）绝不走 countTokens"
    );

    // Expected value: the production projection with anchor null over the
    // very messages the beat sent. The stale-anchor alternative would be
    // `occupancyFromUsage(anchoredUsage) + outputTokens` (≈12k), far above
    // this, so equality pins the reading as the unanchored full estimate.
    const toolsText = JSON.stringify(
      reg.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }))
    );
    const firstBeatMessages = adapter.normalStepMessages[1]!;
    const expected = projectOccupancy({
      messages: firstBeatMessages,
      anchor: null,
      toolsText,
    });
    assert.equal(expected.source, "projected");
    assert.notEqual(
      expected.tokens,
      occupancyFromUsage(anchoredUsage) + anchoredUsage.outputTokens,
      "无锚投影必须与陈旧锚的分母不同"
    );

    // The window between the proactive and the reactive compaction holds
    // exactly the two post-compaction emissions for that beat: the run-level
    // projection and the beat's pre_call reading. Both must be the unanchored
    // estimate; a suppressed or anchored pre_call leaves only one.
    const firstCompaction = events.findIndex(
      (e) => e.type === "compaction_started"
    );
    const secondCompaction = events.findIndex(
      (e, i) => i > firstCompaction && e.type === "compaction_started"
    );
    assert.ok(
      firstCompaction >= 0 && secondCompaction > firstCompaction,
      "主动压缩与反应式压缩都必须出现"
    );
    const betweenCompactions = events
      .slice(firstCompaction + 1, secondCompaction)
      .filter(isProjectedUsage);
    assert.ok(
      betweenCompactions.length >= 2,
      "压缩后 run 内投影 + 下一拍 pre_call 投影都必须出现"
    );
    assert.equal(
      betweenCompactions[0]!.occupancy.tokens,
      expected.tokens,
      "压缩后 run 内投影必须是无锚全量估算"
    );
    assert.equal(
      betweenCompactions[1]!.occupancy.tokens,
      expected.tokens,
      "压缩后第一拍的 pre_call 投影必须是无锚全量估算"
    );
  });
});
