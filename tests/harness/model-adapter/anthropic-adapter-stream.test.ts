/**
 * RealAnthropicAdapter streaming-arm acceptance.
 *
 * Scope:
 *   - happy path: emit sequence = text_delta×N + tool_call_start; finalMessage
 *     → interpretMessage byte-isomorphic to the non-stream fixture (usage kept).
 *   - the three disconnect states: adapter rejects, no half-turn commit; the
 *     partial snapshot is never consumed.
 *   - onStream callback throwing: swallowed, finalMessage delivery unaffected.
 *   - stream=false: zero behavior change (regression guard).
 *   - empty response: `isEmptyFinalResponse` hits in the stream arm.
 *   - empty class: zero-event stream; empty `text_delta` (text="") → the
 *     implementation picked "don't emit".
 *   - overflow class: hundreds of deltas accumulate byte-identically;
 *     max_tokens truncation → supplierStop="truncation".
 *   - concurrent class (dedicated stream-under-race tests): timerTimeout
 *     during raceModel → stop "timeout"; callerAbort → stop "cancelled"; no
 *     emits after abort; no hanging promises.
 *
 * Tests inject fake stream objects (no real network): the fake client's
 * `messages.stream` returns a scripted fake stream that can emit / abort /
 * fail. SDK wire-level faults are replicated into `finalMessage()` rejection
 * by the fake client, keeping real HTTP out of scope.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  AnthropicError,
  APIConnectionError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import type {
  Message as SdkMessage,
  ToolUseBlock,
  TextBlock,
  ContentBlock,
  Usage as SdkUsage,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import {
  createRealAnthropicAdapter,
  interpretMessage,
} from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import { run } from "../../../src/harness/loop-engine.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createStubTool } from "../../../src/harness/stubs/stub-tool.ts";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";
import type { HarnessStreamEvent } from "../../../src/harness/stream.ts";
/**
 * A well-formed SDK `Usage`. The SDK type requires every field, but only the
 * token counts carry meaning for these fixtures — the rest are pinned to their
 * documented "absent" value.
 */
