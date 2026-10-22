/**
 * Occupancy projection (Plan A / T2).
 *
 * The projection is the next request's numerator: a confirmed API `usage`
 * anchor plus the messages appended after the frozen assistant message, or a
 * full re-estimate when no valid anchor exists. These cases pin the anchor's
 * reference-identity contract, the no-double-count rule for output / system /
 * tools, the no-anchor fallback (never `slice(0)` on a dropped anchor), and
 * the compaction reset.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  estimateMessagesTokens,
  estimateRequestTokens,
  projectOccupancy,
} from "../../../src/harness/compress/index.ts";
import { estimateTokens } from "../../../src/harness/compress/estimate.ts";
import type {
  AnthropicNativeMessage,
  TokenUsage,
} from "../../../src/harness/model-adapter/types.ts";

function userText(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): AnthropicNativeMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResult(text: string): AnthropicNativeMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: text }],
  };
}

function imageToolResult(data: string): AnthropicNativeMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "img1",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data },
          },
        ],
      },
    ],
  };
}

function usageOf(
  input: number,
  output: number,
  cache: { read?: number; create?: number } = {}
): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: cache.create ?? null,
    cacheReadInputTokens: cache.read ?? null,
  };
}

/** PNG signature + IHDR with the given dimensions (the decoder reads only the
 *  header, so no IDAT/CRC is needed). */
function pngBase64(width: number, height: number): string {
  const bytes = [
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
  ];
  return Buffer.from(bytes).toString("base64");
}

describe("anchored projection", () => {
  it("base is usage occupancy + output, delta is only the appended messages", () => {
    const usage = usageOf(10_000, 500);
    const assistant = assistantText("answer");
    const result = toolResult("tool output");
    const messages = [userText("go"), assistant, result];
    const expected =
      10_500 +
      estimateMessagesTokens(messages.slice(messages.indexOf(assistant) + 1));
    const reading = projectOccupancy({
      messages,
      anchor: { usage, assistantMessage: assistant },
    });
    assert.deepEqual(reading, { tokens: expected, source: "projected" });
  });

  it("does not double-count system / tools / output on the anchored path", () => {
    const usage = usageOf(10_000, 500);
    const assistant = assistantText("answer");
    const messages = [assistant];
    const withNothing = projectOccupancy({
      messages,
      anchor: { usage, assistantMessage: assistant },
    });
    const withExtras = projectOccupancy({
      messages,
      anchor: { usage, assistantMessage: assistant },
      systemText: "S".repeat(40_000),
      toolsText: "T".repeat(40_000),
    });
    assert.equal(withNothing.tokens, 10_500);
    assert.equal(withExtras.tokens, 10_500);
  });

  it("a message injected between the anchor and the tool result is part of the delta", () => {
    const usage = usageOf(5_000, 200);
    const assistant = assistantText("answer");
    const injected = userText("<status bar>");
    const result = toolResult("tool output");
    const messages = [assistant, injected, result];
    const reading = projectOccupancy({
      messages,
      anchor: { usage, assistantMessage: assistant },
    });
    assert.equal(
      reading.tokens,
      5_200 + estimateMessagesTokens([injected, result])
    );
  });

  it("a nested tool_result image is priced by pixels in the delta", () => {
    const usage = usageOf(5_000, 200);
    const assistant = assistantText("answer");
    const imageResult = imageToolResult(pngBase64(270, 270));
    const messages = [assistant, imageResult];
    const imageOnly = estimateMessagesTokens([imageResult]);
    const reading = projectOccupancy({
      messages,
      anchor: { usage, assistantMessage: assistant },
    });
    assert.equal(reading.tokens, 5_200 + imageOnly);
    assert.ok(
      imageOnly < 1_000,
      `pixel estimate must stay small, got ${imageOnly}`
    );
  });

  it("cache categories are summed through occupancyFromUsage", () => {
    const usage = usageOf(100, 50, { read: 4_000, create: 900 });
    const assistant = assistantText("answer");
    const reading = projectOccupancy({
      messages: [assistant],
      anchor: { usage, assistantMessage: assistant },
    });
    assert.equal(reading.tokens, 100 + 4_000 + 900 + 50);
  });
});

describe("no-anchor projection", () => {
  it("estimates the full history (thinking included) plus system and tools", () => {
    const thinking: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x".repeat(400), signature: "s" },
      ],
    };
    const messages = [userText("go"), thinking, toolResult("out")];
    const reading = projectOccupancy({
      messages,
      anchor: null,
      systemText: "SYS",
      toolsText: "TOOLS",
    });
    const expected =
      estimateMessagesTokens(messages, { countThinking: true }) +
      estimateTokens("SYS") +
      estimateTokens("TOOLS");
    assert.deepEqual(reading, { tokens: expected, source: "projected" });
  });

  it("a dropped anchor falls back to the full estimate, never slice(0) on top of it", () => {
    const usage = usageOf(10_000, 500);
    const original = assistantText("answer");
    // Structurally equal but not the array entry: the freeze clone a
    // compaction / priorMessages continuation produces.
    const clone = assistantText("answer");
    const messages = [userText("go"), clone, toolResult("out")];
    const reading = projectOccupancy({
      messages,
      anchor: { usage, assistantMessage: original },
    });
    assert.equal(reading.tokens, estimateRequestTokens({ messages }));
    // The measured base must not be added on top of the whole history.
    assert.ok(reading.tokens < 10_500 + estimateMessagesTokens(messages));
  });

  it("compaction reset (anchor null) re-estimates the compacted history", () => {
    const compacted = [userText("This session is being continued")];
    const reading = projectOccupancy({
      messages: compacted,
      anchor: null,
    });
    assert.equal(
      reading.tokens,
      estimateRequestTokens({ messages: compacted })
    );
    assert.ok(reading.tokens < 1_000);
  });

  it("the projection is within 10% of a synthetic next-call occupancy", () => {
    const usage = usageOf(20_000, 1_000);
    const assistant = assistantText("answer");
    const result = toolResult("x".repeat(4_000));
    const messages = [assistant, result];
    const reading = projectOccupancy({
      messages,
      anchor: { usage, assistantMessage: assistant },
    });
    // The synthetic provider count for the next request: the previous input +
    // output + one raw text charge for the appended result (padded at 4/3).
    const syntheticNextInput =
      20_000 + 1_000 + Math.ceil((4_000 / 4) * (4 / 3));
    const ratio = reading.tokens / syntheticNextInput;
    assert.ok(
      ratio >= 0.9 && ratio <= 1.1,
      `projection ${reading.tokens} vs synthetic ${syntheticNextInput} (ratio ${ratio})`
    );
  });
});
