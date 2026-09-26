/**
 * Truncated tool_use closeout: a truncated response that already materialized
 * `tool_use` blocks keeps its native assistant message verbatim, runs no tool,
 * and is closed in the same host turn by ONE synthetic `role: user` protocol
 * message carrying one `is_error` tool_result per returned id.
 *
 * Model stubbed at the adapter boundary; registry, executor, and loop engine
 * are real (`.codex/rules/test.md`).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { run, type LoopAdapter } from "../../src/harness/loop-engine.ts";
import { OUTPUT_LIMIT_TOOL_RESULT_TEXT } from "../../src/harness/loop-engine.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
} from "../../src/harness/model-adapter/types.ts";
import { ProtocolError } from "../../src/harness/errors.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../cli/_fixtures.ts";

type ToolResultBlock = Extract<AnthropicContentBlock, { type: "tool_result" }>;

function toolResultBlocks(msg: AnthropicNativeMessage): ToolResultBlock[] {
  return msg.content.filter(
    (b): b is ToolResultBlock => b.type === "tool_result"
  );
}

/** Real echo tool + the count of times its handler actually ran. */
function countingEchoTool(): {
  tool: ReturnType<typeof createStubTool>;
  ran: number[];
} {
  const ran: number[] = [];
  const tool = createStubTool({
    name: "echo",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    next: (input: unknown) => {
      ran.push(1);
      return input;
    },
  });
  return { tool, ran };
}

function truncatedTwoToolUse(): AssistantTurnResult {
  return assistantResult({
    texts: ["partial answer cut off"],
    thinkingBlocks: [
      { type: "thinking", thinking: "planning", signature: "sig-abc" },
    ],
    toolCalls: [
      { id: "toolu_a", name: "echo", input: { value: "ping" } },
      { id: "toolu_b", name: "echo", input: { value: "pong" } },
    ],
    supplierStop: "truncation",
  });
}

/**
 * Drives one truncating run and records every commit batch handed to the host
 * persistence hook (append order = call order).
 */
