/**
 * verify route egress release: every command outcome returns the proxy, and a
 * failed release leaves evidence.
 *
 * `makeDefaultRunVerify` starts its egress session lazily and, before this
 * ticket, offered no working release channel at all — `disposeEgressSessionForVerify`
 * was a documented no-op, so each verify round that carried a policy kept a
 * live proxy server and unix socket for the life of the process. The release
 * belongs to the command boundary (`runVerifyOnce`), which is the one place
 * every outcome passes through: success, non-zero exit, timeout, abort and a
 * spawn failure that never produced a child at all.
 *
 * Technique: module-mock the sandbox index exactly like sandbox-run.test.ts
 * (stub `createEgressSession` / `runInSandbox`, keep every other export real),
 * so the fence assembly and the release wiring are the real ones.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

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
import {
  disposeEgressSessionForVerify,
  makeDefaultRunVerify,
  runVerifyOnce,
} from "../../../src/harness/verify/sandbox-run.ts";
import { createEgressViolationSink } from "../../../src/harness/sandbox/egress/violations.ts";
import type { SandboxRunResult } from "../../../src/harness/sandbox/runner.ts";

const scratch: string[] = [];
const POLICY = {
  allowedDomains: ["example.com"],
  deniedDomains: [],
  commandLabel: "verify",
  allowlistSource: "persisted" as const,
};

afterAll(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratchCwd(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

interface SessionHarness {
  readonly disposals: () => number;
  readonly starts: () => number;
}

/** Wire the stub session factory and record every start / release. */
function stubSession(args: {
  readonly dispose?: () => Promise<void>;
  /** Recorded into the session's own sink at start (what the proxy filter does). */
  readonly violation?: {
    readonly host: string;
    readonly reason: "no-approval-inlet" | "denied-by-user";
  };
}): SessionHarness {
  let starts = 0;
  let disposals = 0;
  vi.mocked(sandboxIndex.createEgressSession).mockReset();
  vi.mocked(sandboxIndex.createEgressSession).mockImplementation(async () => {
    starts += 1;
    const sink = createEgressViolationSink();
    if (args.violation !== undefined) {
      sink.record({
        kind: "egress_violation",
        host: args.violation.host,
        port: 443,
        reason: args.violation.reason,
        command: "curl -sS https://evil.example/x",
      });
    }
    return {
      id: `verify-session-${String(starts)}`,
      spec: {
        unixSocketPath: "/tmp/iknow-verify-egress.sock",
        sandboxLocalPort: 19090,
        env: {},
        innerBridgeScript: "",
        relayAssetsDir: "/test/iknow/vendor/egress-relay",
      },
      violationSink: sink,
      dispose: async () => {
        disposals += 1;
        await (args.dispose?.() ?? Promise.resolve());
      },
    };
  });
  return { disposals: () => disposals, starts: () => starts };
}

function stubSandboxRun(result: SandboxRunResult): void {
  vi.mocked(sandboxIndex.runInSandbox).mockReset();
  vi.mocked(sandboxIndex.runInSandbox).mockImplementation(async () => result);
}

/** A sandbox that never came up (bwrap absent, argv rejected, …). */
function stubSandboxSpawnFailure(message: string): void {
  vi.mocked(sandboxIndex.runInSandbox).mockReset();
  vi.mocked(sandboxIndex.runInSandbox).mockImplementation(async () => {
    throw new Error(message);
  });
}

const okRun: SandboxRunResult = { exitCode: 0, stdout: "passed", stderr: "" };

