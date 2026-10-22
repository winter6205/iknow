/**
 * Context-usage call-beat stream events (#1079 Track A).
 *
 * Certified contract:
 *  - before every model call the host receives one `context_usage` /
 *    "pre_call" reading, measured from `ModelAdapter.countTokens` against
 *    the exact outgoing input (system + tools + messages);
 *  - right after a successful call the host receives the "post_call"
 *    correction carrying that call's API usage — before the tool loop ends;
 *  - beats without a successful real reading emit nothing (chars/N
 *    estimation stays forbidden, ADR-0008 D6);
 *  - an onStream-less host never triggers the measurement call.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { run } from "../../src/harness/loop-engine.ts";
import type { LoopAdapter } from "../../src/harness/loop-engine.ts";
import type {
  AnthropicNativeMessage,
  CountTokensInput,
  TokenUsage,
} from "../../src/harness/model-adapter/types.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { occupancyFromUsage } from "../../src/harness/compress/index.ts";
import { assistantResult } from "../cli/_fixtures.ts";

/** PNG signature + IHDR (the pixel estimator reads only the header). */
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
  return { echo, reg, exec: createExecutor(reg) };
}

/** Wrap a stub model with a scripted countTokens so the pre-call seam has
 *  a measurable adapter. `measure` receives the 1-based beat index. */
function withCountTokens(
  model: LoopAdapter,
  measure: (beat: number, input: CountTokensInput) => number
): LoopAdapter {
  let beat = 0;
  return {
    ...model,
    async countTokens(input: CountTokensInput) {
      beat += 1;
      return { inputTokens: measure(beat, input) };
    },
  };
}

function usageOf(
  input: number,
  cache: { cacheRead?: number | null; cacheCreate?: number | null } = {}
): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: 1,
    cacheCreationInputTokens: cache.cacheCreate ?? null,
    cacheReadInputTokens: cache.cacheRead ?? null,
  };
}

