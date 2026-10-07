/**
 * ADR-0119 / specs/yolo-mode.md — yolo wiring on the verify sandbox-run face
 * (route 3 of four).
 *
 * Invariants pinned here (Contract §3 / §6):
 *   - `makeDefaultRunVerify` reads the yolo holder once at assembly time -> the
 *     fence takes the bare argv (`argv[0] = "bash"`); absent / false ->
 *     byte-identical to the baseline bwrap argv;
 *   - yolo ON => no egress session starts (no fence = no netns, the proxy seam
 *     is meaningless — ADR-0119 ruling 3): `createEgressSession` is not called
 *     and fenceEnv carries no proxy keys; the control case proves the same
 *     non-yolo input does start a session and inject socket bind + proxy env;
 *   - yolo + workspace fsMode -> yolo wins: a missing homeRoot does not fail
 *     loud either (fsMode has nothing to carry).
 *
 * Technique: mock only the two leaf modules (capture runner.runInSandbox / an
 * egress session stand-in), keep createBwrapFence as the real factory — the
 * assertion surface = the {fence, env} runInSandbox receives (real argv; no
 * bwrap actually spawned; same capture layer as
 * tests/harness/aci/yolo-four-routes.test.ts).
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
  return { ...actual, runInSandbox: vi.fn() };
});
vi.mock(
  "../../../src/harness/sandbox/egress/session.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/harness/sandbox/egress/session.ts")
      >();
    return {
      ...actual,
      createEgressSession: vi.fn(async () => {
        throw new Error(
          "createEgressSession must not be called in this fixture unless the test opts in"
        );
      }),
    };
  }
);

import * as sandboxRunner from "../../../src/harness/sandbox/runner.ts";
import * as egressSessionModule from "../../../src/harness/sandbox/egress/session.ts";
import { createEgressViolationSink } from "../../../src/harness/sandbox/egress/violations.js";
import { makeDefaultRunVerify } from "../../../src/harness/verify/sandbox-run.ts";
import {
  createYoloContext,
  type YoloContext,
} from "../../../src/harness/sandbox/yolo.ts";

interface CapturedRun {
  readonly fence: { readonly argv: readonly string[] };
  readonly env: NodeJS.ProcessEnv;
}

const FIX_CWD = mkdtempSync(join(tmpdir(), "yolo-verify-cwd-"));
const FIX_TMP = mkdtempSync(join(tmpdir(), "yolo-verify-tmp-"));

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
  rmSync(FIX_TMP, { recursive: true, force: true });
});

const capturedRuns: CapturedRun[] = [];

beforeEach(() => {
  capturedRuns.length = 0;
  vi.mocked(sandboxRunner.runInSandbox)
    .mockReset()
    .mockImplementation(async (opts) => {
      capturedRuns.push({
        fence: { argv: [...opts.fence.argv] },
        env: opts.env,
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    });
  // Explicitly reinstall the egress stand-in (returns a fake session whose spec
  // can be asserted for "was it consumed").
  vi.mocked(egressSessionModule.createEgressSession)
    .mockReset()
    .mockImplementation(async () => {
      return {
        id: "test-egress-session",
        spec: {
          unixSocketPath: "/tmp/iknow-yolo-verify-test.sock",
          sandboxLocalPort: 18080,
          env: { HTTP_PROXY: "http://127.0.0.1:18080" },
          innerBridgeScript: "",
          relayAssetsDir: "",
        },
        violationSink: createEgressViolationSink(),
        dispose: async () => undefined,
      };
    });
});

afterEach(() => {
  vi.clearAllMocks();
});

const EGRESS_POLICY = {
  allowedDomains: ["example.com"],
  deniedDomains: [],
  commandLabel: "verify:yolo",
} as const;

describe("verify sandbox-run face — yolo wiring (ADR-0119)", () => {
  it("yolo true -> verify fence gets bare argv, no egress session starts (even with an egressPolicy present)", async () => {
    const runVerify = makeDefaultRunVerify({
      cwd: FIX_CWD,
      tmpDir: FIX_TMP,
      yolo: createYoloContext(true),
      egressPolicy: EGRESS_POLICY,
    });
    const result = await runVerify("echo hi", {});
    expect(result.exitCode).toBe(0);
    expect(capturedRuns).toHaveLength(1);
    expect(capturedRuns[0]!.fence.argv).toEqual(["bash", "-c", "echo hi"]);
    expect(Object.keys(capturedRuns[0]!.env)).not.toContain("HTTP_PROXY");
    expect(
      vi.mocked(egressSessionModule.createEgressSession)
    ).not.toHaveBeenCalled();
  });

  it("control case: non-yolo + egressPolicy -> session starts, fence gets socket bind + proxy env", async () => {
    const runVerify = makeDefaultRunVerify({
      cwd: FIX_CWD,
      tmpDir: FIX_TMP,
      egressPolicy: EGRESS_POLICY,
    });
    await runVerify("echo hi", {});
    expect(
      vi.mocked(egressSessionModule.createEgressSession)
    ).toHaveBeenCalledTimes(1);
    expect(capturedRuns).toHaveLength(1);
    const argv = capturedRuns[0]!.fence.argv;
    expect(argv[0]).toBe("bwrap");
    expect(argv).toContain("/tmp/iknow-yolo-verify-test.sock");
    expect(Object.keys(capturedRuns[0]!.env)).toContain("HTTP_PROXY");
  });

  it("yolo absent -> baseline bwrap argv; yolo:false is byte-identical to it (fail-closed, same shape)", async () => {
    const baselineVerify = makeDefaultRunVerify({
      cwd: FIX_CWD,
      tmpDir: FIX_TMP,
    });
    await baselineVerify("echo hi", {});
    const falseVerify = makeDefaultRunVerify({
      cwd: FIX_CWD,
      tmpDir: FIX_TMP,
      yolo: createYoloContext(false),
    });
    await falseVerify("echo hi", {});
    expect(capturedRuns).toHaveLength(2);
    const baseline = capturedRuns[0]!.fence.argv;
    expect(baseline[0]).toBe("bwrap");
    expect(baseline).toContain("--unshare-net");
    expect(capturedRuns[1]!.fence.argv).toEqual(baseline);
  });

  it("yolo true + fsMode workspace (homeRoot absent) -> no throw and the argv stays bare (yolo wins)", async () => {
    const runVerify = makeDefaultRunVerify({
      cwd: FIX_CWD,
      tmpDir: FIX_TMP,
      yolo: createYoloContext(true) as YoloContext,
      fsMode: "workspace",
      // homeRoot is missing on purpose — under non-yolo bwrap fails loud with a
      // typed error; under yolo the fence retires wholesale, so that guard must
      // not fire.
    });
    await runVerify("echo hi", {});
    expect(capturedRuns).toHaveLength(1);
    expect(capturedRuns[0]!.fence.argv).toEqual(["bash", "-c", "echo hi"]);
  });
});
