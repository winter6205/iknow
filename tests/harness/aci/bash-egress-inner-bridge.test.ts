/**
 * tests/harness/aci/bash-egress-inner-bridge.test.ts
 *
 * specs/egress-ssh-bridge.md T1 —— 前台 fence 命令链的**内层桥前导**接线。
 *
 * 钉住的不变式：
 *   - egress session 在场 → `bash -c` 的 payload =
 *     `<spec.innerBridgeScript>\n<finalCommand>`（前导 = 自带 node 中继
 *     单桥 TCP-LISTEN→UNIX + trap kill EXIT，ADR-0107 换装；O3「全仓无
 *     内层监听装配」的清偿点在消费侧的第一处）；
 *   - 无 egress（factory 缺席 / 返 undefined / session start 失败）→
 *     payload 与 V1 baseline **byte-identical**（`<finalCommand>` 逐字节，
 *     无任何前导残留 —— invariant 3「无缝 = 无桥」的 argv 面）。
 *
 * 驱动方式：模块级 vi.mock("node:child_process") 拦截 runInSandbox 的
 * spawn（同 bash-global-mode-visibility.test.ts 先例），捕获 fence argv，
 * 不真起 bwrap 子进程、不真监听。
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

/** 取前台 spawn 的 `bash -c` payload（argv 中 "-c" 后一项）。 */
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
    // 前导含单桥中继与 trap（形状 SSOT 在 session.ts 的构建器，此处钉接线）。
    assert.ok(payload.includes("egress-tcp-relay.mjs"));
    assert.ok(payload.includes(" 3128 "));
    assert.ok(payload.includes('trap "kill %1 2>/dev/null; exit" EXIT'));
    // ADR-0107：旧宿主装包依赖字样不得回潮。
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
 * F4 known_hosts 指引接线（review Spec Medium）：egress session 在场 +
 * 命令非零退出 + stderr 命中 ssh 首次未见主机形态 → 框架在回灌 stderr
 * 末尾补一行宿主侧指引（ssh-keyscan / -o UserKnownHostsFile= 组合写法）。
 * 不命中 / 无 session = envelope stderr byte-identical（零误报纪律）。
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
    // meta 旁路与 output 同文（TUI 取数面一致）。
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
