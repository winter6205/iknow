/**
 * #742 T1:流式臂模型调用的 idle 重置钟 + 有限硬顶,在 loop-engine 上的归属。
 *
 * 合同(plans/model-idle-thinking-peek.md Task 1 + docs/CONTEXT.md
 * 「model-call idle / 模型调用硬顶」):
 *   - 仅流式臂(adapter.streamMode)启用 idle;`stream=off` 与改前单钟一致;
 *   - idle / 硬顶都落既有 `StopReason: timeout`(cancelKind `timerTimeout`),
 *     不新增停因;
 *   - 用户 abort 仍是 `cancelled`,signal 优先;
 *   - 包装后的 `onStream` 必须原样转发给宿主回调,观察者异常照 safeEmitStream
 *     吞咽,不反流。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { raceModel, run } from "../../src/harness/loop-engine.ts";
import type { LoopAdapter } from "../../src/harness/loop-engine.ts";
import type {
  AnthropicNativeMessage,
  LoopState,
} from "../../src/harness/model-adapter/types.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../cli/_fixtures.ts";

const THINKING: HarnessStreamEvent = { type: "thinking_delta", text: "…" };

function makeNative(role: "user" | "assistant", text: string) {
  return { role, content: [{ type: "text", text }] } as AnthropicNativeMessage;
}

/**
 * 本文件替身:首个 step 按固定节奏向 `request.onStream` 打增量,`resolveAfterMs`
 * 缺席 = 永不 settle(交给两根钟裁决)。第二个及之后的 step 是 run() 的收尾摘要
 * 轮,立即返回空文本,避免摘要拖慢用例。emit 处 try/catch 对齐 stub-model 的 D3
 * 纪律(替身不得让观察者异常反流)。
 */
function createDeltaAdapter(opts: {
  readonly event?: HarnessStreamEvent;
  readonly everyMs: number;
  readonly emitCount: number;
  readonly resolveAfterMs?: number;
  readonly streamMode?: boolean;
}): LoopAdapter {
  let calls = 0;
  return Object.freeze({
    ...(opts.streamMode === true ? { streamMode: true } : {}),
    encodeUserText: (text: string) => makeNative("user", text),
    encodeToolResults: () => [],
    step: async (
      _state: LoopState,
      request: { onStream?: (event: HarnessStreamEvent) => void },
      signal?: AbortSignal
    ) => {
      calls++;
      if (calls > 1) {
        return assistantResult({ texts: [], supplierStop: "success" });
      }
      let emitted = 0;
      const ticker = setInterval(() => {
        if (emitted >= opts.emitCount) return;
        emitted++;
        try {
          request.onStream?.(opts.event ?? THINKING);
        } catch {
          // 替身遵守 D3:观察者异常不得反向破坏模型回合。
        }
      }, opts.everyMs);
      try {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void =>
            reject(
              new DOMException("This operation was aborted", "AbortError")
            );
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });
          if (opts.resolveAfterMs !== undefined) {
            setTimeout(resolve, opts.resolveAfterMs);
          }
        });
      } finally {
        clearInterval(ticker);
      }
      return assistantResult({ texts: ["streamed"], supplierStop: "success" });
    },
  });
}

function harness() {
  const registry = createRegistry([
    createStubTool({ name: "noop", next: () => ({}) }),
  ]);
  return { registry, executor: createExecutor(registry) };
}

