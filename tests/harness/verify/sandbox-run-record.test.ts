/**
 * verify trace record: the actual status and a useful cause.
 *
 * `SandboxCmdRecord` is what a reader of the trace sees for a verify command.
 * A command that exited non-zero used to land there as `status: "ok"` with no
 * error at all, and only stdout was persisted — so the one thing the record
 * was for (what happened) was absent exactly when it mattered. The failing
 * command's own stderr is the diagnostic, and a signal death needs the signal
 * named, because the exit code alone is 128+N.
 *
 * `runVerifyOnce` is driven directly with a scripted executor: these assertions
 * are about the record this route writes, not about the sandbox.
 */
import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import { runVerifyOnce } from "../../../src/harness/verify/sandbox-run.ts";
import type { SandboxCmdRecord } from "../../../src/harness/trace/types.ts";
import type { TraceService } from "../../../src/harness/trace/types.ts";
import type { SandboxRunResult } from "../../../src/harness/sandbox/runner.ts";

/** TraceService stand-in that keeps only the sandbox-command rows. */
function capturingTrace(): {
  readonly trace: TraceService;
  readonly records: () => ReadonlyArray<SandboxCmdRecord>;
} {
  const records: SandboxCmdRecord[] = [];
  const trace = {
    recordLlmCall: async () => undefined,
    recordToolCall: async () => undefined,
    recordTurn: async () => undefined,
    recordSession: async () => undefined,
    recordSandboxCmd: async (record: SandboxCmdRecord) => {
      records.push(record);
      return undefined;
    },
    recordViolation: async () => undefined,
    recordGoal: async () => undefined,
    recordSubagentSpawn: async () => undefined,
    recordSubagentStop: async () => undefined,
    recordSubagentStateChange: async () => undefined,
    recordSubagentStep: async () => undefined,
  } as unknown as TraceService;
  return { trace, records: () => records };
}

async function recordFor(
  result: SandboxRunResult,
  parentTurnId = "turn-1"
): Promise<SandboxCmdRecord> {
  const capture = capturingTrace();
  await runVerifyOnce(async () => result, "npm test", {
    timeoutSec: 30,
    parentTurnId,
    trace: capture.trace,
  });
  const record = capture.records()[0];
  assert.ok(record, "the route persisted a sandbox command record");
  return record;
}

describe("verify SandboxCmdRecord reports the actual outcome", () => {
  it("nonzero exit is a failure, not ok", async () => {
    const record = await recordFor({
      exitCode: 1,
      stdout: "1 failing",
      stderr: "TypeError: spec is not a function",
    });
    assert.equal(record.exitCode, 1);
    assert.equal(record.status, "error");
    assert.equal(record.error?.type, "execution_failed");
    assert.match(
      record.error?.message ?? "",
      /TypeError: spec is not a function/
    );
    assert.match(record.error?.message ?? "", /1/);
  });

  it("the command's stdout is still persisted", async () => {
    const record = await recordFor({
      exitCode: 1,
      stdout: "FAIL  src/a.ts:case1",
      stderr: "assertion failed",
    });
    assert.equal(record.stdoutCaptured, true);
    assert.equal(record.stdout, "FAIL  src/a.ts:case1");
  });

  it("signal termination names the signal next to 128+N", async () => {
    const record = await recordFor({
      exitCode: 137,
      stdout: "",
      stderr: "",
      signal: "SIGKILL",
    });
    assert.equal(record.status, "error");
    assert.match(record.error?.message ?? "", /SIGKILL/);
  });

  it("a zero exit stays ok with no error key (Postel)", async () => {
    const record = await recordFor({
      exitCode: 0,
      stdout: "all good",
      stderr: "",
    });
    assert.equal(record.status, "ok");
    assert.equal(record.error, undefined);
    assert.equal(record.stdout, "all good");
  });

  it("a timeout keeps its own typed cause ahead of the command's stderr", async () => {
    const capture = capturingTrace();
    await runVerifyOnce(
      async () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ exitCode: 124, stdout: "", stderr: "late" }),
            5_000
          );
        }),
      "npm test",
      {
        timeoutSec: 0.01,
        parentTurnId: "turn-1",
        trace: capture.trace,
      }
    );
    const record = capture.records()[0]!;
    assert.equal(record.status, "error");
    assert.equal(record.error?.type, "timeout");
  });

  it("an egress release failure is recorded rather than dropped", async () => {
    const capture = capturingTrace();
    // A route that owns a session whose dispose throws: the command itself
    // succeeded, but the proxy release is unresolved and must say so.
    const runVerify = Object.assign(
      async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      {
        disposeEgressSession: async () => {
          throw new Error("proxy close EPERM");
        },
      }
    );
    const { result } = await runVerifyOnce(runVerify, "npm test", {
      timeoutSec: 30,
      parentTurnId: "turn-1",
      trace: capture.trace,
    });
    expect(result.exitCode).toBe(0);
    const record = capture.records()[0]!;
    assert.equal(record.status, "error");
    assert.match(record.error?.message ?? "", /proxy close EPERM/);
  });
});
