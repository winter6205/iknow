/**
 * T8 (#128): SessionHub postMessage 装配 verify-loop 接线测试。
 *
 * 全真实装配链, 无测试缝:
 *   - SessionHubOptions.verifyConfig (command 指向 cwd 内脚本);
 *   - runVerifyLoop 缺省 runVerify = runInSandbox + bwrap (真实沙箱执行,
 *     hasBwrap 守卫, 与 verify-loop 测试同纪律);
 *   - runFn 经 hub.postMessage 走真实 run() (stub model deps)。
 *
 * 闭环激活的铁证 = 验证命令确实执行: 脚本往 cwd 写 marker 文件。
 *
 * 覆盖:
 *   1. verifyConfig 缺席 → 原 run 路径 (SC7): completed 结果 + 验证命令
 *      未执行 (marker 不存在);
 *   2. verifyConfig 配置 + 验证 exit 0 → 闭环激活 (marker 存在) + 单轮
 *      通过, wire finalText 保留;
 *   3. verifyConfig 配置 + 验证真失败 → 注入信封 (下一轮 priorMessages
 *      含 [VALIDATION FAILED] user 消息)。
 *
 * 与 chat 侧装配测试同纪律: 验证命令只在隔离 tmpdir (cwd) 内读写。
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";

/** bwrap 可用性守卫: 缺省 runVerify (runInSandbox) 只在 bwrap 存在时可用。 */
function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

const text = (t: string) => ({ type: "text" as const, text: t });

// -- isolated workdir (cwd for the closed loop's sandbox) ---------------------
const prevCwd = process.cwd();
let dataDir: string;
let workDir: string;
let markerPath: string;
let passScript: string;
let failScript: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "iknow-hub-verify-data-"));
  workDir = mkdtempSync(join(tmpdir(), "iknow-hub-verify-work-"));
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
  // 闭环沙箱 cwd = process.cwd() → 切到隔离工作目录 (不碰真实工作区)。
  process.chdir(workDir);
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

/** 装配带 verifyConfig 的 hub; responses 缺省空 (调用方显式给响应)。 */
function makeHub(opts: {
  verifyConfig?: VerifyConfig;
  responses?: Parameters<typeof makeDeps>[0];
}) {
  const store = new SessionStore(dataDir);
  return new SessionHub({
    store,
    deps: makeDeps(opts.responses ?? []),
    ...(opts.verifyConfig !== undefined
      ? { verifyConfig: opts.verifyConfig }
      : {}),
  });
}

describe("SessionHub postMessage — verify-loop 装配 (T8)", () => {
  it("verifyConfig 缺席 → 原 run 路径: completed + 验证未执行 (SC7)", async () => {
    rmSync(markerPath, { force: true });
    const hub = makeHub({
      responses: [assistantResult({ texts: ["hello world"] })],
    });
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hi",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    assert.equal(res.turn.answer.finalText, "hello world");
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
      const hub = makeHub({
        verifyConfig: { command: passScript },
        responses: [assistantResult({ texts: ["fixed"] })],
      });
      const { session } = await hub.createSession();
      const res = await hub.postMessage({
        conversationId: session.conversation_id,
        text: "fix this",
      });
      assert.equal(res.turn.answer.stopReason, "completed");
      assert.equal(res.turn.answer.finalText, "fixed");
      assert.equal(
        existsSync(markerPath),
        true,
        "配置 verifyConfig 时验证命令应经沙箱执行"
      );
    }
  );

  // T2 (#458 / #128 wire): verify 闭环最终判定为 passed 时,
  // VerifyAnswerView.outcome 必须 = "passed" 且 rounds 落在 wire DTO 上
  // (此前三态白名单缺 passed → 字段缺席, 与 passed 实际是合法终态矛盾)。
  // abort / disabled 仍维持字段缺席 (本测试不覆盖, 见 contract.test.ts)。
  it.skipIf(!hasBwrap())(
    'verifyConfig 配置 + 验证 exit 0 → DTO 出现 verify.outcome="passed" rounds=N (T2 wire)',
    async () => {
      rmSync(markerPath, { force: true });
      const hub = makeHub({
        verifyConfig: { command: passScript },
        responses: [assistantResult({ texts: ["fixed"] })],
      });
      const { session } = await hub.createSession();
      const res = await hub.postMessage({
        conversationId: session.conversation_id,
        text: "fix this",
      });
      // T2: passed 是合法终态, 必须挂到 VerifyAnswerView DTO 上。
      // 与 failed/unstable/escalated 同 surface;abort/disabled 仍字段缺席
      // (byte-stable, 仅契约测试单独钉住)。
      assert.deepEqual(res.turn.answer.verify, {
        outcome: "passed",
        rounds: 1,
      });
    }
  );

  it.skipIf(!hasBwrap())(
    "verifyConfig 配置 + 验证真失败 → 注入失败信封 (下轮 priorMessages)",
    async () => {
      rmSync(markerPath, { force: true });
      // 两条 stub 响应: 第一条 run 返回 (completed) → 验证挂 → 注入信封;
      // 第二条 run (信封在 priorMessages 中) 返回 → 验证仍挂 → 停滞停。
      const hub = makeHub({
        verifyConfig: { command: failScript },
        responses: [
          assistantResult({ texts: ["fix-1"] }),
          assistantResult({ texts: ["fix-2"] }),
        ],
      });
      const { session } = await hub.createSession();
      const res = await hub.postMessage({
        conversationId: session.conversation_id,
        text: "make tests pass",
      });
      assert.equal(res.turn.answer.stopReason, "completed");
      assert.equal(existsSync(markerPath), true, "验证命令应真实执行");
      // 信封注入在第二轮 run 的 priorMessages 里 (messages 含
      // [VALIDATION FAILED] user 消息)。postMessage 已 conditionalSave 落盘,
      // 从盘上 load 最新文件断言。
      const saved = await new SessionStore(dataDir).load(
        session.conversation_id
      );
      const envelopes = saved.messages.filter(
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
    }
  );
});
