/**
 * Tests for T3 (specs/egress-preset-allowlist.md §T3 + SC5 + invariant 3/5)
 * —— 批准门恢复在岗 + 生命周期落差闭合的测试钉。
 *
 * 生命周期落差（本文件按 spec invariant 3 显式引用，不另立文字例外）：
 *   ADR-0097 §生命周期表裁定「允许集非空或批准流可问才起」代理 session。
 *   旧实现落差：settings 无 `isolation.network` 段 → `createEgressPolicyFactory`
 *   返 `undefined` → egress session 根本不起 → 首见批准门「死在入口」
 *   （approval.ts / session.ts 门件与 filter 接线俱在，却被入口短路：档外域
 *   既不会被 ask、也不会被 deny，命令拿到的是静默 DNS 失败）。
 *   ADR-0104 §Consequences「副作用（正向）」裁定闭合该落差：preset 非空 =
 *   生产入口默认起 egress session，首见批准门从「死在入口」恢复在岗。
 *   T1 已把工厂段缺席分支反转为 preset-only policy；本文件以三臂测试钉住
 *   「批准门在岗」这一实现事实，防止回退。
 *
 * invariant 5（fail-closed 面不缩，逐字继承）：
 *   - 批准门非交互拒 → `no-approval-inlet`（臂②）；
 *   - 用户拒绝 → `denied-by-user` → typed failure 回灌（臂①拒绝半）；
 *   - 代理死 fail-closed（egress-proxy-behavior.test.ts）与地址守卫正交
 *     （egress-domain-matcher.test.ts / F5 面）已由既有钉子承担，本文件
 *     不重复覆盖。
 *
 * 手法（spec T3「复用 T6 注入 filter 驱动 seam，不真起代理」）：
 *   policy 全部出自真实 `createEgressPolicyFactory`（干净 settings = 无
 *   `isolation.network` 段），session 走真实 `createEgressSession`，经
 *   `createHttpProxyServer` / `probeSocat` / `spawn` / `socketPathFactory`
 *   注入缝捕获 filter 回调直接驱动 —— 不真起 HTTP CONNECT 代理、不依赖
 *   宿主 socat、不真出网。
 */

import { spawn as realSpawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";
import { createEgressPolicyFactory } from "../../../src/harness/sandbox/egress/assembly.js";
import { BUILTIN_PRESET_ALLOWED_DOMAINS } from "../../../src/harness/sandbox/egress/preset-domains.js";
import { renderEgressViolations } from "../../../src/harness/sandbox/egress/violations.js";
import {
  createEgressSession,
  type EgressPolicyInput,
  type EgressSession,
  type EgressSessionOptions,
} from "../../../src/harness/sandbox/egress/session.js";
import { createHttpProxyServer as createHttpProxyServerOrig } from "../../../src/harness/sandbox/egress/upstream.js";
import type { IknowSettings } from "../../../src/config/settings.js";

const FIX_CWD = mkdtempSync(join(tmpdir(), "t3-approval-cwd-"));
const scratchPaths: string[] = [];

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "t3-approval-test-"));
  scratchPaths.push(d);
  return d;
}

