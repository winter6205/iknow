/**
 * System-level invariant 1 (context-metrics verification plan): one number per
 * beat, no raw alternation.
 *
 * A three-beat scripted run drives the loop through a text tool result and an
 * image-bearing tool result while the adapter reports 10% / 11% / 12% confirmed
 * occupancy. The regression this oracle guards is the observed `20% -> 60% ->
 * 20%` swing: a pre-call reading that charges an image by its base64 length
 * (`base64Length / 4`) while the post-call correction reports the real usage.
 *
 * Certified contract:
 *  - every beat publishes exactly one reading, and an image-bearing request is
 *    projected (`phase:"projected"`, no `usage`) instead of measured;
 *  - the reading moves across the image-bearing tool batch by the estimated
 *    appended cost (single-digit tokens), never by `base64Length / 4`;
 *  - every measured `pre_call` / `post_call` event carries `source:"measured"`;
 *  - the post-call `usage` is the adapter's own object (identity);
 *  - `RunResult.lastUsage` is the last successful post-call usage and carries
 *    no projection fields.
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
  TokenUsage,
} from "../../src/harness/model-adapter/types.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import type { ToolExecutionResult } from "../../src/harness/tools/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { toAnthropicToolResults } from "../../src/harness/tools/tool-result.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import {
  estimateMessagesTokens,
  occupancyFromUsage,
} from "../../src/harness/compress/index.ts";
import { estimateImageTokensFromBase64 } from "../../src/harness/compress/image-tokens.ts";
import { assistantResult } from "../cli/_fixtures.ts";

/** Policy budget window; 10k tokens = 10%. */
const CONTEXT_WINDOW = 100_000;

/** Confirmed API usage per beat: 10% / 11% / 12% of the window. */
const USAGE_1: TokenUsage = {
  inputTokens: 10_000,
  outputTokens: 200,
  cacheCreationInputTokens: null,
  cacheReadInputTokens: null,
};
const USAGE_2: TokenUsage = {
  inputTokens: 11_000,
  outputTokens: 300,
  cacheCreationInputTokens: null,
  cacheReadInputTokens: null,
};
const USAGE_3: TokenUsage = {
  inputTokens: 12_000,
  outputTokens: 400,
  cacheCreationInputTokens: null,
  cacheReadInputTokens: null,
};

const IMAGE_TOOL = "read_image";

/** PNG signature + IHDR (the pixel estimator reads only the header) followed by
 *  filler, so the base64 payload is large while the decoded dimensions stay
 *  tiny. `base64Length / 4` is then ~50k tokens. */
function syntheticPngBase64(
  width: number,
  height: number,
  fillerChars: number
): string {
  const header = Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
    8,
    6,
    0,
    0,
    0,
  ]);
  // 40-char prefix (a multiple of 4) keeps the filler on a base64 character
  // boundary, so the total length stays a multiple of 4.
  return header.toString("base64") + "A".repeat(fillerChars);
}

const IMAGE_FILLER_CHARS = 199_960;
const IMAGE_BASE64 = syntheticPngBase64(64, 64, IMAGE_FILLER_CHARS);
/** What a text-shaped charge would bill for this payload. */
const IMAGE_TEXT_CHARGE = Math.ceil(IMAGE_BASE64.length / 4);

const TEXT_TOOL_PAYLOAD = "T".repeat(400);

function imageBlock(): AnthropicContentBlock {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: IMAGE_BASE64,
    },
  } as AnthropicContentBlock;
}

/** Two tools: a text echo and the `read_image` name gate the executor uses to
 *  pass an image block through into `tool_result.content`. */
function tools() {
  const echo = createStubTool({
    name: "echo",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    next: () => TEXT_TOOL_PAYLOAD,
  });
  const readImage = createStubTool({
    name: IMAGE_TOOL,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    // The executor passes an image payload through verbatim only under this
    // name; the block shape matches the production wire block.
    next: () => imageBlock(),
  });
  const reg = createRegistry([echo, readImage]);
  return { reg, exec: createExecutor(reg) };
}

