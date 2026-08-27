/**
 * GREEN (systematic-debugging Phase 4 / FIX) — 非成功停因必须映射为失败信封。
 *
 * 复现目标:钉死「正常任务里子代理失败」在信封层的真实形态。
 *
 * `runWorkerOnce` 自己的纪律(worker.ts 注释)是:
 *   「run() 正常返回 ≠ 成功: harness 协议层错误 / 空最终回应以 stopReason
 *     形态返回(不 throw), 但 worker 必须标 failed —— 父代理 drain 收到 ok
 *     却带 protocolError stopReason 会误判子代理成功」
 *
 * 该纪律只覆盖了 `fused` / `protocolError` / `emptyFinalResponse` 三值。
 * 另外两个非成功停因漏在门外,直接落到 `toOkEnvelope`:
 *   - `nonSuccessStop` —— 供应商 `stop_reason: "max_tokens"`(token 帽撞顶,
 *     经 anthropic-adapter 映射为 `supplierStop: "truncation"`);
 *   - `timeout` —— per-call 模型调用竞速到点(loop-engine `timerTimeout`)。
 *
 * 两者都必须产出 `status:"failed"`，否则父侧 manager 会按
 * `env.status === "ok"` 直接迁移到 `completed`。
 *
 * 本文件保持 hermetic:只走 `runWorkerOnce` + stub-model,不碰
 * `createWorkerDeps` / `createDefaultAciRegistry`(那条链装配期要 bwrap,
 * 须进 CI --exclude 名单)。
 */
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { runWorkerOnce } from "../../src/harness/subagent/worker.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";

/** 与 worker.test.ts 的 makeDeps 同形态:占位 registry/executor,run 短链。 */
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
      // deps.timeoutMs = per-call 竞速(envelope.timeoutMs 的 per-task 寿命
      // 不参与,见 applyEnvelopeOverrides / D8)。stub 拖过竞速窗口 → run()
      // 返回 stopReason="timeout",且该 abort 不是 SIGTERM(controller.signal
      // 的 reason 不是 "subagent-timeout"),故不走既有的优雅收尾分支。
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
      // 让 run 的初始微任务(system?.() / raceModel 计时器注册)先落盘
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
});