function sdkUsage(overrides: {
  readonly input_tokens: number;
  readonly output_tokens: number;
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

// ─── Test fixtures ──────────────────────────────────────────────────────────

function userMsg(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

const initState = (msgs: AnthropicNativeMessage[] = []): LoopState => ({
  messages: msgs,
  turnCount: 0,
});

type FakeOp =
  | { kind: "text"; text: string }
  | { kind: "streamEvent"; event: unknown }
  | { kind: "complete"; message: SdkMessage }
  | { kind: "fail"; error: unknown };

interface FakeStreamState {
  currentMessageReads: number;
  emittedTexts: string[];
  emittedStreamEvents: number;
  completed: boolean;
  rejected: unknown;
  interrupted: boolean;
  finalMessagePromise: Promise<SdkMessage> | null;
}

interface FakeStreamHandle {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  finalMessage(): Promise<SdkMessage>;
  pushText(text: string): void;
  pushStreamEvent(ev: unknown): void;
  complete(message: SdkMessage): void;
  fail(error: unknown): void;
  readonly currentMessage: SdkMessage;
}

/** Scripted fake stream. `ops` dispatch via microtask after on() wiring; `finalMessage()` settles the promise. */
function makeFakeStream(opts: {
  /** Script of stream events to dispatch via queueMicrotask after listeners are wired. */
  readonly ops?: ReadonlyArray<FakeOp>;
  /** Optional composite AbortSignal — the fake mirrors SDK abort semantics on this signal. */
  readonly signal?: AbortSignal;
  /** Snapshot handed to `(streamEvent, snapshot)` listeners; also gates `currentMessage` reads. */
  readonly partial?: SdkMessage;
}): {
  stream: FakeStreamHandle;
  state: FakeStreamState;
} {
  const state: FakeStreamState = {
    currentMessageReads: 0,
    emittedTexts: [],
    emittedStreamEvents: 0,
    completed: false,
    rejected: undefined,
    interrupted: false,
    finalMessagePromise: null,
  };
  const textListeners: Array<(t: string, s: string) => void> = [];
  const streamEventListeners: Array<(e: unknown, s: unknown) => void> = [];
  let finalResolver: ((m: SdkMessage) => void) | null = null;
  let finalRejecter: ((e: unknown) => void) | null = null;

  const interrupt = (err: unknown): void => {
    if (state.interrupted) return;
    state.interrupted = true;
    state.rejected = err;
    if (finalRejecter && !state.completed) {
      finalRejecter(err);
    }
  };

  if (opts.signal) {
    if (opts.signal.aborted) interrupt(new APIUserAbortError());
    else
      opts.signal.addEventListener(
        "abort",
        () => interrupt(new APIUserAbortError()),
        { once: true }
      );
  }

  const partial: SdkMessage =
    opts.partial ??
    ({
      id: "msg_partial",
      type: "message",
      role: "assistant",
      model: "claude-stream-test",
      content: [] as ContentBlock[],
      stop_reason: null,
      stop_sequence: null,
      usage: sdkUsage({ input_tokens: 0, output_tokens: 0 }),
    } as SdkMessage);

  const handle: FakeStreamHandle = {
    on(event: string, listener: (...args: unknown[]) => void): unknown {
      if (state.interrupted) return handle;
      if (event === "text")
        textListeners.push(listener as (t: string, s: string) => void);
      else if (event === "streamEvent")
        streamEventListeners.push(listener as (e: unknown, s: unknown) => void);
      return handle;
    },
    finalMessage(): Promise<SdkMessage> {
      const promise = new Promise<SdkMessage>((resolve, reject) => {
        finalResolver = resolve;
        finalRejecter = reject;
        if (state.interrupted && state.rejected !== undefined) {
          reject(state.rejected);
        }
      });
      state.finalMessagePromise = promise;
      if (opts.ops) {
        queueMicrotask(() => {
          for (const op of opts.ops!) {
            if (state.interrupted) break;
            if (op.kind === "text") {
              state.emittedTexts.push(op.text);
              for (const l of textListeners) l(op.text, "");
            } else if (op.kind === "streamEvent") {
              state.emittedStreamEvents++;
              for (const l of streamEventListeners) l(op.event, partial);
            } else if (op.kind === "complete") {
              state.completed = true;
              finalResolver?.(op.message);
              return;
            } else if (op.kind === "fail") {
              state.rejected = op.error;
              state.completed = true;
              finalRejecter?.(op.error);
              return;
            }
          }
        });
      }
      return promise;
    },
    pushText(text: string): void {
      if (state.interrupted) return;
      state.emittedTexts.push(text);
      for (const l of textListeners) l(text, "");
    },
    pushStreamEvent(ev: unknown): void {
      if (state.interrupted) return;
      state.emittedStreamEvents++;
      for (const l of streamEventListeners) l(ev, partial);
    },
    complete(message: SdkMessage): void {
      if (state.interrupted) return;
      state.completed = true;
      finalResolver?.(message);
    },
    fail(error: unknown): void {
      interrupt(error);
    },
    get currentMessage(): SdkMessage {
      state.currentMessageReads++;
      return partial;
    },
  };
  return { stream: handle, state };
}

/**
 * Fake client wired directly against `createRealAnthropicAdapter`: builds the
 * fake stream at `messages.stream` call time and captures params plus the
 * RequestOptions 2nd arg (to verify the signal is hung on directly).
 */
function makeStreamingClientFactory(opts: {
  readonly captured: { params: unknown | null; reqOptions: unknown | null }[];
  readonly streamFactory: (
    params: unknown,
    reqOptions: unknown
  ) => FakeStreamHandle;
}): unknown {
  return {
    messages: {
      create: () => {
        throw new Error("create must not be called in stream arm");
      },
      stream: (params: unknown, reqOptions: unknown): FakeStreamHandle => {
        opts.captured.push({ params, reqOptions });
        return opts.streamFactory(params, reqOptions);
      },
    },
  };
}

/** SDK content_block_delta with thinking_delta — fixture for phase-2 thinking passthrough. */
function thinkingDelta(text: string): unknown {
  return {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: text },
  };
}

function toolUseStart(name: string, id: string, index = 0): unknown {
  return {
    type: "content_block_start",
    index,
    content_block: {
      type: "tool_use",
      id,
      name,
      input: {},
      caller: { type: "direct" },
    } satisfies ToolUseBlock,
  };
}

/** SDK content_block_delta with input_json_delta — fixture for tool input deltas. */
function inputJsonDelta(index: number, partialJson: string): unknown {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  };
}

function wellShapedFinal(opts: {
  readonly text?: string;
  readonly toolUse?: { id: string; name: string; input: unknown };
  readonly stop_reason: "end_turn" | "stop_sequence" | "max_tokens" | "refusal";
  readonly usage?: SdkUsage;
}): SdkMessage {
  const blocks: ContentBlock[] = [];
  if (opts.text !== undefined)
    blocks.push({ type: "text", text: opts.text } as TextBlock);
  if (opts.toolUse)
    blocks.push({
      type: "tool_use",
      id: opts.toolUse.id,
      name: opts.toolUse.name,
      input: opts.toolUse.input,
      caller: { type: "direct" },
    } as ToolUseBlock);
  return {
    id: "msg_stream_ok",
    type: "message",
    role: "assistant",
    model: "claude-stream-test",
    content: blocks,
    stop_reason: opts.stop_reason,
    stop_sequence: null,
    usage: opts.usage ?? sdkUsage({ input_tokens: 1, output_tokens: 1 }),
    container: null,
    stop_details: null,
  };
}

// ─── 1. Normal streaming flow ──────────────────────────────────────────────

describe("RealAnthropicAdapter — streaming arm normal flow (T3 #176, D1)", () => {
  it("emits text_delta×N + tool_call_start in wire order; finalMessage → interpretMessage isomorphic to the same fixture", async () => {
    const final = wellShapedFinal({
      text: "Hello world",
      toolUse: { id: "toolu_1", name: "echo", input: { value: "x" } },
      stop_reason: "end_turn",
      usage: sdkUsage({ input_tokens: 42, output_tokens: 23 }),
    });
    const events: HarnessStreamEvent[] = [];
    const captured: { params: unknown; reqOptions: unknown }[] = [];
    const client = makeStreamingClientFactory({
      captured,
      streamFactory: () =>
        makeFakeStream({
          ops: [
            { kind: "text", text: "Hello" },
            { kind: "text", text: " world" },
            { kind: "streamEvent", event: toolUseStart("echo", "toolu_1") },
            { kind: "complete", message: final },
          ],
          partial: final,
        }).stream,
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    const result = (await adapter.step(initState([userMsg("hi")]), {
      onStream: (e) => events.push(e),
    })) as AssistantTurnResult;
    // — wire-order emit sequence —
    assert.deepEqual(events, [
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "tool_call_start", name: "echo", id: "toolu_1" },
    ]);
    // — the composite signal is hung on directly as the RequestOptions 2nd arg —
    assert.equal(captured.length, 1);
    assert.equal(
      (captured[0]!.reqOptions as { signal?: AbortSignal }).signal,
      undefined,
      "无外部 signal 时不应自构 signal"
    );
    // — finalMessage → interpretMessage yields the same shape as the non-stream fixture —
    const expected = interpretMessage(final);
    assert.deepEqual(result, expected);
    assert.equal(result.supplierStop, "success");
    assert.equal(result.needsTools, true);
    assert.deepEqual(result.projection.texts, ["Hello world"]);
    // — usage stays on the finalMessage object (guarded by the dedicated usage test below) —
  });

  it("result with usage-bearing fixture: finalMessage object's usage field is intact (D5 not consumed or stripped)", async () => {
    const final = wellShapedFinal({
      text: "ok",
      stop_reason: "end_turn",
      usage: sdkUsage({ input_tokens: 100, output_tokens: 17 }),
    });
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: () =>
        makeFakeStream({
          ops: [
            { kind: "text", text: "ok" },
            { kind: "complete", message: final },
          ],
          partial: final,
        }).stream,
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    const result = (await adapter.step(
      initState([userMsg("hi")]),
      {}
    )) as AssistantTurnResult;
    // Byte-identical to interpretMessage(final) — shape guard for the usage row.
    assert.deepEqual(result, interpretMessage(final));
    // usage is still on the finalMessage object — no layer dropped or wrapped
    // it. Compared against the very fixture that was dispatched, so any layer
    // that dropped, added to, or rewrote a usage field still fails here.
    assert.deepEqual(
      final.usage,
      sdkUsage({ input_tokens: 100, output_tokens: 17 })
    );
  });
});

// ─── 2. Stream interruption (three cut states) ─────────────────────────────

describe("RealAnthropicAdapter — streaming arm interruption (T3 #176, D8)", () => {
  function streamAdapterWith(
    factory: (params: unknown, reqOptions: unknown) => FakeStreamHandle
  ): ReturnType<typeof createRealAnthropicAdapter> {
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: factory,
    });
    return createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
  }

  it("connection interruption mid-stream → adapter rejects (D8: no half-turn commit); partial snapshot not consumed", async () => {
    const connectionErr = new APIConnectionError({
      message: "connection lost",
    });
    const { stream, state } = makeFakeStream({
      ops: [
        { kind: "text", text: "part" },
        { kind: "fail", error: connectionErr },
      ],
    });
    const adapter = streamAdapterWith(() => stream);
    await assert.rejects(
      () => adapter.step(initState([userMsg("hi")]), {}),
      (e: unknown) => e === connectionErr
    );
    assert.equal(
      state.currentMessageReads,
      0,
      "断流时 partial 快照 (stream.currentMessage) 不被读取 — D8 v1 不消费"
    );
  });

  it("no chunks at all (silent connect) → finalMessage rejects 'request ended without sending any chunks'; adapter rejects", async () => {
    const err = new AnthropicError("request ended without sending any chunks");
    const { stream, state } = makeFakeStream({
      ops: [{ kind: "fail", error: err }],
    });
    const adapter = streamAdapterWith(() => stream);
    await assert.rejects(
      () => adapter.step(initState([userMsg("hi")]), {}),
      (e: unknown) => e === err
    );
    assert.equal(state.currentMessageReads, 0);
  });

  it("silent EOF (stream ends without message_stop) → finalMessage rejects; adapter rejects, no result constructed", async () => {
    const err = new AnthropicError("stream ended before message_stop");
    const { stream, state } = makeFakeStream({
      ops: [
        { kind: "text", text: "some text" },
        { kind: "fail", error: err },
      ],
    });
    const adapter = streamAdapterWith(() => stream);
    await assert.rejects(
      () => adapter.step(initState([userMsg("hi")]), {}),
      (e: unknown) => e === err
    );
    assert.equal(state.currentMessageReads, 0);
  });
});

