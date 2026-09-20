/**
 * SDK prompt-too-long 400 → PromptTooLongError translation (foundation for
 * reactive compaction).
 *
 * Translation condition:
 *   `instanceof APIError && status === 400 && /prompt.*length|too long/i.test(message)`
 *   → `throw new PromptTooLongError(e.message)`; every other error is rethrown untouched.
 *
 * PromptTooLongError extends ProtocolError, so loop-engine's
 * `instanceof ProtocolError` branch catches it (the reactive branch relies on this).
 *
 * Coverage (each arm × 3 classes = 6):
 *   - non-stream arm (`messages.create`): 400 prompt-too-long → translated;
 *     other 400 → verbatim; non-400 → verbatim.
 *   - stream arm (`finalMessage()` reject): 400 prompt-too-long → translated;
 *     other 400 → verbatim; non-400 → verbatim.
 *   - error-class boundary: PromptTooLongError instanceof ProtocolError, `.name` correct.
 *
 * Fake SDK client, no real network (mirrors anthropic-adapter.test.ts /
 * anthropic-adapter-stream.test.ts precedent).
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

/** Real Anthropic 400 prompt-too-long error body: request_too_large. */
function sdkTooLongError(): APIError {
  return new APIError(
    400,
    { type: "request_too_large", message: "prompt is too long: 201409 tokens" },
    undefined,
    new Headers()
  );
}

/** For 400 the SDK actually throws BadRequestError — instanceof APIError still true. */
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

/** Non-stream arm fake client: messages.create rejects with the given error. */
function nonStreamClient(rejectErr: unknown): SdkClient {
  return {
    messages: {
      create: (): Promise<never> => Promise.reject(rejectErr),
    },
  } as unknown as SdkClient;
}

/** Stream arm fake client: messages.stream returns a fake stream whose finalMessage() rejects. */
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

// ─── non-stream arm (`messages.create`) ──────────────────────────────────────

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

// ─── stream arm (`finalMessage()` reject) ────────────────────────────────────

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

// ─── error-class boundary ────────────────────────────────────────────────────

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
