/**
 * ADR-0111: adapter-layer typed translation of "upstream stream incomplete" +
 * fault-discrimination narrowing + SDK-shape sentinel.
 *
 * Invariants pinned (ADR-0111):
 * - Decision 1: when `finalMessage()` rejects with the SDK stream-cut shape
 *   (`AnthropicError('stream ended without producing a Message with role=assistant')`),
 *   what leaves the adapter boundary is `ModelStreamIncompleteError` (extends
 *   `ProtocolError`, carries `visible` + `cause`), never a bare Error;
 *   `visible` comes from the stream arm's "saw a non-empty visible delta" flag
 *   (set by non-empty text / thinking / input_json deltas; empty deltas and
 *   tool_call_start do not set it).
 * - Decision 3(a): `nonClockFaultOf` maps this class →
 *   `{kind:"stream_incomplete", visible}`, discriminated before the abort /
 *   HTTP / cert / network branches.
 * - Decision 4: the default branch narrows to genuinely unknown shapes and
 *   emits a console.warn diagnostic (name + message truncated ≤200, never
 *   stack / request body); known shapes never fall into default.
 * - Decision 1's three conditions: message shape + not an APIError + no
 *   network error in the cause chain (a real disconnect belongs to the
 *   `llm_network` retry cell — no double-labeling → not translated here).
 *
 * Assertion strength follows precedent: anthropic-adapter-stream.test.ts
 * (stream-cut reject case) and anthropic-adapter-prompt-too-long.test.ts
 * (fake client + finalMessage reject translation).
 */

import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import {
  AnthropicError,
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream.mjs";
import type { Message as SdkMessage } from "@anthropic-ai/sdk/resources/messages/messages.js";
import {
  createRealAnthropicAdapter,
  translateAnthropicTransportFault,
} from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import {
  ModelStreamIncompleteError,
  PromptTooLongError,
  ProtocolError,
} from "../../../src/harness/errors.ts";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";

const SDK_STREAM_INCOMPLETE_MESSAGE =
  "stream ended without producing a Message with role=assistant";

function userMsg(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

const initState = (
  msgs: AnthropicNativeMessage[] = [userMsg("hi")]
): LoopState => ({ messages: msgs, turnCount: 0 });

type SdkClient = Parameters<typeof createRealAnthropicAdapter>[0]["client"];

type FakeOp =
  | { kind: "text"; text: string }
  | { kind: "streamEvent"; event: unknown }
  | { kind: "fail"; error: unknown };

/**
 * Minimal fake streaming client (same streamClient technique as
 * anthropic-adapter-prompt-too-long.test.ts): `finalMessage()` rejects with
 * the given error; deltas in ops dispatch via microtask once listeners are
 * wired, driving the adapter's visible-delta flag.
 */
function streamClient(ops: ReadonlyArray<FakeOp>): SdkClient {
  return {
    messages: {
      create: (): never => {
        throw new Error("create must not be called in stream arm");
      },
      stream: () => {
        const textListeners: Array<(t: string, s: string) => void> = [];
        const eventListeners: Array<(e: unknown) => void> = [];
        let rejectFinal: ((e: unknown) => void) | null = null;
        const promise = new Promise<SdkMessage>((_resolve, reject) => {
          rejectFinal = reject;
        });
        queueMicrotask(() => {
          for (const op of ops) {
            if (op.kind === "text") {
              for (const l of textListeners) l(op.text, "");
            } else if (op.kind === "streamEvent") {
              for (const l of eventListeners) l(op.event);
            } else {
              rejectFinal?.(op.error);
            }
          }
        });
        return {
          on: (event: string, listener: (...args: unknown[]) => void) => {
            if (event === "text") {
              textListeners.push(listener as (t: string, s: string) => void);
            } else if (event === "streamEvent") {
              eventListeners.push(listener as (e: unknown) => void);
            }
          },
          finalMessage: () => promise,
        };
      },
    },
  } as unknown as SdkClient;
}

function streamAdapter(
  ops: ReadonlyArray<FakeOp>
): ReturnType<typeof createRealAnthropicAdapter> {
  return createRealAnthropicAdapter({
    client: streamClient(ops),
    model: "claude-test-model",
    maxTokens: 256,
    stream: true,
  });
}

function thinkingDelta(text: string): unknown {
  return {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: text },
  };
}

function inputJsonDelta(index: number, partialJson: string): unknown {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  };
}

function toolUseStart(name: string, id: string, index = 0): unknown {
  return {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input: {} },
  };
}

function sdkStreamIncompleteError(): AnthropicError {
  return new AnthropicError(SDK_STREAM_INCOMPLETE_MESSAGE);
}

// ─── 1. stream arm: SDK stream-cut shape → ModelStreamIncompleteError (visible routing) ─

