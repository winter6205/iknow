/**
 * T4 stubs:确定性替身,仅供测试。
 *
 * stub-model 接受脚本化 responses 数组(每次 step 调用消费下一条);
 * stub-tool 接受 args 返回可控成功 / 失败 / 异常;完全确定性,无时间 / 随机 /
 * IO 依赖;不进生产装配路径(src/cli/runtime.ts、src/session-api/ 不 import)。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../../src/harness/stubs/stub-tool.ts";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";

const initState = (msgs: AnthropicNativeMessage[] = []): LoopState => ({
  messages: msgs,
  turnCount: 0,
});

describe("createStubTool", () => {
  it("returns the configured payload on success", async () => {
    const t = createStubTool({
      name: "ok",
      next: () => ({ value: 42 }),
    });
    assert.equal(t.name, "ok");
    assert.deepEqual(await t.handler({}), { value: 42 });
  });

  it("returns a thrown error for fail-mode", async () => {
    const t = createStubTool({
      name: "bad",
      next: () => {
        throw new Error("nope");
      },
    });
    await assert.rejects(t.handler({}) as Promise<unknown>, /nope/);
  });
});

describe("createStubModel", () => {
  it("consumes scripted AssistantTurnResult in order", async () => {
    const native: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    };
    const r1: AssistantTurnResult = {
      nativeMessage: native,
      projection: {
        nativeMessage: native,
        texts: ["hello"],
        toolCalls: [],
      },
      supplierStop: "success",
      needsTools: false,
      isEmptyFinalResponse: false,
    };
    const model = createStubModel([r1]);
    const out = await model.step(initState(), {});
    assert.equal(out.projection.texts[0], "hello");
    assert.equal(out.supplierStop, "success");
  });

  it("throws ProtocolError when scripted responses are exhausted", async () => {
    const { ProtocolError } = await import("../../../src/harness/errors.ts");
    const model = createStubModel([]);
    await assert.rejects(
      () => model.step(initState(), {}),
      (e: unknown) => e instanceof ProtocolError,
    );
  });
});