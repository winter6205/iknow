/**
 * specs/tui-model-command.md SC9 —— provider.headers → Anthropic SDK
 * `defaultHeaders` 透传（`createAdapterFromEnv` 真实装配路径）。
 *
 * 观测手段（为什么这样选）：
 *   - 在场一侧走 **wire**：本地 http server 记录请求头 —— 黑盒证明 headers
 *     真到达 SDK 发出的请求，而不是只信构造参数。
 *   - 缺席一侧要证的是「构造时根本没传该键」（`undefined` / `{}` 都不允许）。
 *     这一点 wire 上看不出差别（两者都不发头），只能回到 client 实例的
 *     options 观察：断言无同有键 + 与「今日同款构造」（只有 apiKey/baseURL）
 *     的 client 键集逐字节相同。SDK 内部 options 字段名变了的话，本用例会
 *     直接红线报错而不是静默放过。
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

/** 与生产同形的 IknowEnv 字面（只有 baseUrl / headers 参与本文件的断言）。 */
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

/** SDK 把构造 options 冻结在此 protected 字段上（headers 合并点同源）。 */
function clientOptions(client: Anthropic): Record<string, unknown> {
  return (client as unknown as { _options: Record<string, unknown> })._options;
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
    // 对照组 = 今日的构造调用形态（只有 apiKey / baseURL）。键集相等 ⟺
    // 没有多出 `defaultHeaders` 这个自有键（显式传 undefined 会多出该键，
    // 实测可分辨）。
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