/**
 * Scripted adapter with a deterministic `countTokens`: the measured reading is
 * a function of the outgoing history size, so it does not depend on how many
 * probes (gate + display) run per beat. The image-bearing beat must never
 * reach this hook.
 */
function makeAdapter(
  stepScripts: ReadonlyArray<AssistantTurnResult>
): LoopAdapter & { readonly measureCalls: CountTokensInput[] } {
  const measureCalls: CountTokensInput[] = [];
  const model = createStubModel({ responses: stepScripts });
  return {
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    encodeToolResults: (
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] => toAnthropicToolResults(results),
    step: model.step,
    async countTokens(input: CountTokensInput) {
      measureCalls.push(input);
      const messages = (input.messages ??
        []) as ReadonlyArray<AnthropicNativeMessage>;
      // Beat 1 sends one message, beat 2 three; the image-bearing beat sends
      // five and must never be measured.
      return { inputTokens: messages.length >= 3 ? 10_800 : 9_800 };
    },
    measureCalls,
  };
}

/** The reading a host would show for one event: the confirmed occupancy for a
 *  measured beat, the projection for a projected one. */
function readingOf(event: HarnessStreamEvent): number | null {
  if (event.type !== "context_usage") return null;
  return event.phase === "projected"
    ? event.occupancy.tokens
    : occupancyFromUsage(event.usage);
}

function usageEvents(
  events: ReadonlyArray<HarnessStreamEvent>
): ReadonlyArray<ContextUsageEvent> {
  return events.filter(
    (e): e is ContextUsageEvent => e.type === "context_usage"
  );
}

/** The two `context_usage` variants: the measured one (carries `usage`) and
 *  the projected one (no `usage`). */
type ContextUsageEvent = Extract<HarnessStreamEvent, { type: "context_usage" }>;
type MeasuredUsageEvent = Extract<
  HarnessStreamEvent,
  { type: "context_usage"; source: "measured" }
>;
type ProjectedUsageEvent = Extract<
  HarnessStreamEvent,
  { type: "context_usage"; phase: "projected" }
>;

function isMeasured(event: ContextUsageEvent): event is MeasuredUsageEvent {
  return event.phase !== "projected";
}

function isProjected(event: ContextUsageEvent): event is ProjectedUsageEvent {
  return event.phase === "projected";
}

function depsOf(adapter: LoopAdapter): LoopEngineDeps {
  const { reg, exec } = tools();
  return {
    adapter,
    executor: exec,
    registry: reg,
    maxTurns: 5,
    compress: { contextWindow: CONTEXT_WINDOW, thresholdTokens: undefined },
  };
}

