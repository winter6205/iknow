/**
 * T8 (#128): processChatLine 装配 verify-loop 接线测试。
 *
 * 全真实装配链, 无测试缝:
 *   - 真实 VerifyConfig (command 指向 cwd 内脚本);
 *   - runVerifyLoop 缺省 runVerify = runInSandbox + bwrap (真实沙箱执行,
 *     hasBwrap 守卫, 与 verify-loop 测试同纪律);
 *   - runFn 经 processChatLine 走真实 runHarness (stub model)。
 *
 * 闭环激活的铁证 = 验证命令**确实被执行**: 脚本往 cwd 写 marker 文件,
 * 用例断言 marker 存在 (未配置 verifyConfig 时 marker 不存在 → 原路径
 * 不执行验证, SC7 逐字节)。
 *
 * 覆盖:
 *   1. verifyConfig 缺席 → 原 runHarness 路径 (SC7): completed 结果 +
 *      append-only 历史 + 验证命令**未**执行 (marker 不存在);
 *   2. verifyConfig 配置 + 验证 exit 0 → 闭环激活 (marker 存在) + 单轮
 *      通过, 答案文本保留;
 *   3. verifyConfig 配置 + 验证真失败 → 注入失败信封 (user 消息含
 *      [VALIDATION FAILED] + attempt/command/exit_code/signature);
 *   4. verifyConfig 配置 + 验证始终失败 (同签名停滞) → 闭环停止, 不判
 *      完成。
 *
 * 验证命令脚本写入隔离 tmpdir (runVerifyLoop cwd = process.cwd()); 脚本
 * 可执行 (chmod 755) 且依赖 /bin/sh (bwrap 只读绑定 /bin)。HOME 未设 →
 * 沙箱默认 homedir() 绑定 (与生产一致)。
 *
 * 不触碰真实 ~/.iknow / 项目工作区 (命令只在 cwd 内读写)。
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { processChatLine } from "../../src/cli/chat-session.ts";
import { createFsModeContext } from "../../src/harness/sandbox/fs-mode.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";

/** bwrap 可用性守卫: 缺省 runVerify (runInSandbox) 只在 bwrap 存在时可用。 */
function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

// -- isolated workdir (cwd for the closed loop's sandbox) ---------------------
const prevCwd = process.cwd();
let workDir: string;
/** 验证命令运行标记; 脚本写它证明闭环真实执行了验证。 */
let markerPath: string;
let passScript: string; // exit 0 (且写 marker)
let failScript: string; // exit 1 + FAIL 行 (真失败签名) + 写 marker

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "iknow-verify-chat-"));
  markerPath = join(workDir, "verify-ran.marker");
  passScript = join(workDir, "verify-pass.sh");
  failScript = join(workDir, "verify-fail.sh");
  writeFileSync(passScript, `#!/bin/sh\ntouch "${markerPath}"\nexit 0\n`, {
    mode: 0o755,
  });
  writeFileSync(
    failScript,
    `#!/bin/sh\ntouch "${markerPath}"\necho 'FAIL  tests/auth.test.ts:login rejects bad token'\nexit 1\n`,
    { mode: 0o755 }
  );
  chmodSync(passScript, 0o755);
  chmodSync(failScript, 0o755);
  // 闭环沙箱 cwd = process.cwd() → 切到隔离工作目录, 脚本经
  // createFsPolicy(cwd) 绑定进沙箱 (不碰真实工作区)。
  process.chdir(workDir);
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(workDir, { recursive: true, force: true });
});