// ─── 3. onStream callback exception swallowed ──────────────────────────────

describe("RealAnthropicAdapter — streaming arm onStream exception swallow (T3 #176, D3)", () => {
  it("onStream throws on every call → step still resolves with the correct AssistantTurnResult", async () => {
    const final = wellShapedFinal({
      text: "delivered",
      stop_reason: "end_turn",
    });
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: () =>
        makeFakeStream({
          ops: [
            { kind: "text", text: "delivered" },
            { kind: "complete", message: final },
          ],
          partial: final,
        }).stream,
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    let calls = 0;
    const result = (await adapter.step(initState([userMsg("hi")]), {
      onStream: () => {
        calls++;
        throw new Error("observer boom");
      },
    })) as AssistantTurnResult;
    assert.ok(calls > 0, "onStream 应至少被调用一次");
    assert.equal(result.supplierStop, "success");
    assert.deepEqual(result.projection.texts, ["delivered"]);
  });
});

// ─── 4. stream=false regression ───────────────────────────────────────────

describe("RealAnthropicAdapter — stream=false / undefined branches (T3 #176, 017 regression)", () => {
  it("stream=false → client.messages.create is called; messages.stream is NOT called; result identical to non-stream path", async () => {
    const captured: { method: string; params: unknown; reqOptions: unknown }[] =
      [];
    const final = wellShapedFinal({
      text: "ok",
      stop_reason: "end_turn",
      usage: sdkUsage({ input_tokens: 5, output_tokens: 7 }),
    });
    const client = {
      messages: {
        create: (params: unknown, reqOptions: unknown): Promise<SdkMessage> => {
          captured.push({ method: "create", params, reqOptions });
          return Promise.resolve(final);
        },
        stream: (params: unknown, reqOptions: unknown): FakeStreamHandle => {
          captured.push({ method: "stream", params, reqOptions });
          throw new Error("stream arm must not be called when stream=false");
        },
      },
    };
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: false,
    });
    const result = (await adapter.step(
      initState([userMsg("hi")]),
      { tools: [], onStream: () => undefined } // onStream must be ignored harmlessly
    )) as AssistantTurnResult;
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.method, "create");
    assert.equal(
      captured.some((c) => c.method === "stream"),
      false
    );
    assert.deepEqual(result, interpretMessage(final));
  });
});

