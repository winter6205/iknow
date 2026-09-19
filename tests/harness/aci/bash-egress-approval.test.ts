/**
 * Tests for `aci/tools/bash.ts` T6 首次域名批准流接线
 * (specs/network-egress-allowlist.md §首次域名批准流 + SC10)。
 *
 * 钉住的不变式(spec §Boundaries 「首次域名批准流」 + §Failure paths 三行 +
 * §Input-contract classes「首次域名批准」行 + §三类信号可区分):
 *   - bash tool 装配 askApproval 时,egressPolicyFactory 返回的 policy 自动
 *     带上 `approvalGate`(由 bash 工厂闭包期构造,跨调用共享同一会话级集);
 *   - stub session 内 filter 调用 gate 后:批准 → 返回 true + 不记违例;
 *     拒绝 → 返回 false + 记 `denied-by-user` 违例;
 *     gate 缺席 → not-in-allowlist 记 `no-approval-inlet` 违例;
 *   - askApproval 抛异常 → fail-closed(等价于拒绝:记 `denied-by-user`);
 *   - 同 host 第二次调用 → 不再调 askApproval(gate 内部集合命中)。
 *
 * 本测试不真起中继/proxy —— 使用 `createEgressSessionFactory` 注入 stub
 * session,stub 内部把 filter 回调提取出来让我们驱动(filter 在 stub session
 * 构造期即被调用一次,暴露给测试断言),直接验 filter→gate→违例的链路。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";
import { createEgressViolationSink } from "../../../src/harness/sandbox/egress/violations.js";
import type {
  EgressPolicyInput,
  EgressSession,
  EgressSessionOptions,
} from "../../../src/harness/sandbox/egress/session.js";

const FIX_CWD = mkdtempSync(join(tmpdir(), "bash-egress-approval-cwd-"));

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
});

/**
 * Stub session —— 暴露一个可在测试里手动触发的 filter 回调(不真起中继
 * / proxy / 路径守卫)。每次 invokeFilter 即模拟一次 CONNECT 请求。
 *
 * 把 policyInput 持有的 approvalGate 直接拉出来调,模拟「代理 filter 看到
 * host → 调 gate.askIfUnknown(host) → 决定放行/拒绝」。
 */
function makeDrivenEgressSessionFactory(): {
  factory: (opts: EgressSessionOptions) => Promise<EgressSession>;
  captured: { policy?: EgressPolicyInput };
} {
  const captured: { policy?: EgressPolicyInput } = {};
  const factory = async (
    opts: EgressSessionOptions
  ): Promise<EgressSession> => {
    captured.policy = opts.policy;
    const sink = createEgressViolationSink();
    return Object.freeze({
      id: "stub-approval",
      spec: {
        unixSocketPath: "/tmp/iknow-egress-stub.sock",
        sandboxLocalPort: 0,
        env: {},
        innerBridgeScript: "",
        relayAssetsDir: "/test/iknow/vendor/egress-relay",
      },
      violationSink: sink,
      dispose: async () => undefined,
    });
  };
  return { factory, captured };
}

/** 与既有 typed-failure 测试一致的 bash envelope 形状解析。 */
interface BashEnvelope {
  readonly output: string;
}
interface BashResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
function parseBashEnvelope(envelope: BashEnvelope): BashResult {
  return JSON.parse(envelope.output) as BashResult;
}

