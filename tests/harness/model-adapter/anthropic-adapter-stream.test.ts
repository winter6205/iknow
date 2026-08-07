/**
 * #176 T3 (#147 D1/D3/D5/D8) — RealAnthropicAdapter streaming arm acceptance.
 *
 * 范围（plan §3）：
 *   - 正常流：emit 序列 = text_delta×N + tool_call_start；finalMessage → interpretMessage 与
 *     非流式 fixture 逐字节同形（usage 保留，D5 不丢）。
 *   - 断流三态：adapter reject，无整回合提交；partial 快照不消费。
 *   - onStream 回调抛异常：被吞咽，不影响 finalMessage 交付。
 *   - stream=false：既有行为零变化（回归保护）。
 *   - 空响应：`isEmptyFinalResponse` 流式命中。
 *   - empty 类：零事件流；空 `text_delta`（text=""）→ 实现期选中"不 emit"。
 *   - overflow 类：数百 delta 累积逐字节同形；max_tokens 截断 → supplierStop="truncation"。
 *   - concurrent 类（stream-under-race 专测）：raceModel 期间 timerTimeout → stop "timeout"；
 *     callerAbort → stop "cancelled"；abort 后不再 emit；无悬挂 promise。
 *
 * 测试用 inject 假 stream 对象（不依赖真实网络）：fake 客户端的 `messages.stream` 返回脚本化
 * 假 stream，可发 / 可中止 / 可失败。SDK 的 wire-level 异常 → 由 fake client 复刻到
 * `finalMessage()` reject，避免直接挂真实 HTTP（归 T6 端到端）。
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

/** 构造脚本化假流。`ops` 在 on() 装配完后通过 microtask 派发，`finalMessage()` 结算。 */
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
      usage: { input_tokens: 0, output_tokens: 0 },
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
 * 构造一个与 `createRealAnthropicAdapter` 直接对接的假客户端：在 `messages.stream` 调用时即造
 * 出假流，捕获 params + RequestOptions 2nd arg（用于验证 D1 signal 直挂）。
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

/** SDK content_block_delta with thinking_delta — 阶段二 T1 夹具。 */
function thinkingDelta(text: string): unknown {
  return {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: text },
  };
}

function toolUseStart(name: string, id: string): unknown {
  return {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      id,
      name,
      input: {},
    } satisfies ToolUseBlock as unknown as ToolUseBlock,
  };
}

function wellShapedFinal(opts: {
  readonly text?: string;
  readonly toolUse?: { id: string; name: string; input: unknown };
  readonly stop_reason: "end_turn" | "stop_sequence" | "max_tokens" | "refusal";
  readonly usage?: { input_tokens: number; output_tokens: number };
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
    } as ToolUseBlock);
  return {
    id: "msg_stream_ok",
    type: "message",
    role: "assistant",
    model: "claude-stream-test",
    content: blocks,
    stop_reason: opts.stop_reason,
    stop_sequence: null,
    usage: opts.usage ?? { input_tokens: 1, output_tokens: 1 },
  };
}

// ─── 1. Normal streaming flow ──────────────────────────────────────────────

