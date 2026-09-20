/**
 * tests/harness/aci/bash-egress-inner-bridge.test.ts
 *
 * specs/egress-ssh-bridge.md — inner bridge preamble in the foreground fence
 * command chain.
 *
 * Pinned invariants:
 *   - with an egress session present, the `bash -c` payload =
 *     `<spec.innerBridgeScript>\n<finalCommand>` (the preamble is the
 *     bundled-node relay's single TCP-LISTEN→UNIX bridge + trap kill EXIT per
 *     ADR-0107 — the consumer-side anchor of "no inner listener assembly in
 *     the repo");
 *   - no egress (factory absent / returns undefined / session start fails) →
 *     payload byte-identical to the V1 baseline (`<finalCommand>` verbatim,
 *     zero preamble residue — the argv face of "no seam = no bridge").
 *
 * Driving: module-level vi.mock("node:child_process") intercepts runInSandbox's
 * spawn (precedent: bash-global-mode-visibility.test.ts) to capture the fence
 * argv, without starting real bwrap children or listeners.
 */
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});

const childProcessMock = await import("node:child_process");
const spawnMock = childProcessMock.spawn as unknown as ReturnType<typeof vi.fn>;

const { createBashTool } =
  await import("../../../src/harness/aci/tools/bash.ts");
const { buildInnerBridgeScript } =
  await import("../../../src/harness/sandbox/egress/session.ts");
const { createEgressViolationSink } =
  await import("../../../src/harness/sandbox/egress/violations.ts");

const FIX_CWD = mkdtempSync(join(tmpdir(), "bash-egress-inner-bridge-"));

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
});

function makeFakeChild(pid = 47181) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill: vi.fn(() => true),
  });
  queueMicrotask(() => {
    child.emit("close", 0);
  });
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeFakeChild());
});
afterEach(() => {
  spawnMock.mockReset();
});

/** Get the `bash -c` payload of the foreground spawn (argv item after "-c"). */
async function driveForeground(
  tool: ReturnType<typeof createBashTool>,
  command: string
): Promise<string> {
  spawnMock.mockClear();
  await tool.handler({ command }, { conversationId: "conv-inner-bridge" });
  const call = spawnMock.mock.calls[0] as readonly unknown[] | undefined;
  const argv = (call?.[1] as readonly string[]) ?? [];
  const idx = argv.indexOf("-c");
  assert.notEqual(idx, -1, "expected a `bash -c` payload in fence argv");
  return argv[idx + 1] ?? "";
}

const STUB_SCRIPT = buildInnerBridgeScript(
  "/test-root/bin/node",
  "/test-root/vendor/egress-relay/egress-tcp-relay.mjs",
  "/tmp/iknow-egress-inner-stub.sock"
);

function stubSessionFactory() {
  return (async () =>
    Object.freeze({
      id: "stub-inner-bridge",
      spec: {
        unixSocketPath: "/tmp/iknow-egress-inner-stub.sock",
        sandboxLocalPort: 3128,
        env: {
          HTTP_PROXY: "http://iknow:tok@127.0.0.1:3128",
          NO_PROXY: "127.0.0.1,localhost",
        },
        innerBridgeScript: STUB_SCRIPT,
        relayAssetsDir: "/test-root/vendor/egress-relay",
      },
      violationSink: createEgressViolationSink(),
      dispose: async () => undefined,
    })) as never;
}

