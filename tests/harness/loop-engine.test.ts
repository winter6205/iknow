/**
 * T5–T10 Loop Engine fixture matrix S1–S11。
 *
 * 每条 fixture 一次确定性 run,行为由 stub-model + stub-tool 驱动。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { run } from "../../src/harness/loop-engine.ts";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../../src/harness/model-adapter/types.ts";
import type { ToolDef } from "../../src/harness/tools/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";

function makeNative(
  role: "user" | "assistant",
  text: string,
): AnthropicNativeMessage {
  return { role, content: [{ type: "text", text }] };
}

function assistantResult(
  texts: string[],
  toolCalls: Array<{ id: string; name: string; input: unknown }> = [],
  supplierStop: "success" | "truncation" | "refusal" | "other" = "success",
): AssistantTurnResult {
  const blocks: AnthropicNativeMessage["content"] = [];
  for (const t of texts) blocks.push({ type: "text", text: t });
  for (const c of toolCalls) {
    blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  }
  const native: AnthropicNativeMessage = { role: "assistant", content: blocks };
  return {
    nativeMessage: native,
    projection: {
      nativeMessage: native,
      texts,
      toolCalls,
    },
    supplierStop,
    needsTools: toolCalls.length > 0,
    isEmptyFinalResponse:
      supplierStop === "success" &&
      texts.length === 0 &&
      toolCalls.length === 0,
  };
}

describe("loop engine S1: pure-text completion", () => {
  it("returns completed + turnCount=1 + [user, assistant(text)]", async () => {
    const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel([
      assistantResult(["hi there"], [], "success"),
    ]);
    const result = await run("hello", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 1);
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0]!.role, "user");
    assert.equal(result.messages[1]!.role, "assistant");
    assert.equal(result.finalText, "hi there");
  });
});

describe("loop engine S2: single tool call closure", () => {
  it("emits 4 messages: user, assistant(tool_use), user(tool_result), assistant(text)", async () => {
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
    const exec = createExecutor(reg);
    const model = createStubModel([
      assistantResult([], [
        { id: "t1", name: "echo", input: { value: "ping" } },
      ]),
      assistantResult(["done"], [], "success"),
    ]);
    const result = await run("go", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 2);
    assert.equal(result.messages.length, 4);
    assert.equal(result.messages[0]!.role, "user");
    assert.equal(result.messages[1]!.role, "assistant");
    assert.equal(result.messages[2]!.role, "user");
    assert.equal(result.messages[3]!.role, "assistant");
    // tool_result block carries matched identity
    const trBlocks = result.messages[2]!.content;
    assert.equal(trBlocks[0]!.type, "tool_result");
    assert.equal(
      (trBlocks[0] as { type: "tool_result"; tool_use_id: string }).tool_use_id,
      "t1",
    );
    assert.equal(result.finalText, "done");
  });
});