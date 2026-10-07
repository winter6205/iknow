/**
 * Stream-hang detection contract (stream-hang-detect T2/T3), loop level:
 * a real streaming attempt whose connection stays open with zero harness
 * increments and no end event must END inside the configured idle, and the
 * resend path must run through the existing shared budget
 * (`classifyClockRetry` + `TRANSPORT_MAX_ATTEMPTS`) — never a second retry
 * machine, never a bare throw, and no hung `step` promise left dangling
 * past the clock.
 *
 * Assembly is the product shape: real `createRealAnthropicAdapter` over a
 * zombie fake client (finalMessage never settles) wrapped in
 * `withTransportRetry`, driven by `run()` with short clocks (no 300s wall
 * time in cases). The landed-count assertion is the hang detector's ground
 * truth: before the fix, aborted zombie attempts never settle.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { Message as SdkMessage } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { run } from "../../src/harness/loop-engine.ts";
import type { LoopAdapter } from "../../src/harness/loop-engine.ts";
import {
  createRealAnthropicAdapter,
  translateAnthropicTransportFault,
} from "../../src/harness/model-adapter/anthropic-adapter.ts";
import {
  TRANSPORT_MAX_ATTEMPTS,
  withTransportRetry,
} from "../../src/harness/model-adapter/with-transport-retry.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";

function harness() {
  const registry = createRegistry([
    createStubTool({ name: "noop", next: () => ({}) }),
  ]);
  return { registry, executor: createExecutor(registry) };
}

type ZombieClientOpts = {
  /** one visible model-output increment delivered once listeners are wired,
   *  then the stream goes silent forever (which face: text / thinking /
   *  tool-input delta — all three are in the resetsModelIdle closed set) */
  readonly visibleProgress?: "text" | "thinking" | "tool_input";
};

/**
 * Zombie streaming client: the connection stays open — `finalMessage()`
 * never settles (not on data, not on abort), matching the incident shape
 * (open connection, 0 tokens, no end event). `visibleProgress` reproduces
 * the "already produced output, then silence" variants through the SDK
 * event surfaces the real adapter wires (`on("text")` for text deltas,
 * `on("streamEvent")` for thinking / input_json content_block deltas —
 * tool_input additionally needs the content_block_start tool_use block so
 * the delta can pair an id).
 */
function zombieStreamClient(opts: ZombieClientOpts) {
  return {
    messages: {
      create: (): never => {
        throw new Error("create must not be called in stream arm");
      },
      stream: () => {
        const textListeners: Array<(t: string, s: string) => void> = [];
        const streamEventListeners: Array<(e: unknown, s: unknown) => void> =
          [];
        const final = new Promise<SdkMessage>(() => {
          // never settles: hung connection
        });
        if (opts.visibleProgress !== undefined) {
          const kind = opts.visibleProgress;
          queueMicrotask(() => {
            const partial = {
              id: "msg_z",
              type: "message",
              role: "assistant",
            } as unknown as SdkMessage;
            if (kind === "text") {
              for (const l of textListeners) l("partial ", "");
              return;
            }
            if (kind === "thinking") {
              const event = {
                type: "content_block_delta",
                index: 0,
                delta: { type: "thinking_delta", thinking: "hmm" },
              };
              for (const l of streamEventListeners) l(event, partial);
              return;
            }
            // tool_input: wireStreamEvents pairs input_json_delta by the
            // block id registered at content_block_start(tool_use).
            for (const l of streamEventListeners) {
              l(
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: {
                    type: "tool_use",
                    id: "call_z",
                    name: "noop",
                    input: {},
                  },
                },
                partial
              );
              l(
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "input_json_delta", partial_json: "{" },
                },
                partial
              );
            }
          });
        }
        return {
          on: (event: string, listener: (...args: unknown[]) => void) => {
            if (event === "text") {
              textListeners.push(listener as (t: string, s: string) => void);
            } else if (event === "streamEvent") {
              streamEventListeners.push(listener);
            }
          },
          finalMessage: () => final,
        };
      },
    },
  } as unknown as Parameters<typeof createRealAnthropicAdapter>[0]["client"];
}

/**
 * Product assembly with per-call landing bookkeeping: main-loop attempts
 * (request carries tools) vs the tools-less closing-summary call. `landed`
 * counts step promises that actually settled — a hung zombie that survives
 * abort keeps this below `started`.
 */