describe("context_usage call-beat events (loop-engine pre/post seams)", () => {
  it("3-step run with countTokens: host receives 3 pre_call readings, each before that call starts", async () => {
    const { reg, exec } = echoTool();
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
        }),
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t2", name: "echo", input: { value: "b" } }],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    // Each beat measures a growing context; the reading must follow the beat.
    const adapter = withCountTokens(model, (beat) => 100 * beat);
    const events: HarnessStreamEvent[] = [];
    const { result } = await run(
      "go",
      { adapter, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { onStream: (e) => events.push(e) }
    );
    assert.equal(result.stopReason, "completed");
    const preCalls = events.filter(
      (e) => e.type === "context_usage" && e.phase === "pre_call"
    );
    assert.equal(preCalls.length, 3);
    assert.deepEqual(
      preCalls.map((e) =>
        e.type === "context_usage" && e.phase !== "projected"
          ? e.usage.inputTokens
          : -1
      ),
      [100, 200, 300]
    );
    // The bar carries only the measured input (no chars/N guess, no fabricated cache).
    const first = preCalls[0];
    assert.ok(
      first !== undefined &&
        first.type === "context_usage" &&
        first.phase !== "projected"
    );
    assert.deepEqual(first.usage, {
      inputTokens: 100,
      outputTokens: 0,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
    // Measured variants are marked by the discriminant alone.
    assert.equal(first.source, "measured");
    // Ordering: each pre_call reading precedes the following model output
    // (no reading is emitted mid-generation for the next beat).
    const seq = events.map((e) =>
      e.type === "context_usage" && e.phase === "pre_call"
        ? "pre"
        : e.type === "context_usage" && e.phase === "post_call"
          ? "post"
          : e.type === "tool_call_start"
            ? "tc"
            : "-"
    );
    // Beat 1: pre before any tool-call output; beat 2 pre comes after beat 1's
    // post and before beat 2's tool output; ...
    assert.equal(seq[0], "pre");
    assert.ok(seq.indexOf("pre", 1) > seq.indexOf("post"));
  });

  it("post_call correction carries the successful call's API usage before the tool loop ends", async () => {
    const { reg, exec } = echoTool();
    const usage1 = usageOf(7, { cacheRead: 1200, cacheCreate: 30 });
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
          usage: usage1,
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
          usage: usageOf(9),
        }),
      ],
    });
    // countTokens wrapped in so the next beat's pre_call exists to order against.
    const adapter = withCountTokens(model, (beat) => 50 * beat);
    const events: HarnessStreamEvent[] = [];
    const { result } = await run(
      "go",
      { adapter, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { onStream: (e) => events.push(e) }
    );
    assert.equal(result.stopReason, "completed");
    const post = events.filter(
      (e) => e.type === "context_usage" && e.phase === "post_call"
    );
    assert.equal(post.length, 2);
    const firstPost = post[0];
    assert.ok(
      firstPost !== undefined &&
        firstPost.type === "context_usage" &&
        firstPost.phase !== "projected" &&
        // Cache breakdown rides along (null → 0 is the display formula's job).
        JSON.stringify(firstPost.usage) === JSON.stringify(usage1)
    );
    // The measured usage object is the adapter's, by identity.
    assert.equal(firstPost.usage, usage1);
    assert.equal(firstPost.source, "measured");
    // The post-call beat also publishes the next request's projection:
    // previous occupancy + this call's output (no appended messages yet).
    assert.deepEqual(firstPost.projectedNext, {
      tokens: 7 + 1200 + 30 + usage1.outputTokens,
      source: "projected",
    });
    // "Mid-run visibility": call #1's correction arrives before beat #2's
    // pre_call, which by construction follows the whole tool loop of beat #1.
    const types = events.map((e) =>
      e.type === "context_usage" ? `usage:${e.phase}` : `-${e.type}`
    );
    assert.ok(
      types.indexOf("usage:post_call") < types.lastIndexOf("usage:pre_call"),
      `expected post_call before the next beat's pre_call, got: ${types.join(",")}`
    );
  });

  it("adapter without countTokens: no pre_call events at all (never an estimate); post_call still rides successful usage", async () => {
    const { reg, exec } = echoTool();
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
          usage: usageOf(42),
        }),
      ],
    });
    const events: HarnessStreamEvent[] = [];
    await run(
      "go",
      { adapter: model, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { onStream: (e) => events.push(e) }
    );
    const pre = events.filter(
      (e) => e.type === "context_usage" && e.phase === "pre_call"
    );
    assert.equal(pre.length, 0);
    const post = events.filter(
      (e) => e.type === "context_usage" && e.phase === "post_call"
    );
    assert.equal(post.length, 1);
  });

  it("countTokens throws: no measured reading that beat; only the projected phase may follow", async () => {
    const { reg, exec } = echoTool();
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const failing: LoopAdapter = {
      ...model,
      async countTokens() {
        throw new Error("countTokens upstream 5xx");
      },
    };
    const events: HarnessStreamEvent[] = [];
    const { result } = await run(
      "go",
      { adapter: failing, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { onStream: (e) => events.push(e) }
    );
    assert.equal(result.stopReason, "completed");
    // A failed measurement is never fabricated into a measured beat. The
    // post-append projection may still ride the display channel (marked
    // `phase:"projected"`, no `usage`).
    assert.equal(
      events.filter(
        (e) => e.type === "context_usage" && e.phase !== "projected"
      ).length,
      0
    );
    assert.ok(
      events.some((e) => e.type === "context_usage" && e.phase === "projected")
    );
  });

  it("host without onStream: countTokens is never invoked (no cost without a consumer)", async () => {
    const { reg, exec } = echoTool();
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    let calls = 0;
    const adapter = withCountTokens(model, () => {
      calls += 1;
      return 1;
    });
    const { result } = await run("go", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(calls, 0);
  });

  it("hostStreamPresent:false with a wrapper onStream: countTokens is never invoked", async () => {
    const { reg, exec } = echoTool();
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    let calls = 0;
    const adapter = withCountTokens(model, () => {
      calls += 1;
      return 1;
    });
    const events: HarnessStreamEvent[] = [];
    const { result } = await run(
      "go",
      { adapter, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      {
        onStream: (e) => events.push(e),
        hostStreamPresent: false,
      }
    );
    assert.equal(result.stopReason, "completed");
    assert.equal(calls, 0);
    assert.equal(
      events.filter((e) => e.type === "context_usage" && e.phase === "pre_call")
        .length,
      0
    );
  });

  it("pre_call measures the exact outgoing input: system text + tools + messages reach countTokens", async () => {
    const { reg, exec } = echoTool();
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    let seen: CountTokensInput | undefined;
    const adapter = withCountTokens(model, (_beat, input) => {
      seen = input;
      return 123;
    });
    await run(
      "go",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        system: async () => "SYS",
      },
      undefined,
      { onStream: () => undefined }
    );
    assert.ok(seen !== undefined, "countTokens must have been called");
    assert.equal(seen!.system, "SYS");
    const tools = seen!.tools as ReadonlyArray<{ name?: string }> | undefined;
    assert.ok(tools !== undefined && tools.some((t) => t.name === "echo"));
    const messages = seen!.messages as ReadonlyArray<AnthropicNativeMessage>;
    assert.ok(messages.length >= 1, "the outgoing history reaches countTokens");
    assert.equal(messages[0]!.role, "user");
  });

  it("projected readings follow the assistant append and the tool-result batch", async () => {
    const { reg, exec } = echoTool();
    const usage1 = usageOf(5_000);
    const usage2 = usageOf(8_000);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
          usage: usage1,
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
          usage: usage2,
        }),
      ],
    });
    const adapter = withCountTokens(model, (beat) => 100 * beat);
    const events: HarnessStreamEvent[] = [];
    const { result } = await run(
      "go",
      { adapter, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { onStream: (e) => events.push(e) }
    );
    assert.equal(result.stopReason, "completed");
    const projected = events.filter(
      (e) => e.type === "context_usage" && e.phase === "projected"
    );
    // Beat 1 append, beat 1 tool batch, beat 2 append.
    assert.equal(projected.length, 3);
    const tokens = projected.map((e) =>
      e.type === "context_usage" && e.phase === "projected"
        ? e.occupancy.tokens
        : -1
    );
    assert.equal(tokens[0], occupancyFromUsage(usage1) + usage1.outputTokens);
    assert.ok(
      tokens[1]! > tokens[0]!,
      "the tool-result batch must raise the projected value"
    );
    assert.equal(tokens[2], occupancyFromUsage(usage2) + usage2.outputTokens);
    for (const event of projected) {
      assert.ok(
        event.type === "context_usage" &&
          event.phase === "projected" &&
          event.occupancy.source === "projected"
      );
    }
  });

  it("image-bearing pre-call emits phase projected, never calls countTokens", async () => {
    const { reg, exec } = echoTool();
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
          usage: usageOf(1_000),
        }),
      ],
    });
    let calls = 0;
    // The production inflation: a text-shaped count would charge base64/4.
    const adapter = withCountTokens(model, () => {
      calls += 1;
      return 999_999;
    });
    const imagePrior: AnthropicNativeMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "img1",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: pngBase64(270, 270),
                },
              },
            ],
          },
        ],
      },
    ];
    const events: HarnessStreamEvent[] = [];
    const { result } = await run(
      "Q",
      { adapter, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { priorMessages: imagePrior, onStream: (e) => events.push(e) }
    );
    assert.equal(result.stopReason, "completed");
    assert.equal(calls, 0, "an image-bearing request must skip countTokens");
    const firstUsage = events.find((e) => e.type === "context_usage");
    assert.ok(
      firstUsage !== undefined &&
        firstUsage.type === "context_usage" &&
        firstUsage.phase === "projected"
    );
    assert.equal(firstUsage.occupancy.source, "projected");
    assert.ok(
      firstUsage.occupancy.tokens < 10_000,
      `pixel estimate must not use base64 length, got ${firstUsage.occupancy.tokens}`
    );
    assert.equal(
      events.filter((e) => e.type === "context_usage" && e.phase === "pre_call")
        .length,
      0
    );
  });

  it("post_call forwards generationMs when the adapter measured it", async () => {
    const { reg, exec } = echoTool();
    const base = assistantResult({
      texts: ["done"],
      toolCalls: [],
      supplierStop: "success",
      usage: usageOf(42),
    });
    const model = createStubModel({
      responses: [{ ...base, generationMs: 1_234 }],
    });
    const events: HarnessStreamEvent[] = [];
    await run(
      "go",
      { adapter: model, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { onStream: (e) => events.push(e) }
    );
    const post = events.find(
      (e) => e.type === "context_usage" && e.phase === "post_call"
    );
    assert.ok(
      post !== undefined &&
        post.type === "context_usage" &&
        post.phase !== "projected"
    );
    assert.equal(post.generationMs, 1_234);
  });
});
