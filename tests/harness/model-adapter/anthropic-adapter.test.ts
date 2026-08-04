/**
 * T11 Anthropic Adapter offline acceptance — 7 classes from contract 014.
 *
 * Adapter 是 Foundation 自治的 ModelAdapter 实现:它把 Anthropic 原生
 * JSON 响应解释成 AssistantTurnResult(完整原子校验 + 投影);把用户文本
 * / 工具结果编码为原生 Anthropic user message;不连真实模型;全部 fixture
 * 离线。所有样例用 SDK 的 Message 类型构造 fixture,Adapter 不调用
 * client.messages.create。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  createAnthropicAdapter,
  createRealAnthropicAdapter,
} from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import { ProtocolError } from "../../../src/harness/errors.ts";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";
import type {
  Message as SdkMessage,
  ContentBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
  ToolUseBlock,
  TextBlock,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

function adapterFrom(
  responses: ReadonlyArray<SdkMessage>,
  options?: { model?: string; maxTokens?: number }
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
      // #160 T2 / ADR-0008 Decision 2: 复用既有 usage fixture 用例,
      // 断言 cache_creation_input_tokens 缺失 → null, cache_read_input_tokens
      // 出现 → 透传,snake→camel 映射落在 result.usage 上。
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 5,
      },
    };
    const adapter = adapterFrom([sdkResp]);
    const result = (await adapter.step(
      initState([userMsg("hi")]),
      {}
    )) as AssistantTurnResult;
    assert.equal(result.supplierStop, "success");
    assert.equal(result.needsTools, false);
    assert.equal(result.isEmptyFinalResponse, false);
    assert.equal(result.projection.texts.length, 1);
    assert.equal(result.projection.texts[0], "hi there");
    // #160 T2: usage 投影到 AssistantTurnResult;NULL cache_creation 字段
    // 透传为 null(snake→camel 投影仅此一处)。
    assert.deepEqual(result.usage, {
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 5,
    });
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
    const result = (await adapter.step(
      initState([userMsg("go")]),
      {}
    )) as AssistantTurnResult;
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
    const result = (await adapter.step(
      initState([userMsg("go")]),
      {}
    )) as AssistantTurnResult;
    assert.equal(result.needsTools, true);
    assert.equal(result.projection.toolCalls.length, 2);
    assert.deepEqual(
      result.projection.toolCalls.map((c) => c.id),
      ["a", "b"]
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
    const result = (await adapter.step(
      initState([userMsg("go")]),
      {}
    )) as AssistantTurnResult;
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
    const result = (await adapter.step(
      initState([userMsg("go")]),
      {}
    )) as AssistantTurnResult;
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
      (e: unknown) => e instanceof ProtocolError
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
      (e: unknown) => e instanceof ProtocolError
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
      "hello world"
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
    const result = (await adapter.step(
      initState([userMsg("go")]),
      {}
    )) as AssistantTurnResult;
    assert.equal(result.supplierStop, "refusal");
    assert.equal(result.isEmptyFinalResponse, false);
    assert.equal(result.projection.texts.length, 1);
    assert.equal(result.projection.texts[0], "I cannot help with that.");
  });
});

describe("createAnthropicAdapter (017 signal/timeout signature)", () => {
  it("step accepts an AbortSignal third param without error", async () => {
    const sdkResp: SdkMessage = {
      id: "sig_1",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [{ type: "text", text: "hello" }] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const adapter = adapterFrom([sdkResp]);
    const controller = new AbortController();
    const r = (await adapter.step(
      initState([userMsg("hi")]),
      { tools: [] },
      controller.signal
    )) as AssistantTurnResult;
    assert.equal(r.supplierStop, "success");
    assert.equal(r.projection.texts[0], "hello");
  });

  it("pre-aborted signal still resolves in offline mode (offline ignores signal)", async () => {
    const sdkResp: SdkMessage = {
      id: "sig_2",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [{ type: "text", text: "still ok" }] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    // Fresh adapter so it consumes the fresh response.
    const adapter = adapterFrom([sdkResp]);
    const controller = new AbortController();
    controller.abort();
    const r2 = (await adapter.step(
      initState([userMsg("hi")]),
      { tools: [] },
      controller.signal
    )) as AssistantTurnResult;
    assert.equal(r2.supplierStop, "success");
    assert.equal(r2.projection.texts[0], "still ok");
  });

  it("AnthropicAdapterOptions accepts timeoutMs without error", async () => {
    const sdkResp: SdkMessage = {
      id: "sig_3",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [{ type: "text", text: "with timeout" }] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const adapter = createAnthropicAdapter({
      responses: [sdkResp],
      model: "claude-test-model",
      maxTokens: 256,
      timeoutMs: 1000,
    });
    const r = (await adapter.step(
      initState([userMsg("hi")]),
      {}
    )) as AssistantTurnResult;
    assert.equal(r.supplierStop, "success");
    assert.equal(r.projection.texts[0], "with timeout");
  });
});

describe("anthropic-adapter T3 thinking/redacted_thinking passthrough (#150, closes #134 issue 1)", () => {
  it("preserves thinking + redacted_thinking + text + tool_use in nativeMessage.content (full fields, order)", async () => {
    const sdkResp: SdkMessage = {
      id: "msg_think_1",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [
        {
          type: "thinking",
          thinking: "Let me reason about this carefully.",
          signature: "sig_abc123",
        } as ThinkingBlock,
        {
          type: "redacted_thinking",
          data: "encrypted_blob_data_here==",
        } as RedactedThinkingBlock,
        { type: "text", text: "final answer" } as TextBlock,
        {
          type: "tool_use",
          id: "toolu_t1",
          name: "echo",
          input: { value: "x" },
        } as ToolUseBlock,
      ] as ContentBlock[],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const adapter = adapterFrom([sdkResp]);
    const result = (await adapter.step(
      initState([userMsg("think then act")]),
      {}
    )) as AssistantTurnResult;

    // --- 1. nativeMessage.content 字段级深保留,块序保持 ---
    const nativeContent = result.nativeMessage.content;
    assert.equal(nativeContent.length, 4);

    // Block 0: thinking (full fields, original order)
    const b0 = nativeContent[0] as {
      type: "thinking";
      thinking: string;
      signature: string;
    };
    assert.equal(b0.type, "thinking");
    assert.equal(b0.thinking, "Let me reason about this carefully.");
    assert.equal(b0.signature, "sig_abc123");

    // Block 1: redacted_thinking (data 完整保留)
    const b1 = nativeContent[1] as { type: "redacted_thinking"; data: string };
    assert.equal(b1.type, "redacted_thinking");
    assert.equal(b1.data, "encrypted_blob_data_here==");

    // Block 2: text (顺序仍在 thinking/tool_use 之间)
    const b2 = nativeContent[2] as { type: "text"; text: string };
    assert.equal(b2.type, "text");
    assert.equal(b2.text, "final answer");

    // Block 3: tool_use (顺序在 thinking 之后)
    const b3 = nativeContent[3] as {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    };
    assert.equal(b3.type, "tool_use");
    assert.equal(b3.id, "toolu_t1");
    assert.equal(b3.name, "echo");
    assert.deepEqual(b3.input, { value: "x" });

    // --- 2. projection.texts 不含 thinking 文本;finalText 派生不变 ---
    assert.deepEqual(result.projection.texts, ["final answer"]);

    // --- 3. tool_calls 投影正常 ---
    assert.equal(result.projection.toolCalls.length, 1);
    assert.equal(result.projection.toolCalls[0]!.id, "toolu_t1");
    assert.equal(result.projection.toolCalls[0]!.name, "echo");

    // --- 4. supplierStop: tool_use stop_reason 不在 success 分类 -> "other"
    //         (这是现有 014 投影的既有行为,本测试只确认未因 thinking 引入回归) ---
    assert.equal(result.supplierStop, "other");
    assert.equal(result.needsTools, true);

    // --- 5. projection.nativeMessage === nativeMessage (同源引用) ---
    assert.equal(result.projection.nativeMessage, result.nativeMessage);
  });

  it("preserves only thinking (no text/tool_use) — native carries signature+thinking, texts empty", async () => {
    const sdkResp: SdkMessage = {
      id: "msg_think_2",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [
        {
          type: "thinking",
          thinking: "Just thinking...",
          signature: "sig_xyz",
        } as ThinkingBlock,
      ] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 1 },
    };
    const adapter = adapterFrom([sdkResp]);
    const result = (await adapter.step(
      initState([userMsg("think")]),
      {}
    )) as AssistantTurnResult;

    // nativeMessage.content 保留 thinking 全字段
    assert.equal(result.nativeMessage.content.length, 1);
    const tBlock = result.nativeMessage.content[0] as {
      type: "thinking";
      thinking: string;
      signature: string;
    };
    assert.equal(tBlock.type, "thinking");
    assert.equal(tBlock.thinking, "Just thinking...");
    assert.equal(tBlock.signature, "sig_xyz");

    // projection.texts 为空(thinking 不进 texts)
    assert.deepEqual(result.projection.texts, []);
    // 仅有 thinking + success stop_reason -> isEmptyFinalResponse 应为 true
    // (因为成功停止但无 text block)
    assert.equal(result.isEmptyFinalResponse, true);
    assert.equal(result.needsTools, false);
  });

  it("preserves only redacted_thinking — native carries data, texts empty", async () => {
    const sdkResp: SdkMessage = {
      id: "msg_think_3",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [
        {
          type: "redacted_thinking",
          data: "redacted_blob_v1",
        } as RedactedThinkingBlock,
      ] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 1 },
    };
    const adapter = adapterFrom([sdkResp]);
    const result = (await adapter.step(
      initState([userMsg("think")]),
      {}
    )) as AssistantTurnResult;

    assert.equal(result.nativeMessage.content.length, 1);
    const rBlock = result.nativeMessage.content[0] as {
      type: "redacted_thinking";
      data: string;
    };
    assert.equal(rBlock.type, "redacted_thinking");
    assert.equal(rBlock.data, "redacted_blob_v1");

    assert.deepEqual(result.projection.texts, []);
    assert.equal(result.isEmptyFinalResponse, true);
  });

  it("unsupported block type still throws ProtocolError (regression: #134 invariant preserved)", async () => {
    const bad = {
      id: "msg_bad",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [
        // @ts-expect-error - intentionally invalid block type to test rejection
        { type: "image", source: { type: "base64", data: "..." } },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as SdkMessage;
    const adapter = adapterFrom([bad]);
    await assert.rejects(
      () => adapter.step(initState([userMsg("go")]), {}),
      (e: unknown) =>
        e instanceof ProtocolError &&
        /unsupported assistant block type 'image'/.test((e as Error).message)
    );
  });
});

// --- T4 (#151): RealAnthropicAdapter 请求侧 thinking 控制臂 ---------------

/**
 * 构造假 Anthropic 客户端:messages.create 捕获 params,返回可被 interpretMessage
 * 接受的最小 SdkMessage fixture。让请求侧断言落在实际发出的 params 上。
 */
