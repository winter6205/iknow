/**
 * Idle-reset clock + finite hard cap for streaming-arm model calls, as owned
 * by loop-engine.
 *
 * Contract (docs/CONTEXT.md "model-call idle"):
 *   - idle is enabled only on the streaming arm (adapter.streamMode);
 *     `stream=off` behaves exactly like the pre-change single clock;
 *   - both idle and hard cap land on the existing `StopReason: timeout`
 *     (cancelKind `timerTimeout`) — no new stop reasons;
 *   - user abort still wins as `cancelled` (signal takes priority);
 *   - the wrapped `onStream` must forward verbatim to the host callback, and
 *     observer exceptions keep being swallowed by safeEmitStream without
 *     flowing back into the model turn.
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
 * Local stand-in: the first step pushes deltas to `request.onStream` at a
 * fixed cadence; with `resolveAfterMs` absent it never settles (the two clocks
 * decide). Second and later steps are run()'s closing-summary turns returning
 * empty text immediately so the summary doesn't slow cases down. The emit is
 * wrapped in try/catch to match the stub-model discipline (a stand-in must not
 * let observer exceptions flow back).
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
          // The stand-in honors the no-backflow rule: observer exceptions must not break the model turn.
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
      // Single legacy clock at 40ms — pre-change it would have cut this still-producing call at 40ms.
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
      // streamMode absent = stream=off / offline stand-in.
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
        // Single clock at 40ms: without the wrapping this call would be cut off and the forwarding assertions moot.
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
 * specs/transport-continue-persist.md invariant 1:
 * invisible idle expiry -> the whole call is re-dispatched (at least once);
 * already-produced output -> never re-dispatched.
 *
 * Stand-in discipline: `createDeltaAdapter`'s first step never settles (the
 * clocks decide) and later steps return the closing summary. To verify a real
 * re-dispatch the next race must be able to settle after the clock fires, so
 * `createStallAdapter` is used: step #1 hangs forever, step #2 succeeds
 * immediately — the true shape of "re-send after a stalled connection".
 */
function createStallAdapter(opts: {
  readonly emitFirstAttempt?: HarnessStreamEvent;
  readonly firstAttemptEveryMs?: number;
  /** Finite emit count on the first attempt: only "output then silence again" lets idle actually expire. */
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
      // Count main-loop calls only: after an abnormal stop, the best-effort
      // summary turn gets a tools-less request (runSummaryWithTimeout's
      // request = {}), which carries no "re-dispatch" semantics.
      if (request.tools === undefined) {
        return assistantResult({ texts: [], supplierStop: "success" });
      }
      calls += 1;
      if (calls > 1) {
        // Re-dispatch succeeded: it must carry text to land as completed (empty text would be flagged emptyFinalResponse).
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
            // No backflow: observer exceptions must not break the stream.
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
    // Step 1 stalls → idle expires → re-dispatch; step 2 succeeds immediately → completed.
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
      // Finite deltas: after output goes silent again, idle can expire (otherwise deltas keep resetting idle).
      firstAttemptEmitTicks: 2,
    });
    const { result, trace } = await run("x", {
      adapter,
      executor,
      registry,
      maxTurns: 1,
      modelTimeoutMs: 5_000,
      // The idle budget must comfortably exceed "delta delivery + rescheduling"
      // time: this case asserts "already-produced output is not re-dispatched".
      // If delta delivery were slower than idle expiry, the verdict would
      // degrade into invisible re-send and stop testing this invariant
      // (calls()===2 was once reproducible under load).
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
    // Every step stalls: idle expires → re-send, until the budget is exhausted.
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
        // Count main-loop calls only (summary turns have no tools in request).
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
      // transport-continue-persist: the backoff table defaults to seconds; tests compress it to 1ms so cases finish in seconds (the table itself is pinned by transport-retry.test.ts).
      transportRetryDelayMs: () => 1,
    });
    // Budget 5: first attempt + 4 re-sends all exhausted → timeout, no 6th.
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
        // Count main-loop calls only (summary turns have no tools in request).
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
        // Stretch the backoff long enough that the abort lands inside the backoff window, not mid-attempt.
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
   * timerTimeout outcomes must carry `clockAbort`, and it must be the exact
   * same value stamped on `childSignal.reason` (`onExpire` aborts first, then
   * settles) — the re-send decision consumes the former and the translate
   * layer the latter; a fork would let "which clock fired" and "what got
   * classified" disagree.
   *
   * Both `source` values are pinned here deliberately: `source` is not an
   * input to `classifyFault` (see `FaultEvent.clock_timeout`), so reading the
   * wrong value never surfaces there — only this direct assertion catches an
   * idle / hardCap swap.
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

    // No deltas → idle fires first: source is idle, visible=false (the re-sendable cell).
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

    // Deltas keep resetting idle → the hard cap fires first: source is hardCap, visible=true.
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
