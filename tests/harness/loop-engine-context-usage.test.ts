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
import { assistantResult } from "../cli/_fixtures.ts";

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
        e.type === "context_usage" ? e.usage.inputTokens : -1
      ),
      [100, 200, 300]
    );
    // The bar carries only the measured input (no chars/N guess, no fabricated cache).
    const first = preCalls[0];
    assert.ok(first !== undefined && first.type === "context_usage");
    assert.deepEqual(first.usage, {
      inputTokens: 100,
      outputTokens: 0,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
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
        // Cache breakdown rides along (null → 0 is the display formula's job).
        JSON.stringify(firstPost.usage) === JSON.stringify(usage1)
    );
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

  it("countTokens throws: that beat is skipped silently, the run is unaffected", async () => {
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
    assert.equal(events.filter((e) => e.type === "context_usage").length, 0);
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
});
