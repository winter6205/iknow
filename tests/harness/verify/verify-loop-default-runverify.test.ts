/**
 * Default runVerify assembly for verify-loop (ADR-0092).
 *
 * Pins the pass-through leg: VerifyLoopOptions.cwd reaches makeDefaultRunVerify's
 * input. The retired `home` option was deleted from VerifyLoopOptions / runVerify
 * (no consumers; the default is the process's real cwd). installRoot pass-through
 * retired with the closed-world front end (ADR-0092): global-mode `--bind / /`
 * makes the project toolchain visible anyway, so there is no installRoot read
 * allowlist left to feed the default runVerify.
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

/**
 * Content-gate signal: an inert non-doc source edit. Opens the upstream
 * verify gate (text-only stubs would now never enter verify) with zero
 * effect on checkEvidence verdict/reasons.
 */
function gateSignalMessage(): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "gate-edit",
        name: "edit_file",
        input: { filePath: "src/app.ts" },
      },
    ],
  };
}

function stubRun(text: string, userText: string): RunOutcome {
  const messages: AnthropicNativeMessage[] = [
    makeNative({ role: "user", text: userText }),
    gateSignalMessage(),
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
    // When absent these keys must not be set at all — byte-identical input
    // shape with legacy callers (no fs-mode wired). "Passing undefined" vs
    // "not passing" is equivalent under the downstream `?? "global"`, but the
    // input shape itself is the test-seam contract (same assertion style as cwd).
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
