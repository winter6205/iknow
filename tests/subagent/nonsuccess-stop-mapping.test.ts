/**
 * Non-success stop reasons must map to a failed envelope.
 *
 * Pins the real envelope shape for "sub-agent fails inside a normal task".
 *
 * worker.ts discipline: run() returning normally ≠ success — harness protocol
 * errors / empty final responses come back as a stopReason (no throw), but the
 * worker must still mark failed, otherwise the parent's drain sees ok +
 * protocolError and misjudges the child as successful. That rule only covered
 * `fused` / `protocolError` / `emptyFinalResponse`; two more non-success stop
 * reasons leaked past it straight into `toOkEnvelope`:
 *   - `nonSuccessStop` — supplier `stop_reason: "max_tokens"` (token cap hit;
 *     mapped by anthropic-adapter to `supplierStop: "truncation"`);
 *   - `timeout` — per-call model race expiry (loop-engine `timerTimeout`).
 *
 * Both must yield `status:"failed"`, else the parent-side manager migrates to
 * `completed` on `env.status === "ok"`.
 *
 * Hermetic: only `runWorkerOnce` + stub-model; avoids `createWorkerDeps` /
 * `createDefaultAciRegistry` (that chain needs bwrap at assembly time and is
 * on the CI --exclude list).
 */
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { runWorkerOnce } from "../../src/harness/subagent/worker.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";

/** Same shape as worker.test.ts makeDeps: placeholder registry/executor, short run path. */
function makeDeps(adapter: LoopEngineDeps["adapter"]): LoopEngineDeps {
  return {
    adapter,
    executor: undefined as never,
    registry: {
      list: () => [],
      get: () => undefined,
    },
    system: () => undefined,
    promptTools: () => [],
  } as unknown as LoopEngineDeps;
}

const BASE_ENVELOPE: WorkerEnvelope = {
  task: "investigate X",
  sandboxRoot: "/tmp/sb",
};

describe("subagent worker: 非成功停因 → 信封状态 (Phase 4 修复)", () => {
  it("token 帽撞顶 (supplierStop=truncation) 不得报成 ok", async () => {
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: ["partial answer cut off at max_tokens"],
          supplierStop: "truncation",
        }),
      ],
    });
    const env = await runWorkerOnce({
      workerEnvelope: BASE_ENVELOPE,
      deps: makeDeps(adapter),
    });

    assert.equal(
      env.stop_reason,
      "nonSuccessStop",
      "前提: max_tokens 截断走 stopReason=nonSuccessStop"
    );
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "protocolError");
    assert.equal(env.summary, "nonSuccessStop (e.g. truncation)");
  });

  it("token 帽撞顶且无可用文本 (thinking 吃光预算) 不得报成 ok", async () => {
    const adapter = createStubModel({
      responses: [assistantResult({ texts: [], supplierStop: "truncation" })],
    });
    const env = await runWorkerOnce({
      workerEnvelope: BASE_ENVELOPE,
      deps: makeDeps(adapter),
    });

    assert.equal(env.stop_reason, "nonSuccessStop");
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "protocolError");
    assert.ok(env.summary.length > 0);
  });

  it("per-call 模型调用竞速到点 (stopReason=timeout) 不得报成 ok", async () => {
    vi.useFakeTimers();
    try {
      // deps.timeoutMs = per-call race (the per-task lifetime of
      // envelope.timeoutMs is not involved — see applyEnvelopeOverrides). The
      // stub outlives the race window → run() returns stopReason="timeout",
      // and that abort is not SIGTERM (the reason on controller.signal is not
      // "subagent-timeout"), so the existing graceful-finish branch is skipped.
      const adapter = {
        ...createStubModel({
          responses: [assistantResult({ texts: ["late answer"] })],
          delayMs: 400_000,
        }),
        streamMode: true,
      };
      const p = runWorkerOnce({
        workerEnvelope: BASE_ENVELOPE,
        deps: { ...makeDeps(adapter), timeoutMs: 300_000 },
      });
      // let run's initial microtasks (system?.() / raceModel timer registration) settle first
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500_000);
      const env = await p;

      assert.equal(env.stop_reason, "timeout", "前提: 竞速到点落 timeout");
      assert.equal(env.status, "failed");
      assert.equal(env.reason, "timeout");
      assert.equal(env.summary, "per-call model timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("negative: refusal supplier stop with text is failed, not ok", async () => {
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: ["I cannot comply with that request."],
          supplierStop: "refusal",
        }),
      ],
    });
    const env = await runWorkerOnce({
      workerEnvelope: BASE_ENVELOPE,
      deps: makeDeps(adapter),
    });

    assert.equal(env.stop_reason, "nonSuccessStop");
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "protocolError");
    assert.ok(env.summary.length > 0);
  });

  it("overflow: long partial text with truncation is failed", async () => {
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: ["partial output ".repeat(2_000)],
          supplierStop: "truncation",
        }),
      ],
    });
    const env = await runWorkerOnce({
      workerEnvelope: BASE_ENVELOPE,
      deps: makeDeps(adapter),
    });

    assert.equal(env.stop_reason, "nonSuccessStop");
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "protocolError");
  });

  it("concurrent: two non-success runs both produce failed envelopes", async () => {
    const [first, second] = await Promise.all(
      [1, 2].map(() =>
        runWorkerOnce({
          workerEnvelope: BASE_ENVELOPE,
          deps: makeDeps(
            createStubModel({
              responses: [
                assistantResult({
                  texts: ["partial"],
                  supplierStop: "truncation",
                }),
              ],
            })
          ),
        })
      )
    );

    assert.equal(first.status, "failed");
    assert.equal(first.reason, "protocolError");
    assert.equal(first.stop_reason, "nonSuccessStop");
    assert.equal(second.status, "failed");
    assert.equal(second.reason, "protocolError");
    assert.equal(second.stop_reason, "nonSuccessStop");
  });

  it("exception: MaxTurnsExceeded remains maxTurnsExceeded", async () => {
    const adapter = createStubModel({ responses: [] });
    const env = await runWorkerOnce({
      workerEnvelope: BASE_ENVELOPE,
      deps: { ...makeDeps(adapter), maxTurns: 0 },
    });

    assert.equal(env.status, "failed");
    assert.equal(env.reason, "maxTurnsExceeded");
  });

  it("truncation carrying tool_use: still failed, no tool runs, no summary round", async () => {
    // The worker's only closing-summary call is the SIGTERM-timeout epilogue
    // (reason "timeout"), so a truncation has no summary path at all; run()
    // itself must not request one either.
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: ["partial answer cut off at max_tokens"],
          toolCalls: [{ id: "toolu_a", name: "echo", input: {} }],
          supplierStop: "truncation",
        }),
        assistantResult({
          texts: ["summary that must never be requested"],
          supplierStop: "success",
        }),
      ],
    });
    const env = await runWorkerOnce({
      workerEnvelope: BASE_ENVELOPE,
      deps: makeDeps(adapter),
    });

    assert.equal(env.status, "failed");
    assert.equal(env.stop_reason, "nonSuccessStop");
  });
});