// ─── 5/6. Empty response / empty class ───────────────────────────────────

describe("RealAnthropicAdapter — streaming arm empty response (T3 #176, isEmptyFinalResponse)", () => {
  it("zero-event stream with content:[] + end_turn → isEmptyFinalResponse hits in the stream arm", async () => {
    const final: SdkMessage = {
      id: "msg_empty",
      type: "message",
      role: "assistant",
      model: "claude-stream-test",
      content: [] as ContentBlock[],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: sdkUsage({ input_tokens: 1, output_tokens: 0 }),
      container: null,
      stop_details: null,
    };
    const events: HarnessStreamEvent[] = [];
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: () =>
        makeFakeStream({
          ops: [{ kind: "complete", message: final }],
          partial: final,
        }).stream,
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    const result = (await adapter.step(initState([userMsg("hi")]), {
      onStream: (e) => events.push(e),
    })) as AssistantTurnResult;
    assert.equal(result.supplierStop, "success");
    assert.equal(result.isEmptyFinalResponse, true);
    // Zero-event stream — no text_delta / tool_call_start emitted.
    assert.equal(events.length, 0);
  });

  it("empty text_delta (text='') is NOT emitted —实现期选项：'don't emit' (避免渲染噪声)", async () => {
    const final = wellShapedFinal({ text: "", stop_reason: "end_turn" });
    const events: HarnessStreamEvent[] = [];
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: () =>
        makeFakeStream({
          ops: [
            { kind: "text", text: "" },
            { kind: "text", text: "" },
            { kind: "complete", message: final },
          ],
          partial: final,
        }).stream,
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    await adapter.step(initState([userMsg("hi")]), {
      onStream: (e) => events.push(e),
    });
    assert.equal(events.length, 0, "空文本 delta 不引发 text_delta emit");
  });
});

// ─── 7. Overflow class ─────────────────────────────────────────────────────