afterEach(() => {
  for (const p of scratchPaths.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
});

/** 干净装配：settings 无 `isolation.network` 段（ADR-0104 preset-only 入口）。 */
function cleanPolicyFactory(
  commandLabel: string
): () => EgressPolicyInput | undefined {
  return createEgressPolicyFactory({
    settings: {} as unknown as IknowSettings,
    commandLabel,
  });
}

function fakeSocatProc(pid: number) {
  const proc = realSpawn("/bin/true", ["--version"], { stdio: "ignore" });
  try {
    proc.kill("SIGKILL");
  } catch {
    /* best-effort */
  }
  return Object.assign(proc, { pid });
}

let fakePidCounter = 20000;

interface CapturedCall {
  readonly filter: (port: number, host: string) => Promise<boolean>;
  readonly policy: EgressPolicyInput;
  readonly session: EgressSession;
}

/**
 * T6 注入 filter 驱动 seam 的 bash 侧包装：真实 `createEgressSession` +
 * 全假装配（probeSocat 恒真 / fake spawn / 落盘 socket 文件 / 捕获 filter）。
 * `driveOutboundOnAssembly` = 装配期即对档外域发起一次 filter 驱动（fire-and-
 * await-microtask），让拒绝违例在 handler drain 前确定性入 sink。
 */
function makeSessionCaptureSeam(driveOutboundOnAssembly = false): {
  factory: (opts: EgressSessionOptions) => Promise<EgressSession>;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const factory = async (
    opts: EgressSessionOptions
  ): Promise<EgressSession> => {
    const captured: { filter?: CapturedCall["filter"] } = {};
    const session = await createEgressSession({
      ...opts,
      probeSocat: () => true,
      spawn: (() =>
        fakeSocatProc(fakePidCounter++)) as unknown as typeof realSpawn,
      socketPathFactory: (id) => {
        const p = join(scratchDir(), `t3-${id}.sock`);
        // 落盘一个普通文件占位：fence 的 socket bind 源端存在即可，
        // 本测试不真连代理。
        writeFileSync(p, "");
        return p;
      },
      createHttpProxyServer: (proxyOpts) => {
        captured.filter = proxyOpts.filter as CapturedCall["filter"];
        if (driveOutboundOnAssembly && captured.filter !== undefined) {
          // 拒绝路径违例 = 纯 microtask 链；handler 的 sandbox 执行跨
          // 真实子进程 spawn（≥1 macrotask），drain 前必然已入 sink。
          void captured.filter(443, "example.com");
        }
        return createServer();
      },
    });
    // session 装配成功 ⇒ filter 必已构造（createHttpProxyServer 同步调用）。
    calls.push({
      filter: captured.filter!,
      policy: opts.policy,
      session,
    });
    return session;
  };
  return { factory, calls };
}

interface BashEnvelope {
  readonly output: string;
}
function parseBashEnvelope(envelope: BashEnvelope): {
  code: number;
  stdout: string;
  stderr: string;
} {
  return JSON.parse(envelope.output) as {
    code: number;
    stdout: string;
    stderr: string;
  };
}

describe("T3 臂① — 干净装配交互前台：首见批准门在岗（ask 一次 → 会话放行）", () => {
  it("档外域触发 ask；批准 → 本会话放行不再问；档内域不问（回归反转：旧行为批准门死在入口）", async () => {
    const askApproval = vi.fn(async () => true);
    const seam = makeSessionCaptureSeam();
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: cleanPolicyFactory("bash"),
      askApproval,
      createEgressSessionFactory: seam.factory,
    });

    const envelope = (await tool.handler(
      { command: "true" },
      { conversationId: "t3-approve" }
    )) as BashEnvelope;
    // 无违例 → ok envelope（批准门放行不打断命令）。
    expect(parseBashEnvelope(envelope)).toBeDefined();

    expect(seam.calls.length).toBe(1);
    const { filter, policy, session } = seam.calls[0]!;
    // —— 生命周期落差闭合的可观察证据（旧行为反转记录）：干净装配下
    //    session 起了（calls.length===1）、policy 是 preset-only 且
    //    approvalGate 已挂上 —— 旧实现此处工厂返 undefined、session 根本
    //    不起、门死在入口（ADR-0097 §生命周期表落差 / ADR-0104 §Consequences）。
    expect(policy.approvalGate).toBeDefined();
    expect(policy.allowedDomains).toEqual([
      ...BUILTIN_PRESET_ALLOWED_DOMAINS,
    ]);
    expect(policy.allowlistSource).toBe("builtin");
    expect(askApproval).not.toHaveBeenCalled();

    // 档内域（preset）直通，不问。
    await expect(filter(443, "github.com")).resolves.toBe(true);
    expect(askApproval).not.toHaveBeenCalled();

    // 档外域首见 → ask 一次 → 放行。
    await expect(filter(443, "example.com")).resolves.toBe(true);
    expect(askApproval).toHaveBeenCalledTimes(1);
    expect(askApproval).toHaveBeenCalledWith("example.com");
    expect(session.violationSink.size()).toBe(0);

    // 本会话再访档外域 → 集合命中，不再问（批准 = 会话级放行）。
    await expect(filter(443, "example.com")).resolves.toBe(true);
    expect(askApproval).toHaveBeenCalledTimes(1);

    // 跨 per-call session 共享同一 gate（同一 bash tool 实例 = 同一会话）：
    // 第二次 handler 调用的新 session 里再访 → 仍不问。
    await tool.handler({ command: "true" }, { conversationId: "t3-approve" });
    expect(seam.calls.length).toBe(2);
    await expect(seam.calls[1]!.filter(443, "example.com")).resolves.toBe(
      true
    );
    expect(askApproval).toHaveBeenCalledTimes(1);

    await session.dispose();
    await seam.calls[1]!.session.dispose();
  });
});