describe("#742 T1: 流式臂 idle 重置", () => {
  it("持续 thinking_delta 超过今日单钟 → 不以 timeout 结束", async () => {
    const { registry, executor } = harness();
    const adapter = createDeltaAdapter({
      everyMs: 15,
      emitCount: 12,
      resolveAfterMs: 200,
      streamMode: true,
    });
    const { result } = await run("x", {
      adapter,
      executor,
      registry,
      maxTurns: 1,
      // 今日单钟 40ms —— 改前它会在第 40ms 砍掉这次仍在出字的调用。
      modelTimeoutMs: 40,
      modelIdleTimeoutMs: 200,
      modelHardCapMs: 2_000,
      summaryTimeoutMs: 50,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.finalText, "streamed");
  });

  it("增量之后静默满 idle → timeout,整回合不进历史,cancelKind=timerTimeout", async () => {
    const { registry, executor } = harness();
    const adapter = createDeltaAdapter({
      everyMs: 10,
      emitCount: 1,
      streamMode: true,
    });
    const { result, trace } = await run("x", {
      adapter,
      executor,
      registry,
      maxTurns: 1,
      modelTimeoutMs: 5_000,
      modelIdleTimeoutMs: 60,
      modelHardCapMs: 5_000,
      summaryTimeoutMs: 50,
    });
    assert.equal(result.stopReason, "timeout");
    assert.equal(result.turnCount, 0);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.role, "user");
    assert.equal(
      trace.turns[trace.turns.length - 1]!.cancelKind,
      "timerTimeout"
    );
  });

  it("硬顶到点即使仍有增量 → timeout", async () => {
    const { registry, executor } = harness();
    const adapter = createDeltaAdapter({
      everyMs: 15,
      emitCount: 100,
      streamMode: true,
    });
    const { result, trace } = await run("x", {
      adapter,
      executor,
      registry,
      maxTurns: 1,
      modelTimeoutMs: 5_000,
      modelIdleTimeoutMs: 2_000,
      modelHardCapMs: 80,
      summaryTimeoutMs: 50,
    });
    assert.equal(result.stopReason, "timeout");
    assert.equal(
      trace.turns[trace.turns.length - 1]!.cancelKind,
      "timerTimeout"
    );
  });

  it("用户 abort 优先于两根钟 → cancelled", async () => {
    const { registry, executor } = harness();
    const adapter = createDeltaAdapter({
      everyMs: 15,
      emitCount: 100,
      streamMode: true,
    });
    const controller = new AbortController();
    const pending = run(
      "x",
      {
        adapter,
        executor,
        registry,
        maxTurns: 1,
        modelTimeoutMs: 5_000,
        modelIdleTimeoutMs: 300,
        modelHardCapMs: 5_000,
        summaryTimeoutMs: 50,
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 20);
    const { result } = await pending;
    assert.equal(result.stopReason, "cancelled");
  });

  it("非流式臂:配了 idle/硬顶也只走今日单钟", async () => {
    const { registry, executor } = harness();
    const adapter = createDeltaAdapter({
      everyMs: 15,
      emitCount: 100,
      // streamMode 缺席 = stream=off / 离线替身。
    });
    const { result, trace } = await run("x", {
      adapter,
      executor,
      registry,
      maxTurns: 1,
      modelTimeoutMs: 60,
      modelIdleTimeoutMs: 5_000,
      modelHardCapMs: 5_000,
      summaryTimeoutMs: 50,
    });
    assert.equal(result.stopReason, "timeout");
    assert.equal(
      trace.turns[trace.turns.length - 1]!.cancelKind,
      "timerTimeout"
    );
  });
});

describe("#742 T1: onStream 包装的转发纪律", () => {
  it("包装后的 onStream 原样转发宿主回调(顺序 + 载荷)", async () => {
    const { registry, executor } = harness();
    const adapter = createDeltaAdapter({
      event: { type: "text_delta", text: "ab" },
      everyMs: 15,
      emitCount: 3,
      resolveAfterMs: 150,
      streamMode: true,
    });
    const seen: HarnessStreamEvent[] = [];
    const { result } = await run(
      "x",
      {
        adapter,
        executor,
        registry,
        maxTurns: 1,
        // 今日单钟 40ms:包装缺席时这次调用会被砍掉,转发断言也就无从谈起。
        modelTimeoutMs: 40,
        modelIdleTimeoutMs: 2_000,
        modelHardCapMs: 5_000,
        summaryTimeoutMs: 50,
      },
      undefined,
      { onStream: (event) => seen.push(event) }
    );
    assert.equal(result.stopReason, "completed");
    assert.deepEqual(
      seen.filter((e) => e.type === "text_delta"),
      [
        { type: "text_delta", text: "ab" },
        { type: "text_delta", text: "ab" },
        { type: "text_delta", text: "ab" },
      ]
    );
  });

  it("观察者抛异常被吞咽,且 idle 仍被那次增量重置", async () => {
    const { registry, executor } = harness();
    const adapter = createDeltaAdapter({
      everyMs: 15,
      emitCount: 12,
      resolveAfterMs: 200,
      streamMode: true,
    });
    const { result } = await run(
      "x",
      {
        adapter,
        executor,
        registry,
        maxTurns: 1,
        modelTimeoutMs: 40,
        modelIdleTimeoutMs: 200,
        modelHardCapMs: 5_000,
        summaryTimeoutMs: 50,
      },
      undefined,
      {
        onStream: () => {
          throw new Error("observer blew up");
        },
      }
    );
    assert.equal(result.stopReason, "completed");
    assert.equal(result.finalText, "streamed");
  });

  it("宿主未订阅 onStream 时,adapter 的增量依然重置 idle", async () => {
    const { registry, executor } = harness();
    const adapter = createDeltaAdapter({
      everyMs: 15,
      emitCount: 12,
      resolveAfterMs: 200,
      streamMode: true,
    });
    const { result } = await run("x", {
      adapter,
      executor,
      registry,
      maxTurns: 1,
      modelTimeoutMs: 40,
      modelIdleTimeoutMs: 200,
      modelHardCapMs: 5_000,
      summaryTimeoutMs: 50,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.finalText, "streamed");
  });
});

describe("#742 T1: raceModel 直测的 idle 选项", () => {
  it("idleTimeoutMs 到点 → source timerTimeout(硬顶远未到)", async () => {
    const { registry, executor } = harness();
    const adapter = createDeltaAdapter({
      everyMs: 10,
      emitCount: 1,
      streamMode: true,
    });
    const state = Object.freeze({ messages: Object.freeze([]), turnCount: 0 });
    const deps = Object.freeze({ adapter, executor, registry, maxTurns: 1 });
    const handle = raceModel({
      adapter,
      state,
      deps,
      signal: undefined,
      timeoutMs: 5_000,
      idleTimeoutMs: 60,
    });
    assert.equal((await handle.outcome).source, "timerTimeout");
  });
});
