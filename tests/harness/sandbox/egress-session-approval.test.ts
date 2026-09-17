/**
 * Tests for `egress/session.ts` filter + approvalGate integration —
 * T6 首次域名批准流的判定侧端到端走读
 * (specs/network-egress-allowlist.md §首次域名批准流 + SC10)。
 *
 * 钉住的不变式:
 *   - filter 内 not-in-allowlist + gate 在场 + 批准 → 返回 true + 不记违例;
 *   - filter 内 not-in-allowlist + gate 在场 + 拒绝 → 返回 false + 记
 *     `denied-by-user` 违例;
 *   - filter 内 not-in-allowlist + gate 缺席 → 返回 false + 记
 *     `no-approval-inlet` 违例(spec §Failure paths「非交互入口首见新域名」);
 *   - 其它 deny reason(denied / allowlist-empty / allowlist-malformed /
 *     address-denied)不经 gate —— deny 优先 / 配置层错误 不该被「询问用户」
 *     绕过;
 *   - gate 同 host 第二次进入 filter → 不再调 askApproval(集合命中)。
 *
 * 本测试通过 `createHttpProxyServer` 测试 seam 注入假 factory,在装配期
 * 捕获 filter 回调并直接驱动,避免真起 HTTP 代理 server + 走真实 CONNECT
 * 协议 + 处理 auth token 的复杂性(只验判定逻辑,不验真 dial 出网)。
 */

import { spawn as realSpawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEgressSession,
  type EgressPolicyInput,
} from "../../../src/harness/sandbox/egress/session.js";
import { createEgressApprovalGate } from "../../../src/harness/sandbox/egress/approval.js";
import {
  createEgressViolationSink,
  type EgressViolationSink,
} from "../../../src/harness/sandbox/egress/violations.js";
import { createHttpProxyServer as createHttpProxyServerOrig } from "../../../src/harness/sandbox/egress/upstream.js";

const scratchPaths: string[] = [];

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "iknow-egress-approval-test-"));
  scratchPaths.push(d);
  return d;
}

