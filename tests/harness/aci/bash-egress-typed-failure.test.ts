/**
 * tests/harness/aci/bash-egress-typed-failure.test.ts
 *
 * T5 tier 1→mid 端到端走读（specs/network-egress-allowlist.md §Violation
 * feedback channel 第 3 跳「前缀与 tier 入口」+ SC3 验收点）。
 *
 * **钉住的不变式（来自 spec §T5 选定形态(a)+ §假绿警告）**：
 *   - bash handler 在 egress session 记录违例时抛 `ToolExecutionError`，
 *     message 含 `[network_denied]` 前缀 —— 由 executor `buildFailureResult`
 *     路径包成 `kind: "execution_failed"`；
 *   - 把该 result 喂给既有 `categorizeResult` → tier == "mid"；
 *   - **不**直接构造 `kind: "execution_failed"` 假绿 —— message 必须从
 *     bash handler 的真实返回流出来（spec 点名
 *     `violation-handling.test.ts:269-279` 为反面教材）。
 *
 * 测试不依赖真实 socat / bwrap：使用 bash tool 的
 * `createEgressSessionFactory` 测试 seam（生产不传）注入 stub session，
 * stub 在构造时主动 record 一条违例；bash handler drain → throw → executor
 * 包装 → categorizeResult 全链路。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import {
  SocatUnavailableError,
  type EgressSession,
  type EgressSessionOptions,
} from "../../../src/harness/sandbox/egress/session.js";
import {
  createEgressViolationSink,
  type EgressViolation,
} from "../../../src/harness/sandbox/egress/violations.js";
import type { ToolExecutionContext } from "../../../src/harness/tools/types.js";
import { createExecutor } from "../../../src/harness/tools/executor.js";
import { createRegistry } from "../../../src/harness/tools/registry.js";
import { categorizeResult } from "../../../src/harness/sandbox/violation-handling.js";
import type { ToolCall } from "../../../src/harness/tools/types.js";
import { buildViolationWiring } from "../../../src/harness/sandbox/violation-executor.js";

const FIX_CWD = mkdtempSync(join(tmpdir(), "bash-egress-typed-failure-"));

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
});

/**
 * 构造 stub `createEgressSession` —— 不真起 socat / proxy，直接构造一个
 * session 形状，spec 用空 fence 占位（bash handler 在 fence 装配期会读
 * `spec` 的 `unixSocketPath` / `sandboxLocalPort` / `env`；不真起桥仍
 * 满足装配要求，因为 runSandbox 不会去 dial）。
 *
 * 同时 stub 在构造时主动 record 一条 `not-in-allowlist` 违例到 sink，
 * bash handler drain 时会取到 → throw typed failure。
 */
function makeStubEgressSessionFactory(args: {
  readonly host: string;
  readonly port: number;
  readonly command: string;
  readonly reason: EgressViolation["reason"];
  readonly allowlistSource?: "session" | "persisted" | "preset";
}): (opts: EgressSessionOptions) => Promise<EgressSession> {
  return async () => {
    const sink = createEgressViolationSink();
    sink.record({
      kind: "egress_violation",
      host: args.host,
      port: args.port,
      reason: args.reason,
      command: args.command,
    });
    const id = "stub-session-id";
    const spec = {
      unixSocketPath: "/tmp/iknow-egress-stub.sock",
      sandboxLocalPort: 0,
      env: {},
    };
    return Object.freeze({
      id,
      spec,
      violationSink: sink,
      dispose: async () => undefined,
    });
  };
}

