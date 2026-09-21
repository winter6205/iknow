/**
 * Stream-hang detection contract (stream-hang-detect T2), adapter layer:
 * an aborted signal must end `step` — the engine's idle / hard-cap clock
 * aborts the child signal, and a hung `finalMessage()` (open connection,
 * no chunks, no end event) must not outlive that abort as a dangling
 * attempt.
 *
 * Invariants pinned:
 * - abort (clock or user) → step rejects with the SDK-native
 *   `APIUserAbortError` shape, bounded (never waits for the stream body);
 * - rejection translation reads the clock marker first: idle+invisible →
 *   `clock_timeout` (retryable), hardCap+visible → `timeout` (no retry),
 *   plain user abort → `user_cancel` — never `stream_incomplete` (the
 *   stream did not end on its own; ADR-0111 stays reserved for that);
 * - signal already aborted at entry → immediate rejection;
 * - normal / broken-stream terminal shapes are untouched by the race
 *   (resolve wins, SDK reject classifies as before).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { APIUserAbortError } from "@anthropic-ai/sdk";
import { AnthropicError } from "@anthropic-ai/sdk";
import type { Message as SdkMessage } from "@anthropic-ai/sdk/resources/messages/messages.js";
import {
  createRealAnthropicAdapter,
  translateAnthropicTransportFault,
} from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import { ModelStreamIncompleteError } from "../../../src/harness/errors.ts";
import type {
  AnthropicNativeMessage,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";

type SdkClient = Parameters<typeof createRealAnthropicAdapter>[0]["client"];

function userMsg(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

const initState = (): LoopState => ({
  messages: [userMsg("hi")],
  turnCount: 0,
});

function streamAdapter(
  finalMessage: () => Promise<SdkMessage>
): ReturnType<typeof createRealAnthropicAdapter> {
  return createRealAnthropicAdapter({
    client: {
      messages: {
        create: (): never => {
          throw new Error("create must not be called in stream arm");
        },
        stream: () => ({
          on: () => undefined,
          finalMessage,
        }),
      },
    } as unknown as SdkClient,
    model: "claude-test-model",
    maxTokens: 256,
    stream: true,
  });
}

/** The hung-stream shape: finalMessage never settles, not even after abort. */
function zombieFinalMessage(): () => Promise<SdkMessage> {
  return () =>
    new Promise<SdkMessage>(() => {
      // open connection: no chunk, no end event, never settles
    });
}

/** Race a bounded watcher against the step promise to observe settlement. */
async function settleWithin<T>(
  promise: Promise<T>,
  graceMs: number
): Promise<"pending" | "resolved" | "rejected"> {
  let state: "pending" | "resolved" | "rejected" = "pending";
  promise.then(
    () => (state = "resolved"),
    () => (state = "rejected")
  );
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  return state;
}

function abortClock(
  source: "idle" | "hardCap",
  visible: boolean
): { kind: "clock_abort"; source: "idle" | "hardCap"; visible: boolean } {
  return { kind: "clock_abort", source, visible };
}