async function runTruncatingTurn(opts?: { readonly failOnBatch?: number }) {
  const { tool, ran } = countingEchoTool();
  const reg = createRegistry([tool]);
  const exec = createExecutor(reg);
  const adapter = createStubModel({
    responses: [
      truncatedTwoToolUse(),
      assistantResult({
        texts: ["must never be reached"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ],
  });
  const committed: AnthropicNativeMessage[][] = [];
  let batch = 0;
  const deps = {
    adapter,
    executor: exec,
    registry: reg,
    maxTurns: 5,
    commitMessages: async (
      messages: ReadonlyArray<AnthropicNativeMessage>
    ): Promise<void> => {
      batch += 1;
      if (opts?.failOnBatch === batch) {
        throw new Error("injected persistence failure");
      }
      committed.push([...messages]);
    },
  };

  let result: Awaited<ReturnType<typeof run>>["result"] | undefined;
  let thrown: unknown;
  try {
    result = (await run("go", deps)).result;
  } catch (err) {
    thrown = err;
  }
  return { result, thrown, committed, ran };
}

describe("truncated tool_use closeout SC13: append order and pairing", () => {
  it("commits the native assistant message, then one synthetic protocol message", async () => {
    const { result, thrown, committed, ran } = await runTruncatingTurn();

    assert.equal(thrown, undefined);
    assert.equal(result!.stopReason, "nonSuccessStop");
    assert.equal(
      (result as { supplierDetail?: string } | undefined)?.supplierDetail,
      "truncation"
    );
    assert.deepEqual(ran, [], "no tool from the truncated response may run");

    assert.equal(committed.length, 2, "assistant commit then closeout commit");
    const assistantBatch = committed[0]!;
    const closeoutBatch = committed[1]!;
    assert.equal(assistantBatch.length, 1);
    assert.equal(assistantBatch[0]!.role, "assistant");
    assert.equal(closeoutBatch.length, 1);
    assert.equal(closeoutBatch[0]!.role, "user");
  });

  it("keeps the native assistant blocks and signatures verbatim", async () => {
    const { committed } = await runTruncatingTurn();
    const assistant = committed[0]![0]!;
    const scripted = truncatedTwoToolUse().nativeMessage;

    assert.deepEqual(assistant.content, scripted.content);
    const thinking = assistant.content.find((b) => b.type === "thinking") as
      { type: "thinking"; thinking: string; signature: string } | undefined;
    assert.equal(thinking?.signature, "sig-abc");
  });

  it("the synthetic message holds exactly one is_error tool_result per returned id", async () => {
    const { committed } = await runTruncatingTurn();
    const closeout = committed[1]![0]!;
    const blocks = closeout.content;

    assert.deepEqual(
      blocks.map((b) => b.type),
      ["tool_result", "tool_result"],
      "the synthetic message carries ONLY tool_result blocks"
    );
    const results = toolResultBlocks(closeout);
    assert.deepEqual(
      results.map((r) => r.tool_use_id),
      ["toolu_a", "toolu_b"]
    );
    for (const r of results) {
      assert.equal(r.is_error, true);
      assert.deepEqual(r.content, [
        { type: "text", text: OUTPUT_LIMIT_TOOL_RESULT_TEXT },
      ]);
    }
  });

  it("states the output limit and never claims process death or unknown outcome", async () => {
    assert.match(OUTPUT_LIMIT_TOOL_RESULT_TEXT, /output limit/i);
    assert.doesNotMatch(OUTPUT_LIMIT_TOOL_RESULT_TEXT, /process exited/i);
    assert.doesNotMatch(OUTPUT_LIMIT_TOOL_RESULT_TEXT, /outcome is unknown/i);
    assert.doesNotMatch(OUTPUT_LIMIT_TOOL_RESULT_TEXT, /unknown side effect/i);

    const { committed, result } = await runTruncatingTurn();
    const texts = toolResultBlocks(committed[1]![0]!)
      .flatMap((r) => r.content as { text?: string }[])
      .map((c) => c.text ?? "");
    for (const t of texts) {
      assert.equal(t, OUTPUT_LIMIT_TOOL_RESULT_TEXT);
    }
    // The same two messages are the authoritative in-memory history tail.
    assert.equal(result!.messages.length, 3);
    assert.equal(result!.messages[2]!.role, "user");
    assert.deepEqual(
      toolResultBlocks(result!.messages[2]!).map((r) => r.tool_use_id),
      ["toolu_a", "toolu_b"]
    );
  });

  it("is deterministic: two identical runs produce byte-identical closeout", async () => {
    const a = await runTruncatingTurn();
    const b = await runTruncatingTurn();
    assert.deepEqual(a.committed[1], b.committed[1]);
  });

  it("makes no second model call for the truncated generation", async () => {
    const { tool } = countingEchoTool();
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    let calls = 0;
    const inner = createStubModel({ responses: [truncatedTwoToolUse()] });
    const adapter: LoopAdapter = {
      encodeUserText: (text: string) => inner.encodeUserText(text),
      encodeToolResults: (results) => inner.encodeToolResults(results),
      step: async (state, request, signal) => {
        calls += 1;
        return inner.step(state, request, signal);
      },
    };

    const { result } = await run("go", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });

    assert.equal(result.stopReason, "nonSuccessStop");
    assert.equal(calls, 1);
  });
});

describe("truncated tool_use closeout: the no-materialized-id arm keeps protocolError", () => {
  it("an adapter ProtocolError records no synthetic result and no invented id", async () => {
    const { tool } = countingEchoTool();
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const adapter: LoopAdapter = Object.freeze({
      encodeUserText: (text: string): AnthropicNativeMessage => ({
        role: "user",
        content: [{ type: "text", text }],
      }),
      encodeToolResults: (): AnthropicContentBlock[] => [],
      step: async (): Promise<AssistantTurnResult> => {
        throw new ProtocolError(
          "truncated before any tool_use id materialized"
        );
      },
    });
    const committed: AnthropicNativeMessage[][] = [];

    const { result } = await run("go", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      commitMessages: async (
        messages: ReadonlyArray<AnthropicNativeMessage>
      ) => {
        committed.push([...messages]);
      },
    });

    assert.equal(result.stopReason, "protocolError");
    assert.deepEqual(committed, [], "nothing of the failed turn is appended");
    assert.equal(
      result.messages.filter((m) => toolResultBlocks(m).length > 0).length,
      0
    );
  });

  it("a truncation with no tool_use block gets no synthetic message", async () => {
    const { tool } = countingEchoTool();
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: ["partial only"],
          toolCalls: [],
          supplierStop: "truncation",
        }),
      ],
    });
    const committed: AnthropicNativeMessage[][] = [];

    const { result } = await run("go", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      commitMessages: async (
        messages: ReadonlyArray<AnthropicNativeMessage>
      ) => {
        committed.push([...messages]);
      },
    });

    assert.equal(result.stopReason, "nonSuccessStop");
    assert.equal(committed.length, 1, "assistant commit only");
    assert.equal(
      committed.flat().filter((m) => toolResultBlocks(m).length > 0).length,
      0
    );
  });
});

describe("truncated tool_use closeout SC14: persistence failures are typed and never completed", () => {
  it("failure appending the assistant message surfaces MessageCommitError", async () => {
    const { thrown, result } = await runTruncatingTurn({ failOnBatch: 1 });
    const { MessageCommitError } = await import("../../src/harness/errors.ts");
    assert.ok(thrown instanceof MessageCommitError);
    assert.equal(result, undefined, "no RunResult escapes a failed commit");
  });

  it("failure appending the synthetic result message surfaces MessageCommitError", async () => {
    const { thrown, result, committed } = await runTruncatingTurn({
      failOnBatch: 2,
    });
    const { MessageCommitError } = await import("../../src/harness/errors.ts");
    assert.ok(thrown instanceof MessageCommitError);
    assert.equal(result, undefined);
    assert.equal(
      committed.length,
      1,
      "the assistant batch landed; the failing closeout batch did not"
    );
  });
});
