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
});
