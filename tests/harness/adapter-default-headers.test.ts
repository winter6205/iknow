/**
 * provider.headers → Anthropic SDK `defaultHeaders` pass-through, verified on
 * the real assembly path of `createAdapterFromEnv`.
 *
 * Observation design:
 *   - Present side asserts on the WIRE: a local http server records request
 *     headers — black-box proof that headers actually reach the SDK request,
 *     not just the constructor argument.
 *   - Absent side must prove the key is never passed at construction (neither
 *     `undefined` nor `{}` allowed). The wire cannot tell those apart (neither
 *     sends the header), so observe the client instance's options instead:
 *     no such own key, plus a key set identical to a control client built the
 *     same way today (apiKey/baseURL only). If the SDK renames its internal
 *     options field, this test fails loudly rather than passing silently.
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { createAdapterFromEnv } from "../../src/harness/build-engine.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import type { LoopAdapter } from "../../src/harness/index.ts";
import {
  MINIMAL_MESSAGE_RESPONSE,
  startHttpCapture,
  type HttpCapture,
} from "../_helpers/http-capture.ts";

/** IknowEnv literal shaped like production; only baseUrl / headers matter to this file's asserts. */
function makeEnv(opts: {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
}): IknowEnv {
  return {
    llm: {
      apiKey: "test-key",
      baseUrl: opts.baseUrl,
      model: "test-model",
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
      fallback: [],
      maxOutputTokens: 64,
      // The route entry owns the request budget; 64 keeps the non-streaming arm
      // inside the SDK's 10-minute-per-request allowance.
      routeMaxTokens: 64,
      timeoutMs: 2_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "off",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    workspaceRoot: undefined,
    productRoot: undefined,
  };
}

/** The SDK freezes constructor options on this protected field (same point where headers are merged). */
function clientOptions(client: Anthropic): Record<string, unknown> {
  return (client as unknown as { _options: Record<string, unknown> })._options;
}

/** Drive one real adapter request (non-streaming arm; empty state.messages is a valid request). */
async function stepOnce(adapter: LoopAdapter): Promise<void> {
  await adapter.step(
    { messages: [], turnCount: 0 } as Parameters<LoopAdapter["step"]>[0],
    {}
  );
}

let capture: HttpCapture | undefined;

afterEach(async () => {
  if (capture) {
    await capture.close();
    capture = undefined;
  }
});

describe("createAdapterFromEnv — provider headers 透传（SC9）", () => {
  it("env.llm.headers 在场 → client.defaultHeaders 含该键值，且真到达 wire", async () => {
    capture = await startHttpCapture(MINIMAL_MESSAGE_RESPONSE);
    const { client, adapter } = createAdapterFromEnv(
      makeEnv({
        baseUrl: capture.origin,
        headers: { "X-Foo": "bar" },
      })
    );

    assert.deepEqual(clientOptions(client)["defaultHeaders"], {
      "X-Foo": "bar",
    });

    await stepOnce(adapter);
    assert.equal(capture.headers.length, 1);
    assert.equal(capture.headers[0]!["x-foo"], "bar");
  });

  it("env.llm.headers 缺席 → 不传 defaultHeaders 键（构造 options 与今日同款 client 逐键相同），wire 无该头", async () => {
    capture = await startHttpCapture(MINIMAL_MESSAGE_RESPONSE);
    const { client, adapter } = createAdapterFromEnv(
      makeEnv({ baseUrl: capture.origin })
    );
    // Control group = today's construction shape (apiKey / baseURL only).
    // Equal key sets ⟺ no extra `defaultHeaders` own key (passing undefined
    // explicitly would add the key; empirically distinguishable).
    const control = new Anthropic({
      apiKey: "test-key",
      baseURL: capture.origin,
    });

    assert.equal(
      Object.prototype.hasOwnProperty.call(
        clientOptions(client),
        "defaultHeaders"
      ),
      false
    );
    assert.deepEqual(
      Object.keys(clientOptions(client)),
      Object.keys(clientOptions(control))
    );

    await stepOnce(adapter);
    assert.equal(capture.headers.length, 1);
    assert.equal("x-foo" in capture.headers[0]!, false);
  });
});