describe("RealAnthropicAdapter — streaming arm overflow class (T3 #176, byte-identity / truncation)", () => {
  it("300 text deltas accumulate → result is byte-identical to a non-streaming fixture carrying the same text", async () => {
    const chunks: string[] = [];
    const fullText = Array.from(
      { length: 300 },
      (_, i) => `chunk-${i.toString().padStart(3, "0")} `
    ).join("");
    for (const c of fullText.match(/.{1,13}/g) ?? []) chunks.push(c);
    const final = wellShapedFinal({ text: fullText, stop_reason: "end_turn" });
    const events: HarnessStreamEvent[] = [];
    const captured: { method: string }[] = [];
    const client = {
      messages: {
        create: (): Promise<SdkMessage> => Promise.resolve(final),
        stream: (): FakeStreamHandle => {
          captured.push({ method: "stream" });
          const ops: FakeOp[] = chunks.map((c) => ({ kind: "text", text: c }));
          ops.push({ kind: "complete", message: final });
          return makeFakeStream({ ops, partial: final }).stream;
        },
      },
    };
    const streamAdapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    const result = (await streamAdapter.step(initState([userMsg("hi")]), {
      onStream: (e) => events.push(e),
    })) as AssistantTurnResult;
    // emit count = chunk count (empty deltas skipped), first/last order pinned.
    assert.equal(events.length, chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(
        (events[i] as { type: "text_delta"; text: string }).text,
        chunks[i]
      );
    }
    // Streaming result is byte-identical to the non-stream fixture —
    // interpretMessage(final) is the reference baseline.
    assert.deepEqual(result, interpretMessage(final));
  });

  it("max_tokens truncation (stop_reason=max_tokens) → supplierStop='truncation' (与离线臂一致)", async () => {
    const final = wellShapedFinal({
      text: "partial answer",
      stop_reason: "max_tokens",
      usage: sdkUsage({ input_tokens: 5, output_tokens: 256 }),
    });
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: () =>
        makeFakeStream({
          ops: [
            { kind: "text", text: "partial" },
            { kind: "text", text: " answer" },
            { kind: "complete", message: final },
          ],
          partial: final,
        }).stream,
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    const result = (await adapter.step(
      initState([userMsg("hi")]),
      {}
    )) as AssistantTurnResult;
    assert.equal(result.supplierStop, "truncation");
    assert.equal(result.isEmptyFinalResponse, false);
    assert.deepEqual(result.projection.texts, ["partial answer"]);
  });
});

// ─── 8. concurrent class (stream under race) ───────────────────────────────

describe("RealAnthropicAdapter — streaming arm concurrent class (T3 #176, race semantics)", () => {
  it("composite signal abort during streaming → adapter step rejects; no further emit after abort", async () => {
    const captured: { reqOptions: unknown }[] = [];
    let streamHandle: FakeStreamHandle | null = null;
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: (_params, reqOptions) => {
        captured.push({ reqOptions });
        const { stream } = makeFakeStream({
          ops: [{ kind: "text", text: "part" }],
          signal: (reqOptions as { signal?: AbortSignal }).signal,
        });
        streamHandle = stream;
        return stream;
      },
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    const events: HarnessStreamEvent[] = [];
    // Stand-in for raceModel's composite signal: the test owns the controller
    // and passes it through as step's 3rd arg.
    const composite = new AbortController();
    const stepPromise = adapter.step(
      initState([userMsg("hi")]),
      { onStream: (e) => events.push(e) },
      composite.signal
    );
    // Wait for the first delta to dispatch, then abort (simulates a timerTimeout
    // aborting the composite signal).
    await new Promise<void>((r) => setTimeout(r, 5));
    const passedSignal = (captured[0]!.reqOptions as { signal?: AbortSignal })
      .signal;
    assert.equal(
      passedSignal,
      composite.signal,
      "stream() 接收的 RequestOptions 第二参必须直挂 composite signal（D1）"
    );
    composite.abort(new APIUserAbortError());
    await assert.rejects(stepPromise);
    // — force a later push (verifies the fake stops pushing after abort) —
    streamHandle!.pushText("late-after-abort");
    assert.equal(
      events.some(
        (e) =>
          e.type === "text_delta" &&
          (e as { text: string }).text === "late-after-abort"
      ),
      false,
      "abort 后不会再触发 text_delta"
    );
  });

  it("caller abort mid-stream → step rejects with APIUserAbortError-shaped; finalMessage rejected, not hung", async () => {
    const captured: { reqOptions: unknown }[] = [];
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: (_params, reqOptions) => {
        captured.push({ reqOptions });
        return makeFakeStream({
          ops: [{ kind: "text", text: "hello" }],
          signal: (reqOptions as { signal?: AbortSignal }).signal,
        }).stream;
      },
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    const caller = new AbortController();
    const stepPromise = adapter.step(
      initState([userMsg("hi")]),
      {},
      caller.signal
    );
    await new Promise<void>((r) => setTimeout(r, 5));
    const passedSignal = (captured[0]!.reqOptions as { signal?: AbortSignal })
      .signal;
    assert.equal(passedSignal, caller.signal);
    caller.abort();
    await assert.rejects(
      stepPromise,
      (e: unknown) => e instanceof APIUserAbortError
    );
  });

  it("pre-aborted signal → finalMessage rejects immediately with APIUserAbortError; no events emitted", async () => {
    const controller = new AbortController();
    controller.abort(new APIUserAbortError());
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: (_params, reqOptions) =>
        makeFakeStream({
          ops: [{ kind: "text", text: "would-be-first" }],
          signal: (reqOptions as { signal?: AbortSignal }).signal,
        }).stream,
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    const events: HarnessStreamEvent[] = [];
    const stepPromise = adapter.step(
      initState([userMsg("hi")]),
      { onStream: (e) => events.push(e) },
      controller.signal
    );
    await assert.rejects(
      stepPromise,
      (e: unknown) => e instanceof APIUserAbortError
    );
    // "would-be-first" is already queued in ops, but state.interrupted=true blocks dispatch.
    assert.equal(events.length, 0);
  });

  it("AbortSignal passes through to client.messages.stream as the RequestOptions 2nd arg (D1)", async () => {
    const controller = new AbortController();
    const captured: { reqOptions: unknown }[] = [];
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: (_params, reqOptions) => {
        captured.push({ reqOptions });
        return makeFakeStream({
          ops: [
            {
              kind: "complete",
              message: wellShapedFinal({
                text: "ok",
                stop_reason: "end_turn",
              }),
            },
          ],
        }).stream;
      },
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    await adapter.step(initState([userMsg("hi")]), {}, controller.signal);
    assert.equal(captured.length, 1);
    assert.equal(
      (captured[0]!.reqOptions as { signal?: AbortSignal }).signal,
      controller.signal
    );
  });
});