describe("bash 前台命令链内层桥前导 (egress-ssh-bridge T1)", () => {
  it("egress 在场 → payload = innerBridgeScript + '\\n' + finalCommand 逐字", async () => {
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:inner-bridge",
      }),
      createEgressSessionFactory: stubSessionFactory(),
    });
    const payload = await driveForeground(tool, "echo hi");
    assert.equal(payload, `${STUB_SCRIPT}\necho hi`);
    // the preamble contains the single-bridge relay and the trap (shape SSOT is the builder in session.ts; this pins the wiring).
    assert.ok(payload.includes("egress-tcp-relay.mjs"));
    assert.ok(payload.includes(" 3128 "));
    assert.ok(payload.includes('trap "kill %1 2>/dev/null; exit" EXIT'));
    // ADR-0107: the old host-package-dependency wording must not resurface.
    assert.ok(!payload.toLowerCase().includes("socat"));
  });

  it("无 egress（factory 缺席）→ payload byte-identical 于 V1 baseline", async () => {
    const tool = createBashTool(FIX_CWD, {});
    const payload = await driveForeground(tool, "echo hi");
    assert.equal(payload, "echo hi");
  });

  it("egressPolicyFactory 返 undefined → payload byte-identical（无缝 = 无桥，invariant 3）", async () => {
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => undefined,
      createEgressSessionFactory: stubSessionFactory(),
    });
    const payload = await driveForeground(tool, "echo hi");
    assert.equal(payload, "echo hi");
  });
});

/**
 * known_hosts guidance wiring: egress session present + command exits
 * non-zero + stderr matches the ssh first-unknown-host shape → the framework
 * appends one host-side guidance line (ssh-keyscan / -o UserKnownHostsFile=
 * combined form) at the end of the fed-back stderr.
 * No match / no session = envelope stderr byte-identical (zero false-positive discipline).
 */
function makeFailingChild(args: {
  readonly stderrText: string;
  readonly exitCode: number;
}) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 47182,
    kill: vi.fn(() => true),
  });
  queueMicrotask(() => {
    child.stderr.write(args.stderrText);
    child.emit("close", args.exitCode);
  });
  return child;
}

async function driveForegroundResult(
  tool: ReturnType<typeof createBashTool>,
  command: string,
  childFactory: () => EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    kill: () => boolean;
  }
): Promise<string> {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => childFactory());
  const result = (await tool.handler(
    { command },
    { conversationId: "conv-f4-guidance" }
  )) as { output: string; meta: { stderr: string } };
  return (JSON.parse(result.output) as { stderr: string }).stderr;
}

const SSH_UNKNOWN_HOST_STDERR =
  "git@github.com: Permission denied (publickey).\r\n" +
  "Host key verification failed.\r\n";

describe("F4 known_hosts 指引回灌（ssh 类失败文案面）", () => {
  it("egress 在场 + ssh host-key 失败 stderr → 末行补 F4 指引", async () => {
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:f4-guidance",
      }),
      createEgressSessionFactory: stubSessionFactory(),
    });
    const stderr = await driveForegroundResult(tool, "git push", () =>
      makeFailingChild({ stderrText: SSH_UNKNOWN_HOST_STDERR, exitCode: 255 })
    );
    assert.ok(stderr.startsWith(SSH_UNKNOWN_HOST_STDERR));
    assert.match(stderr, /ssh-keyscan/);
    assert.match(stderr, /UserKnownHostsFile=/);
    assert.ok(!stderr.includes("StrictHostKeyChecking=no"));
    // the meta bypass carries the same text as output (consistent with the TUI data surface).
  });

  it("egress 在场 + 非 ssh 失败 stderr → byte-identical（零误报）", async () => {
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:f4-miss",
      }),
      createEgressSessionFactory: stubSessionFactory(),
    });
    const stderr = await driveForegroundResult(tool, "false", () =>
      makeFailingChild({
        stderrText: "bash: line 1: false: error\n",
        exitCode: 1,
      })
    );
    assert.equal(stderr, "bash: line 1: false: error\n");
  });

  it("无 egress session + ssh 形态 stderr → byte-identical（缝不在场不指路）", async () => {
    const tool = createBashTool(FIX_CWD, {});
    const stderr = await driveForegroundResult(tool, "git push", () =>
      makeFailingChild({
        stderrText: SSH_UNKNOWN_HOST_STDERR,
        exitCode: 255,
      })
    );
    assert.equal(stderr, SSH_UNKNOWN_HOST_STDERR);
  });
});