function zombieAssembly(opts: ZombieClientOpts): {
  readonly adapter: LoopAdapter;
  readonly started: () => number;
  readonly landed: () => number;
  readonly startedMain: () => number;
} {
  const real = createRealAnthropicAdapter({
    client: zombieStreamClient(opts),
    model: "claude-test-model",
    maxTokens: 256,
    stream: true,
  });
  let started = 0;
  let startedMain = 0;
  let landed = 0;
  const tracked: LoopAdapter = {
    ...real,
    step: (state, request, signal) => {
      started += 1;
      if ((request as { tools?: unknown }).tools !== undefined) {
        startedMain += 1;
      }
      const p = real.step(state, request, signal);
      p.then(
        () => (landed += 1),
        () => (landed += 1)
      );
      return p;
    },
  };
  const adapter = withTransportRetry(tracked, {
    translate: translateAnthropicTransportFault,
  }) as LoopAdapter;
  return {
    adapter,
    started: () => started,
    landed: () => landed,
    startedMain: () => startedMain,
  };
}

describe("挂死 attempt 在 idle 内结束并走共用预算（stream-hang-detect T2/T3）", () => {
  it("空流挂死 visible=false：attempt 恰为预算上限、全部 step 落地、干净 timeout、不进权威历史", async () => {
    const { registry, executor } = harness();
    const { adapter, started, landed, startedMain } = zombieAssembly({});
    const seen: HarnessStreamEvent[] = [];
    const { result, trace } = await run(
      "x",
      {
        adapter,
        executor,
        registry,
        maxTurns: 1,
        modelTimeoutMs: 5_000,
        modelIdleTimeoutMs: 60,
        modelHardCapMs: 5_000,
        summaryTimeoutMs: 50,
        transportRetryDelayMs: () => 1,
      },
      undefined,
      { onStream: (event) => seen.push(event) }
    );
    assert.equal(result.stopReason, "timeout");
    // 共用预算：首个不可见 attempt + 4 次重发 = 上限，无第 6 次。
    assert.equal(startedMain(), TRANSPORT_MAX_ATTEMPTS);
    // 挂死检测的 ground truth：每个被时钟掐掉的 step promise 都已落地。
    assert.equal(landed(), started());
    // 重发走的是现有 classifyClockRetry 机器（invisible_timeout 进度事件）。
    const retries = seen.filter((e) => e.type === "transport_retry");
    assert.equal(retries.length, TRANSPORT_MAX_ATTEMPTS - 1);
    assert.ok(
      retries.every(
        (e) => e.type === "transport_retry" && e.detail === "invisible_timeout"
      )
    );
    // 整 step 不进权威历史：无 assistant。
    assert.ok(result.messages.every((m) => m.role !== "assistant"));
    assert.equal(
      trace.turns[trace.turns.length - 1]!.cancelKind,
      "timerTimeout"
    );
  });

  // All three faces of the resetsModelIdle closed set that a streaming
  // attempt can deliver (text / thinking / tool-input delta): whichever
  // one lands, the later silence is a visible=true expiry — zero resend.
  for (const kind of ["text", "thinking", "tool_input"] as const) {
    it(`已出增量(${kind})后静默挂死 visible=true：零自动重打，挂死 attempt 同样落地`, async () => {
      const { registry, executor } = harness();
      const { adapter, started, landed, startedMain } = zombieAssembly({
        visibleProgress: kind,
      });
      const seen: HarnessStreamEvent[] = [];
      const { result, trace } = await run(
        "x",
        {
          adapter,
          executor,
          registry,
          maxTurns: 1,
          modelTimeoutMs: 5_000,
          // idle 预算需明显大于增量送达时间，否则退化为不可见重发。
          modelIdleTimeoutMs: 200,
          modelHardCapMs: 5_000,
          summaryTimeoutMs: 50,
          transportRetryDelayMs: () => 1,
        },
        undefined,
        { onStream: (event) => seen.push(event) }
      );
      assert.equal(result.stopReason, "timeout");
      assert.equal(startedMain(), 1, "已出字的 attempt 不得重发");
      assert.equal(landed(), started(), "挂死 attempt 在 abort 时必须落地");
      assert.equal(seen.filter((e) => e.type === "transport_retry").length, 0);
      assert.equal(
        trace.turns[trace.turns.length - 1]!.cancelKind,
        "timerTimeout"
      );
    });
  }

  it("run 收敛时（含收尾 summary 被掐）不留悬空 step promise", async () => {
    const { registry, executor } = harness();
    const { adapter, started, landed } = zombieAssembly({});
    await run(
      "x",
      {
        adapter,
        executor,
        registry,
        maxTurns: 1,
        modelTimeoutMs: 5_000,
        modelIdleTimeoutMs: 40,
        modelHardCapMs: 5_000,
        summaryTimeoutMs: 40,
        transportRetryDelayMs: () => 1,
      },
      undefined,
      { onStream: () => {} }
    );
    // 主循环预算 attempt + 一次收尾 summary 调用都必须落地。
    assert.equal(started(), TRANSPORT_MAX_ATTEMPTS + 1);
    assert.equal(landed(), started());
  });
});
