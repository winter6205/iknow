/**
 * stream-hang-detect T4 (ADR-0111 invariant (b) extension): a worker killed by
 * upstream stream stalling must hand the parent a resumable-transient envelope
 * (reason=modelTransient) — never the "no envelope + SIGKILL → crashed"
 * attribution, and never a lifetime-"timeout" label that hides the hang.
 *
 * The hang shape is produced by the real loop clock-retry machine, not a
 * faked event: a streaming zombie adapter whose step never settles; the idle
 * clock fires with zero deltas and the shared budget resends with
 * detail=invisible_timeout. That resend is the hang fingerprint observable at
 * the worker's `run()` call face, where RunResult only carries
 * stopReason=timeout.
 *
 * Control case: a streaming hard-cap expiry without the idle machine (idle
 * disabled) lands on the same stopReason but with zero resends — it must keep
 * the existing reason=timeout derivation (nonsuccess-stop-mapping invariant),
 * so the reattribution never swallows genuine per-call timeout stops.
 *
 * Short real clocks (idle 20ms, backoff 1ms); no fake timers, no incident
 * wall time.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type {
  LoopAdapter,
  LoopEngineDeps,
} from "../../src/harness/loop-engine.ts";
import { TRANSPORT_MAX_ATTEMPTS } from "../../src/harness/model-adapter/with-transport-retry.ts";
import type { RunResult } from "../../src/harness/model-adapter/types.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import {
  mapStopReasonToEnvelope,
  runWorkerOnce,
} from "../../src/harness/subagent/worker.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";
import { assistantResult } from "../cli/_fixtures.ts";

const BASE_ENVELOPE: WorkerEnvelope = {
  task: "investigate X",
  sandboxRoot: "/tmp/sb",
};

function makeDeps(
  adapter: LoopAdapter,
  extra: Partial<LoopEngineDeps> = {}
): LoopEngineDeps {
  return {
    adapter,
    executor: undefined as never,
    registry: {
      list: () => [],
      get: () => undefined,
    },
    system: () => undefined,
    promptTools: () => [],
    ...extra,
  } as unknown as LoopEngineDeps;
}

/** Zombie streaming adapter: `step` never settles (open connection, silence). */
function zombieAdapter(): {
  readonly adapter: LoopAdapter;
  readonly startedMain: () => number;
} {
  let startedMain = 0;
  const adapter = {
    streamMode: true,
    step: (_state: unknown, request: { tools?: unknown }): Promise<never> => {
      if (request.tools !== undefined) startedMain += 1;
      return new Promise<never>(() => {});
    },
    encodeUserText: (text: string) => ({
      role: "user",
      content: [{ type: "text", text }],
    }),
    encodeToolResults: () => [],
  } as unknown as LoopAdapter;
  return { adapter, startedMain: () => startedMain };
}

describe("subagent worker: 流挂死耗尽 → modelTransient 信封（stream-hang-detect T4）", () => {
  it("不可见挂死耗尽共用预算 → 有信封、reason=modelTransient、stop_reason 观测仍为 timeout", async () => {
    const { adapter, startedMain } = zombieAdapter();
    const env = await runWorkerOnce({
      workerEnvelope: BASE_ENVELOPE,
      deps: makeDeps(adapter, {
        maxTurns: 1,
        modelTimeoutMs: 60_000,
        modelIdleTimeoutMs: 20,
        modelHardCapMs: 60_000,
        summaryTimeoutMs: 20,
        transportRetryDelayMs: () => 1,
      }),
    });

    // 前提：挂死检测确实触发了共用重发机器（非快路径假绿）。
    assert.equal(startedMain(), TRANSPORT_MAX_ATTEMPTS);
    assert.equal(env.status, "failed");
    assert.equal(
      env.reason,
      "modelTransient",
      "耗尽的挂死是上游瞬时可续，不得标成 lifetime timeout 语义"
    );
    assert.equal(env.stop_reason, "timeout");
  });

  it("对照：idle 关闭的流式硬帽超时（零重发）→ 维持 reason=timeout", async () => {
    const { adapter } = zombieAdapter();
    const env = await runWorkerOnce({
      workerEnvelope: BASE_ENVELOPE,
      deps: makeDeps(adapter, {
        maxTurns: 1,
        modelTimeoutMs: 60_000,
        modelHardCapMs: 20,
        summaryTimeoutMs: 20,
        transportRetryDelayMs: () => 1,
      }),
    });

    assert.equal(env.status, "failed");
    assert.equal(env.reason, "timeout");
    assert.equal(env.summary, "per-call model timeout");
    assert.equal(env.stop_reason, "timeout");
  });
});

// ---------------------------------------------------------------------------
// Fingerprint liveness (T4 attribution refinement): the invisible-resend
// fingerprint must be live at settle. An earlier turn's resend-then-progress
// sequence has already settled that call — a later turn's plain (zero-resend)
// timeout must NOT inherit modelTransient from it, or the worker doc's
// per-call-timeout-keeps-timeout contract silently degrades run-wide.
// ---------------------------------------------------------------------------