afterEach(() => {
  for (const p of scratchPaths.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

function fakeSocatProc(pid: number) {
  const proc = realSpawn("/bin/true", ["--version"], { stdio: "ignore" });
  try {
    proc.kill("SIGKILL");
  } catch {
    /* */
  }
  return Object.assign(proc, { pid });
}

/**
 * 在 session 装配期捕获 filter 回调 —— 用注入的假 `createHttpProxyServer`
 * 拦截。
 */
interface CapturedFilter {
  readonly filter: (port: number, host: string) => Promise<boolean> | boolean;
}
function captureFilter(): {
  createHttpProxyServer: NonNullable<
    Parameters<typeof createEgressSession>[0]["createHttpProxyServer"]
  >;
  captured: CapturedFilter | undefined;
} {
  const captured: { value?: CapturedFilter } = {};
  const createHttpProxyServer = (
    opts: Parameters<typeof createHttpProxyServerOrig>[0]
  ) => {
    captured.value = { filter: opts.filter };
    // 返回一个最小 server 形状,让 session 后续 listenOnFreePort 能拿到 port。
    // server.listen 必须可被监听且 .address() 返回 { port }。
    return createServer();
  };
  return { createHttpProxyServer, captured };
}

describe("egress session filter — approvalGate 接线 (T6 SC10)", () => {
  it("not-in-allowlist + gate 在场 + 批准 → filter 返回 true + 不记违例", async () => {
    const askApproval = vi.fn(async () => true);
    const gate = createEgressApprovalGate({ askApproval });
    const sink: EgressViolationSink = createEgressViolationSink();
    const policy: EgressPolicyInput = {
      allowedDomains: ["github.com"],
      deniedDomains: [],
      commandLabel: "test:approve",
      approvalGate: gate,
    };
    const { createHttpProxyServer, captured } = captureFilter();
    const proc = fakeSocatProc(11111);
    const session = await createEgressSession({
      policy,
      socatCommand: "fake-socat",
      probeSocat: () => true,
      spawn: (() => proc) as typeof realSpawn,
      socketPathFactory: (id) => join(scratchDir(), `e-${id}.sock`),
      violationSink: sink,
      createHttpProxyServer,
    });
    try {
      expect(captured.value).toBeDefined();
      const filter = captured.value!.filter;
      const result = await filter(443, "evil.example");
      expect(result).toBe(true);
      expect(askApproval).toHaveBeenCalledWith("evil.example");
      expect(sink.size()).toBe(0);
      expect(gate.allowedThisSession()).toContain("evil.example");
    } finally {
      await session.dispose();
    }
  });

  it("not-in-allowlist + gate 在场 + 拒绝 → filter 返回 false + sink 记 denied-by-user", async () => {
    const askApproval = vi.fn(async () => false);
    const gate = createEgressApprovalGate({ askApproval });
    const sink: EgressViolationSink = createEgressViolationSink();
    const policy: EgressPolicyInput = {
      allowedDomains: ["github.com"],
      deniedDomains: [],
      commandLabel: "test:deny",
      approvalGate: gate,
    };
    const { createHttpProxyServer, captured } = captureFilter();
    const proc = fakeSocatProc(22222);
    const session = await createEgressSession({
      policy,
      socatCommand: "fake-socat",
      probeSocat: () => true,
      spawn: (() => proc) as typeof realSpawn,
      socketPathFactory: (id) => join(scratchDir(), `e-${id}.sock`),
      violationSink: sink,
      createHttpProxyServer,
    });
    try {
      const filter = captured.value!.filter;
      const result = await filter(443, "evil.example");
      expect(result).toBe(false);
      expect(askApproval).toHaveBeenCalledWith("evil.example");
      expect(sink.size()).toBe(1);
      const drained = sink.drain();
      expect(drained[0]?.reason).toBe("denied-by-user");
      expect(drained[0]?.host).toBe("evil.example");
      expect(gate.deniedThisSession()).toContain("evil.example");
    } finally {
      await session.dispose();
    }
  });

  it("not-in-allowlist + gate 缺席 → filter 返回 false + sink 记 no-approval-inlet", async () => {
    const sink: EgressViolationSink = createEgressViolationSink();
    const policy: EgressPolicyInput = {
      allowedDomains: ["github.com"],
      deniedDomains: [],
      commandLabel: "test:no-inlet",
      // approvalGate 故意缺席
    };
    const { createHttpProxyServer, captured } = captureFilter();
    const proc = fakeSocatProc(33333);
    const session = await createEgressSession({
      policy,
      socatCommand: "fake-socat",
      probeSocat: () => true,
      spawn: (() => proc) as typeof realSpawn,
      socketPathFactory: (id) => join(scratchDir(), `e-${id}.sock`),
      violationSink: sink,
      createHttpProxyServer,
    });
    try {
      const filter = captured.value!.filter;
      const result = await filter(443, "evil.example");
      expect(result).toBe(false);
      expect(sink.size()).toBe(1);
      const drained = sink.drain();
      expect(drained[0]?.reason).toBe("no-approval-inlet");
    } finally {
      await session.dispose();
    }
  });

  it("deny 优先 —— host 在 denied 集 → 不调 askApproval,reason=denied", async () => {
    // deny 优先(spec §Settled invariants)—— host 在 denied 集,即使
    // approvalGate 在场,filter 也直接拒,不调 askApproval。
    const askApproval = vi.fn(async () => true);
    const gate = createEgressApprovalGate({ askApproval });
    const sink: EgressViolationSink = createEgressViolationSink();
    const policy: EgressPolicyInput = {
      allowedDomains: ["github.com"],
      deniedDomains: ["evil.example"],
      commandLabel: "test:deny-priority",
      approvalGate: gate,
    };
    const { createHttpProxyServer, captured } = captureFilter();
    const proc = fakeSocatProc(44444);
    const session = await createEgressSession({
      policy,
      socatCommand: "fake-socat",
      probeSocat: () => true,
      spawn: (() => proc) as typeof realSpawn,
      socketPathFactory: (id) => join(scratchDir(), `e-${id}.sock`),
      violationSink: sink,
      createHttpProxyServer,
    });
    try {
      const filter = captured.value!.filter;
      const result = await filter(443, "evil.example");
      expect(result).toBe(false);
      expect(askApproval).not.toHaveBeenCalled();
      const drained = sink.drain();
      expect(drained[0]?.reason).toBe("denied");
    } finally {
      await session.dispose();
    }
  });

  it("同 host 第二次进入 filter → 不再调 askApproval(集合命中)", async () => {
    const askApproval = vi.fn(async () => true);
    const gate = createEgressApprovalGate({ askApproval });
    const sink: EgressViolationSink = createEgressViolationSink();
    const policy: EgressPolicyInput = {
      allowedDomains: ["github.com"],
      deniedDomains: [],
      commandLabel: "test:cache-hit",
      approvalGate: gate,
    };
    const { createHttpProxyServer, captured } = captureFilter();
    const proc = fakeSocatProc(55555);
    const session = await createEgressSession({
      policy,
      socatCommand: "fake-socat",
      probeSocat: () => true,
      spawn: (() => proc) as typeof realSpawn,
      socketPathFactory: (id) => join(scratchDir(), `e-${id}.sock`),
      violationSink: sink,
      createHttpProxyServer,
    });
    try {
      const filter = captured.value!.filter;
      const r1 = await filter(443, "evil.example");
      const r2 = await filter(443, "evil.example");
      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(askApproval).toHaveBeenCalledTimes(1);
      expect(sink.size()).toBe(0);
    } finally {
      await session.dispose();
    }
  });

  it("并发同 host 两次进入 filter → 合并为一次 ask(只调一次)", async () => {
    // 异步并发进入 filter → 同 host 走 gate 的 in-flight 合并表,只调
    // askApproval 一次。
    let resolveAsk: ((v: boolean) => void) | undefined;
    const askApproval = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAsk = resolve;
        })
    );
    const gate = createEgressApprovalGate({ askApproval });
    const sink: EgressViolationSink = createEgressViolationSink();
    const policy: EgressPolicyInput = {
      allowedDomains: ["github.com"],
      deniedDomains: [],
      commandLabel: "test:concurrent",
      approvalGate: gate,
    };
    const { createHttpProxyServer, captured } = captureFilter();
    const proc = fakeSocatProc(66666);
    const session = await createEgressSession({
      policy,
      socatCommand: "fake-socat",
      probeSocat: () => true,
      spawn: (() => proc) as typeof realSpawn,
      socketPathFactory: (id) => join(scratchDir(), `e-${id}.sock`),
      violationSink: sink,
      createHttpProxyServer,
    });
    try {
      const filter = captured.value!.filter;
      const p1 = filter(443, "evil.example");
      const p2 = filter(443, "evil.example");
      expect(askApproval).toHaveBeenCalledTimes(1);
      resolveAsk?.(true);
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(sink.size()).toBe(0);
      expect(gate.allowedThisSession()).toContain("evil.example");
    } finally {
      await session.dispose();
    }
  });
});