describe("verify egress release on every command outcome", () => {
  it("success: the session started for the command is released", async () => {
    const session = stubSession({});
    stubSandboxRun(okRun);
    const runVerify = makeDefaultRunVerify({
      cwd: scratchCwd("verify-release-ok-"),
      egressPolicy: { ...POLICY },
    });
    await runVerifyOnce(runVerify, "npm test", {
      timeoutSec: 30,
      parentTurnId: "turn-1",
    });
    expect(session.starts()).toBe(1);
    expect(session.disposals()).toBe(1);
  });

  it("nonzero exit: still released (the command failing is not the fence's end of life)", async () => {
    const session = stubSession({});
    stubSandboxRun({ exitCode: 1, stdout: "1 failing", stderr: "boom" });
    const runVerify = makeDefaultRunVerify({
      cwd: scratchCwd("verify-release-nonzero-"),
      egressPolicy: { ...POLICY },
    });
    await runVerifyOnce(runVerify, "npm test", {
      timeoutSec: 30,
      parentTurnId: "turn-1",
    });
    expect(session.disposals()).toBe(1);
  });

  it("timeout: still released", async () => {
    const session = stubSession({});
    // The abort reaches the fence, but the stub still settles a moment later
    // (as a real child does) — which is when the release channel runs.
    vi.mocked(sandboxIndex.runInSandbox).mockReset();
    vi.mocked(sandboxIndex.runInSandbox).mockImplementation(
      () =>
        new Promise<SandboxRunResult>((resolve) => {
          setTimeout(
            () => resolve({ exitCode: 124, stdout: "", stderr: "" }),
            250
          );
        })
    );
    const runVerify = makeDefaultRunVerify({
      cwd: scratchCwd("verify-release-timeout-"),
      egressPolicy: { ...POLICY },
    });
    const { timedOut } = await runVerifyOnce(runVerify, "sleep 100", {
      timeoutSec: 0.01,
      parentTurnId: "turn-1",
    });
    expect(timedOut).toBe(true);
    expect(session.disposals()).toBe(1);
  });

  it("denied egress: the session whose filter blocked the host is still released", async () => {
    // The proxy's own filter records the denial into the session's sink at
    // start; the command then fails to reach the host.
    const session = stubSession({
      violation: { host: "evil.example", reason: "no-approval-inlet" },
    });
    stubSandboxRun({ exitCode: 7, stdout: "", stderr: "proxy denied" });
    const runVerify = makeDefaultRunVerify({
      cwd: scratchCwd("verify-release-denied-"),
      egressPolicy: { ...POLICY },
    });
    const { result } = await runVerifyOnce(
      runVerify,
      "curl -sS https://evil.example/x",
      {
        timeoutSec: 30,
        parentTurnId: "turn-1",
      }
    );
    expect(result.exitCode).toBe(7);
    expect(session.starts()).toBe(1);
    expect(session.disposals()).toBe(1);
  });

  it("spawn failure: released even though the command never produced a child", async () => {
    const session = stubSession({});
    stubSandboxSpawnFailure("spawn ENOENT");
    const runVerify = makeDefaultRunVerify({
      cwd: scratchCwd("verify-release-spawn-fail-"),
      egressPolicy: { ...POLICY },
    });
    const { result } = await runVerifyOnce(runVerify, "npm test", {
      timeoutSec: 30,
      parentTurnId: "turn-1",
    });
    expect(result.exitCode).toBe(127);
    expect(session.starts()).toBe(1);
    expect(session.disposals()).toBe(1);
  });

  it("a second command starts a fresh session (the previous one is not reused)", async () => {
    const session = stubSession({});
    stubSandboxRun(okRun);
    const runVerify = makeDefaultRunVerify({
      cwd: scratchCwd("verify-release-twice-"),
      egressPolicy: { ...POLICY },
    });
    await runVerifyOnce(runVerify, "npm test", {
      timeoutSec: 30,
      parentTurnId: "turn-1",
    });
    await runVerifyOnce(runVerify, "npm test", {
      timeoutSec: 30,
      parentTurnId: "turn-2",
    });
    expect(session.starts()).toBe(2);
    expect(session.disposals()).toBe(2);
  });

  it("disposeEgressSessionForVerify releases a directly-driven session, idempotently", async () => {
    const session = stubSession({});
    stubSandboxRun(okRun);
    const runVerify = makeDefaultRunVerify({
      cwd: scratchCwd("verify-release-helper-"),
      egressPolicy: { ...POLICY },
    });
    await runVerify("npm test", {});
    expect(session.starts()).toBe(1);
    await expect(
      disposeEgressSessionForVerify(runVerify)
    ).resolves.toBeUndefined();
    expect(session.disposals()).toBe(1);
    await expect(
      disposeEgressSessionForVerify(runVerify)
    ).resolves.toBeUndefined();
    expect(session.disposals()).toBe(1);
  });

  it("a failing dispose is recorded, never swallowed", async () => {
    const lines: string[] = [];
    const session = stubSession({
      dispose: async () => {
        throw new Error("proxy close EPERM");
      },
    });
    stubSandboxRun(okRun);
    const runVerify = makeDefaultRunVerify({
      cwd: scratchCwd("verify-release-fail-"),
      egressPolicy: { ...POLICY },
      log: (message: string) => lines.push(message),
    });
    await runVerify("npm test", {});
    await disposeEgressSessionForVerify(runVerify);
    expect(session.disposals()).toBe(1);
    expect(lines.join("\n")).toContain("proxy close EPERM");
  });
});
