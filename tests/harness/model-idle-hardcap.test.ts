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
import { TRANSPORT_MAX_ATTEMPTS } from "../../src/harness/model-adapter/with-transport-retry.ts";
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

/**
 * transport-continue-persist T1 / spec inv 1 + SC1:
 * 不可见 idle 到点 → 整次调用重发(至少一次);已出字 → 不重发。
 *
 * 替身纪律:`createDeltaAdapter` 首个 step 永不 settle(交给两根钟裁决),
 * 第二及之后的 step 返回收尾摘要空文本。要验「重发」必须让第一根钟到点后
 * 下一次 race 真能 settle,故用 `createStallAdapter`:第 1 次 step 永不 settle
 * (卡死),第 2 次 step 立刻成功 —— 这正是「连接卡死后重发」的真实形态。
 */
function createStallAdapter(opts: {
  readonly emitFirstAttempt?: HarnessStreamEvent;
  readonly firstAttemptEveryMs?: number;
  /** 首发增量次数;有限次才有「出字之后重新静默」→ idle 真能到点。 */
  readonly firstAttemptEmitTicks?: number;
  readonly streamMode?: boolean;
  readonly firstAttemptResolveAfterMs?: number;
}): { readonly adapter: LoopAdapter; readonly calls: () => number } {
  let calls = 0;
  const adapter: LoopAdapter = Object.freeze({
    ...(opts.streamMode === true ? { streamMode: true } : {}),
    encodeUserText: (text: string) => makeNative("user", text),
    encodeToolResults: () => [],
    step: async (
      _state: LoopState,
      request: {
        tools?: unknown;
        onStream?: (event: HarnessStreamEvent) => void;
      },
      signal?: AbortSignal
    ) => {
      // 只计主回路调用:异常停后 best-effort 收尾摘要轮 request 无 tools
      // (runSummaryWithTimeout 的 request = {}),它换不来「重发」的语义。
      if (request.tools === undefined) {
        return assistantResult({ texts: [], supplierStop: "success" });
      }
      calls += 1;
      if (calls > 1) {
        // 重发成功:带文本才落 completed(空文本会被判 emptyFinalResponse)。
        return assistantResult({ texts: ["retried"], supplierStop: "success" });
      }
      let ticker: ReturnType<typeof setInterval> | undefined;
      if (opts.emitFirstAttempt !== undefined) {
        const maxTicks = opts.firstAttemptEmitTicks ?? Number.MAX_SAFE_INTEGER;
        let ticks = 0;
        ticker = setInterval(() => {
          if (ticks >= maxTicks) {
            if (ticker !== undefined) clearInterval(ticker);
            return;
          }
          ticks += 1;
          try {
            request.onStream?.(opts.emitFirstAttempt!);
          } catch {
            // D3:观察者异常不得反流。
          }
        }, opts.firstAttemptEveryMs ?? 5);
      }
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
          if (opts.firstAttemptResolveAfterMs !== undefined) {
            setTimeout(resolve, opts.firstAttemptResolveAfterMs);
          }
        });
      } finally {
        if (ticker !== undefined) clearInterval(ticker);
      }
      return assistantResult({ texts: ["late"] });
    },
  });
  return { adapter, calls: () => calls };
}

