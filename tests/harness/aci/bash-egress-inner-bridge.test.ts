/**
 * tests/harness/aci/bash-egress-inner-bridge.test.ts
 *
 * specs/egress-ssh-bridge.md T1 —— 前台 fence 命令链的**内层桥前导**接线。
 *
 * 钉住的不变式：
 *   - egress session 在场 → `bash -c` 的 payload =
 *     `<spec.innerBridgeScript>\n<finalCommand>`（前导 = socat TCP-LISTEN
 *     单桥 + trap kill EXIT，O3「全仓无 TCP-LISTEN/UNIX-CONNECT 装配」的
 *     清偿点在消费侧的第一处）；
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
const spawnMock = childProcessMock.spawn as unknown as ReturnType<
  typeof vi.fn
>;

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
  "socat",
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
    // 前导含单桥监听与 trap（形状 SSOT 在 session.ts 的构建器，此处钉接线）。
    assert.ok(payload.includes("TCP-LISTEN:3128,fork,reuseaddr"));
    assert.ok(payload.includes('trap "kill %1 2>/dev/null; exit" EXIT'));
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