describe("T3 臂① — 干净装配交互前台：拒绝 → denied-by-user 违例回灌 execution_failed", () => {
  it("用户拒绝 → handler drain 到 denied-by-user → 抛 typed failure（[network_denied] + session 级文案 + builtin 来源标注）", async () => {
    const askApproval = vi.fn(async () => false);
    const seam = makeSessionCaptureSeam(true); // 装配期驱动档外域
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: cleanPolicyFactory("bash"),
      askApproval,
      createEgressSessionFactory: seam.factory,
    });

    let caught: unknown;
    try {
      await tool.handler(
        { command: "true" },
        { conversationId: "t3-deny" }
      );
    } catch (err) {
      caught = err;
    }
    // executor 把 ToolExecutionError 包成 kind:"execution_failed"
    //（bash-egress-typed-failure.test.ts 已端到端钉死该包装；此处按
    // 同款钉子断言 typed failure 源头）。
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    expect(message).toContain("[network_denied]");
    expect(message).toContain("example.com:443 denied by user for this session");
    // 干净装配的来源标注 = builtin 档（非静默、非伪造）。
    expect(message).toContain(
      "Current allowlist source: built-in preset allowlist (github / npm / playwright defaults)."
    );
    expect(askApproval).toHaveBeenCalledTimes(1);
    expect(seam.calls[0]!.session.violationSink.size()).toBe(0); // 已 drain
    await seam.calls[0]!.session.dispose();
  });
});

describe("T3 臂② — 干净装配非交互面（background / verify 形态）：no-approval-inlet fail-closed", () => {
  it("policy 无 approvalGate（非交互 caller 直喂工厂产物）→ 档外域 session 照起、filter fail-closed 且违例有名字（区别于旧「session 不起、静默 DNS 失败」）", async () => {
    // background manager / verify sandbox-run 拿到的就是工厂直出 policy
    //（gate 只由 bash 工厂闭包期附加——非交互面拿不到 ask 入口）。
    const policy = cleanPolicyFactory("background:t3")();
    expect(policy).toBeDefined();
    expect(policy!.approvalGate).toBeUndefined();

    const seam = makeSessionCaptureSeam();
    const session = await seam.factory({ policy: policy! });
    const filter = seam.calls[0]!.filter;

    // 旧行为对照：干净装配下 session 现在会起（此处 seam 已被调用即证）。
    await expect(filter(443, "example.com")).resolves.toBe(false);
    const drained = session.violationSink.drain();
    expect(drained.length).toBe(1);
    expect(drained[0]!.reason).toBe("no-approval-inlet");
    expect(drained[0]!.host).toBe("example.com");
    // 违例回灌「有名字」：可行动文案（含非交互入口事实 + 预配指引），
    // 而不是旧世界「session 不起 → 命令静默 DNS 失败」无名无姓。
    const rendered = renderEgressViolations(drained);
    expect(rendered).toContain("[network_denied]");
    expect(rendered).toContain(
      "seen for the first time and no interactive approval inlet is available"
    );
    expect(rendered).toContain(
      "pre-add it to isolation.network.allowedDomains for non-interactive runs"
    );
    await session.dispose();
  });
});