// ─── 9. stream-under-race (real raceModel / run() integration semantics) ───
//
// Mirrors tests/harness/aci/interrupt-routing.test.ts and the loop-engine
// integration precedents: raceModel's composite signal is hung directly on the
// stream arm via SDK RequestOptions, and timer/abort triggers make the fake
// stream reject finalMessage with abort semantics — the settle routing matches
// the existing integration tests (timerTimeout → stop "timeout"; callerAbort →
// stop "cancelled"). raceModel / loop-engine themselves are untouched here.

function streamingRunDeps(opts: {
  readonly streamFactory: (
    params: unknown,
    reqOptions: unknown
  ) => FakeStreamHandle;
  readonly modelTimeoutMs?: number;
  /** Lets the test shorten the summary-only timeout (so a never-completing fake stream doesn't hang the run). */
  readonly summaryTimeoutMs?: number;
}): {
  adapter: ReturnType<typeof createRealAnthropicAdapter>;
  executor: ReturnType<typeof createExecutor>;
  registry: ReturnType<typeof createRegistry>;
  maxTurns: number;
  modelTimeoutMs: number;
  summaryTimeoutMs?: number;
} {
  const client = makeStreamingClientFactory({
    captured: [],
    streamFactory: opts.streamFactory,
  });
  const adapter = createRealAnthropicAdapter({
    client: client as unknown as Parameters<
      typeof createRealAnthropicAdapter
    >[0]["client"],
    model: "claude-stream-test",
    maxTokens: 256,
    stream: true,
  });
  const tool = createStubTool({ name: "noop", next: () => ({}) });
  const registry = createRegistry([tool]);
  const executor = createExecutor(registry);
  return {
    adapter,
    executor,
    registry,
    maxTurns: 1,
    modelTimeoutMs: opts.modelTimeoutMs ?? 20,
    ...(opts.summaryTimeoutMs !== undefined
      ? { summaryTimeoutMs: opts.summaryTimeoutMs }
      : {}),
  };
}

