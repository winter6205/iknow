/**
 * T4 (plans/closed-world-bash-fence.md) — verify 沙箱装配迁移双轴闭世界 policy。
 *
 * ADR-0037 §9.2 / §9.4:
 *   - #4 installRoot:验证命令同样需要项目自身工具链的读通道。来源裁决:
 *     VerifyLoopOptions 本无 installRoot → 最小接线补齐(新增可选字段,
 *     makeDefaultRunVerify 缺省回退 resolveInstallRoot() 进程级 SSOT,
 *     不静默留空)。显式传入时覆盖 SSOT(测试注入缝,session-roots 刻意
 *     不给进程缓存 reset 缝)。
 *   - #7 git 全局配置:单一 source helper(defaultOptionalReadRoots)。
 *   - verify 不传 projectIdentityRoot(维持现状)。
 *
 * 手法:module-mock sandbox index(捕获 createBwrapFence 的 fsPolicy,
 * stub runInSandbox),与 tests/subagent/bash-mode-channel.test.ts 同款。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";

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
import { resolveInstallRoot } from "../../../src/harness/session-roots.ts";
import type { FsPolicy } from "../../../src/harness/sandbox/fs-policy.ts";

interface CapturedFence {
  readonly fsPolicy: FsPolicy;
  readonly cwd: string;
  readonly [k: string]: unknown;
}

const captured: CapturedFence[] = [];

beforeEach(() => {
  captured.length = 0;
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
});

const SCRATCH: string[] = [];
function makeScratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  SCRATCH.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of SCRATCH) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("makeDefaultRunVerify — closed-world read roots (T4)", () => {
  it("installRoot omitted → SSOT fallback resolveInstallRoot() enters the read whitelist (no silent empty)", async () => {
    const cwd = makeScratch("verify-run-cwd-");
    const runVerify = makeDefaultRunVerify({ cwd, home: "/home/user" });
    await runVerify("true", {});
    expect(captured).toHaveLength(1);
    const readRoots = captured[0]!.fsPolicy.readRoots();
    assert.ok(
      readRoots.includes(resolveInstallRoot()),
      `verify fence must thread the install root via the SSOT fallback; readRoots=${JSON.stringify(readRoots)}`
    );
  });

  it("explicit installRoot option overrides the SSOT fallback (test injection seam)", async () => {
    const cwd = makeScratch("verify-run-cwd2-");
    const installRoot = makeScratch("verify-run-install-");
    const runVerify = makeDefaultRunVerify({
      cwd,
      home: "/home/user",
      installRoot,
    });
    await runVerify("true", {});
    const readRoots = captured[0]!.fsPolicy.readRoots();
    assert.ok(readRoots.includes(installRoot));
    assert.equal(
      readRoots.includes(resolveInstallRoot()),
      installRoot === resolveInstallRoot(),
      "explicit installRoot replaces the SSOT fallback"
    );
  });

  it("git global config pair enters optionalReadRoots when on disk (same helper as bash)", async () => {
    const cwd = makeScratch("verify-run-cwd3-");
    const home = makeScratch("verify-run-home-");
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    writeFileSync(join(home, ".gitconfig"), "[user]\n");
    writeFileSync(join(home, ".config", "git", "config"), "[user]\n");
    const runVerify = makeDefaultRunVerify({ cwd, home });
    await runVerify("true", {});
    const optional = captured[0]!.fsPolicy.optionalReadRoots();
    assert.ok(optional.includes(join(home, ".gitconfig")));
    assert.ok(optional.includes(join(home, ".config", "git", "config")));
  });

  it("write axis stays taskRoot + tmp; verify never threads projectIdentityRoot", async () => {
    const cwd = makeScratch("verify-run-cwd4-");
    const runVerify = makeDefaultRunVerify({ cwd, home: "/home/user" });
    await runVerify("true", {});
    const fence = captured[0]!;
    assert.deepEqual(
      [...fence.fsPolicy.writeRoots()],
      [cwd, tmpdir()],
      "write whitelist = taskRoot(cwd) + tmpDir, nothing else"
    );
    assert.equal(
      "projectIdentityRoot" in fence,
      false,
      "verify keeps the projectIdentityRoot unthreaded (pre-existing shape)"
    );
    // fence 实际驱动 runInSandbox(cwd 一致)。
    expect(vi.mocked(sandboxIndex.runInSandbox)).toHaveBeenCalledTimes(1);
    const runArgs = vi.mocked(sandboxIndex.runInSandbox).mock.calls[0]?.[0] as
      { cwd?: string } | undefined;
    assert.equal(runArgs?.cwd, cwd);
  });
});
