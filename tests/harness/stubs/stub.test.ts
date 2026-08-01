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
import { createStubSignalTool } from "../../../src/harness/stubs/stub-signal-tool.ts";
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
    const model = createStubModel({ responses: [r1] });
    const out = await model.step(initState(), {});
    assert.equal(out.projection.texts[0], "hello");
    assert.equal(out.supplierStop, "success");
  });

  it("throws ProtocolError when scripted responses are exhausted", async () => {
    const { ProtocolError } = await import("../../../src/harness/errors.ts");
    const model = createStubModel({ responses: [] });
    await assert.rejects(
      () => model.step(initState(), {}),
      (e: unknown) => e instanceof ProtocolError
    );
  });
});

// 017:helper for fixture AssistantTurnResult —— 与上面 createStubModel
// 第一个测试同款,确保新的 delay/ signal 用例拿到一致的 r1 形状。
const buildR1 = (): AssistantTurnResult => {
  const native: AnthropicNativeMessage = {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
  };
  return {
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
};

describe("createStubModel (017 signal/delay)", () => {
  it("delayMs: step resolves to the scripted response after the configured delay", async () => {
    const r1 = buildR1();
    const model = createStubModel({ responses: [r1], delayMs: 20 });
    const out = await model.step(initState(), {});
    assert.equal(out.projection.texts[0], "hello");
    assert.equal(out.supplierStop, "success");
    assert.equal(out.needsTools, false);
  });

  it("signal abort during delay: step rejects with AbortError", async () => {
    const r1 = buildR1();
    const model = createStubModel({ responses: [r1], delayMs: 200 });
    const controller = new AbortController();
    const pending = model.step(initState(), {}, controller.signal);
    controller.abort();
    await assert.rejects(
      pending,
      (e: unknown) => e instanceof DOMException && e.name === "AbortError"
    );
  });
});

describe("createStubSignalTool (017 S17)", () => {
  it("handler resolves normally when signal not aborted", async () => {
    const tool = createStubSignalTool();
    const controller = new AbortController();
    const out = await tool.handler({}, { signal: controller.signal });
    assert.deepEqual(out, {});
  });

  it("handler rejects with AbortError when signal already aborted", async () => {
    const tool = createStubSignalTool();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => tool.handler({}, { signal: controller.signal }),
      (e: unknown) => e instanceof DOMException && e.name === "AbortError"
    );
  });

  it("handler rejects with AbortError when aborted while waiting", async () => {
    const tool = createStubSignalTool({ delayMs: 200 });
    const controller = new AbortController();
    const pending = tool.handler({}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(
      pending,
      (e: unknown) => e instanceof DOMException && e.name === "AbortError"
    );
  });
});