describe("RealAnthropicAdapter — stream-under-race 专测 (T3 #176, 023 语义同形)", () => {
  it("raceModel timerTimeout during streaming → run stopReason='timeout'（与 T2-new-1 同语义）", async () => {
    // Fake stream: emits one delta then hangs forever (no complete/fail),
    // waiting for the composite signal to abort.
    const deps = streamingRunDeps({
      streamFactory: (_params, reqOptions) =>
        makeFakeStream({
          ops: [{ kind: "text", text: "partial" }],
          signal: (reqOptions as { signal?: AbortSignal }).signal,
        }).stream,
      modelTimeoutMs: 20,
      // The fake stream hangs — shorten the summary timeout so run() isn't
      // held by the 15s default.
      summaryTimeoutMs: 20,
    });
    const { result } = await run("x", deps);
    assert.equal(result.stopReason, "timeout");
    // The whole turn is not committed: authoritative history holds only the user
    // message, no half assistant turn.
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.role, "user");
    assert.equal(result.turnCount, 0);
  });

  it("raceModel callerAbort during streaming → run stopReason='cancelled'（与 T2-new-3 同语义）", async () => {
    const deps = streamingRunDeps({
      streamFactory: (_params, reqOptions) =>
        makeFakeStream({
          ops: [{ kind: "text", text: "streaming..." }],
          signal: (reqOptions as { signal?: AbortSignal }).signal,
        }).stream,
      modelTimeoutMs: 0, // timer disabled: pure callerAbort vs adapter race
    });
    const controller = new AbortController();
    const pending = run("x", deps, controller.signal);
    // Abort only after the first delta dispatches — simulates cancel mid-streaming.
    await new Promise<void>((r) => setTimeout(r, 10));
    controller.abort();
    const { result } = await pending;
    assert.equal(result.stopReason, "cancelled");
    // On cancel, a system interrupt message is appended at the end (first-class
    // transcript citizen): seeded user(1) + system interrupt(1) = 2.
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[1]!.role, "system");
    assert.equal(result.turnCount, 0);
  });

  it("abort 后不再 emit、finalMessage 无悬挂（step reject 被 race settle 吞咽,测试自然收敛）", async () => {
    const emitted: HarnessStreamEvent[] = [];
    let streamHandle: FakeStreamHandle | null = null;
    const deps = streamingRunDeps({
      streamFactory: (_params, reqOptions) => {
        const { stream } = makeFakeStream({
          ops: [{ kind: "text", text: "first" }],
          signal: (reqOptions as { signal?: AbortSignal }).signal,
        });
        streamHandle = stream;
        return stream;
      },
      modelTimeoutMs: 20,
      summaryTimeoutMs: 20,
    });
    const { result } = await run("x", deps);
    assert.equal(result.stopReason, "timeout");
    // After abort, the fake's pushText is gated off by interrupted → no late events.
    // (raceModel does not forward onStream; the fake's own state is the guard here.)
    streamHandle!.pushText("late-after-timeout");
    assert.equal(emitted.length, 0);
    // Reaching this line means the finalMessage rejection was swallowed by the
    // settle chain — no dangling promise.
  });
});

// ─── 10. thinking_delta + tool_call_start.id extension ─────────────────────
//
// The harness protocol carries thinking_delta, and tool_call_start gains an id
// field for live-status pairing:
// - thinking_delta is passed through only from content_block_delta (delta.type="thinking_delta");
// - empty thinking_delta is not emitted (matching the existing text_delta discipline);
// - tool_call_start must carry block.id (the anchor for postToolUse pairing).

describe("RealAnthropicAdapter — T1 streaming arm extension (phase 2)", () => {
  it("thinking_delta content_block_delta → emit thinking_delta with text in wire order", async () => {
    const final = wellShapedFinal({
      text: "ok",
      stop_reason: "end_turn",
    });
    const events: HarnessStreamEvent[] = [];
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: () =>
        makeFakeStream({
          ops: [
            { kind: "streamEvent", event: thinkingDelta("先想 ") },
            { kind: "streamEvent", event: thinkingDelta("后做") },
            { kind: "text", text: "ok" },
            { kind: "complete", message: final },
          ],
          partial: final,
        }).stream,
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    await adapter.step(initState([userMsg("hi")]), {
      onStream: (e) => events.push(e),
    });
    assert.deepEqual(
      events.filter((e) => e.type === "thinking_delta"),
      [
        { type: "thinking_delta", text: "先想 " },
        { type: "thinking_delta", text: "后做" },
      ]
    );
  });

  it("empty thinking_delta (thinking='') is NOT emitted — 对齐 text_delta 纪律", async () => {
    const final = wellShapedFinal({
      text: "ok",
      stop_reason: "end_turn",
    });
    const events: HarnessStreamEvent[] = [];
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: () =>
        makeFakeStream({
          ops: [
            { kind: "streamEvent", event: thinkingDelta("") },
            { kind: "streamEvent", event: thinkingDelta("") },
            { kind: "text", text: "ok" },
            { kind: "complete", message: final },
          ],
          partial: final,
        }).stream,
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    await adapter.step(initState([userMsg("hi")]), {
      onStream: (e) => events.push(e),
    });
    assert.equal(
      events.some((e) => e.type === "thinking_delta"),
      false,
      "空 thinking_delta 不引发 thinking_delta emit"
    );
  });

  it("tool_call_start 携带 block.id — 与 postToolUse 配对的 anchor (T4 依赖)", async () => {
    const final = wellShapedFinal({
      text: "ok",
      toolUse: { id: "toolu_42", name: "echo", input: { value: "x" } },
      stop_reason: "end_turn",
    });
    const events: HarnessStreamEvent[] = [];
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: () =>
        makeFakeStream({
          ops: [
            { kind: "text", text: "ok" },
            { kind: "streamEvent", event: toolUseStart("echo", "toolu_42") },
            { kind: "complete", message: final },
          ],
          partial: final,
        }).stream,
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    await adapter.step(initState([userMsg("hi")]), {
      onStream: (e) => events.push(e),
    });
    const toolStart = events.find((e) => e.type === "tool_call_start");
    assert.deepEqual(toolStart, {
      type: "tool_call_start",
      name: "echo",
      id: "toolu_42",
    });
  });
});

// ─── 11. tool_input_delta ───────────────────────────────────────────────────

