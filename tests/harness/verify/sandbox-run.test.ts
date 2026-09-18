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
    createEgressSession: vi.fn(),
  };
});

import * as sandboxIndex from "../../../src/harness/sandbox/index.ts";
import { makeDefaultRunVerify } from "../../../src/harness/verify/sandbox-run.ts";
import {
  createFsPolicy,
  type FsPolicy,
} from "../../../src/harness/sandbox/fs-policy.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";

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
    const runVerify = makeDefaultRunVerify({ cwd });
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
        tmpDir: sessionTmp,
      });
      await runVerify("true", {});
      assert.equal(captured[0]!.fsPolicy.tmpRoot(), sessionTmp);
    } finally {
      rmSync(sessionTmp, { recursive: true, force: true });
    }
  });

  it("fenceEnv carries TMPDIR = the session tmp (ADR-0092 SC12)", async () => {
    // 判别力:修复前 fenceEnv 只过 envIsolation.filter(process.env),宿主未
    // 导出 TMPDIR 时围栏内 `$TMPDIR` 根本不在场 → 写 `"$TMPDIR/x"` 落到
    // `/x` 被拒。本用例钉「显式注入且值 = 会话 tmp 宿主真路径」。
    captured.length = 0;
    const cwd = tmpdir();
    const sessionTmp = mkdtempSync(join(tmpdir(), "verify-fence-env-tmp-"));
    try {
      const runVerify = makeDefaultRunVerify({ cwd, tmpDir: sessionTmp });
      await runVerify("true", {});
      assert.equal(captured[0]!.env["TMPDIR"], sessionTmp);
      // $TMPDIR 与交给 fence 的 tmpRoot 必须是同一份(工作区档写白名单
      // 与围栏内看到的路径不能分叉)。
      const runArgs = vi.mocked(sandboxIndex.runInSandbox).mock
        .calls[0]?.[0] as { env?: Record<string, string> } | undefined;
      assert.equal(runArgs?.env?.["TMPDIR"], sessionTmp);
    } finally {
      rmSync(sessionTmp, { recursive: true, force: true });
    }
  });

  it("workspace mode binds the session tmp as tmpRoot (ADR-0092 SC12)", async () => {
    captured.length = 0;
    const cwd = mkdtempSync(join(tmpdir(), "verify-ws-bind-"));
    const sessionTmp = mkdtempSync(join(tmpdir(), "verify-ws-session-tmp-"));
    try {
      const runVerify = makeDefaultRunVerify({
        cwd,
        tmpDir: sessionTmp,
        fsMode: "workspace",
        homeRoot: "/fixture/home",
      });
      await runVerify("true", {});
      const opts = captured[0]!;
      assert.equal(
        opts["tmpRoot"],
        sessionTmp,
        "工作区档必须把会话 tmp 作为 --bind <tmpRoot> 源端交给 fence"
      );
      assert.equal(opts["workspaceRoot"], cwd);
      assert.equal(captured[0]!.env["TMPDIR"], sessionTmp);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(sessionTmp, { recursive: true, force: true });
    }
  });

  it("workspace mode without homeRoot keeps the key so the fence guard is reachable", async () => {
    // verify 面是独立调用点:workspace 档漏传 homeRoot 时**不得**在此预过滤
    // 掉该 key —— 丢弃 = 装配层看不见缺口,静默退化成全局档(home 可写)。
    // 本用例钉调用点这一段(key 在场、值 undefined);bwrap 对该形态抛 typed
    // error 由下面 `real createBwrapFence` 一段直接验证 —— 两段合起来才是
    // 「fail-loud」,单看任一段都不够。
    // 判别力:修复前是条件展开(`homeRoot !== undefined ? {...} : {}`),
    // key 不在场 → 本用例红(已实测)。
    const cwd = mkdtempSync(join(tmpdir(), "verify-ws-nohome-"));
    try {
      const runVerify = makeDefaultRunVerify({
        cwd,
        tmpDir: cwd,
        fsMode: "workspace",
        // homeRoot 缺席 —— 缺口本身。
      });
      captured.length = 0;
      await runVerify("true", {});
      const opts = captured[0]!;
      assert.equal(
        "homeRoot" in opts,
        true,
        "workspace-mode verify must not drop the homeRoot key (guard would be unreachable)"
      );
      assert.equal(opts["homeRoot"], undefined);

      // 真实(未 mock 的)构造函数对这份 opts 抛 typed error。
      const realBwrap = await vi.importActual<
        typeof import("../../../src/harness/sandbox/bwrap.ts")
      >("../../../src/harness/sandbox/bwrap.ts");
      assert.throws(
        () =>
          realBwrap.createBwrapFence({
            command: "bash",
            args: ["-c", "true"],
            fsPolicy: createFsPolicy({ tmpDir: cwd, mode: "workspace" }),
            env: { PATH: "/bin" },
            cwd,
            homeRoot: undefined,
            workspaceRoot: cwd,
            tmpRoot: cwd,
          }),
        (err: unknown) =>
          err instanceof ToolExecutionError && /homeRoot/.test(err.message),
        "the real fence constructor must fail loud on the opts the verify seam hands over"
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fence is driven with the verify cwd and command via runInSandbox", async () => {
    captured.length = 0;
    const cwd = "/tmp/verify-run-cwd-fixture";
    const runVerify = makeDefaultRunVerify({ cwd });
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

// ── ADR-0097 / T7:egress 缝装配单测 ────────────────────────────────────────
//
// 验证 verify 模块级 session 形态:policy 缺省 = 无缝;policy 在场 → 首次
// 调用 lazy start,session 起成功 → fence args 带 egress spec;start 失败
// → 无缝(fail-closed,任务仍起)。

describe("makeDefaultRunVerify — egress 缝装配 (ADR-0097 / T7)", () => {
  it("egressPolicy 缺省 → 不起 session,fence 不带 egress spec", async () => {
    captured.length = 0;
    const cwd = "/tmp/verify-egress-none";
    const runVerify = makeDefaultRunVerify({ cwd });
    await runVerify("true", {});
    const fence = captured[0]!;
    assert.equal(fence.egress, undefined);
  });

  it("egressPolicy 在场 + createEgressSession 成功 → fence 带 egress spec,spec.env 注入 fenceEnv", async () => {
    // 透过 mock 返回 fake session;fake spec.env 应出现在 fence.env。
    const fakeSpec = {
      unixSocketPath: "/tmp/iknow-verify-egress.sock",
      sandboxLocalPort: 19090,
      env: { HTTP_PROXY: "http://127.0.0.1:19090" },
      innerBridgeScript: "",
      relayAssetsDir: "/test/iknow/vendor/egress-relay",
    };
    vi.mocked(sandboxIndex.createEgressSession).mockReset();
    vi.mocked(sandboxIndex.createEgressSession).mockResolvedValue({
      spec: fakeSpec,
      dispose: async () => undefined,
    });
    captured.length = 0;
    const cwd = "/tmp/verify-egress-ok";
    const runVerify = makeDefaultRunVerify({
      cwd,
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "verify",
        allowlistSource: "persisted",
      },
    });
    await runVerify("true", {});
    const fence = captured[0]!;
    assert.deepEqual(fence.egress, fakeSpec);
    assert.equal(fence.env.HTTP_PROXY, "http://127.0.0.1:19090");
  });

  it("createEgressSession 抛错 → fence 不带 egress spec,verify 仍能执行 (fail-closed)", async () => {
    vi.mocked(sandboxIndex.createEgressSession).mockReset();
    vi.mocked(sandboxIndex.createEgressSession).mockRejectedValue(
      new Error("relay deps missing")
    );
    captured.length = 0;
    const cwd = "/tmp/verify-egress-fail";
    const runVerify = makeDefaultRunVerify({
      cwd,
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "verify",
        allowlistSource: "persisted",
      },
    });
    await runVerify("true", {});
    const fence = captured[0]!;
    assert.equal(fence.egress, undefined);
    expect(vi.mocked(sandboxIndex.runInSandbox)).toHaveBeenCalledTimes(1);
  });
});
