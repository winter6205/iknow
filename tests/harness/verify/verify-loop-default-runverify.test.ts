/**
 * verify-loop 缺省 runVerify 装配 (ADR-0092)。
 *
 * 锁的是透传那一段:VerifyLoopOptions.cwd 到达 makeDefaultRunVerify 入参。
 * Round-2 dead-surface 退役:`home` 选项在 VerifyLoopOptions / runVerify
 * 都已删除(无人消费,缺省即进程真实 cwd)。
 * T4 的 `options.installRoot` 透传随闭世界前端退役(ADR-0092):全局档
 * `--bind / /` 让项目工具链根本就可见,不再有 installRoot 读白名单需要
 * 喂给缺省 runVerify。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";

vi.mock(
  "../../../src/harness/verify/sandbox-run.ts",
  async (importOriginal) => {
    const actual = await vi.importActual<
      typeof import("../../../src/harness/verify/sandbox-run.ts")
    >("../../../src/harness/verify/sandbox-run.ts");
    return {
      ...actual,
      makeDefaultRunVerify: vi.fn(),
    };
  }
);

import { makeDefaultRunVerify } from "../../../src/harness/verify/sandbox-run.ts";
import { runVerifyLoop } from "../../../src/harness/verify/verify-loop.ts";
import { makeNative } from "../../cli/_fixtures.ts";
import type { RunOutcome } from "../../../src/harness/verify/verify-loop.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/model-adapter/types.ts";
import type { LoopTrace } from "../../../src/harness/loop-trace.ts";

const SCRATCH: string[] = [];
afterAll(() => {
  for (const dir of SCRATCH.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function stubRun(text: string, userText: string): RunOutcome {
  const messages: AnthropicNativeMessage[] = [
    makeNative({ role: "user", text: userText }),
    makeNative({ role: "assistant", text }),
  ];
  return {
    result: {
      finalText: text,
      messages,
      turnCount: 1,
      stopReason: "completed",
      lastUsage: null,
    },
    trace: EMPTY_TRACE,
  };
}

const EMPTY_TRACE: LoopTrace = Object.freeze({
  turns: Object.freeze([]),
  totals: Object.freeze({
    totalDurationMs: 0,
    cancelKindCounts: Object.freeze({
      none: 0,
      callerAbort: 0,
      timerTimeout: 0,
      hostCancel: 0,
    }),
    toolErrorTotals: Object.freeze({
      ok: 0,
      validation_failed: 0,
      tool_not_found: 0,
      execution_failed: 0,
    }),
  }),
});

describe("runVerifyLoop — default runVerify assembly threads cwd", () => {
  it("options.cwd reaches makeDefaultRunVerify", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-loop-cwd-"));
    SCRATCH.push(cwd);

    const captured: Array<Record<string, unknown>> = [];
    vi.mocked(makeDefaultRunVerify).mockImplementation((opts) => {
      captured.push(opts as Record<string, unknown>);
      return async () => ({ exitCode: 0, stdout: "ok", stderr: "" });
    });

    const outcome = await runVerifyLoop({
      runFn: async (text) => stubRun("done", text),
      userText: "do it",
      config: { command: "true" },
      sessionId: "verify-loop-default-runverify",
      cwd,
    });

    expect(captured).toHaveLength(1);
    assert.equal(captured[0]!.cwd, cwd);
    assert.equal(outcome.outcome, "passed");
  });

  it("options.tmpDir reaches makeDefaultRunVerify (ADR-0092 SC12)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-loop-tmpdir-"));
    SCRATCH.push(cwd);
    const sessionTmp = mkdtempSync(join(tmpdir(), "verify-loop-session-tmp-"));
    SCRATCH.push(sessionTmp);

    const captured: Array<Record<string, unknown>> = [];
    vi.mocked(makeDefaultRunVerify).mockImplementation((opts) => {
      captured.push(opts as Record<string, unknown>);
      return async () => ({ exitCode: 0, stdout: "ok", stderr: "" });
    });

    const outcome = await runVerifyLoop({
      runFn: async (text) => stubRun("done", text),
      userText: "do it",
      config: { command: "true" },
      sessionId: "verify-loop-default-runverify-tmpdir",
      cwd,
      fsMode: "workspace",
      homeRoot: "/fixture/home",
      tmpDir: sessionTmp,
    });

    expect(captured).toHaveLength(1);
    assert.equal(
      captured[0]!.tmpDir,
      sessionTmp,
      "会话 tmp 必须到达缺省执行体（$TMPDIR 与 --bind <tmpRoot> 同源）"
    );
    assert.equal(outcome.outcome, "passed");
  });

  it("options.fsMode / options.homeRoot reach makeDefaultRunVerify (ADR-0092 SC11)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-loop-fsmode-"));
    SCRATCH.push(cwd);

    const captured: Array<Record<string, unknown>> = [];
    vi.mocked(makeDefaultRunVerify).mockImplementation((opts) => {
      captured.push(opts as Record<string, unknown>);
      return async () => ({ exitCode: 0, stdout: "ok", stderr: "" });
    });

    const outcome = await runVerifyLoop({
      runFn: async (text) => stubRun("done", text),
      userText: "do it",
      config: { command: "true" },
      sessionId: "verify-loop-default-runverify-fsmode",
      cwd,
      fsMode: "workspace",
      homeRoot: "/fixture/home",
    });

    expect(captured).toHaveLength(1);
    assert.equal(captured[0]!.fsMode, "workspace");
    assert.equal(captured[0]!.homeRoot, "/fixture/home");
    assert.equal(outcome.outcome, "passed");
  });

  it("absent fsMode / homeRoot / tmpDir put no key on the runVerify opts (V1 baseline)", async () => {
    // 缺席时必须不打这些 key —— 与既有调用方(未接 fs 档)的入参形状逐字节
    // 一致;「传 undefined」与「不传」在下游 `?? "global"` 下虽等价,但入参
    // 形状本身是测试缝的契约(见 cwd 同款断言)。
    const cwd = mkdtempSync(join(tmpdir(), "verify-loop-nofsmode-"));
    SCRATCH.push(cwd);

    const captured: Array<Record<string, unknown>> = [];
    vi.mocked(makeDefaultRunVerify).mockImplementation((opts) => {
      captured.push(opts as Record<string, unknown>);
      return async () => ({ exitCode: 0, stdout: "ok", stderr: "" });
    });

    const outcome = await runVerifyLoop({
      runFn: async (text) => stubRun("done", text),
      userText: "do it",
      config: { command: "true" },
      sessionId: "verify-loop-default-runverify-nofsmode",
      cwd,
    });

    expect(captured).toHaveLength(1);
    assert.equal("fsMode" in captured[0]!, false, "no fsMode key when absent");
    assert.equal(
      "homeRoot" in captured[0]!,
      false,
      "no homeRoot key when absent"
    );
    assert.equal("tmpDir" in captured[0]!, false, "no tmpDir key when absent");
    assert.equal(outcome.outcome, "passed");
  });
});