describe("processChatLine — verify-loop 装配 (T8)", () => {
  it("verifyConfig 缺席 → 原 runHarness 路径: completed + append-only + 验证未执行", async () => {
    rmSync(markerPath, { force: true });
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["answer-1"] })],
    });
    const r = await processChatLine({ line: "hello", ctx });
    assert.equal(r.quit, false);
    assert.equal(r.ranQuery, true);
    assert.match(r.output, /answer-1/);
    assert.equal(ctx.state.messages.length, 2); // [user, assistant]
    assert.equal(ctx.state.messages[1]!.role, "assistant");
    const lastText = (
      ctx.state.messages[1]!.content[0] as { type: "text"; text: string }
    ).text;
    assert.equal(lastText, "answer-1");
    // SC7: 未配置 verifyConfig → 验证命令绝不执行。
    assert.equal(
      existsSync(markerPath),
      false,
      "未配置 verifyConfig 时验证命令不得执行"
    );
  });

  it.skipIf(!hasBwrap())(
    "verifyConfig 配置 + 验证 exit 0 → 闭环激活 + 单轮通过",
    async () => {
      rmSync(markerPath, { force: true });
      const ctx = makeCtx({
        responses: [assistantResult({ texts: ["answer-ok"] })],
      });
      Object.assign(ctx, {
        verifyConfig: { command: passScript } satisfies VerifyConfig,
      });
      const r = await processChatLine({ line: "fix this", ctx });
      assert.equal(r.ranQuery, true);
      assert.match(r.output, /answer-ok/);
      // 铁证: 验证命令真实执行了 (闭环激活)。
      assert.equal(
        existsSync(markerPath),
        true,
        "配置 verifyConfig 时验证命令应经沙箱执行"
      );
      // 单轮通过, 历史形状与未配置一致 (SC7: 通过轮不改装配面)。
      assert.equal(ctx.state.messages.length, 2);
      assert.equal(ctx.state.messages[1]!.role, "assistant");
    }
  );

  it.skipIf(!hasBwrap())(
    "verifyConfig 配置 + 验证真失败 → 注入失败信封",
    async () => {
      rmSync(markerPath, { force: true });
      const ctx = makeCtx({
        responses: [
          assistantResult({ texts: ["fix-attempt-1"] }),
          assistantResult({ texts: ["fix-attempt-2"] }),
        ],
      });
      Object.assign(ctx, {
        verifyConfig: { command: failScript } satisfies VerifyConfig,
      });
      const r = await processChatLine({ line: "make tests pass", ctx });
      assert.equal(r.ranQuery, true);
      assert.equal(existsSync(markerPath), true, "验证命令应真实执行");
      // failScript 恒定 exit 1 → 首轮失败注入信封 → 第二轮验证同签名停滞 →
      // 闭环停止。历史含两条 assistant。
      assert.equal(
        ctx.state.messages.filter((m) => m.role === "assistant").length,
        2
      );
      const envelopes = ctx.state.messages.filter(
        (m) =>
          m.role === "user" &&
          m.content.some(
            (b) =>
              b.type === "text" &&
              (b.text as string).includes("[VALIDATION FAILED]")
          )
      );
      assert.equal(envelopes.length, 1, "应恰有一条注入信封");
      const envText = (
        envelopes[0]!.content[0] as { type: "text"; text: string }
      ).text;
      assert.match(envText, /attempt=1\/12/);
      assert.match(envText, /exit_code: 1/);
      assert.match(envText, /signature: exit=1\|tests\/auth\.test\.ts/);
    }
  );

  it("装配层默认启用: command 缺失 (verifyConfig = { command: '' }) + subagentManager 在场 → runVerifyLoop + runClassifier 接管 (spec #128 Objective)", async () => {
    rmSync(markerPath, { force: true });
    // 判官 envelope 脚本: 第 1 次 spawn → pass (首轮 completed → 判官 pass →
    // 闭环 passed, 不再透明关闭)。历史形状与裸 run 一致 (pass 不改装配面)。
    const spawnedDefs: Array<{ task: string; model: string | undefined }> = [];
    const manager: SubAgentManager = {
      spawn: (def) => {
        spawnedDefs.push({ task: def.task, model: def.model });
        return { taskId: "judge-1" };
      },
      queryBuffer: () => ({ status: "completed" }),
      waitFor: async () =>
        ({
          status: "ok",
          summary: "judge done",
          result: JSON.stringify({
            kind: "pass",
            reason: "evidence present",
            evidence: [{ command: "noop", result: "pass" }],
          }),
        }) satisfies SubAgentEnvelope,
      shutdown: async () => {},
      drainCompleted: () => [],
      listActive: () => [],
      abortTask: () => false,
      // #358 T7: 接口新增只读枚举面 —— fake 补全保持结构兼容。
      listSubagents: () => [],
    };

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["answer-classified"] })],
    });
    Object.assign(ctx, {
      verifyConfig: { command: "" } satisfies VerifyConfig,
      subagentManager: manager,
    });
    const r = await processChatLine({ line: "research a topic", ctx });

    assert.equal(r.ranQuery, true);
    assert.match(r.output, /answer-classified/);
    // Plan T1 HITL: no pinned goal → completion judge spawn = 0.
    assert.equal(
      spawnedDefs.length,
      0,
      "HITL (no goal) must not spawn completion-facing judge"
    );
    // 闭环 passed: 历史形状与裸 run 一致 (pass 不改消息面)。
    // T3 SC2: HITL 闲聊不得印绿勾。
    assert.equal(
      r.output.includes("[验证] 验证通过"),
      false,
      "HITL chat must not print passed green check"
    );
    assert.equal(ctx.state.messages.length, 2);
    assert.equal(ctx.state.messages[1]!.role, "assistant");
    // 验证命令 (command 为空, 不存在脚本) 绝不能执行。
    assert.equal(
      existsSync(markerPath),
      false,
      "command 缺失 → 无验证命令执行"
    );
  });

  it("verifyConfig 配置 + 验证始终失败 → 闭环停止, 不判完成", async () => {
    rmSync(markerPath, { force: true });
    const ctx = makeCtx({
      responses: [
        assistantResult({ texts: ["fix-attempt-1"] }),
        assistantResult({ texts: ["fix-attempt-2"] }),
      ],
    });
    Object.assign(ctx, {
      verifyConfig: { command: failScript } satisfies VerifyConfig,
    });
    const r = await processChatLine({ line: "make tests pass", ctx });
    assert.equal(r.ranQuery, true);
    assert.ok(r.output.length > 0, "输出应非空 (如实报告)");
    // M3 (SC2/SC6 交付面): 验证最终判定 surface 到 chat 输出 —— 用户必须看到
    // "验证未通过"而非正常完成。断言 output 含验证报告标记。
    assert.match(
      r.output,
      /\[验证\] 验证未通过（\d+ 轮）/,
      "chat 输出必须 surface 验证失败报告 (M3)"
    );
    // 停止轮未注入第二轮信封 (同签名停滞 → 趋势 stop, 只记录一轮)。
    const envelopes = ctx.state.messages.filter(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (b) =>
            b.type === "text" &&
            (b.text as string).includes("[VALIDATION FAILED]")
        )
    );
    assert.equal(envelopes.length, 1);
  });

  // ADR-0092 / SC11–SC13: chat 的 verify 命令面必须与 bash 工具面同档。
  // 判别力设计: 验证脚本**尝试写 home**。workspace 档下 home 是 ro-bind,
  // 写必须 EROFS 失败; 若 holder 没传到 verify 面 (回归), 沙箱是全局档,
  // 写会成功 —— 两种结果可直接观测, 不是只查 opts 字段。
  it.skipIf(!hasBwrap())(
    "fsMode=workspace → verify 命令落在工作区档围栏 (写 home 被 EROFS 拒)",
    async () => {
      const homeProbe = join(osHomedir(), ".iknow-verify-fsmode-probe");
      rmSync(homeProbe, { force: true });
      const probeScript = join(workDir, "verify-write-home.sh");
      writeFileSync(
        probeScript,
        `#!/bin/sh\necho probe > "${homeProbe}"\nexit 0\n`,
        { mode: 0o755 }
      );
      chmodSync(probeScript, 0o755);

      const ctx = makeCtx({
        responses: [assistantResult({ texts: ["answer-ws"] })],
        fsMode: createFsModeContext("workspace"),
      });
      Object.assign(ctx, {
        verifyConfig: { command: probeScript } satisfies VerifyConfig,
      });
      const r = await processChatLine({ line: "fix this", ctx });
      assert.equal(r.ranQuery, true);
      // 档真的到达了 verify 面 → home 写被内核拒 → 宿主侧无落盘。
      assert.equal(
        existsSync(homeProbe),
        false,
        "workspace 档下 verify 命令写 home 必须 EROFS 拒绝且宿主侧不落盘"
      );
      rmSync(homeProbe, { force: true });
    }
  );

  // 反向对照 (排除「写永远失败」的假绿): 同一个脚本在 global 档下写 home
  // 必须成功。两条一起才证明断言的是**档位差异**, 不是脚本本身写不动。
  it.skipIf(!hasBwrap())(
    "fsMode=global（对照）→ 同一 verify 脚本写 home 成功",
    async () => {
      const homeProbe = join(osHomedir(), ".iknow-verify-fsmode-probe-global");
      rmSync(homeProbe, { force: true });
      const probeScript = join(workDir, "verify-write-home-global.sh");
      writeFileSync(
        probeScript,
        `#!/bin/sh\necho probe > "${homeProbe}"\nexit 0\n`,
        { mode: 0o755 }
      );
      chmodSync(probeScript, 0o755);

      const ctx = makeCtx({
        responses: [assistantResult({ texts: ["answer-g"] })],
        fsMode: createFsModeContext("global"),
      });
      Object.assign(ctx, {
        verifyConfig: { command: probeScript } satisfies VerifyConfig,
      });
      const r = await processChatLine({ line: "fix this", ctx });
      assert.equal(r.ranQuery, true);
      assert.equal(
        existsSync(homeProbe),
        true,
        "global 档下 verify 命令写 home 应成功（对照: 证明确实是档位在起作用）"
      );
      rmSync(homeProbe, { force: true });
    }
  );
});