describe("context occupancy sequence: one number per beat (invariant 1)", () => {
  it("keeps one reading per beat, projects the image beat, and never charges base64/4", async () => {
    const adapter = makeAdapter([
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t1", name: "echo", input: {} }],
        usage: USAGE_1,
      }),
      assistantResult({
        texts: [],
        toolCalls: [{ id: "t2", name: IMAGE_TOOL, input: {} }],
        usage: USAGE_2,
      }),
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
        usage: USAGE_3,
      }),
    ]);
    const events: HarnessStreamEvent[] = [];
    const { result } = await run("go", depsOf(adapter), undefined, {
      onStream: (e) => events.push(e),
    });
    assert.equal(result.stopReason, "completed");

    const usage = usageEvents(events);
    const readings = usage.map(readingOf);
    const phases = usage.map((e) => e.phase);

    // The image-bearing beat is never measured: `countTokens` prices base64
    // as text, so the request that carries the image must skip it.
    const measuredHistorySizes = adapter.measureCalls.map(
      (c) => (c.messages ?? []).length
    );
    assert.deepEqual(
      measuredHistorySizes,
      [1, 1, 3, 3],
      "only the two image-free beats are measured (gate + display each)"
    );

    // One reading per beat, in order: measured pre-call, confirmed post-call,
    // then the projections published after the assistant append and after the
    // tool-result batch. The image-bearing beat's pre-call is projected.
    assert.deepEqual(phases, [
      "pre_call",
      "post_call",
      "projected",
      "projected",
      "pre_call",
      "post_call",
      "projected",
      "projected",
      "projected",
      "post_call",
      "projected",
    ]);

    // The image-bearing tool result adds single-digit tokens, not the ~50k a
    // text-shaped charge would bill.
    const imageDelta = readings[7]! - readings[6]!;
    assert.ok(
      imageDelta >= 1 && imageDelta <= 10,
      `image result must be priced by pixels (delta ${imageDelta}), not by payload length`
    );
    assert.ok(
      IMAGE_TEXT_CHARGE > 40_000,
      `premise: the text-shaped charge must be large (${IMAGE_TEXT_CHARGE})`
    );
    assert.ok(
      Math.max(...readings.filter((r): r is number => r !== null)) <
        IMAGE_TEXT_CHARGE,
      "no reading may reach the text-charged image cost"
    );
    assert.equal(
      estimateImageTokensFromBase64(IMAGE_BASE64),
      5,
      "the pixel estimator reads the 64x64 header, not the payload length"
    );

    // The confirmed beats carry the adapter's exact usage objects.
    const measured = usage.filter(isMeasured);
    const posts = measured.filter((e) => e.phase === "post_call");
    assert.equal(posts.length, 3);
    assert.equal(posts[0]!.usage, USAGE_1);
    assert.equal(posts[1]!.usage, USAGE_2);
    assert.equal(posts[2]!.usage, USAGE_3);
    assert.equal(posts[0]!.source, "measured");
    assert.equal(posts[1]!.source, "measured");
    assert.equal(posts[2]!.source, "measured");

    // Every measured pre-call carries its source and a usage object.
    const pres = measured.filter((e) => e.phase === "pre_call");
    assert.equal(pres.length, 2);
    for (const pre of pres) {
      assert.equal(pre.source, "measured");
      assert.equal(pre.usage.inputTokens, pre === pres[0] ? 9_800 : 10_800);
      assert.equal(pre.usage.outputTokens, 0);
    }

    // Every projected event is marked as such and carries no usage.
    const projected = usage.filter(isProjected);
    assert.equal(projected.length, 6);
    for (const event of projected) {
      assert.equal(event.occupancy.source, "projected");
      assert.equal(
        "usage" in event,
        false,
        "a projected event must not carry a usage object"
      );
    }

    // The measured beat values line up with the confirmed occupancies, and
    // the projections move by the appended cost.
    assert.deepEqual(readings, [
      9_800,
      occupancyFromUsage(USAGE_1),
      occupancyFromUsage(USAGE_1) + USAGE_1.outputTokens,
      occupancyFromUsage(USAGE_1) + USAGE_1.outputTokens + textBatchCost(),
      10_800,
      occupancyFromUsage(USAGE_2),
      occupancyFromUsage(USAGE_2) + USAGE_2.outputTokens,
      occupancyFromUsage(USAGE_2) + USAGE_2.outputTokens + imageBatchCost(),
      occupancyFromUsage(USAGE_2) + USAGE_2.outputTokens + imageBatchCost(),
      occupancyFromUsage(USAGE_3),
      occupancyFromUsage(USAGE_3) + USAGE_3.outputTokens,
    ]);

    // `lastUsage` is the last successful post-call usage and carries no
    // projection field (ADR-0008 D6).
    assert.equal(result.lastUsage, USAGE_3);
    assert.deepEqual(Object.keys(result.lastUsage ?? {}).sort(), [
      "cacheCreationInputTokens",
      "cacheReadInputTokens",
      "inputTokens",
      "outputTokens",
    ]);
  });
});

/** The estimated cost of the appended text tool-result batch. */
function textBatchCost(): number {
  return estimateMessagesTokens([
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: TEXT_TOOL_PAYLOAD,
        },
      ],
    },
  ]);
}

/** The estimated cost of the appended image-bearing tool-result batch. */
function imageBatchCost(): number {
  return estimateMessagesTokens([
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: [imageBlock()],
        },
      ],
    },
  ]);
}
