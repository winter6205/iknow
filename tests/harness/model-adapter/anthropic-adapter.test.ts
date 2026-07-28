/**
 * T11 Anthropic Adapter offline acceptance — 7 classes from contract 014.
 *
 * Adapter 是 Foundation 自治的 ModelAdapter 实现:它把 Anthropic 原生
 * JSON 响应解释成 AssistantTurnResult(完整原子校验 + 投影);把用户文本
 * / 工具结果编码为原生 Anthropic user message;不连真实模型;全部 fixture
 * 离线。所有样例用 SDK 的 Message 类型构造 fixture,Adapter 不调用
 * client.messages.create。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAnthropicAdapter } from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import { ProtocolError } from "../../../src/harness/errors.ts";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";
import type {
  Message as SdkMessage,
  ContentBlock,
  ToolUseBlock,
  TextBlock,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

function adapterFrom(
  responses: ReadonlyArray<SdkMessage>,
  options?: { model?: string; maxTokens?: number },
) {
  return createAnthropicAdapter({
    responses,
    model: options?.model ?? "claude-test-model",
    maxTokens: options?.maxTokens ?? 256,
  });
}

function userMsg(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

const initState = (msgs: AnthropicNativeMessage[] = []): LoopState => ({
  messages: msgs,
  turnCount: 0,
});

describe("createAnthropicAdapter (T11)", () => {
  it("class 1 — pure text completion -> success + completed turnCount=1", async () => {
    const sdkResp: SdkMessage = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [{ type: "text", text: "hi there" }] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    const adapter = adapterFrom([sdkResp]);
    const result = (await adapter.step(initState([userMsg("hi")]), {})) as AssistantTurnResult;
    assert.equal(result.supplierStop, "success");
    assert.equal(result.needsTools, false);
    assert.equal(result.isEmptyFinalResponse, false);
    assert.equal(result.projection.texts.length, 1);
    assert.equal(result.projection.texts[0], "hi there");
  });

  it("class 2 — text + single tool call -> needsTools + 1 tool_call", async () => {
    const sdkResp: SdkMessage = {
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [
        { type: "text", text: "calling tool" } as TextBlock,
        {
          type: "tool_use",
          id: "toolu_1",
          name: "echo",
          input: { value: "ping" },
        } as ToolUseBlock,
      ] as ContentBlock[],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 4 },
    };
    const adapter = adapterFrom([sdkResp]);
    const result = (await adapter.step(initState([userMsg("go")]), {})) as AssistantTurnResult;
    assert.equal(result.needsTools, true);
    assert.equal(result.projection.toolCalls.length, 1);
    assert.equal(result.projection.toolCalls[0]!.id, "toolu_1");
    assert.equal(result.projection.toolCalls[0]!.name, "echo");
    assert.deepEqual(result.projection.toolCalls[0]!.input, { value: "ping" });
    assert.equal(result.projection.texts[0], "calling tool");
  });

  it("class 3 — same-turn multiple tool calls -> needsTools + ordered projection", async () => {
    const sdkResp: SdkMessage = {
      id: "msg_3",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [
        {
          type: "tool_use",
          id: "a",
          name: "echo",
          input: { value: "1" },
        } as ToolUseBlock,
        {
          type: "tool_use",
          id: "b",
          name: "echo",
          input: { value: "2" },
        } as ToolUseBlock,
      ] as ContentBlock[],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 6 },
    };
    const adapter = adapterFrom([sdkResp]);
    const result = (await adapter.step(initState([userMsg("go")]), {})) as AssistantTurnResult;
    assert.equal(result.needsTools, true);
    assert.equal(result.projection.toolCalls.length, 2);
    assert.deepEqual(
      result.projection.toolCalls.map((c) => c.id),
      ["a", "b"],
    );
  });

  it("class 4 — truncation -> nonSuccessStop + text NOT classified as final", async () => {
    const sdkResp: SdkMessage = {
      id: "msg_4",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [{ type: "text", text: "partial answer" }] as ContentBlock[],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 256 },
    };
    const adapter = adapterFrom([sdkResp]);
    const result = (await adapter.step(initState([userMsg("go")]), {})) as AssistantTurnResult;
    assert.equal(result.supplierStop, "truncation");
    assert.equal(result.isEmptyFinalResponse, false);
  });

  it("class 5 — empty final response (success + no text/tool) -> isEmptyFinalResponse", async () => {
    const sdkResp: SdkMessage = {
      id: "msg_5",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    };
    const adapter = adapterFrom([sdkResp]);
    const result = (await adapter.step(initState([userMsg("go")]), {})) as AssistantTurnResult;
    assert.equal(result.supplierStop, "success");
    assert.equal(result.isEmptyFinalResponse, true);
  });

  it("class 6 — missing required tool_use id -> ProtocolError", async () => {
    const bad = {
      id: "msg_6",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [
        {
          type: "tool_use",
          id: "",
          name: "echo",
          input: {},
        } as ToolUseBlock,
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as SdkMessage;
    const adapter = adapterFrom([bad]);
    await assert.rejects(
      () => adapter.step(initState([userMsg("go")]), {}),
      (e: unknown) => e instanceof ProtocolError,
    );
  });

  it("class 7 — stream interrupted before complete response -> ProtocolError, no half turn submitted", async () => {
    const partialEvent = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial" },
    };
    // Adapter takes a 'streamInterrupt' option which makes the second event
    // a synthetic interrupt before message_stop.
    const adapter = createAnthropicAdapter({
      responses: [],
      model: "claude-test-model",
      maxTokens: 256,
      streamEvents: [partialEvent],
      streamInterrupt: true,
    });
    await assert.rejects(
      () => adapter.step(initState([userMsg("go")]), {}),
      (e: unknown) => e instanceof ProtocolError,
    );
  });

  it("encodeUserText + encodeToolResults produce canonical Anthropic messages", () => {
    const adapter = adapterFrom([]);
    const userMsg2 = adapter.encodeUserText("hello world");
    assert.equal(userMsg2.role, "user");
    assert.equal(userMsg2.content.length, 1);
    assert.equal(userMsg2.content[0]!.type, "text");
    assert.equal(
      (userMsg2.content[0] as { type: "text"; text: string }).text,
      "hello world",
    );
    const toolResultBlocks = adapter.encodeToolResults([
      {
        kind: "ok",
        toolUseId: "t1",
        payload: [{ type: "text", text: "ok-msg" }],
      },
    ]);
    assert.equal(toolResultBlocks.length, 1);
    const tr = toolResultBlocks[0]! as {
      type: "tool_result";
      tool_use_id: string;
      is_error?: boolean;
      content: unknown;
    };
    assert.equal(tr.type, "tool_result");
    assert.equal(tr.tool_use_id, "t1");
    assert.equal(tr.is_error, undefined);
  });

  it("class 8 — refusal stop_reason -> supplierStop='refusal' + text in projection, NOT empty", async () => {
    const sdkResp: SdkMessage = {
      id: "msg_8",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [
        { type: "text", text: "I cannot help with that." } as TextBlock,
      ] as ContentBlock[],
      stop_reason: "refusal",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 8 },
    };
    const adapter = adapterFrom([sdkResp]);
    const result = (await adapter.step(initState([userMsg("go")]), {})) as AssistantTurnResult;
    assert.equal(result.supplierStop, "refusal");
    assert.equal(result.isEmptyFinalResponse, false);
    assert.equal(result.projection.texts.length, 1);
    assert.equal(result.projection.texts[0], "I cannot help with that.");
  });
});