/**
 * T2 (#252): SDK prompt-too-long 400 → PromptTooLongError 翻译 (reactive compact 地基)。
 *
 * 翻译条件 (spec 252 `:93-98`):
 *   `instanceof APIError && status === 400 && /prompt.*length|too long/i.test(message)`
 *   → `throw new PromptTooLongError(e.message)`;其余错误原样 rethrow。
 *
 * PromptTooLongError extends ProtocolError — 故 loop-engine.ts:431 的
 * `instanceof ProtocolError` 分支能命中 (T3 reactive 分支依赖)。
 *
 * 覆盖 (每臂 × 3 类 = 6):
 *   - 非流式臂 (`messages.create`): 400 prompt-too-long → 翻译;其他 400 → 原样;
 *     非 400 → 原样。
 *   - 流式臂 (`finalMessage()` reject): 400 prompt-too-long → 翻译;其他 400 →
 *     原样;非 400 → 原样。
 *   - 异常类边界:PromptTooLongError instanceof ProtocolError, `.name` 正确。
 *
 * 用 fake SDK client 装配,不连真实网络 (对齐 anthropic-adapter.test.ts /
 * anthropic-adapter-stream.test.ts 既有先例)。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { APIError, BadRequestError } from "@anthropic-ai/sdk";
import type { Message as SdkMessage } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { createRealAnthropicAdapter } from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import {
  ProtocolError,
  PromptTooLongError,
} from "../../../src/harness/errors.ts";
import type {
  AnthropicNativeMessage,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";

function userMsg(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

const initState = (): LoopState => ({ messages: [], turnCount: 0 });

/** 真实 Anthropic 400 prompt-too-long 错误体:request_too_large。 */
function sdkTooLongError(): APIError {
  return new APIError(
    400,
    { type: "request_too_large", message: "prompt is too long: 201409 tokens" },
    undefined,
    new Headers()
  );
}

/** SDK 实际对 400 抛 BadRequestError —— instanceof APIError 为 true。 */
function sdkBadRequestOther(): APIError {
  return new BadRequestError(
    400,
    { type: "invalid_request_error", message: "messages: role is invalid" },
    undefined,
    new Headers()
  );
}

function sdkServerError(): APIError {
  return new APIError(
    500,
    { type: "api_error", message: "internal server error" },
    undefined,
    new Headers()
  );
}

type SdkClient = Parameters<typeof createRealAnthropicAdapter>[0]["client"];

/** 非流式臂 fake client:messages.create 拒指定错误。 */
function nonStreamClient(rejectErr: unknown): SdkClient {
  return {
    messages: {
      create: (): Promise<never> => Promise.reject(rejectErr),
    },
  } as unknown as SdkClient;
}

/** 流式臂 fake client:messages.stream 返回 fake stream,finalMessage() reject。 */
function streamClient(rejectErr: unknown): SdkClient {
  return {
    messages: {
      create: (): never => {
        throw new Error("create must not be called in stream arm");
      },
      stream: () => ({
        on: () => undefined,
        finalMessage: (): Promise<SdkMessage> => Promise.reject(rejectErr),
      }),
    },
  } as unknown as SdkClient;
}

function adapterFromClient(
  client: SdkClient,
  opts?: { stream?: boolean }
): ReturnType<typeof createRealAnthropicAdapter> {
  return createRealAnthropicAdapter({
    client,
    model: "claude-test-model",
    maxTokens: 256,
    stream: opts?.stream,
  });
}

// ─── 非流式臂 (`messages.create`) ───────────────────────────────────────────

describe("PromptTooLongError translation — non-stream arm (create)", () => {
  it("400 prompt-too-long → throws PromptTooLongError (wraps SDK message)", async () => {
    const adapter = adapterFromClient(nonStreamClient(sdkTooLongError()));
    await assert.rejects(
      () => adapter.step(initState(), {}),
      (e: unknown) =>
        e instanceof PromptTooLongError &&
        /too long|prompt/i.test((e as Error).message)
    );
  });

  it("other 400 → rethrows original SDK error (NOT PromptTooLongError)", async () => {
    const err = sdkBadRequestOther();
    const adapter = adapterFromClient(nonStreamClient(err));
    await assert.rejects(
      () => adapter.step(initState(), {}),
      (e: unknown) =>
        e === err && e instanceof APIError && !(e instanceof PromptTooLongError)
    );
  });

  it("non-400 → rethrows original SDK error (NOT PromptTooLongError)", async () => {
    const err = sdkServerError();
    const adapter = adapterFromClient(nonStreamClient(err));
    await assert.rejects(
      () => adapter.step(initState(), {}),
      (e: unknown) =>
        e === err && e instanceof APIError && !(e instanceof PromptTooLongError)
    );
  });
});

// ─── 流式臂 (`finalMessage()` reject) ──────────────────────────────────────

describe("PromptTooLongError translation — stream arm (finalMessage reject)", () => {
  it("400 prompt-too-long reject → throws PromptTooLongError", async () => {
    const adapter = adapterFromClient(streamClient(sdkTooLongError()), {
      stream: true,
    });
    await assert.rejects(
      () => adapter.step(initState(), {}),
      (e: unknown) => e instanceof PromptTooLongError
    );
  });

  it("other 400 reject → rethrows original SDK error (NOT PromptTooLongError)", async () => {
    const err = sdkBadRequestOther();
    const adapter = adapterFromClient(streamClient(err), { stream: true });
    await assert.rejects(
      () => adapter.step(initState(), {}),
      (e: unknown) =>
        e === err && e instanceof APIError && !(e instanceof PromptTooLongError)
    );
  });

  it("non-400 reject → rethrows original SDK error (NOT PromptTooLongError)", async () => {
    const err = sdkServerError();
    const adapter = adapterFromClient(streamClient(err), { stream: true });
    await assert.rejects(
      () => adapter.step(initState(), {}),
      (e: unknown) =>
        e === err && e instanceof APIError && !(e instanceof PromptTooLongError)
    );
  });
});

// ─── 异常类边界 ─────────────────────────────────────────────────────────────

describe("PromptTooLongError class boundary", () => {
  it("is a ProtocolError subclass (loop-engine instanceof ProtocolError branch hits)", () => {
    const e = new PromptTooLongError("too long");
    assert.ok(e instanceof ProtocolError);
    assert.ok(e instanceof Error);
    assert.equal(e.name, "PromptTooLongError");
  });

  it("translation rethrows non-APIError untouched (e.g. plain Error)", async () => {
    const plain = new Error("boom");
    const adapter = adapterFromClient(nonStreamClient(plain));
    await assert.rejects(
      () => adapter.step(initState(), {}),
      (e: unknown) => e === plain
    );
  });
});
