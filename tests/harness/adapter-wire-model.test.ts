/**
 * ADR-0094: wire-model resolution in `createAdapterFromEnv`.
 *
 * Ground truth = the `model` field of the Anthropic SDK request body, which
 * must equal providers.models[].id (no provider prefix). This file sends real
 * SDK requests through a local capture server and asserts on the wire `model`:
 * all three assembly points (build-engine / thinking-override / subagent
 * worker) put only the route ID's tail (after the first `/`) on the wire;
 * the provider id never appears there.
 *
 * Unit/type sanity for the worker assembly is covered in
 * `tests/subagent/worker.test.ts`; the worker shares the same
 * `wireModelFromRoute` SSOT, so build-engine serves as the representative
 * wire observation surface here.
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { createAdapterFromEnv } from "../../src/harness/build-engine.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import type { LoopAdapter } from "../../src/harness/index.ts";
import {
  MINIMAL_MESSAGE_RESPONSE,
  startHttpCapture,
  type HttpCapture,
} from "../_helpers/http-capture.ts";

/** IknowEnv literal shaped like production; model / baseUrl / apiKey are the only fields this file asserts on. */
function makeEnv(opts: {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
}): IknowEnv {
  return {
    llm: {
      apiKey: opts.apiKey ?? "test-key",
      baseUrl: opts.baseUrl,
      model: opts.model,
      fallback: [],
      maxOutputTokens: 64,
      // The request budget comes from the route's model entry; 64 keeps the
      // non-streaming arm inside the SDK's 10-minute-per-request allowance.
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

describe("createAdapterFromEnv — wire model (ADR-0094 T1 / SC1-SC3)", () => {
  it("route=9router/Opus4.8 → wire=Opus4.8（provider id 不上 wire）", async () => {
    capture = await startHttpCapture(MINIMAL_MESSAGE_RESPONSE);
    const { adapter } = createAdapterFromEnv(
      makeEnv({ baseUrl: capture.origin, model: "9router/Opus4.8" })
    );

    await stepOnce(adapter);

    assert.equal(capture.bodies.length, 1);
    const body = capture.bodies[0] as { model?: string };
    assert.equal(body.model, "Opus4.8");
    assert.equal(body.model?.includes("9router"), false);
  });

  it("route=9router/ocg/deepseek-v4-flash → wire=ocg/deepseek-v4-flash（SC2：尾段含 /）", async () => {
    capture = await startHttpCapture(MINIMAL_MESSAGE_RESPONSE);
    const { adapter } = createAdapterFromEnv(
      makeEnv({
        baseUrl: capture.origin,
        model: "9router/ocg/deepseek-v4-flash",
      })
    );

    await stepOnce(adapter);

    assert.equal(capture.bodies.length, 1);
    const body = capture.bodies[0] as { model?: string };
    assert.equal(body.model, "ocg/deepseek-v4-flash");
  });

  it("bare name（无 /）→ wire=identity（裸模型透传）", async () => {
    capture = await startHttpCapture(MINIMAL_MESSAGE_RESPONSE);
    const { adapter } = createAdapterFromEnv(
      makeEnv({ baseUrl: capture.origin, model: "test-model" })
    );

    await stepOnce(adapter);

    assert.equal(capture.bodies.length, 1);
    const body = capture.bodies[0] as { model?: string };
    assert.equal(body.model, "test-model");
  });
});
