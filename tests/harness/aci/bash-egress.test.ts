/**
 * Tests for `aci/tools/bash.ts` egress wiring — T4 前台 fence 装配 +
 * T5 typed failure 升级（specs/network-egress-allowlist.md §Violation
 * feedback channel 第 2/3 跳「回灌 → 前缀与 tier 入口」）。
 *
 * 钉住的不变式（来自 specs/network-egress-allowlist.md §T4 + §T5 + ADR-0097）：
 *   - egressPolicyFactory 缺席 → handler 不起 session,fence 走 V1 baseline
 *     (无 socket bind,无代理 env);
 *   - egressPolicyFactory 返回 policy + 宿主缺 socat → handler 抛 typed
 *     failure `ToolExecutionError`,message 含 `[network_denied]` 前缀
 *     + 「egress seam unavailable」infra 文案（不再走 stderr 旁路 —— T5
 *     升级后走通既有 `categorizeResult` 的 `networkDenied → mid` 分支）;
 *   - egressPolicyFactory 返回 undefined → handler 完全跳过 session 尝试;
 *
 * **不测真实 bwrap+netns 出网**(SC2 真实链路实测由 leader 在收尾阶段用
 * pty 或 probe 承担)。handler 会真起 socat (若 probe 通过) + 真 spawn
 * bwrap —— 这部分在 socat 缺失的 CI 上不会被触发(我们的 probe 走默认
 * `which`, 本机通常无 socat)。
 *
 * tier 1→mid 端到端走读见 `bash-egress-typed-failure.test.ts`(走 bash
 * handler 真实返回 → executor → categorizeResult → mid tier,不直接
 * 造 `kind:"execution_failed"`)。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

const FIX_CWD = mkdtempSync(join(tmpdir(), "bash-egress-cwd-"));

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
});

/** 探测宿主是否装了 socat —— 用于 skip 依赖 socat 的 case。 */
function socatAvailable(): boolean {
  const probe = spawnSync("which", ["socat"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000,
  });
  return probe.status === 0;
}

interface BashEnvelope {
  readonly output: string;
  readonly meta?: { readonly stdout?: string; readonly stderr?: string };
}

interface BashResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function parseBashEnvelope(envelope: BashEnvelope): BashResult {
  return JSON.parse(envelope.output) as BashResult;
}

describe("bash handler — egress wiring (T4 expand)", () => {
  it("egressPolicyFactory 缺席 → 无 egress 旁路,handler 走 V1 路径", async () => {
    const tool = createBashTool(FIX_CWD, {
      // 故意不传 egressPolicyFactory
    });
    const result = (await tool.handler(
      { command: "true" },
      { conversationId: "conv-no-policy" }
    )) as BashEnvelope;
    const env = parseBashEnvelope(result);
    // V1 baseline: 无 egress 旁路文案
    expect(env.stderr).not.toContain("[network_denied] egress");
    expect(env.stderr).not.toContain("egress seam unavailable");
  });

  it("egressPolicyFactory 返 undefined → 跳过 session 尝试,无旁路文案", async () => {
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => undefined,
    });
    const result = (await tool.handler(
      { command: "true" },
      { conversationId: "conv-undef-policy" }
    )) as BashEnvelope;
    const env = parseBashEnvelope(result);
    expect(env.stderr).not.toContain("[network_denied] egress");
    expect(env.stderr).not.toContain("egress seam unavailable");
  });

  it("egressPolicyFactory 返 policy + socat 缺失 → 抛 typed failure,message 含 [network_denied] 前缀 (T5 / SC13)", async () => {
    if (socatAvailable()) {
      // 宿主有 socat —— 此 case 不适用(应走「成功路径」但本测试不验);
      // 跳过避免误报。
      return;
    }
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:egress-fail-closed",
      }),
    });
    let caught: unknown;
    try {
      await tool.handler(
        { command: "true" },
        { conversationId: "conv-socat-missing" }
      );
    } catch (err) {
      caught = err;
    }
    // T5:typed failure（不再是 stderr 旁路 + ok envelope）。
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    // 含 [network_denied] 前缀 → 让既有 categorizeResult 落到 mid tier。
    expect(message).toContain("[network_denied]");
    // 「egress seam unavailable」infra 文案 —— 与域判定拒绝可区分。
    expect(message).toContain("egress seam unavailable");
    expect(message).toContain("infrastructure fault");
    // 修复指引:infra → 不给配置键指引（避免误导）。
    expect(message).not.toContain("isolation.network.allowedDomains");
    expect(message).toContain("egress bridge");
    // 「命令已跑完」语义提示。
    expect(message).toContain("command ran to completion");
  });

  it("egressPolicyFactory 返 policy + socat 存在 → handler 正常走完(占位 smoke)", async () => {
    if (!socatAvailable()) {
      return; // 缺 socat 时此 case 不适用
    }
    // 真起 socat + http-proxy —— 消耗端口资源,本测试仅断言 handler 不抛错。
    // SC2 真实链路(curl 经代理出网)由 leader 在收尾阶段用 probe 测,本仓
    // 只验装配契约。
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:egress-success",
      }),
    });
    const result = (await tool.handler(
      { command: "true" },
      { conversationId: "conv-socat-present" }
    )) as BashEnvelope;
    const env = parseBashEnvelope(result);
    // 真 session 起来后,runInSandbox 会真 spawn bwrap,可能因 bwrap argv
    // 缺可执行程序而失败 —— 我们只断言 handler 不抛 typed error。
    expect(typeof env.code).toBe("number");
    expect(typeof env.stderr).toBe("string");
  });
});
