/**
 * verify 沙箱装配 (ADR-0092 全局档)。
 *
 * verify 与 bash 工具共用同一围栏装配语义(spec:64):命令拼 `bash -c`,
 * bwrap 全局档 argv 由 createBwrapFence 决定。Round 1 后 policy 只承载
 * 会话 tmp 宿主路径(`$TMPDIR` 来源),不再有闭世界读/写白名单。
 *
 * 手法:module-mock sandbox index(捕获 createBwrapFence 的 opts,
 * stub runInSandbox),与 tests/subagent/bash-mode-channel.test.ts 同款。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/harness/sandbox/index.ts", async (importOriginal) => {
  const actual = await vi.importActual<
    typeof import("../../../src/harness/sandbox/index.ts")
  >("../../../src/harness/sandbox/index.ts");
  return {
    ...actual,
    createBwrapFence: vi.fn(),
    runInSandbox: vi.fn(),
  };
});

import * as sandboxIndex from "../../../src/harness/sandbox/index.ts";
import { makeDefaultRunVerify } from "../../../src/harness/verify/sandbox-run.ts";
import type { FsPolicy } from "../../../src/harness/sandbox/fs-policy.ts";

interface CapturedFence {
  readonly fsPolicy: FsPolicy;
  readonly cwd: string;
  readonly [k: string]: unknown;
}

const captured: CapturedFence[] = [];

vi.mocked(sandboxIndex.createBwrapFence)
  .mockReset()
  .mockImplementation((opts) => {
    captured.push(opts as unknown as CapturedFence);
    return { argv: ["bwrap", "--", "bash", "-c", "true"], sealed: true };
  });
vi.mocked(sandboxIndex.runInSandbox).mockReset().mockResolvedValue({
  exitCode: 0,
  stdout: "",
  stderr: "",
});

beforeEach(() => {
  captured.length = 0;
  vi.mocked(sandboxIndex.runInSandbox).mockClear();
});

describe("makeDefaultRunVerify — global-mode assembly (ADR-0092)", () => {
  it("threads a global fs-policy whose tmpRoot is the session tmp host path", async () => {
    captured.length = 0;
    const cwd = tmpdir();
    const runVerify = makeDefaultRunVerify({ cwd, home: "/home/user" });
    await runVerify("true", {});
    expect(captured).toHaveLength(1);
    const policy = captured[0]!.fsPolicy;
    assert.equal(
      policy.tmpRoot(),
      tmpdir(),
      "default verify tmpRoot falls back to process tmpdir()"
    );
    // The retired closed-world surfaces must be gone.
    assert.equal("readRoots" in policy, false);
    assert.equal("writeRoots" in policy, false);
    assert.equal("optionalReadRoots" in policy, false);
  });

  it("explicit tmpDir overrides the process tmpdir() fallback", async () => {
    captured.length = 0;
    const cwd = tmpdir();
    const sessionTmp = mkdtempSync(join(tmpdir(), "verify-session-tmp-"));
    try {
      const runVerify = makeDefaultRunVerify({
        cwd,
        home: "/home/user",
        tmpDir: sessionTmp,
      });
      await runVerify("true", {});
      assert.equal(captured[0]!.fsPolicy.tmpRoot(), sessionTmp);
    } finally {
      rmSync(sessionTmp, { recursive: true, force: true });
    }
  });

  it("fence is driven with the verify cwd and command via runInSandbox", async () => {
    captured.length = 0;
    const cwd = "/tmp/verify-run-cwd-fixture";
    const runVerify = makeDefaultRunVerify({ cwd, home: "/home/user" });
    await runVerify("true", {});
    const fence = captured[0]!;
    assert.equal(fence.cwd, cwd);
    // verify never threads a projectIdentityRoot into the fence options.
    assert.equal("projectIdentityRoot" in fence, false);
    expect(vi.mocked(sandboxIndex.runInSandbox)).toHaveBeenCalledTimes(1);
    const runArgs = vi.mocked(sandboxIndex.runInSandbox).mock.calls[0]?.[0] as
      { cwd?: string } | undefined;
    assert.equal(runArgs?.cwd, cwd);
  });
});
