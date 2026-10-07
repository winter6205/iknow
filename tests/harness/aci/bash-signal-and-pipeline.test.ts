/**
 * Foreground bash: observable termination cause, honest pipeline status, and a
 * release failure that leaves evidence instead of silence.
 *
 * Three pinned facts:
 *   1. A signal-terminated fence reports the signal name next to 128+N in the
 *      model-visible envelope (the exit code alone cannot distinguish the
 *      bounded teardown from the command's own `kill`).
 *   2. `producer | tail` reports **tail's** real status. This is the shell's
 *      status with the declared `bash -c` semantics and no `pipefail`; it is
 *      deliberately NOT a recovery of the producer's status, and the command
 *      runs the producer directly when that status is the thing under test.
 *   3. A failing egress-session dispose is recorded in the result's stderr
 *      channel. The release runs after the fence finished, so it cannot change
 *      the exit status; swallowing it would leave a proxy/socket release in
 *      question with no record anywhere.
 *
 * Real bwrap fences throughout (skipped where bwrap is absent); the egress
 * session is a stub carrying the same seams the handler reads.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import type { EgressSession } from "../../../src/harness/sandbox/egress/session.js";
import { createEgressViolationSink } from "../../../src/harness/sandbox/egress/violations.js";

const FIX_CWD = mkdtempSync(join(tmpdir(), "bash-signal-"));
afterAll(() => rmSync(FIX_CWD, { recursive: true, force: true }));

function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

interface BashEnvelope {
  readonly output: string;
}
interface BashJson {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal?: string;
}
async function runBash(command: string): Promise<BashJson> {
  const tool = createBashTool(FIX_CWD);
  const envelope = (await tool.handler({ command })) as BashEnvelope;
  return JSON.parse(envelope.output) as BashJson;
}

/** Session stub whose dispose rejects — the "release failed" arm. */
function stubSessionFailingDispose(args: {
  readonly sockPath: string;
  readonly relayDir: string;
}): () => Promise<EgressSession> {
  return async () => ({
    id: "stub-dispose-fail",
    spec: {
      unixSocketPath: args.sockPath,
      sandboxLocalPort: 0,
      env: {},
      innerBridgeScript: "",
      relayAssetsDir: args.relayDir,
    },
    violationSink: createEgressViolationSink(),
    dispose: async () => {
      throw new Error("stub proxy close failed");
    },
  });
}

describe.skipIf(!hasBwrap())("bash foreground truthful status", () => {
  it("yolo (bare argv, host-observed) signal termination reports the name beside 128+N", async () => {
    // yolo is the one foreground shape that runs the fence argv directly, so
    // the host — not a bwrap boundary — observes the exit signal. That is the
    // projection this assertion pins.
    const tool = createBashTool(FIX_CWD, {
      yolo: { get: () => true, set: () => undefined },
    });
    const envelope = (await tool.handler({
      command: "kill -9 $$",
    })) as BashEnvelope;
    const result = JSON.parse(envelope.output) as BashJson;
    assert.equal(result.code, 137, "shell convention 128 + 9");
    assert.equal(result.signal, "SIGKILL");
  });

  it("bwrap fence: a signal-folded 137 carries no fabricated signal name", async () => {
    // bwrap 0.11.1 reports its child's signal death as exit code 128+N and
    // exits normally, so the host never sees the signal. The envelope must
    // publish what was observed: 137, and no invented `signal`.
    const result = await runBash("kill -9 $$");
    assert.equal(result.code, 137);
    assert.equal(result.signal, undefined);
  });

  it("natural exit reports no signal field", async () => {
    const result = await runBash("echo done; exit 3");
    assert.equal(result.code, 3);
    assert.equal(result.signal, undefined);
  });

  it("producer | tail reports tail's real status (no pipefail — not a recovery of the producer's)", async () => {
    const result = await runBash("sh -c 'echo installing; exit 3' | tail -n 1");
    assert.equal(result.stdout.trim(), "installing");
    assert.equal(
      result.code,
      0,
      "the pipeline's status is tail's; the producer's 3 is not recoverable here"
    );
    // Same producer run directly keeps its own status — that is the command
    // shape a test uses when the producer's status is the thing under test.
    const direct = await runBash("sh -c 'echo installing; exit 3'");
    assert.equal(direct.code, 3);
  });

  it("failing egress dispose is recorded in the result's stderr channel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bash-egress-sock-"));
    // The fence binds both the session socket path and the relay assets dir,
    // so both stub paths must exist on the host.
    const sockPath = join(dir, "iknow-egress-stub.sock");
    writeFileSync(sockPath, "");
    const relayDir = join(dir, "relay");
    mkdirSync(relayDir);
    try {
      const tool = createBashTool(FIX_CWD, {
        egressPolicyFactory: () => ({
          allowedDomains: [],
          deniedDomains: [],
          commandLabel: "test:dispose-failure",
        }),
        createEgressSessionFactory: stubSessionFailingDispose({
          sockPath,
          relayDir,
        }) as never,
      });
      const envelope = (await tool.handler({
        command: "echo hi",
      })) as BashEnvelope;
      const result = JSON.parse(envelope.output) as BashJson;
      assert.equal(result.code, 0, "the command itself succeeded");
      expect(result.stderr).toContain("stub proxy close failed");
      expect(result.stderr).toMatch(/egress/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
/**
 * Input boundary: an empty command starts nothing.
 *
 * The handler rejects it before the fence is built, so no session is started,
 * no bwrap runs and no deadline timer is armed — the "rejected calls start no
 * child process" half of the input contract. Pinning test: the behaviour is
 * already in place, this test only holds it there.
 */
describe("bash input boundary — empty command", () => {
  it("rejected before any egress session or fence exists", async () => {
    let sessionStarts = 0;
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: [],
        deniedDomains: [],
        commandLabel: "test:empty",
      }),
      createEgressSessionFactory: (async () => {
        sessionStarts += 1;
        throw new Error("must not be reached");
      }) as never,
    });
    await expect(tool.handler({ command: "" })).rejects.toThrow(
      /non-empty string/
    );
    expect(sessionStarts).toBe(0);
  });
});