describe("bash handler → executor → categorizeResult → mid tier (T5 typed failure, SC3)", () => {
  it("egress 拒绝 → handler 抛 ToolExecutionError → executor 包 execution_failed → categorizeResult → mid", async () => {
    const stub = makeStubEgressSessionFactory({
      host: "evil.example",
      port: 443,
      command: "curl -sS https://evil.example/x",
      reason: "not-in-allowlist",
    });

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "curl -sS https://evil.example/x",
      }),
      createEgressSessionFactory: stub as never,
    });

    // 真实 executor + registry 装配 —— 走 buildOkResult / buildFailureResult
    // 真实路径，不在测试里手搓 `kind: "execution_failed"` 假绿。
    const registry = createRegistry([tool]);
    const inner = createExecutor(registry);
    const { executor } = buildViolationWiring(inner, {
      sink: () => undefined,
    });

    const calls: ReadonlyArray<ToolCall> = [
      Object.freeze({
        id: "u1",
        name: "bash",
        input: { command: "curl -sS https://evil.example/x" },
      }) as ToolCall,
    ];

    const results = await executor.executeAll(calls);
    expect(results).toHaveLength(1);
    const r = results[0]!;

    // 真走 bash handler → executor 真实路径 —— result 是 execution_failed
    // (typed-error catch → buildFailureResult)。message 含 [network_denied]
    // 前缀（直接从 handler 抛的 ToolExecutionError.message 流出来）。
    expect(r.kind).toBe("execution_failed");
    const message = (r as { message: string }).message;
    expect(message).toContain("[network_denied]");
    expect(message).toContain("evil.example:443");
    expect(message).toContain("isolation.network.allowedDomains");
    // 「命令已跑完但出网被拒」语义
    expect(message).toContain("command ran to completion");
    // exit code 旁路（partial stdout/stderr）—— 当前 runInSandbox 已 spawn
    // 真 bwrap 跑 `true` —— 不会触发，但 stub session 让违例路径先 throw
    // 在 runSandbox 之前。本测试用 `curl ...` 命令，runSandbox 真起来会
    // 跑 curl；curl 在 bwrap 内被 `--unshare-net` 隔断，exit 非零 —— 但
    // 我们关心的不是 exit code（typed failure 才是观察面）。

    // 喂给既有 categorizeResult —— 必须命中 mid tier（spec §假绿警告：
    // 这里 message 是从 bash handler 真实返回流出来的，不是手搓）。
    const cat = categorizeResult({
      name: "bash",
      input: { command: "curl -sS https://evil.example/x" },
      kind: r.kind,
      message,
    });
    expect(cat.tier).toBe("mid");
    expect(cat.detail).toContain("[network_denied]");
    expect(cat.detail).toContain("evil.example");
  });

  it("infra failure (egressStartError) → handler 抛 ToolExecutionError,message 显式标 'infrastructure fault' 不给配置键指引", async () => {
    // 让 stub 在构造时抛 SocatUnavailableError 形态 —— bash handler
    // 把它当 startError 走 infra 路径。
    const stub = (async () => {
      throw new Error(
        "egress seam unavailable for this call: stub bridge dead"
      );
    }) as never;

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:infra-fail",
      }),
      createEgressSessionFactory: stub,
    });

    const registry = createRegistry([tool]);
    const inner = createExecutor(registry);
    const { executor } = buildViolationWiring(inner, {
      sink: () => undefined,
    });

    const calls: ReadonlyArray<ToolCall> = [
      Object.freeze({
        id: "u2",
        name: "bash",
        input: { command: "true" },
      }) as ToolCall,
    ];

    const results = await executor.executeAll(calls);
    const r = results[0]!;
    expect(r.kind).toBe("execution_failed");
    const message = (r as { message: string }).message;
    expect(message).toContain("[network_denied]");
    // infra 与域判定拒绝文案可区分(spec §三类信号 + §Failure paths)
    expect(message).toContain("egress seam unavailable");
    expect(message).toContain("infrastructure fault");
    // 修复指引:infra → 不给配置键指引(避免误导)
    expect(message).not.toContain("isolation.network.allowedDomains");
    expect(message).not.toContain("configure isolation.network");

    // 同样 mid tier(前缀命中 `networkDenied` 分支)
    const cat = categorizeResult({
      name: "bash",
      input: {},
      kind: r.kind,
      message,
    });
    expect(cat.tier).toBe("mid");
  });

  it("drain 空 + 无 startError → handler 维持 V1 ok 形状(byte-identical 于 T4 前)", async () => {
    // stub session: drain 空(不 record 任何违例) —— handler 应走 V1 ok
    // 形状,抛 ToolExecutionError 路径不进入。这条用例验证「违例 / startError
    // 均空时维持 ok」是 T5 升级后保留的不变式(回归基线)。
    const stub = (async () => {
      const sink = createEgressViolationSink();
      return Object.freeze({
        id: "stub-empty",
        spec: {
          unixSocketPath: "/tmp/iknow-egress-empty.sock",
          sandboxLocalPort: 0,
          env: {},
        },
        violationSink: sink,
        dispose: async () => undefined,
      });
    }) as never;

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:empty-drain",
      }),
      createEgressSessionFactory: stub,
    });

    const ctx: ToolExecutionContext = { conversationId: "conv-empty" };
    const out = await tool.handler({ command: "true" }, ctx);
    // V1 ok 形状:envelope { output, meta? }
    expect(out).toBeTypeOf("object");
    const envelope = out as {
      output: string;
      meta?: { stdout: string; stderr: string };
    };
    expect(typeof envelope.output).toBe("string");
    const parsed = JSON.parse(envelope.output) as {
      code: number;
      stdout: string;
      stderr: string;
    };
    // exit code 来自 bwrap runInSandbox —— 通常 0 (true 命令)
    expect(typeof parsed.code).toBe("number");
    // stderr 不含 typed failure 文案前缀
    expect(parsed.stderr).not.toContain("[network_denied]");
  });

  it("SocatUnavailableError typed-error catch 契约 → typed failure message 含 socat 命令名 + 补装指引(apt install 字样)", async () => {
    // typed-error catch 契约(code-quality.md):startEgressSessionForCall 的 catch
    // 必须先识别判别联合的具体类型。对 SocatUnavailableError 这种携带 socatCommand
    // + installHint 的 typed 错误直接构造结构化 startError / infraHint;透传到
    // renderEgressFailureMessage 的 infraHint 后,typed failure message 必须
    // 让模型/TUI 看到「装哪个 + 怎么装」(SC13 验收点 + spec §三类信号可区分)。
    const stubThrowSocatUnavailable = (async () => {
      throw new SocatUnavailableError(
        "socat",
        "Install socat (Debian/Ubuntu: `sudo apt install socat`; macOS: `brew install socat`)"
      );
    }) as never;

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "curl https://example.com/x",
      }),
      createEgressSessionFactory: stubThrowSocatUnavailable,
    });

    const registry = createRegistry([tool]);
    const inner = createExecutor(registry);
    const { executor } = buildViolationWiring(inner, {
      sink: () => undefined,
    });

    const calls: ReadonlyArray<ToolCall> = [
      Object.freeze({
        id: "u4",
        name: "bash",
        input: { command: "curl https://example.com/x" },
      }) as ToolCall,
    ];
    const results = await executor.executeAll(calls);
    const r = results[0]!;
    expect(r.kind).toBe("execution_failed");
    const message = (r as { message: string }).message;

    // typed-error 渲染契约:typed failure message 必须含 socat 命令名 + 补装指引,
    // 不被 plain object 的 [object Object] 吞掉。
    expect(message).toContain("[network_denied]");
    // socat 命令名显式出现(非 [object Object])
    expect(message).toContain("socat");
    // 补装指引 —— 「sudo apt install socat」字样直接出现
    expect(message).toContain("sudo apt install socat");
    // infra/域判定分离仍然成立:不出现域判定修复指引
    expect(message).not.toContain("isolation.network.allowedDomains");
    expect(message).not.toContain("configure isolation.network");
    // infra 三字语义保留
    expect(message).toContain("infrastructure fault");

    // 中 tier 路由保持(prefix 命中 networkDenied → mid)
    const cat = categorizeResult({
      name: "bash",
      input: {},
      kind: r.kind,
      message,
    });
    expect(cat.tier).toBe("mid");
  });

  it("allowlistSource 透传 → typed failure message 标注 'Current allowlist source'", async () => {
    // 验证 T5 阶段虽未接 T6 真值,但 allowlistSource 透传链路通:装配面
    // 注入 → typed failure 渲染管线消费 → 文案含来源标注。
    const stub = makeStubEgressSessionFactory({
      host: "evil.example",
      port: 443,
      command: "curl",
      reason: "not-in-allowlist",
      allowlistSource: "session",
    });

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "curl",
        allowlistSource: "session",
      }),
      createEgressSessionFactory: stub as never,
    });

    const registry = createRegistry([tool]);
    const inner = createExecutor(registry);
    const { executor } = buildViolationWiring(inner, {
      sink: () => undefined,
    });

    const calls: ReadonlyArray<ToolCall> = [
      Object.freeze({
        id: "u3",
        name: "bash",
        input: { command: "curl" },
      }) as ToolCall,
    ];
    const results = await executor.executeAll(calls);
    const r = results[0]!;
    expect(r.kind).toBe("execution_failed");
    const message = (r as { message: string }).message;
    expect(message).toContain(
      "Current allowlist source: session-level allowlist"
    );
  });
});