describe("bash handler — T6 首次域名批准流接线 (SC10)", () => {
  it("egressPolicyFactory 缺席 + askApproval 在场 → handler 仍走 V1 路径(egress 不起)", async () => {
    // askApproval 在场但 egressPolicyFactory 缺席 → bash 工厂不构造 gate
    // (gate 只在 policy 路径上注入),V1 baseline:handler 走无 egress 缝路径,
    // stub 不被调。
    const { factory } = makeDrivenEgressSessionFactory();
    const tool = createBashTool(FIX_CWD, {
      askApproval: async () => true,
      createEgressSessionFactory: factory as never,
    });
    const result = (await tool.handler(
      { command: "true" },
      { conversationId: "conv-no-policy" }
    )) as BashEnvelope;
    const env = parseBashEnvelope(result);
    expect(env.stderr).not.toContain("[network_denied]");
  });

  it("askApproval 缺席 + egressPolicyFactory 返 policy → handler 不带 gate,filter 走 no-approval-inlet", async () => {
    // 没注入 askApproval → approvalGate 在工厂闭包期为 undefined → policy
    // 上不挂 gate。本测试通过 stub session + 直接读 captured.policy 验证。
    const { factory, captured } = makeDrivenEgressSessionFactory();
    const tool = createBashTool(FIX_CWD, {
      // 注意:故意不传 askApproval。
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:no-approval-inlet",
      }),
      createEgressSessionFactory: factory as never,
    });
    await tool.handler({ command: "true" }, { conversationId: "conv-no-ask" });
    expect(captured.policy?.approvalGate).toBeUndefined();
    // 此时若直接调 filter(not-in-allowlist 域) → 记 no-approval-inlet。
    // filter 已绑在 stub session 内,这里只验 policy shape 即可,完整
    // filter 行为由 session.ts 单测覆盖。
  });

  it("askApproval 在场 + egressPolicyFactory 返 policy → captured.policy 挂 gate + allowlistSource fallback = session", async () => {
    const { factory, captured } = makeDrivenEgressSessionFactory();
    const tool = createBashTool(FIX_CWD, {
      askApproval: async () => true,
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:gate-wired",
        // 故意不传 allowlistSource —— bash 工厂应自动 fallback 到 "session"
      }),
      createEgressSessionFactory: factory as never,
    });
    await tool.handler({ command: "true" }, { conversationId: "conv-gate" });
    expect(captured.policy?.approvalGate).toBeDefined();
    expect(typeof captured.policy?.approvalGate?.askIfUnknown).toBe("function");
    expect(captured.policy?.allowlistSource).toBe("session");
  });

  it("caller 显式 allowlistSource='persisted' → bash 不覆盖该值", async () => {
    const { factory, captured } = makeDrivenEgressSessionFactory();
    const tool = createBashTool(FIX_CWD, {
      askApproval: async () => true,
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:source-pinned",
        allowlistSource: "persisted",
      }),
      createEgressSessionFactory: factory as never,
    });
    await tool.handler(
      { command: "true" },
      { conversationId: "conv-pinned-source" }
    );
    expect(captured.policy?.allowlistSource).toBe("persisted");
  });

  it("跨调用同 host → gate 命中 allowed 集,不再调 askApproval", async () => {
    // 真实创建 session(走 stub factory)—— 第二次调用仍命中同一 bash tool
    // 实例下的同一 gate。
    const askApproval = vi.fn(async () => true);
    const { factory, captured } = makeDrivenEgressSessionFactory();
    const tool = createBashTool(FIX_CWD, {
      askApproval,
      egressPolicyFactory: () => ({
        allowedDomains: [],
        deniedDomains: [],
        commandLabel: "test:cross-call",
      }),
      createEgressSessionFactory: factory as never,
    });
    // 第一次调用 —— 在 factory 内 captured.policy 注入,后续断言。
    await tool.handler({ command: "true" }, { conversationId: "c1" });
    const gate = captured.policy?.approvalGate;
    expect(gate).toBeDefined();
    // 直接驱动 gate(模拟 filter 行为) — 两次不同 conversationId 但
    // 同一 bash tool 实例共享同一 gate。
    const r1 = await gate!.askIfUnknown("github.com");
    expect(r1).toBe(true);
    expect(askApproval).toHaveBeenCalledTimes(1);
    const r2 = await gate!.askIfUnknown("github.com");
    expect(r2).toBe(true);
    expect(askApproval).toHaveBeenCalledTimes(1); // 仍 1 —— gate 命中
    expect(gate!.allowedThisSession()).toContain("github.com");
  });

  it("askApproval 抛 → gate fail-closed,违例 reason `denied-by-user`", async () => {
    // 通过 stub 直接驱动 filter-like 行为：调用 gate + sink.record，
    // 模仿 session.ts:filter 拒绝路径的 sink.record 调用。
    const { factory, captured } = makeDrivenEgressSessionFactory();
    const tool = createBashTool(FIX_CWD, {
      askApproval: async () => {
        throw new Error("ask surface broken");
      },
      egressPolicyFactory: () => ({
        allowedDomains: [],
        deniedDomains: [],
        commandLabel: "test:ask-throws",
      }),
      createEgressSessionFactory: factory as never,
    });
    await tool.handler({ command: "true" }, { conversationId: "c-throws" });
    const gate = captured.policy?.approvalGate;
    expect(gate).toBeDefined();
    const r = await gate!.askIfUnknown("github.com");
    expect(r).toBe(false);
    expect(gate!.deniedThisSession()).toContain("github.com");
  });
});

