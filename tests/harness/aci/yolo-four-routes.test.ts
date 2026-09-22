/**
 * ADR-0119 / specs/yolo-mode.md — yolo wiring of the foreground bash surface
 * (route 1 of four).
 *
 * Invariants pinned (Contract §3 / §5 / §6):
 *   - `CreateBashToolOptions.yolo` (holder) is snapshotted once per call at
 *     handler entry (D2, same shape as fsMode) -> `buildForegroundFence` passes
 *     yolo -> the fence argv is bare (`argv[0] = "bash"`);
 *   - yolo ON skips the egress seam wholesale: `startEgressSessionForCall` starts
 *     no session (no socket bind, no proxy env); the non-yolo path is byte-identical;
 *   - the `requireBwrap` sequencing ruling: at factory time the yolo holder's
 *     initial value decides whether to probe — the yolo assembly path skips it (so a
 *     host without bwrap can still assemble); non-yolo behavior is unchanged
 *     (no bwrap -> throws during assembly).
 *
 * Technique: module-mock runner.ts only (a no-op `requireBwrap` spy + a
 * `runInSandbox` stand-in) and keep `createBwrapFence` the real factory — the
 * asserted face is the {fence, env} `runInSandbox` receives, i.e. the real fence
 * argv and the real fenceEnv (bwrap never actually runs; same mock shape as
 * tests/subagent/bash-mode-channel.test.ts, one capture layer deeper).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../../../src/harness/sandbox/runner.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/harness/sandbox/runner.ts")
    >();
  return {
    ...actual,
    requireBwrap: vi.fn(),
    runInSandbox: vi.fn(),
  };
});

import * as sandboxRunner from "../../../src/harness/sandbox/runner.ts";
import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";
import {
  createYoloContext,
  type YoloContext,
} from "../../../src/harness/sandbox/yolo.ts";

/** The {fence, env} captured by the runInSandbox stand-in — fence comes from the real factory. */
interface CapturedRun {
  readonly fence: { readonly argv: readonly string[] };
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

const FIX_CWD = mkdtempSync(join(tmpdir(), "yolo-four-routes-cwd-"));
const FIX_TMP = mkdtempSync(join(tmpdir(), "yolo-four-routes-tmp-"));

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
  rmSync(FIX_TMP, { recursive: true, force: true });
});

const capturedRuns: CapturedRun[] = [];

beforeEach(() => {
  capturedRuns.length = 0;
  vi.mocked(sandboxRunner.requireBwrap).mockReset();
  vi.mocked(sandboxRunner.runInSandbox)
    .mockReset()
    .mockImplementation(async (opts) => {
      capturedRuns.push({
        fence: { argv: [...opts.fence.argv] },
        env: opts.env,
        cwd: opts.cwd,
      });
      return { exitCode: 0, stdout: "hi\n", stderr: "" };
    });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function runBash(opts: {
  readonly yolo?: YoloContext;
  readonly egressPolicyFactory?: () => unknown;
  readonly createEgressSessionFactory?: () => unknown;
  readonly command?: string;
}): Promise<void> {
  const tool = createBashTool(FIX_CWD, {
    tmpDir: FIX_TMP,
    ...(opts.yolo !== undefined ? { yolo: opts.yolo } : {}),
    ...(opts.egressPolicyFactory !== undefined
      ? { egressPolicyFactory: opts.egressPolicyFactory as never }
      : {}),
    ...(opts.createEgressSessionFactory !== undefined
      ? {
          createEgressSessionFactory: opts.createEgressSessionFactory as never,
        }
      : {}),
  });
  await tool.handler(
    { command: opts.command ?? "echo hi" },
    { conversationId: "yolo-four-routes" }
  );
}

describe("foreground bash surface — yolo wiring (ADR-0119)", () => {
  it("yolo ON -> the foreground fence is bare argv (argv[0] = bash) and requireBwrap is never called", async () => {
    await runBash({ yolo: createYoloContext(true) });
    expect(capturedRuns).toHaveLength(1);
    expect(capturedRuns[0]!.fence.argv).toEqual(["bash", "-c", "echo hi"]);
    expect(capturedRuns[0]!.cwd).toBe(FIX_CWD);
    // The factory skips the bwrap probe (a host without bwrap can still assemble).
    expect(vi.mocked(sandboxRunner.requireBwrap)).not.toHaveBeenCalled();
  });

  it("yolo ON skips the egress seam wholesale: the session factory is untouched, fenceEnv carries no proxy key", async () => {
    const egressSessionFactory = vi.fn(() => {
      throw new Error("egress session must not be started under yolo");
    });
    await runBash({
      yolo: createYoloContext(true),
      egressPolicyFactory: () => ({
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "test:yolo-egress-skip",
      }),
      createEgressSessionFactory: egressSessionFactory as never,
    });
    expect(egressSessionFactory).not.toHaveBeenCalled();
    expect(capturedRuns).toHaveLength(1);
    // No fence means no netns, so the proxy seam has nothing to carry: no proxy key
    // in env, argv is bare.
    expect(Object.keys(capturedRuns[0]!.env)).not.toContain("HTTP_PROXY");
    expect(capturedRuns[0]!.fence.argv).toEqual(["bash", "-c", "echo hi"]);
  });

  it("yolo absent -> baseline bwrap argv; yolo:false is byte-identical to it (fail-closed, same shape)", async () => {
    await runBash({});
    await runBash({ yolo: createYoloContext(false) });
    expect(capturedRuns).toHaveLength(2);
    const baseline = capturedRuns[0]!.fence.argv;
    expect(baseline[0]).toBe("bwrap");
    expect(baseline).toContain("--unshare-net");
    expect(capturedRuns[1]!.fence.argv).toEqual(baseline);
    // Non-yolo: the factory probes as before (once per createBashTool).
    expect(vi.mocked(sandboxRunner.requireBwrap)).toHaveBeenCalledTimes(2);
  });

  it("requireBwrap sequencing: on a host without bwrap non-yolo assembly throws typed, yolo assembly does not", () => {
    vi.mocked(sandboxRunner.requireBwrap).mockImplementation(() => {
      throw new ToolExecutionError(
        "runInSandbox: bwrap is required; install bwrap (≥ 0.11.1)"
      );
    });
    // Non-yolo (holder absent): throws during assembly (existing behavior unchanged).
    expect(() => createBashTool(FIX_CWD, { tmpDir: FIX_TMP })).toThrow(
      ToolExecutionError
    );
    // Non-yolo (holder explicitly false): fail-closed, same shape.
    expect(() =>
      createBashTool(FIX_CWD, {
        tmpDir: FIX_TMP,
        yolo: createYoloContext(false),
      })
    ).toThrow(ToolExecutionError);
    // yolo ON: the assembly path skips the probe — a host without bwrap does not
    // block assembly.
    expect(() =>
      createBashTool(FIX_CWD, {
        tmpDir: FIX_TMP,
        yolo: createYoloContext(true),
      })
    ).not.toThrow();
  });
});
