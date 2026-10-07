/**
 * Signal termination is observable, not only folded into 128 + signal number.
 *
 * The exit code a killed fence reports (`128 + N`) is a shell convention, not
 * evidence of *why* the process ended: `137` reads identically whether a
 * SIGKILL arrived from the bounded teardown, from the caller's own `kill -9`,
 * or from something else that happened to deliver signal 9. Every route above
 * this seam (bash foreground envelope, verify SandboxCmdRecord) can only report
 * what the response carries, so the signal name has to travel on the response
 * itself.
 *
 * Real processes throughout: the fixture fence runs `sh -c 'kill -9 $$'`, so the
 * assertions are about the host's actual exit event, not a fabricated shape.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  runInSandbox,
  type SandboxRunResult,
} from "../../../src/harness/sandbox/runner.ts";
import { createSandboxServer } from "../../../src/harness/sandbox/server/index.js";
import type { BwrapFence } from "../../../src/harness/sandbox/bwrap.ts";

const CWD = process.cwd();

function selfKillFence(): BwrapFence {
  return Object.freeze({
    argv: Object.freeze(["sh", "-c", "kill -9 $$"]),
    sealed: true as const,
    exactFileMaskPaths: Object.freeze([]),
  });
}

function sleepFence(): BwrapFence {
  return Object.freeze({
    argv: Object.freeze(["sh", "-c", "exit 3"]),
    sealed: true as const,
    exactFileMaskPaths: Object.freeze([]),
  });
}

describe("exec signal termination (S4 observable status)", () => {
  it("signal-terminated fence → exec response carries the signal name next to 128+N", async () => {
    const server = createSandboxServer();
    const response = await server.exec({
      kind: "exec",
      fence: selfKillFence(),
      cwd: CWD,
      env: { PATH: "/bin:/usr/bin" },
    });
    assert.equal(
      response.exitCode,
      137,
      "shell convention 128 + 9 is unchanged"
    );
    assert.equal(response.signal, "SIGKILL");
  });

  it("runInSandbox projection keeps the signal name (the shape every route reads)", async () => {
    const result: SandboxRunResult = await runInSandbox({
      fence: selfKillFence(),
      cwd: CWD,
      env: { PATH: "/bin:/usr/bin" },
    });
    assert.equal(result.exitCode, 137);
    assert.equal(result.signal, "SIGKILL");
  });

  it("natural exit carries no signal field (Postel: absent means not signal-terminated)", async () => {
    const result = await runInSandbox({
      fence: sleepFence(),
      cwd: CWD,
      env: { PATH: "/bin:/usr/bin" },
    });
    assert.equal(result.exitCode, 3);
    assert.equal(result.signal, undefined);
    assert.ok(!("signal" in result), "no signal key on a natural exit");
  });
});