describe("subagent worker: 指纹按结算时在场归因（跨 turn 不粘滞）", () => {
  it("turn1 曾不可见重发后成功出字 → turn2 已出字再静默零重打到期 → 维持 reason=timeout", async () => {
    const registry = createRegistry([
      createStubTool({ name: "noop", next: () => ({}) }),
    ]);
    let mainCalls = 0;
    const adapter = {
      streamMode: true,
      step: (
        _state: unknown,
        request: {
          tools?: unknown;
          onStream?: (event: { type: "text_delta"; text: string }) => void;
        }
      ): Promise<unknown> => {
        mainCalls += 1;
        if (mainCalls === 1) {
          // turn1 attempt1: open connection, zero deltas → idle resends
          // (the hang fingerprint fires exactly once).
          return new Promise<never>(() => {});
        }
        if (mainCalls === 2) {
          // turn1 attempt2: the call settles with visible tool progress.
          return Promise.resolve(
            assistantResult({
              texts: ["working"],
              toolCalls: [{ id: "call_1", name: "noop", input: {} }],
            })
          );
        }
        // turn2: a visible delta first (progress clears the stale fingerprint),
        // then silence; idle expiry is visible=true → no resend → plain
        // per-call timeout face.
        request.onStream?.({ type: "text_delta", text: "partial " });
        return new Promise<never>(() => {});
      },
      encodeUserText: (text: string) => ({
        role: "user",
        content: [{ type: "text", text }],
      }),
      encodeToolResults: () => [],
    } as unknown as LoopAdapter;
    const env = await runWorkerOnce({
      workerEnvelope: BASE_ENVELOPE,
      deps: makeDeps(adapter, {
        registry,
        executor: createExecutor(registry),
        promptTools: () => registry.list(),
        maxTurns: 4,
        modelTimeoutMs: 60_000,
        modelIdleTimeoutMs: 20,
        modelHardCapMs: 60_000,
        summaryTimeoutMs: 20,
        transportRetryDelayMs: () => 1,
      }),
    });

    // 前提：重发确实在前一 turn 发生过（非假绿）。
    assert.ok(mainCalls >= 3, `step calls=${mainCalls}`);
    assert.equal(env.status, "failed");
    assert.equal(
      env.reason,
      "timeout",
      "前一 turn 的 invisible 重发不得跨 turn 粘滞到后一 turn 的零重发 timeout"
    );
    assert.equal(env.summary, "per-call model timeout");
    assert.equal(env.stop_reason, "timeout");
  });
});

// ---------------------------------------------------------------------------
// mapStopReasonToEnvelope — the extracted derivation chain, direct-call
// coverage of the T4 branch and its neighbors (behavior pinned at the pure
// function, not only through a whole run()).
// ---------------------------------------------------------------------------

function fakeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    finalText: null,
    messages: [],
    turnCount: 1,
    stopReason: "completed",
    lastUsage: null,
    ...overrides,
  } as RunResult;
}

describe("mapStopReasonToEnvelope: stopReason→信封纯映射", () => {
  const obs = { observability: {} };

  it("timeout + 在场指纹 → modelTransient（挂死耗尽），stop_reason 仍为 timeout", () => {
    const env = mapStopReasonToEnvelope(
      fakeResult({ stopReason: "timeout" }),
      { ...obs, sawInvisibleStallResend: true }
    );
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "modelTransient");
    assert.equal(env.summary, "stream stalled; invisible-clock resend budget exhausted");
    assert.equal(env.stop_reason, "timeout");
  });

  it("timeout + 无指纹 → 维持 per-call timeout 归因", () => {
    const env = mapStopReasonToEnvelope(
      fakeResult({ stopReason: "timeout" }),
      { ...obs, sawInvisibleStallResend: false }
    );
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "timeout");
    assert.equal(env.summary, "per-call model timeout");
    assert.equal(env.stop_reason, "timeout");
  });

  it("protocolError apiError 分流不变：present→modelTransient / absent→protocolError", () => {
    const transient = mapStopReasonToEnvelope(
      fakeResult({ stopReason: "protocolError", apiError: { message: "x" } }),
      { ...obs, sawInvisibleStallResend: false }
    );
    assert.equal(transient.reason, "modelTransient");
    const real = mapStopReasonToEnvelope(
      fakeResult({ stopReason: "protocolError" }),
      { ...obs, sawInvisibleStallResend: false }
    );
    assert.equal(real.reason, "protocolError");
  });

  it("fused / nonSuccessStop → protocolError；completed 且无指纹 → ok 信封不变", () => {
    assert.equal(
      mapStopReasonToEnvelope(fakeResult({ stopReason: "fused" }), {
        ...obs,
        sawInvisibleStallResend: false,
      }).reason,
      "protocolError"
    );
    assert.equal(
      mapStopReasonToEnvelope(fakeResult({ stopReason: "nonSuccessStop" }), {
        ...obs,
        sawInvisibleStallResend: false,
      }).reason,
      "protocolError"
    );
    const ok = mapStopReasonToEnvelope(
      fakeResult({ stopReason: "completed", finalText: "done" }),
      { ...obs, sawInvisibleStallResend: false }
    );
    assert.equal(ok.status, "ok");
    assert.equal(ok.summary, "done");
  });
});
