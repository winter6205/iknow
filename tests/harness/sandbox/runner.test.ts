/**
 * Direct unit tests for the runner (added after the runner extraction).
 *
 * runInSandbox's contract is "argv = the fence argv"; the tests let sh act as
 * the argv directly (bypassing bwrap), so exit-code mapping / truncation /
 * abort behavior are all coverable without bwrap present. The real bwrap-fence
 * execution path is covered by the real-spawn tests in bash-sandbox.test.ts /
 * interrupt-routing.test.ts.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import {
  SIGNAL_EXIT_CODES,
  runInSandbox,
  signalExitCode,
  truncateByCodePoint,
} from "../../../src/harness/sandbox/runner.ts";
import type { BwrapFence } from "../../../src/harness/sandbox/bwrap.ts";
import { waitForPidFile } from "../aci/tools/spawn-test-utils.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

/** Test double for the fence: sh stands in as the fence argv (no bwrap). */
function shFence(command: string): BwrapFence {
  return Object.freeze({
    argv: Object.freeze(["sh", "-c", command]),
    sealed: true as const,
  });
}

describe("signalExitCode", () => {
  it("maps known signals to 128 + signal number", () => {
    assert.equal(signalExitCode("SIGKILL"), 137);
    assert.equal(signalExitCode("SIGTERM"), 143);
    assert.equal(signalExitCode("SIGINT"), 130);
    assert.equal(signalExitCode("SIGSEGV"), 139);
  });

  it("returns 1 for null (no signal)", () => {
    assert.equal(signalExitCode(null), 1);
  });

  it("returns 1 for unmapped signals", () => {
    assert.equal(signalExitCode("SIGRTMIN"), 1);
  });

  it("SIGNAL_EXIT_CODES is frozen (immutable contract)", () => {
    assert.equal(Object.isFrozen(SIGNAL_EXIT_CODES), true);
  });
});

describe("runInSandbox", () => {
  it("returns exit code, stdout, and stderr", async () => {
    const result = await runInSandbox({
      fence: shFence("printf out; printf err >&2; exit 7"),
      cwd: tmpdir(),
      env: process.env,
    });
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
  });

  it("truncates stdout and stderr at maxOutputCodePoints", async () => {
    const result = await runInSandbox({
      fence: shFence("printf 'aaaaaaaaaa'; printf 'bbbbbbbbbb' >&2"),
      cwd: tmpdir(),
      env: process.env,
      maxOutputCodePoints: 5,
    });
    assert.equal(result.stdout, "aaaaa");
    assert.equal(result.stderr, "bbbbb");
  });

  it("defaults maxOutputCodePoints to DEFAULT_MAX_OUTPUT_CODE_POINTS", () => {
    assert.equal(
      truncateByCodePoint("x".repeat(12_001), 12_000).length,
      12_000
    );
    assert.equal(
      truncateByCodePoint("😀".repeat(12_001), 12_000).length,
      24_000 // code units = 2 per emoji, proving code-point (not unit) semantics
    );
  });

  it("maps a signal-terminated child to exitCode = 128 + signal number", async () => {
    const result = await runInSandbox({
      fence: shFence("kill -TERM $$"),
      cwd: tmpdir(),
      env: process.env,
    });
    assert.equal(result.exitCode, 143);
  });

  it("abort signal stops the detached process tree and yields non-zero exitCode", async () => {
    const cwd = await makeScratch("runner-abort-");
    const pidFile = join(cwd, "child.pid");
    const controller = new AbortController();
    const execution = runInSandbox({
      fence: shFence(`sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`),
      cwd,
      env: process.env,
      signal: controller.signal,
      killGraceMs: 50,
    });
    await waitForPidFile(pidFile);
    controller.abort();
    const result = await execution;
    assert.notEqual(result.exitCode, 0);
  }, 5_000);
});