describe("RealAnthropicAdapter — streaming arm normal flow (T3 #176, D1)", () => {
  it("emits text_delta×N + tool_call_start in wire order; finalMessage → interpretMessage isomorphic to the same fixture", async () => {
    const final = wellShapedFinal({
      text: "Hello world",
      toolUse: { id: "toolu_1", name: "echo", input: { value: "x" } },
      stop_reason: "end_turn",
      usage: { input_tokens: 42, output_tokens: 23 },
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
    // — signal 直挂 RequestOptions 第 2 参（D1） —
    assert.equal(captured.length, 1);
    assert.equal(
      (captured[0]!.reqOptions as { signal?: AbortSignal }).signal,
      undefined,
      "无外部 signal 时不应自构 signal"
    );
    // — finalMessage → interpretMessage 与非流式 fixture 同形 —
    const expected = interpretMessage(final);
    assert.deepEqual(result, expected);
    assert.equal(result.supplierStop, "success");
    assert.equal(result.needsTools, true);
    assert.deepEqual(result.projection.texts, ["Hello world"]);
    // — usage 字段保留在 finalMessage 上（D5，由下方 usage 专测守护）—
  });

  it("result with usage-bearing fixture: finalMessage object's usage field is intact (D5 not consumed or stripped)", async () => {
    const final = wellShapedFinal({
      text: "ok",
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 17 },
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
    // 字节同形等于 interpretMessage(final) — D5 行的形态护栏。
    assert.deepEqual(result, interpretMessage(final));
    // usage 字段仍在 finalMessage 上 — 未被任何一层丢弃或包装。
    assert.deepEqual(final.usage, { input_tokens: 100, output_tokens: 17 });
  });
});

// ─── 2. Stream interruption (断流三态) ─────────────────────────────────────

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
      usage: { input_tokens: 5, output_tokens: 7 },
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
      { tools: [], onStream: () => undefined } // onStream 必须无害忽略
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
      usage: { input_tokens: 1, output_tokens: 0 },
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
    // 零事件流 — 没有 text_delta / tool_call_start。
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
    // emit 次数 = chunk 数 (空 delta 被跳过后)，且首尾顺序明确。
    assert.equal(events.length, chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(
        (events[i] as { type: "text_delta"; text: string }).text,
        chunks[i]
      );
    }
    // 流式结果与非流式 fixture 逐字节同形 — 用 interpretMessage(final) 为参照基线。
    assert.deepEqual(result, interpretMessage(final));
  });

  it("max_tokens truncation (stop_reason=max_tokens) → supplierStop='truncation' (与离线臂一致)", async () => {
    const final = wellShapedFinal({
      text: "partial answer",
      stop_reason: "max_tokens",
      usage: { input_tokens: 5, output_tokens: 256 },
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
    // raceModel composite signal 的替身：测试自持 controller，step 第三参透传。
    const composite = new AbortController();
    const stepPromise = adapter.step(
      initState([userMsg("hi")]),
      { onStream: (e) => events.push(e) },
      composite.signal
    );
    // 等首条 delta 派发，然后 abort（模拟 timerTimeout：composite signal abort）。
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
    // — 后续强行 push（验证 fake 在 abort 后不再 push） —
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
    // ops 中 "would-be-first" 已入 queue 但 state.interrupted=true 阻止派发。
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

// ─── 9. stream-under-race 专测（真实 raceModel / run() 集成语义）─────────────
//
// 参照 tests/harness/aci/interrupt-routing.test.ts 与 loop-engine T2-new-* 先例：
// raceModel 的 composite signal 经 SDK RequestOptions 直挂 stream arm（D1），
// timer/abort 触发 → fake 流按 abort 语义 reject finalMessage → settle 路由与
// 023 既有集成测试同语义（timerTimeout → stop "timeout"；callerAbort → stop
// "cancelled"）。raceModel / loop-engine 本身零改动（T4/T5 的活）。

function streamingRunDeps(opts: {
  readonly streamFactory: (
    params: unknown,
    reqOptions: unknown
  ) => FakeStreamHandle;
  readonly modelTimeoutMs?: number;
}): {
  adapter: ReturnType<typeof createRealAnthropicAdapter>;
  executor: ReturnType<typeof createExecutor>;
  registry: ReturnType<typeof createRegistry>;
  maxTurns: number;
  modelTimeoutMs: number;
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
  };
}

describe("RealAnthropicAdapter — stream-under-race 专测 (T3 #176, 023 语义同形)", () => {
  it("raceModel timerTimeout during streaming → run stopReason='timeout'（与 T2-new-1 同语义）", async () => {
    // fake 流：发一条 delta 后永挂（无 complete/fail），等 composite signal abort。
    const deps = streamingRunDeps({
      streamFactory: (_params, reqOptions) =>
        makeFakeStream({
          ops: [{ kind: "text", text: "partial" }],
          signal: (reqOptions as { signal?: AbortSignal }).signal,
        }).stream,
      modelTimeoutMs: 20,
    });
    const { result } = await run("x", deps);
    assert.equal(result.stopReason, "timeout");
    // 整回合不提交：权威历史只有 user 消息，无 assistant 半回合（D8）。
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
      modelTimeoutMs: 0, // 关 timer，纯 callerAbort vs adapter 竞速
    });
    const controller = new AbortController();
    const pending = run("x", deps, controller.signal);
    // 等首条 delta 派发后再 abort — 模拟 streaming 期间取消。
    await new Promise<void>((r) => setTimeout(r, 10));
    controller.abort();
    const { result } = await pending;
    assert.equal(result.stopReason, "cancelled");
    assert.equal(result.messages.length, 1);
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
    });
    const { result } = await run("x", deps);
    assert.equal(result.stopReason, "timeout");
    // abort 之后 fake 的 pushText 被 interrupted 门挡住 → 不会有任何迟到事件。
    // （raceModel 不透传 onStream —— T4 的活；此处以 fake 状态守门。）
    streamHandle!.pushText("late-after-timeout");
    assert.equal(emitted.length, 0);
    // 测试能走到这里 = finalMessage reject 已被 settle 链吞咽,无悬挂 promise。
  });
});

// ─── 10. thinking_delta + tool_call_start.id (T1 阶段二扩展) ────────────────
//
// 阶段二 (plans/tui-stream-phase2.md T1): harness 协议扩 thinking_delta,
// tool_call_start 加 id 字段 (供 T4 实时状态配对)。
// - thinking_delta 仅从 content_block_delta (delta.type="thinking_delta") 透传;
// - 空 thinking_delta 不 emit (对齐 text_delta 既有纪律);
// - tool_call_start 必须带 block.id (anchor 给 postToolUse 配对)。

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
