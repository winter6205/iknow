/**
 * T4 (plans/closed-world-bash-fence.md) — verify-loop installRoot 最小接线。
 *
 * VerifyLoopOptions 新增可选 installRoot,runVerifyLoop 透传给
 * makeDefaultRunVerify(缺省 runVerify 装配);makeDefaultRunVerify 内部
 * 再回退 resolveInstallRoot() SSOT(见 sandbox-run.test.ts)。本文件锁的
 * 是透传那一段:options.installRoot 到达 makeDefaultRunVerify 入参。
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

describe("runVerifyLoop — installRoot threaded to the default runVerify (T4)", () => {
  it("options.installRoot reaches makeDefaultRunVerify", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-loop-t4-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "verify-loop-t4-home-"));
    const installRoot = mkdtempSync(join(tmpdir(), "verify-loop-t4-install-"));
    SCRATCH.push(cwd, home, installRoot);

    const captured: Array<Record<string, unknown>> = [];
    vi.mocked(makeDefaultRunVerify).mockImplementation((opts) => {
      captured.push(opts as Record<string, unknown>);
      return async () => ({ exitCode: 0, stdout: "ok", stderr: "" });
    });

    const outcome = await runVerifyLoop({
      runFn: async (text) => stubRun("done", text),
      userText: "do it",
      config: { command: "true" },
      sessionId: "t4-verify-loop",
      cwd,
      home,
      installRoot,
    });

    expect(captured).toHaveLength(1);
    assert.equal(captured[0]!.cwd, cwd);
    assert.equal(captured[0]!.home, home);
    assert.equal(
      captured[0]!.installRoot,
      installRoot,
      "VerifyLoopOptions.installRoot must be threaded through to the default runVerify assembly"
    );
    assert.equal(outcome.outcome, "passed");
  });
});
