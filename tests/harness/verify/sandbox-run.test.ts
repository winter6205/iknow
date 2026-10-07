/**
 * verify sandbox assembly (ADR-0092 global mode).
 *
 * verify shares the fence-assembly semantics with the bash tool: the command
 * is wrapped as `bash -c` and the bwrap global-mode argv comes from
 * createBwrapFence. Post-Round-1 the policy carries only the session tmp host
 * path (`$TMPDIR` source) — no closed-world read/write allowlists.
 *
 * Technique: module-mock the sandbox index (capture createBwrapFence opts,
 * stub runInSandbox), same shape as tests/subagent/bash-mode-channel.test.ts.
 */
import assert from "node:assert/strict";
import { createEgressViolationSink } from "../../../src/harness/sandbox/egress/violations.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/harness/sandbox/index.ts", async () => {
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

/**
 * The captured fence's env map. `CapturedFence` carries an index signature, so
 * `env` reads as `unknown`; this keeps the narrowing in one place instead of at
 * every assertion.
 */
function fenceEnv(fence: CapturedFence): Record<string, string> {
  const env = fence.env;
  assert.ok(
    env !== undefined && typeof env === "object",
    "the fence was assembled with an env map"
  );
  return env as Record<string, string>;
}

/**
 * The verify cwd IS the name-pattern scan root (specs/effect-boundary-protection
 * .md "Scan scope"), so it must be a real directory — the inventory refuses an
 * absent root at assembly rather than assembling a fence whose name arm matched
 * nothing. These cases never enumerate it, so a scratch dir is the whole cost.
 */
const scratchRoots: string[] = [];
function scratchCwd(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}
function scratchSubdir(root: string, ...segments: string[]): string {
  const dir = join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}
afterAll(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

vi.mocked(sandboxIndex.createBwrapFence)
  .mockReset()
  .mockImplementation((opts) => {
    captured.push(opts as unknown as CapturedFence);
    return {
      argv: ["bwrap", "--", "bash", "-c", "true"],
      sealed: true as const,
      // the fake never assembles a boundary block, so it names no mask
      exactFileMaskPaths: [],
    };
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
    // Discriminating case: before the fix fenceEnv only passed
    // envIsolation.filter(process.env), so when the host did not export TMPDIR
    // the fence had no `$TMPDIR` at all → writes to `"$TMPDIR/x"` landed on
    // `/x` and were denied. This pins "explicitly injected, value = session
    // tmp's real host path".
    captured.length = 0;
    const cwd = tmpdir();
    const sessionTmp = mkdtempSync(join(tmpdir(), "verify-fence-env-tmp-"));
    try {
      const runVerify = makeDefaultRunVerify({ cwd, tmpDir: sessionTmp });
      await runVerify("true", {});
      assert.equal(fenceEnv(captured[0]!)["TMPDIR"], sessionTmp);
      // $TMPDIR and the tmpRoot handed to the fence must be the same value
      // (the path seen inside the fence cannot diverge from the bind source).
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
      assert.equal(fenceEnv(captured[0]!)["TMPDIR"], sessionTmp);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(sessionTmp, { recursive: true, force: true });
    }
  });

  it("workspace mode without homeRoot keeps the key so the fence guard is reachable", async () => {
    // verify is an independent call site: when workspace mode omits homeRoot
    // this key must NOT be pre-filtered here — dropping it hides the gap from
    // assembly and silently degrades to global mode (writable home). This case
    // pins the call-site half (key present, value undefined); the typed error
    // bwrap throws for that shape is verified directly by the real
    // createBwrapFence block below — both halves together make "fail loud",
    // neither alone is enough.
    // Discriminating case: before the fix the spread was conditional
    // (`homeRoot !== undefined ? {...} : {}`), the key was absent → this test
    // went red (actually observed).
    const cwd = mkdtempSync(join(tmpdir(), "verify-ws-nohome-"));
    try {
      const runVerify = makeDefaultRunVerify({
        cwd,
        tmpDir: cwd,
        fsMode: "workspace",
        // homeRoot absent — that absence is the gap under test.
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

      // The real (unmocked) constructor must throw a typed error for these opts.
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
    const cwd = scratchCwd("t8-scan-verify-run-cwd-fixture-");
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

// ── ADR-0097: egress seam assembly ─────────────────────────────────────────
//
// verify's module-level session shape: no policy → no seam; policy present →
// lazy start on first call; session up → fence args carry the egress spec;
// start failure → no seam (fail-closed, the task still runs).

describe("makeDefaultRunVerify — egress 缝装配 (ADR-0097 / T7)", () => {
  it("egressPolicy 缺省 → 不起 session,fence 不带 egress spec", async () => {
    captured.length = 0;
    const cwd = scratchCwd("t8-scan-verify-egress-none-");
    const runVerify = makeDefaultRunVerify({ cwd });
    await runVerify("true", {});
    const fence = captured[0]!;
    assert.equal(fence.egress, undefined);
  });

  it("egressPolicy 在场 + createEgressSession 成功 → fence 带 egress spec,spec.env 注入 fenceEnv", async () => {
    // The mock returns a fake session; the fake spec.env must show up in fence.env.
    const fakeSpec = {
      unixSocketPath: "/tmp/iknow-verify-egress.sock",
      sandboxLocalPort: 19090,
      env: { HTTP_PROXY: "http://127.0.0.1:19090" },
      innerBridgeScript: "",
      relayAssetsDir: "/test/iknow/vendor/egress-relay",
    };
    vi.mocked(sandboxIndex.createEgressSession).mockReset();
    vi.mocked(sandboxIndex.createEgressSession).mockResolvedValue({
      id: "verify-egress-session",
      spec: fakeSpec,
      violationSink: createEgressViolationSink(),
      dispose: async () => undefined,
    });
    captured.length = 0;
    const cwd = scratchCwd("t8-scan-verify-egress-ok-");
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
    assert.equal(fenceEnv(fence).HTTP_PROXY, "http://127.0.0.1:19090");
  });

  it("createEgressSession 抛错 → fence 不带 egress spec,verify 仍能执行 (fail-closed)", async () => {
    vi.mocked(sandboxIndex.createEgressSession).mockReset();
    vi.mocked(sandboxIndex.createEgressSession).mockRejectedValue(
      new Error("relay deps missing")
    );
    captured.length = 0;
    const cwd = scratchCwd("t8-scan-verify-egress-fail-");
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

describe("makeDefaultRunVerify — UNBOUND_FENCE 段 (issue 1059)", () => {
  it("holder ON + cwd 是主 checkout → createBwrapFence opts 叠 unboundFence {mainCheckout: cwd, tmpPad}", async () => {
    captured.length = 0;
    const cwd = mkdtempSync(join(tmpdir(), "verify-unbound-main-"));
    const sessionTmp = mkdtempSync(join(tmpdir(), "verify-unbound-tmp-"));
    try {
      const runVerify = makeDefaultRunVerify({
        cwd,
        tmpDir: sessionTmp,
        worktreeOnMutate: { get: () => true },
      });
      await runVerify("true", {});
      const opts = captured[0]!;
      assert.deepEqual(opts.unboundFence, {
        mainCheckout: cwd,
        tmpPad: sessionTmp,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(sessionTmp, { recursive: true, force: true });
    }
  });

  it("holder 缺席 → opts 不含 unboundFence 键 (V1 baseline 字节不变)", async () => {
    captured.length = 0;
    const cwd = scratchCwd("t8-scan-verify-unbound-absent-");
    const runVerify = makeDefaultRunVerify({ cwd });
    await runVerify("true", {});
    assert.equal("unboundFence" in captured[0]!, false);
  });

  it.each([
    ["holder OFF", () => ({ get: () => false })],
    ["bound(task-worktree 形 cwd)", () => ({ get: () => true })],
  ])(
    "%s → 不发段 (G3: 与 bash 工具面同源判定)",
    async (_label, holderFactory) => {
      captured.length = 0;
      const isBound = _label.startsWith("bound");
      const cwd = isBound
        ? scratchSubdir(
            scratchCwd("t8-scan-verify-unbound-main-"),
            ".iknow",
            "worktrees",
            "conv-1"
          )
        : scratchCwd("t8-scan-verify-unbound-main-");
      const runVerify = makeDefaultRunVerify({
        cwd,
        ...(isBound
          ? { worktreeOnMutate: { get: () => true } }
          : { worktreeOnMutate: holderFactory() }),
      });
      await runVerify("true", {});
      assert.equal("unboundFence" in captured[0]!, false);
    }
  );

  it("工厂期快照 vintage:闭包造好后翻 holder,本轮 opts 不变 (per-round 快照)", async () => {
    captured.length = 0;
    const cwd = scratchCwd("t8-scan-verify-unbound-vintage-");
    let on = true;
    const runVerify = makeDefaultRunVerify({
      cwd,
      worktreeOnMutate: { get: () => on },
    });
    on = false; // closure already built: flipping the value must not leak into this round
    await runVerify("true", {});
    assert.deepEqual(captured[0]!.unboundFence, {
      mainCheckout: cwd,
      tmpPad: tmpdir(),
    });
    // Next round (caller rebuilds per round) sees the new value.
    captured.length = 0;
    const nextRound = makeDefaultRunVerify({
      cwd,
      worktreeOnMutate: { get: () => on },
    });
    await nextRound("true", {});
    assert.equal("unboundFence" in captured[0]!, false);
  });
});
