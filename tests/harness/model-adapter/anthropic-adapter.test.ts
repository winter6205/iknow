/**
 * Anthropic adapter offline acceptance — the seven response classes.
 *
 * The adapter is Foundation-owned: it interprets a native Anthropic JSON
 * response into an AssistantTurnResult (full atomic validation + projection)
 * and encodes user text / tool results into native Anthropic user messages.
 * No real model is contacted; every fixture is offline. Fixtures are built
 * with the SDK's Message type; the adapter never calls client.messages.create.
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
  Usage as SdkUsage,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

/**
 * A well-formed SDK `Usage`. The SDK type requires every field, but only the
 * token counts (and, where a case says so, the cache breakdown) carry meaning
 * for these fixtures — the rest are pinned to their documented "absent" value.
 */
function sdkUsage(overrides: {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation?: SdkUsage["cache_creation"];
  readonly inference_geo?: string | null;
}): SdkUsage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    ...overrides,
  };
}

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
      container: null,
      stop_details: null,
      // ADR-0008 Decision 2: reuse this usage fixture to assert that a missing
      // cache_creation_input_tokens maps to null, a present
      // cache_read_input_tokens passes through, and snake→camel lands on result.usage.
      usage: sdkUsage({
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 5,
      }),
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
    // usage projects onto AssistantTurnResult; a NULL cache_creation field
    // passes through as null (this is the only snake→camel projection site).
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
      container: null,
      stop_details: null,
      usage: sdkUsage({ input_tokens: 10, output_tokens: 4 }),
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
      container: null,
      stop_details: null,
      usage: sdkUsage({ input_tokens: 10, output_tokens: 6 }),
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
      container: null,
      stop_details: null,
      usage: sdkUsage({ input_tokens: 10, output_tokens: 256 }),
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
      usage: sdkUsage({ input_tokens: 10, output_tokens: 0 }),
      container: null,
      stop_details: null,
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
      usage: sdkUsage({ input_tokens: 1, output_tokens: 1 }),
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
      container: null,
      stop_details: null,
      usage: sdkUsage({ input_tokens: 5, output_tokens: 8 }),
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
      container: null,
      stop_details: null,
      usage: sdkUsage({ input_tokens: 1, output_tokens: 1 }),
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
      container: null,
      stop_details: null,
      usage: sdkUsage({ input_tokens: 1, output_tokens: 1 }),
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
      container: null,
      stop_details: null,
      usage: sdkUsage({ input_tokens: 1, output_tokens: 1 }),
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
      container: null,
      stop_details: null,
      usage: sdkUsage({ input_tokens: 10, output_tokens: 5 }),
    };
    const adapter = adapterFrom([sdkResp]);
    const result = (await adapter.step(
      initState([userMsg("think then act")]),
      {}
    )) as AssistantTurnResult;

    // --- 1. nativeMessage.content keeps every field, block order preserved ---
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

    // Block 1: redacted_thinking (data fully preserved)
    const b1 = nativeContent[1] as { type: "redacted_thinking"; data: string };
    assert.equal(b1.type, "redacted_thinking");
    assert.equal(b1.data, "encrypted_blob_data_here==");

    // Block 2: text (still ordered between thinking and tool_use)
    const b2 = nativeContent[2] as { type: "text"; text: string };
    assert.equal(b2.type, "text");
    assert.equal(b2.text, "final answer");

    // Block 3: tool_use (ordered after thinking)
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

    // --- 2. projection.texts excludes thinking text; finalText derivation unchanged ---
    assert.deepEqual(result.projection.texts, ["final answer"]);

    // --- 3. tool_calls projection unaffected ---
    assert.equal(result.projection.toolCalls.length, 1);
    assert.equal(result.projection.toolCalls[0]!.id, "toolu_t1");
    assert.equal(result.projection.toolCalls[0]!.name, "echo");

    // --- 4. supplierStop: tool_use stop_reason is not classified as success -> "other"
    //         (pre-existing projection behavior; this only confirms thinking
    //          introduced no regression) ---
    assert.equal(result.supplierStop, "other");
    assert.equal(result.needsTools, true);

    // --- 5. projection.nativeMessage === nativeMessage (same reference) ---
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
      container: null,
      stop_details: null,
      usage: sdkUsage({ input_tokens: 5, output_tokens: 1 }),
    };
    const adapter = adapterFrom([sdkResp]);
    const result = (await adapter.step(
      initState([userMsg("think")]),
      {}
    )) as AssistantTurnResult;

    // nativeMessage.content keeps all thinking fields
    assert.equal(result.nativeMessage.content.length, 1);
    const tBlock = result.nativeMessage.content[0] as {
      type: "thinking";
      thinking: string;
      signature: string;
    };
    assert.equal(tBlock.type, "thinking");
    assert.equal(tBlock.thinking, "Just thinking...");
    assert.equal(tBlock.signature, "sig_xyz");

    // projection.texts is empty (thinking never enters texts)
    assert.deepEqual(result.projection.texts, []);
    // thinking only + success stop_reason -> isEmptyFinalResponse must be true
    // (stopped successfully but produced no text block)
    assert.equal(result.isEmptyFinalResponse, true);
    assert.equal(result.needsTools, false);
  });

  it("normalizes a thinking block missing signature to empty string (#191 deepseek compat)", async () => {
    // deepseek-flash-combo forwarded through 9router emits thinking blocks with
    // no signature field (observed: only { type, thinking }) — normalize to ""
    // so the canonical contract holds.
    const sdkResp: SdkMessage = {
      id: "msg_think_nosig",
      type: "message",
      role: "assistant",
      model: "deepseek-flash-combo",
      content: [
        {
          type: "thinking",
          thinking: "We need answer.",
        } as unknown as ThinkingBlock,
        { type: "text", text: "final" } as TextBlock,
      ] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      container: null,
      stop_details: null,
      usage: sdkUsage({ input_tokens: 4, output_tokens: 2 }),
    };
    const adapter = adapterFrom([sdkResp]);
    const result = (await adapter.step(
      initState([userMsg("ping")]),
      {}
    )) as AssistantTurnResult;

    const tBlock = result.nativeMessage.content[0] as {
      type: "thinking";
      thinking: string;
      signature: string;
    };
    assert.equal(tBlock.type, "thinking");
    assert.equal(tBlock.thinking, "We need answer.");
    assert.equal(tBlock.signature, ""); // missing signature normalizes to ""

    // Projection is unaffected: thinking does not enter texts
    assert.deepEqual(result.projection.texts, ["final"]);
  });

  it('normalizeThinkingSignature: null / non-string → "", string → passthrough (#191)', async () => {
    const { normalizeThinkingSignature } =
      await import("../../../src/harness/model-adapter/anthropic-adapter.ts");
    assert.equal(normalizeThinkingSignature("sig_abc"), "sig_abc");
    assert.equal(normalizeThinkingSignature(undefined), "");
    assert.equal(normalizeThinkingSignature(null), "");
    assert.equal(normalizeThinkingSignature(123), "");
    assert.equal(normalizeThinkingSignature({}), "");
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
      container: null,
      stop_details: null,
      usage: sdkUsage({ input_tokens: 5, output_tokens: 1 }),
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
        // A block type this adapter does not translate, to test rejection. The
        // SDK type now admits `image`, so this no longer needs a type directive;
        // the runtime rejection assertion below is what the case pins.
        { type: "image", source: { type: "base64", data: "..." } },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: sdkUsage({ input_tokens: 1, output_tokens: 1 }),
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

// --- request-side thinking control arm of RealAnthropicAdapter --------------

/**
 * Fake Anthropic client: messages.create captures params and returns the
 * minimal SdkMessage fixture interpretMessage accepts, so request-side
 * assertions run against the params actually sent.
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
    container: null,
    stop_details: null,
    usage: sdkUsage({ input_tokens: 1, output_tokens: 1 }),
  };
  // Only the messages.create subset; widest possible typing.
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

// --- ADR-0008 Decision 2/4: AssistantTurnResult exposes usage ---------------
describe("anthropic-adapter — #160 T2 usage projection (ADR-0008 Decision 2/4)", () => {
  it("SDK usage 缺失 → result.usage 字段缺席(=== undefined,Postel)", async () => {
    // Bare message with usage deliberately missing, simulating stub / 9router
    // default returns; SdkMessage's static type requires usage there, so this
    // casts around it like the class 6/7 fixtures do.
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
    // Absent field is the Postel semantics: not null, not a placeholder, not an
    // object wrapping undefined.
    assert.equal(result.usage, undefined);
  });

  it("SDK 周边字段(service_tier / cache_creation / output_tokens_details 等)不进 result.usage", async () => {
    // Minimal SdkMessage whose usage carries every SDK 0.115 peripheral field
    // (service_tier, cache_creation TTL object, output_tokens_details,
    // server_tool_use, inference_geo); only the 4 token fields may cross into
    // the domain TokenUsage. Built fresh to avoid interference from other fixtures.
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
    // deepStrictEqual fails on any extra peripheral field in result.usage, so
    // this one assertion pins both invariants: "exactly 4 fields" and the
    // snake→camel translation.
    assert.deepEqual(result.usage, {
      inputTokens: 7,
      outputTokens: 2,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: null,
    });
  });

  it("畸形 usage(usage:{} / input_tokens 非 number)→ result.usage 字段缺席(不产垃圾对象)", async () => {
    // Postel: usage present but malformed → the whole field is absent; never
    // emit an {inputTokens: undefined,...} object that violates the TokenUsage contract.
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

    // non-number input_tokens → absent as well.
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

    // non-number cache fields normalize to null rather than passing through garbage / undefined.
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