describe("transport-continue-persist T1: 不可见 idle 可重试", () => {
  it("SC1: 无任何增量 + idle 到点 → 重发整次调用(第二次成功)", async () => {
    const { registry, executor } = harness();
    const { adapter, calls } = createStallAdapter({ streamMode: true });
    const { result } = await run("x", {
      adapter,
      executor,
      registry,
      maxTurns: 1,
      modelTimeoutMs: 5_000,
      modelIdleTimeoutMs: 40,
      modelHardCapMs: 5_000,
      summaryTimeoutMs: 50,
    });
    // 第一次 step 卡死 → idle 到点 → 重发;第二次 step 立即成功 → completed。
    assert.equal(calls(), 2);
    assert.equal(result.stopReason, "completed");
  });

  it("不可见 idle 重发时向宿主发 transport_retry 事件(进度可见)", async () => {
    const { registry, executor } = harness();
    const { adapter } = createStallAdapter({ streamMode: true });
    const seen: HarnessStreamEvent[] = [];
    const { result } = await run(
      "x",
      {
        adapter,
        executor,
        registry,
        maxTurns: 1,
        modelTimeoutMs: 5_000,
        modelIdleTimeoutMs: 40,
        modelHardCapMs: 5_000,
        summaryTimeoutMs: 50,
      },
      undefined,
      { onStream: (event) => seen.push(event) }
    );
    assert.equal(result.stopReason, "completed");
    const retries = seen.filter((e) => e.type === "transport_retry");
    assert.equal(retries.length, 1);
    assert.deepEqual(retries[0], {
      type: "transport_retry",
      attempt: 1,
      maxAttempts: TRANSPORT_MAX_ATTEMPTS,
      detail: "invisible_timeout",
    });
  });

  it("可见增量之后 idle 到点 → 不重发,落 timeout(timerTimeout)", async () => {
    const { registry, executor } = harness();
    const { adapter, calls } = createStallAdapter({
      streamMode: true,
      emitFirstAttempt: THINKING,
      firstAttemptEveryMs: 10,
      // 有限次增量:出字之后重新静默,idle 才会到点(否则增量一路重置 idle)。
      firstAttemptEmitTicks: 2,
    });
    const { result, trace } = await run("x", {
      adapter,
      executor,
      registry,
      maxTurns: 1,
      modelTimeoutMs: 5_000,
      // idle 预算必须显著大于"增量送达 + 重排"的耗时:该用例断言的是
      // 「已出字不重发」,若增量投递慢于 idle 到点,判据会退化成不可见重发,
      // 测的就不是这条不变式了(负载下曾复现 calls()===2)。
      modelIdleTimeoutMs: 400,
      modelHardCapMs: 5_000,
      summaryTimeoutMs: 50,
    });
    assert.equal(calls(), 1, "已出字的 attempt 不得重发");
    assert.equal(result.stopReason, "timeout");
    assert.equal(
      trace.turns[trace.turns.length - 1]!.cancelKind,
      "timerTimeout"
    );
  });

  it("退避后仍不可见 → 有界重发,第 5 次尝试耗尽仍落 timeout", async () => {
    const { registry, executor } = harness();
    // 每次 step 都卡死:idle 到点 → 重发,直到预算耗尽。
    let calls = 0;
    const adapter: LoopAdapter = Object.freeze({
      streamMode: true,
      encodeUserText: (text: string) => makeNative("user", text),
      encodeToolResults: () => [],
      step: async (
        _state: LoopState,
        request: { tools?: unknown },
        signal?: AbortSignal
      ) => {
        // 只计主回路调用(摘要轮 request 无 tools)。
        if (request.tools === undefined) {
          return assistantResult({ texts: [], supplierStop: "success" });
        }
        calls += 1;
        await new Promise<void>((_resolve, reject) => {
          const onAbort = (): void =>
            reject(
              new DOMException("This operation was aborted", "AbortError")
            );
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        return assistantResult({ texts: ["unreachable"] });
      },
    });
    const { result, trace } = await run("x", {
      adapter,
      executor,
      registry,
      maxTurns: 1,
      modelTimeoutMs: 5_000,
      modelIdleTimeoutMs: 20,
      modelHardCapMs: 5_000,
      summaryTimeoutMs: 50,
      // transport-continue-persist T1:退避表默认秒级,测试里压到 1ms
      // 保持用例秒级完成(退避表本身由 transport-retry.test.ts 钉死)。
      transportRetryDelayMs: () => 1,
    });
    // 预算 5:第 1 次 + 4 次重发全部耗尽 → timeout,不再第 6 次。
    assert.equal(calls, TRANSPORT_MAX_ATTEMPTS);
    assert.equal(result.stopReason, "timeout");
    assert.equal(
      trace.turns[trace.turns.length - 1]!.cancelKind,
      "timerTimeout"
    );
  });

  it("退避窗口内宿主 abort → cancelled,不再发起下一次 attempt", async () => {
    const { registry, executor } = harness();
    let calls = 0;
    const adapter: LoopAdapter = Object.freeze({
      streamMode: true,
      encodeUserText: (text: string) => makeNative("user", text),
      encodeToolResults: () => [],
      step: async (
        _state: LoopState,
        request: { tools?: unknown },
        signal?: AbortSignal
      ) => {
        // 只计主回路调用(摘要轮 request 无 tools)。
        if (request.tools === undefined) {
          return assistantResult({ texts: [], supplierStop: "success" });
        }
        calls += 1;
        await new Promise<void>((_resolve, reject) => {
          const onAbort = (): void =>
            reject(
              new DOMException("This operation was aborted", "AbortError")
            );
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        return assistantResult({ texts: ["unreachable"] });
      },
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
        modelIdleTimeoutMs: 20,
        modelHardCapMs: 5_000,
        summaryTimeoutMs: 50,
        // 退避拉到足够长,确保 abort 落在退避窗口内而非下一次 attempt 中。
        transportRetryDelayMs: () => 5_000,
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 60);
    const { result } = await pending;
    assert.equal(calls, 1, "abort 之后不得再发起 attempt");
    assert.equal(result.stopReason, "cancelled");
  });

  it("非流式臂:配了 idle 也只走今日单钟,不因不可见而重发", async () => {
    const { registry, executor } = harness();
    const { adapter, calls } = createStallAdapter({});
    const { result } = await run("x", {
      adapter,
      executor,
      registry,
      maxTurns: 1,
      modelTimeoutMs: 40,
      modelIdleTimeoutMs: 5_000,
      modelHardCapMs: 5_000,
      summaryTimeoutMs: 50,
      transportRetryDelayMs: () => 1,
    });
    assert.equal(calls(), 1, "非流式臂的请求墙钟超时不进入 idle 重发");
    assert.equal(result.stopReason, "timeout");
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

  /**
   * transport-continue-persist T1:timerTimeout 支必带 `clockAbort`,且它与
   * 刻在 `childSignal.reason` 上的是**同一个值**(`onExpire` 先 abort 再
   * settle)—— 重发判定消费前者、translate 层消费后者,分叉会让「谁到点」
   * 与「谁被归类」各说各话。
   *
   * `source` 两值都钉死,是因为它刻意**不参与** `classifyFault`(见
   * `FaultEvent.clock_timeout`),读错值不会在 classify 处露头:只有这里
   * 直接断言才拦得住 idle / hardCap 互换。
   */
  it("clockAbort 与 childSignal.reason 同值:两根钟各自的 source 都带到 outcome", async () => {
    const { registry, executor } = harness();
    const state = Object.freeze({ messages: Object.freeze([]), turnCount: 0 });
    const raceOnce = async (opts: {
      readonly idleTimeoutMs: number;
      readonly hardCapMs: number;
      readonly emitCount: number;
    }) => {
      const adapter = createDeltaAdapter({
        everyMs: 10,
        emitCount: opts.emitCount,
        streamMode: true,
      });
      const deps = Object.freeze({ adapter, executor, registry, maxTurns: 1 });
      const handle = raceModel({
        adapter,
        state,
        deps,
        signal: undefined,
        timeoutMs: opts.hardCapMs,
        idleTimeoutMs: opts.idleTimeoutMs,
      });
      const outcome = await handle.outcome;
      assert.equal(outcome.source, "timerTimeout");
      assert.ok(
        outcome.source === "timerTimeout",
        "收窄失败会让下面的 clockAbort 读不成"
      );
      return { outcome, reason: handle.childSignal.reason as unknown };
    };

    // 无增量 → idle 先到点:source 是 idle,visible=false(可重发那格)。
    const idle = await raceOnce({
      idleTimeoutMs: 40,
      hardCapMs: 5_000,
      emitCount: 0,
    });
    assert.deepEqual(idle.outcome.clockAbort, {
      kind: "clock_abort",
      source: "idle",
      visible: false,
    });
    assert.deepEqual(idle.reason, idle.outcome.clockAbort);

    // 增量持续重置 idle → 硬顶先到点:source 是 hardCap,visible=true。
    const hard = await raceOnce({
      idleTimeoutMs: 5_000,
      hardCapMs: 60,
      emitCount: Number.MAX_SAFE_INTEGER,
    });
    assert.deepEqual(hard.outcome.clockAbort, {
      kind: "clock_abort",
      source: "hardCap",
      visible: true,
    });
    assert.deepEqual(hard.reason, hard.outcome.clockAbort);
  });
});