function makeFakeClient(opts: {
  readonly captured: { params: unknown | null };
}) {
  const sdkResp: SdkMessage = {
    id: "msg_capture_1",
    type: "message",
    role: "assistant",
    model: "claude-test-model",
    content: [{ type: "text", text: "ok" }] as ContentBlock[],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  // 仅取 messages.create 子集,类型最宽。
  return {
    messages: {
      create: async (
        params: unknown,
        _reqOpts?: unknown
      ): Promise<SdkMessage> => {
        opts.captured.params = params;
        return sdkResp;
      },
    },
  };
}

describe("createRealAnthropicAdapter — request-side thinking control (#151 T4)", () => {
  it("thinking=off(默认)— params 不含 thinking / output_config", async () => {
    const captured = { params: null as unknown };
    const adapter = createRealAnthropicAdapter({
      client: makeFakeClient({ captured }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
    });
    await adapter.step(initState([userMsg("hi")]), {});
    const p = captured.params as Record<string, unknown>;
    assert.equal("thinking" in p, false, "thinking 应不在 params");
    assert.equal("output_config" in p, false, "output_config 应不在 params");
    assert.equal(p.model, "claude-test-model");
    assert.equal(p.max_tokens, 256);
  });

  it("thinking=adaptive + effort 空 → params 含 thinking:{type:'adaptive'}, 不含 output_config", async () => {
    const captured = { params: null as unknown };
    const adapter = createRealAnthropicAdapter({
      client: makeFakeClient({ captured }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
      thinking: { mode: "adaptive" },
    });
    await adapter.step(initState([userMsg("hi")]), {});
    const p = captured.params as Record<string, unknown>;
    assert.deepEqual(p.thinking, { type: "adaptive" });
    assert.equal("output_config" in p, false);
  });

  it("thinking=adaptive + effort=high → params 含 thinking:{type:'adaptive'} + output_config:{effort:'high'}", async () => {
    const captured = { params: null as unknown };
    const adapter = createRealAnthropicAdapter({
      client: makeFakeClient({ captured }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
      thinking: { mode: "adaptive", effort: "high" },
    });
    await adapter.step(initState([userMsg("hi")]), {});
    const p = captured.params as Record<string, unknown>;
    assert.deepEqual(p.thinking, { type: "adaptive" });
    assert.deepEqual(p.output_config, { effort: "high" });
  });

  it("thinking=off + effort=high → params 不含 thinking / output_config(effort 单独不发)", async () => {
    const captured = { params: null as unknown };
    const adapter = createRealAnthropicAdapter({
      client: makeFakeClient({ captured }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
      thinking: { mode: "off", effort: "high" },
    });
    await adapter.step(initState([userMsg("hi")]), {});
    const p = captured.params as Record<string, unknown>;
    assert.equal("thinking" in p, false);
    assert.equal("output_config" in p, false);
  });

  it("temperature 正交:thinking=off 时, temperature=0.7 仍发送", async () => {
    const captured = { params: null as unknown };
    const adapter = createRealAnthropicAdapter({
      client: makeFakeClient({ captured }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
      temperature: 0.7,
    });
    await adapter.step(initState([userMsg("hi")]), {});
    const p = captured.params as Record<string, unknown>;
    assert.equal(p.temperature, 0.7);
    assert.equal("thinking" in p, false);
    assert.equal("output_config" in p, false);
  });

  it("temperature 正交:thinking=adaptive 时, temperature 仍发送且不被覆盖", async () => {
    const captured = { params: null as unknown };
    const adapter = createRealAnthropicAdapter({
      client: makeFakeClient({ captured }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
      temperature: 0.3,
      thinking: { mode: "adaptive", effort: "medium" },
    });
    await adapter.step(initState([userMsg("hi")]), {});
    const p = captured.params as Record<string, unknown>;
    assert.equal(p.temperature, 0.3);
    assert.deepEqual(p.thinking, { type: "adaptive" });
    assert.deepEqual(p.output_config, { effort: "medium" });
  });

  it("temperature 未设 → 不出现 temperature 字段(无论 thinking 状态)", async () => {
    const captured = { params: null as unknown };
    const adapter = createRealAnthropicAdapter({
      client: makeFakeClient({ captured }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
      thinking: { mode: "adaptive" },
    });
    await adapter.step(initState([userMsg("hi")]), {});
    const p = captured.params as Record<string, unknown>;
    assert.equal("temperature" in p, false);
    assert.deepEqual(p.thinking, { type: "adaptive" });
  });
});

// --- #160 T2 (ADR-0008 Decision 2/4): AssistantTurnResult 透出 usage ----
describe("anthropic-adapter — #160 T2 usage projection (ADR-0008 Decision 2/4)", () => {
  it("SDK usage 缺失 → result.usage 字段缺席(=== undefined,Postel)", async () => {
    // 构造裸 message(故意缺 usage)以模拟 stub / 9router 缺省返回;
    // SdkMessage 静态类型在那里要求 usage,此处与 class 6/7 同样用 cast 旁路。
    const noUsage = {
      id: "msg_no_usage",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [{ type: "text", text: "no usage attached" }] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
    } as unknown as SdkMessage;
    const adapter = adapterFrom([noUsage]);
    const result = (await adapter.step(
      initState([userMsg("hi")]),
      {}
    )) as AssistantTurnResult;
    assert.equal(result.supplierStop, "success");
    // 字段缺席即 Postel 语义:not null,not 占位值,not 包裹 undefined 的 object。
    assert.equal(result.usage, undefined);
  });

  it("SDK 周边字段(service_tier / cache_creation / output_tokens_details 等)不进 result.usage", async () => {
    // 极简 SdkMessage:usage 携带 SDK 0.115 全周边字段(service_tier、cache_creation TTL
    // 对象、output_tokens_details、server_tool_use、inference_geo),只允许 4 个 token
    // 字段穿越到域 TokenUsage;ad-hoc 新造最小 fixture,以排除既有测试的其他语义干涉。
    const sdkResp = {
      id: "msg_peripheral",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [{ type: "text", text: "with extras" }] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 7,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: null,
        cache_creation: {
          ephemeral_5m_input_tokens: 1,
          ephemeral_1h_input_tokens: 2,
        },
        inference_geo: "us-east-1",
        output_tokens_details: { reasoning_tokens: 0 },
        server_tool_use: { web_search_requests: 0 },
        service_tier: "standard",
      },
    } as unknown as SdkMessage;
    const adapter = adapterFrom([sdkResp]);
    const result = (await adapter.step(
      initState([userMsg("hi")]),
      {}
    )) as AssistantTurnResult;
    // deepStrictEqual:在 result.usage 上多出任何周边字段都会失败,所以这一条
    // 同时锁死「仅 4 字段」与「snake→camel 翻译」两个不变式。
    assert.deepEqual(result.usage, {
      inputTokens: 7,
      outputTokens: 2,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: null,
    });
  });

  it("畸形 usage(usage:{} / input_tokens 非 number)→ result.usage 字段缺席(不产垃圾对象)", async () => {
    // Postel:usage 存在但形状非法 → 整条缺席,绝不产出
    // {inputTokens: undefined,...} 这类违反 TokenUsage 契约的对象。
    const malformed = {
      id: "msg_malformed",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [{ type: "text", text: "broken usage" }] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {},
    } as unknown as SdkMessage;
    const adapter = adapterFrom([malformed]);
    const result = (await adapter.step(
      initState([userMsg("hi")]),
      {}
    )) as AssistantTurnResult;
    assert.equal(result.supplierStop, "success");
    assert.equal(result.usage, undefined);

    // input_tokens 非 number → 同样缺席。
    const wrongType = {
      id: "msg_malformed2",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [{ type: "text", text: "bad type" }] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: "oops", output_tokens: 3 },
    } as unknown as SdkMessage;
    const adapter2 = adapterFrom([wrongType]);
    const result2 = (await adapter2.step(
      initState([userMsg("hi")]),
      {}
    )) as AssistantTurnResult;
    assert.equal(result2.usage, undefined);

    // cache 两字段非 number → 归一为 null,而非透传垃圾值 / undefined。
    const garbageCache = {
      id: "msg_malformed3",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [{ type: "text", text: "garbage cache" }] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: "garbage",
        cache_read_input_tokens: undefined,
      },
    } as unknown as SdkMessage;
    const adapter3 = adapterFrom([garbageCache]);
    const result3 = (await adapter3.step(
      initState([userMsg("hi")]),
      {}
    )) as AssistantTurnResult;
    assert.deepEqual(result3.usage, {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
  });
});