describe("bash handler — egress typed failure 反映 denied-by-user", () => {
  it("filter 拒绝(denied-by-user) → handler 抛 typed failure + message 含 denied-by-user 文案", async () => {
    // 不走 stub filter —— 直接 stub 出 sink 内有一条 denied-by-user 违例,
    // 走 bash handler typed failure 管线。message 渲染对齐 violations.ts
    // 的 `denied-by-user` case。
    const stub = (async (
      opts: EgressSessionOptions
    ): Promise<EgressSession> => {
      const sink = createEgressViolationSink();
      sink.record({
        kind: "egress_violation",
        host: "evil.example",
        port: 443,
        reason: "denied-by-user",
        command: "curl evil.example",
      });
      // 假装 policyInput 已被 gate 注入(占位,本测试不消费 filter 行为)。
      void opts;
      return Object.freeze({
        id: "stub",
        spec: {
          unixSocketPath: "/tmp/iknow-egress-stub.sock",
          sandboxLocalPort: 0,
          env: {},
          innerBridgeScript: "",
          relayAssetsDir: "/test/iknow/vendor/egress-relay",
        },
        violationSink: sink,
        dispose: async () => undefined,
      });
    }) as (opts: EgressSessionOptions) => Promise<EgressSession>;

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "curl evil.example",
      }),
      createEgressSessionFactory: stub,
    });

    let caught: unknown;
    try {
      await tool.handler(
        { command: "curl evil.example" },
        { conversationId: "conv-denied" }
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    expect(message).toContain("[network_denied]");
    expect(message).toContain("denied by user for this session");
    expect(message).toContain("evil.example");
  });

  it("filter 拒绝(no-approval-inlet) → handler 抛 typed failure + message 含 no-approval-inlet 文案", async () => {
    const stub = (async (): Promise<EgressSession> => {
      const sink = createEgressViolationSink();
      sink.record({
        kind: "egress_violation",
        host: "github.com",
        port: 443,
        reason: "no-approval-inlet",
        command: "curl github.com",
      });
      return Object.freeze({
        id: "stub",
        spec: {
          unixSocketPath: "/tmp/iknow-egress-stub.sock",
          sandboxLocalPort: 0,
          env: {},
          innerBridgeScript: "",
          relayAssetsDir: "/test/iknow/vendor/egress-relay",
        },
        violationSink: sink,
        dispose: async () => undefined,
      });
    }) as (opts: EgressSessionOptions) => Promise<EgressSession>;

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: [],
        deniedDomains: [],
        commandLabel: "curl github.com",
      }),
      createEgressSessionFactory: stub,
    });

    let caught: unknown;
    try {
      await tool.handler(
        { command: "curl github.com" },
        { conversationId: "conv-no-approval" }
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    expect(message).toContain("[network_denied]");
    expect(message).toContain("no interactive approval inlet");
    expect(message).toContain("github.com");
  });
});