describe("ModelStreamIncompleteError translation — stream arm (ADR-0111 D1)", () => {
  it("finalMessage rejects with SDK 断流形态, no delta → ModelStreamIncompleteError(visible=false), not bare Error", async () => {
    const adapter = streamAdapter([
      { kind: "fail", error: sdkStreamIncompleteError() },
    ]);
    await assert.rejects(
      () => adapter.step(initState(), {}),
      (e: unknown) =>
        e instanceof ModelStreamIncompleteError &&
        e.visible === false &&
        e.cause instanceof AnthropicError &&
        e.name === "ModelStreamIncompleteError"
    );
  });

  it("typed 错误 extends ProtocolError（loop-engine instanceof ProtocolError 收口支命中）", async () => {
    const adapter = streamAdapter([
      { kind: "fail", error: sdkStreamIncompleteError() },
    ]);
    const err = await adapter.step(initState(), {}).catch((e: unknown) => e);
    assert.ok(err instanceof ProtocolError);
    assert.ok(err instanceof Error);
  });

  it("出过非空 text delta 后断流 → visible=true（已出字，不自动重试面）", async () => {
    const adapter = streamAdapter([
      { kind: "text", text: "partial answer" },
      { kind: "fail", error: sdkStreamIncompleteError() },
    ]);
    await assert.rejects(
      () => adapter.step(initState(), {}),
      (e: unknown) =>
        e instanceof ModelStreamIncompleteError && e.visible === true
    );
  });

  it("非空 thinking_delta / input_json_delta 同样置位 visible", async () => {
    const thinkingAdapter = streamAdapter([
      { kind: "streamEvent", event: thinkingDelta("先想") },
      { kind: "fail", error: sdkStreamIncompleteError() },
    ]);
    await assert.rejects(
      () => thinkingAdapter.step(initState(), {}),
      (e: unknown) =>
        e instanceof ModelStreamIncompleteError && e.visible === true
    );
    const inputAdapter = streamAdapter([
      { kind: "streamEvent", event: toolUseStart("echo", "toolu_1") },
      { kind: "streamEvent", event: inputJsonDelta(0, '{"a":') },
      { kind: "fail", error: sdkStreamIncompleteError() },
    ]);
    await assert.rejects(
      () => inputAdapter.step(initState(), {}),
      (e: unknown) =>
        e instanceof ModelStreamIncompleteError && e.visible === true
    );
  });

  it("空 delta 不置位 visible（对齐 empty-delta 纪律）；tool_call_start 非输出增量也不置位", async () => {
    const emptyTextAdapter = streamAdapter([
      { kind: "text", text: "" },
      { kind: "streamEvent", event: thinkingDelta("") },
      { kind: "fail", error: sdkStreamIncompleteError() },
    ]);
    await assert.rejects(
      () => emptyTextAdapter.step(initState(), {}),
      (e: unknown) =>
        e instanceof ModelStreamIncompleteError && e.visible === false
    );
    const toolStartOnlyAdapter = streamAdapter([
      { kind: "streamEvent", event: toolUseStart("echo", "toolu_2") },
      { kind: "fail", error: sdkStreamIncompleteError() },
    ]);
    await assert.rejects(
      () => toolStartOnlyAdapter.step(initState(), {}),
      (e: unknown) =>
        e instanceof ModelStreamIncompleteError && e.visible === false
    );
  });

  it("非断流形态原样 rethrow：'request ended without sending any chunks' / 'stream ended before message_stop' 不翻本类", async () => {
    const chunks = new AnthropicError(
      "request ended without sending any chunks"
    );
    const chunksAdapter = streamAdapter([{ kind: "fail", error: chunks }]);
    await assert.rejects(
      () => chunksAdapter.step(initState(), {}),
      (e: unknown) => e === chunks
    );
    const eof = new AnthropicError("stream ended before message_stop");
    const eofAdapter = streamAdapter([{ kind: "fail", error: eof }]);
    await assert.rejects(
      () => eofAdapter.step(initState(), {}),
      (e: unknown) => e === eof
    );
  });

  it("cause 链含网络错误的同文本错误不翻本类（真网络断开归 llm_network retry 格，不双标签）", async () => {
    const connErr = new APIConnectionError({
      message: SDK_STREAM_INCOMPLETE_MESSAGE,
      cause: new TypeError("fetch failed"),
    });
    const adapter = streamAdapter([{ kind: "fail", error: connErr }]);
    await assert.rejects(
      () => adapter.step(initState(), {}),
      (e: unknown) =>
        e === connErr && !(e instanceof ModelStreamIncompleteError)
    );
  });
});

// ─── 2. nonClockFaultOf: stream_incomplete cell + default narrowing (observability signal) ─

/** Capture console.warn during a run: returns [hit count, first message]. */
function captureConsoleWarn(run: () => void): [number, string] {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    run();
    const calls = spy.mock.calls.map((args) => String(args[0]));
    return [calls.length, calls[0] ?? ""];
  } finally {
    spy.mockRestore();
  }
}