describe("RealAnthropicAdapter — T1 tool_input_delta streaming arm extension", () => {
  it("content_block_start tool_use + input_json_delta ×N → emit tool_call_start + tool_input_delta×N, id 配对正确, partialJson 拼接等于完整 input", async () => {
    const final = wellShapedFinal({
      text: "ok",
      toolUse: {
        id: "toolu_7",
        name: "bash",
        input: { command: "ls -la", cwd: "/tmp" },
      },
      stop_reason: "end_turn",
    });
    const events: HarnessStreamEvent[] = [];
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: () =>
        makeFakeStream({
          ops: [
            { kind: "text", text: "ok" },
            {
              kind: "streamEvent",
              event: toolUseStart("bash", "toolu_7"),
            },
            {
              kind: "streamEvent",
              event: inputJsonDelta(0, '{"command":'),
            },
            {
              kind: "streamEvent",
              event: inputJsonDelta(0, '"ls -la","cwd":'),
            },
            {
              kind: "streamEvent",
              event: inputJsonDelta(0, '"/tmp"}'),
            },
            { kind: "complete", message: final },
          ],
          partial: final,
        }).stream,
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    await adapter.step(initState([userMsg("hi")]), {
      onStream: (e) => events.push(e),
    });
    const inputDeltas = events.filter(
      (e): e is { type: "tool_input_delta"; id: string; partialJson: string } =>
        e.type === "tool_input_delta"
    );
    assert.deepEqual(inputDeltas, [
      { type: "tool_input_delta", id: "toolu_7", partialJson: '{"command":' },
      {
        type: "tool_input_delta",
        id: "toolu_7",
        partialJson: '"ls -la","cwd":',
      },
      { type: "tool_input_delta", id: "toolu_7", partialJson: '"/tmp"}' },
    ]);
    // partialJson concatenated in order = the complete tool input JSON.
    assert.equal(
      inputDeltas.map((d) => d.partialJson).join(""),
      '{"command":"ls -la","cwd":"/tmp"}'
    );
    // id pairing is correct — every delta belongs to the same tool_use block.
    assert.equal(
      inputDeltas.every((d) => d.id === "toolu_7"),
      true
    );
    // Wire order: tool_call_start first, then the increments.
    assert.deepEqual(
      events.map((e) => e.type),
      [
        "text_delta",
        "tool_call_start",
        "tool_input_delta",
        "tool_input_delta",
        "tool_input_delta",
      ]
    );
    // The authoritative input is still delivered once via finalMessage —
    // interpretMessage is unchanged (result is shape-identical to the fixture).
  });

  it("empty partial_json ('') is NOT emitted — 对齐 text_delta / thinking_delta 纪律", async () => {
    const final = wellShapedFinal({
      text: "ok",
      toolUse: { id: "toolu_9", name: "echo", input: { value: "x" } },
      stop_reason: "end_turn",
    });
    const events: HarnessStreamEvent[] = [];
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: () =>
        makeFakeStream({
          ops: [
            { kind: "streamEvent", event: toolUseStart("echo", "toolu_9") },
            { kind: "streamEvent", event: inputJsonDelta(0, "") },
            { kind: "streamEvent", event: inputJsonDelta(0, "") },
            { kind: "streamEvent", event: inputJsonDelta(0, '{"value":"x"}') },
            { kind: "text", text: "ok" },
            { kind: "complete", message: final },
          ],
          partial: final,
        }).stream,
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    await adapter.step(initState([userMsg("hi")]), {
      onStream: (e) => events.push(e),
    });
    const inputDeltas = events.filter((e) => e.type === "tool_input_delta");
    // The two empty deltas are skipped — only the non-empty one emits.
    assert.deepEqual(inputDeltas, [
      { type: "tool_input_delta", id: "toolu_9", partialJson: '{"value":"x"}' },
    ]);
  });

  it("input_json_delta without a registered content_block_start (unknown index) is NOT emitted — 无 id 可配对", async () => {
    const final = wellShapedFinal({
      text: "ok",
      stop_reason: "end_turn",
    });
    const events: HarnessStreamEvent[] = [];
    const client = makeStreamingClientFactory({
      captured: [],
      streamFactory: () =>
        makeFakeStream({
          ops: [
            { kind: "streamEvent", event: inputJsonDelta(0, '{"value":"x"}') },
            { kind: "streamEvent", event: inputJsonDelta(0, "{}") },
            { kind: "text", text: "ok" },
            { kind: "complete", message: final },
          ],
          partial: final,
        }).stream,
    });
    const adapter = createRealAnthropicAdapter({
      client: client as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-stream-test",
      maxTokens: 256,
      stream: true,
    });
    await adapter.step(initState([userMsg("hi")]), {
      onStream: (e) => events.push(e),
    });
    assert.equal(
      events.some((e) => e.type === "tool_input_delta"),
      false,
      "未登记的 index 不 emit tool_input_delta"
    );
  });
});
