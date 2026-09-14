/**
 * ADR-0094 T1 / spec SC1-SC3, SC7：`createAdapterFromEnv` 的 wire-model 解析。
 *
 * 物理世界 = Anthropic SDK 请求 body 的 `model` 字段 = providers.models[].id
 * （不含 provider 前缀）。本文件用本地 capture server 走**真实 SDK 请求**，
 * 拿到 wire 上的 `model`，黑盒证明三个装配点（build-engine / thinking-override /
 * subagent worker）只把路由 ID 的尾段（首个 `/` 之后）放上 wire，provider id
 * 不出现在 wire 上。
 *
 * 装配点的 unit / type sanity 测已在 `tests/subagent/worker.test.ts` D 段覆盖；
 * worker 走同一个 `wireModelFromRoute` SSOT，本文件选 build-engine 当
 * 代表性 wire 观测面。
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

/** 与生产同形的 IknowEnv 字面（model / baseUrl / apiKey 是本文件唯一参与字段）。 */
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

/** 走一次真实 adapter 请求（非流式臂；state.messages 空是合法请求）。 */
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