describe("nonClockFaultOf: stream_incomplete 格（ADR-0111 D3a/D4）", () => {
  it("ModelStreamIncompleteError → {kind:'stream_incomplete', visible} 透传，不误入 protocol_error", () => {
    const invisible = new ModelStreamIncompleteError(
      false,
      sdkStreamIncompleteError()
    );
    assert.deepEqual(translateAnthropicTransportFault(invisible), {
      kind: "stream_incomplete",
      visible: false,
    });
    const visible = new ModelStreamIncompleteError(
      true,
      sdkStreamIncompleteError()
    );
    assert.deepEqual(translateAnthropicTransportFault(visible), {
      kind: "stream_incomplete",
      visible: true,
    });
  });

  it("真·未知形态 → protocol_error 且产生一条 console.warn 诊断（含 name + message 片段）", () => {
    let event: unknown;
    const [warns, text] = captureConsoleWarn(() => {
      event = translateAnthropicTransportFault(
        new Error("wholly unrecognized failure mode")
      );
    });
    assert.deepEqual(event, { kind: "protocol_error" });
    assert.equal(warns, 1);
    assert.ok(text.includes("wholly unrecognized failure mode"));
  });

  it("warn 诊断 message 截断 ≤200 字符，不带 stack", () => {
    const long = "x".repeat(500);
    let event: unknown;
    const [warns, text] = captureConsoleWarn(() => {
      event = translateAnthropicTransportFault(new Error(long));
    });
    assert.deepEqual(event, { kind: "protocol_error" });
    assert.equal(warns, 1);
    assert.ok(!text.includes("x".repeat(201)));
    assert.ok(!text.includes("at "));
  });

  it("既有形态不误入 default：prompt_too_long / user_cancel / llm_http / cert / llm_network 均无 warn", () => {
    const cases: ReadonlyArray<[unknown, string]> = [
      [new PromptTooLongError("prompt is too long"), "prompt_too_long"],
      [new APIUserAbortError(), "user_cancel"],
      [
        new APIError(
          429,
          { error: { message: "rate limited" } },
          undefined,
          new Headers()
        ),
        "llm_http",
      ],
      [new Error("unable to verify the first certificate"), "protocol_error"],
      [
        new APIConnectionError({ cause: new TypeError("fetch failed") }),
        "llm_network",
      ],
    ];
    for (const [err, kind] of cases) {
      let event: unknown;
      const [warns] = captureConsoleWarn(() => {
        event = translateAnthropicTransportFault(err);
      });
      assert.equal((event as { kind: string }).kind, kind);
      assert.equal(warns, 0, `${kind} 形态不得触发 default warn`);
    }
  });
});

// ─── 3. SDK shape sentinel (any shape change on SDK upgrade goes RED) ────────

/**
 * Pins the real MessageStream empty-stream reject shape of @anthropic-ai/sdk
 * 0.115.0 (package.json "^0.115.0", resolved to 0.115.0 in package-lock): a
 * stream that ends with only message_start seen → no complete Message before
 * message_stop → `finalMessage()` takes the real `#getFinalMessage` reject
 * path. This test does not mock the SDK — if an upgrade changes the error
 * class / message text / reject timing, it goes RED immediately, forcing a
 * manual re-check of the adapter predicate (the three conditions of
 * `isStreamIncompleteShape`).
 */
describe("@anthropic-ai/sdk 0.115.0 断流形态哨兵（ADR-0111 D1 判据的 ground truth）", () => {
  it("real MessageStream: message_start 后流结束（无 message_stop）→ finalMessage rejects 匹配 /stream ended without producing a Message/i 的 AnthropicError，非 APIError、无 cause", async () => {
    const startEvent = {
      type: "message_start",
      message: {
        id: "msg_sentinel",
        type: "message",
        role: "assistant",
        model: "claude-sentinel",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
    // MessageStream.fromReadableStream consumes newline-separated JSON frames (the SDK's public front-end surface).
    const payload = JSON.stringify(startEvent) + "\n";
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    const stream = MessageStream.fromReadableStream(readable);
    await assert.rejects(
      () => stream.finalMessage(),
      (e: unknown) => {
        assert.ok(
          e instanceof AnthropicError,
          "断流错误形态必须是 AnthropicError"
        );
        assert.ok(
          /stream ended without producing a Message/i.test(
            (e as Error).message
          ),
          `SDK 断流 message 文本已漂移: ${JSON.stringify((e as Error).message)}`
        );
        assert.equal(
          e instanceof APIError,
          false,
          "断流错误不得是 APIError（adapter 判据依赖此）"
        );
        assert.equal((e as { cause?: unknown }).cause, undefined);
        return true;
      }
    );
  });
});

// ─── 4. happy-path regression: translation must not touch the success path ───

describe("stream arm 成功路径回归（翻译只改异常类，不触正常流）", () => {
  it("正常流 complete fixture → step resolves（无 typed 错误挂上）", async () => {
    const final = {
      id: "msg_ok",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as SdkMessage;
    const adapter = createRealAnthropicAdapter({
      client: {
        messages: {
          create: (): never => {
            throw new Error("create must not be called in stream arm");
          },
          stream: () => ({
            on: () => undefined,
            finalMessage: () => Promise.resolve(final),
          }),
        },
      } as unknown as SdkClient,
      model: "claude-test-model",
      maxTokens: 256,
      stream: true,
    });
    const result = (await adapter.step(initState(), {})) as AssistantTurnResult;
    assert.deepEqual(result.projection.texts, ["ok"]);
  });
});