describe("挂死流必须随 abort 落地（stream-hang-detect T2 / adapter 层）", () => {
  it("idle 时钟 abort（invisible）→ 挂死的 finalMessage 不再悬空，step 有界 reject", async () => {
    const adapter = streamAdapter(zombieFinalMessage());
    const controller = new AbortController();
    const step = adapter.step(initState(), {}, controller.signal);
    setTimeout(() => controller.abort(abortClock("idle", false)), 10);
    assert.equal(await settleWithin(step, 200), "rejected");
    const err = await step.catch((e: unknown) => e);
    assert.ok(
      err instanceof APIUserAbortError,
      `reject 形态必须是 SDK 原生 abort: ${String(err)}`
    );
  });

  it("clock abort 后翻译读 clock marker：idle+invisible → clock_timeout（不误标 stream_incomplete）", async () => {
    const adapter = streamAdapter(zombieFinalMessage());
    const controller = new AbortController();
    const step = adapter.step(initState(), {}, controller.signal);
    controller.abort(abortClock("idle", false));
    const err = await step.catch((e: unknown) => e);
    assert.ok(!(err instanceof ModelStreamIncompleteError));
    assert.deepEqual(translateAnthropicTransportFault(err, controller.signal), {
      kind: "clock_timeout",
      source: "idle",
      visible: false,
    });
  });

  it("hardCap abort（visible）→ 翻译 timeout（已出字不重打面）", async () => {
    const adapter = streamAdapter(zombieFinalMessage());
    const controller = new AbortController();
    const step = adapter.step(initState(), {}, controller.signal);
    controller.abort(abortClock("hardCap", true));
    const err = await step.catch((e: unknown) => e);
    assert.deepEqual(translateAnthropicTransportFault(err, controller.signal), {
      kind: "timeout",
    });
  });

  it("无 clock marker 的用户 abort → reject + 翻译 user_cancel", async () => {
    const adapter = streamAdapter(zombieFinalMessage());
    const controller = new AbortController();
    const step = adapter.step(initState(), {}, controller.signal);
    setTimeout(() => controller.abort(), 10);
    assert.equal(await settleWithin(step, 200), "rejected");
    const err = await step.catch((e: unknown) => e);
    assert.deepEqual(translateAnthropicTransportFault(err, controller.signal), {
      kind: "user_cancel",
    });
  });

  it("入口 signal 已 abort → 立即 reject，不等流体", async () => {
    const adapter = streamAdapter(zombieFinalMessage());
    const controller = new AbortController();
    controller.abort(abortClock("idle", false));
    assert.equal(
      await settleWithin(adapter.step(initState(), {}, controller.signal), 50),
      "rejected"
    );
  });

  it("真实 SDK 形态（abort 使 finalMessage reject）：入口已 abort 丢弃该 promise 不留 unhandled rejection", async () => {
    // settleOnAbort 的入口分支丢弃实参 promise；真实 SDK 在 signal abort 后
    // 会让 finalMessage() 以 APIUserAbortError reject —— 若不先给它挂
    // handler，被丢弃的 reject 会变成 orphaned unhandled rejection。
    let unhandled: unknown;
    const onUnhandled = (reason: unknown): void => {
      unhandled ??= reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const adapter = streamAdapter(
        () =>
          new Promise<SdkMessage>((_, reject) => {
            setTimeout(() => reject(new APIUserAbortError()), 10);
          })
      );
      const controller = new AbortController();
      controller.abort(abortClock("idle", false));
      const step = adapter.step(initState(), {}, controller.signal);
      assert.equal(await settleWithin(step, 50), "rejected");
      const err = await step.catch((e: unknown) => e);
      assert.ok(err instanceof APIUserAbortError);
      // SDK 形态的 reject 稍后到达：此时 promise 已被入口分支挂上 handler。
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(
        unhandled,
        undefined,
        `被丢弃的 finalMessage reject 不得成为 unhandled rejection: ${String(unhandled)}`
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("正常 resolve 先到 → 结果照常返回；随后的 abort 不产生悬空/未处理拒绝", async () => {
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
    const adapter = streamAdapter(() => Promise.resolve(final));
    const controller = new AbortController();
    const result = await adapter.step(initState(), {}, controller.signal);
    assert.deepEqual(result.projection.texts, ["ok"]);
    controller.abort(abortClock("idle", false));
    // 让 abort 事件有机会传播；无未处理拒绝即通过（vitest 会报告 unhandled）。
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("SDK 断流 reject 先到 → stream_incomplete 翻译不受 abort 竞速影响（ADR-0111 回归）", async () => {
    const adapter = streamAdapter(() =>
      Promise.reject(
        new AnthropicError(
          "stream ended without producing a Message with role=assistant"
        )
      )
    );
    const controller = new AbortController();
    const step = adapter.step(initState(), {}, controller.signal);
    setTimeout(() => controller.abort(abortClock("idle", false)), 10);
    const err = await step.catch((e: unknown) => e);
    assert.ok(err instanceof ModelStreamIncompleteError);
    assert.equal(err.visible, false);
  });
});
