/**
 * verdict.ts pure functions (failure auto-fix closed loop).
 *
 * Coverage of the unit-level semantics:
 *   - three-state verdict: pass / true-failure / unstable, one case each
 *   - confirmation ladder: two levels (full rerun passes → flaky; all fail → true failure)
 *   - signature normalization: built-in regex extraction / countRegex takes
 *     priority / neither → plain exit signature
 *   - trend: progress continues / same-signature stall stops / two consecutive
 *     regressing rounds stop / single-round oscillation is tolerated
 *
 * Boundaries: empty output / no failure lines but exit≠0 / rerunTemplate
 * unset skips the single run.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  assessVerdict,
  confirmFailure,
  buildFailureSignature,
  evaluateTrend,
  countFailures,
} from "../../../src/harness/verify/verdict.ts";

/* ------------------------------ three-state verdict ------------------------------ */

describe("assessVerdict — 三态判定", () => {
  it("exit 0 → pass", () => {
    assert.equal(assessVerdict({ exitCode: 0 }), "pass");
  });

  it("exit≠0 + failedCount 0 → pass (无失败用例的退出码)", () => {
    assert.equal(assessVerdict({ exitCode: 1, failedCount: 0 }), "pass");
  });

  it("exit≠0 + 阶梯全不过 → true-failure", () => {
    assert.equal(
      assessVerdict({ exitCode: 1, failedCount: 3, rerunPassed: false }),
      "true-failure"
    );
  });

  it("exit≠0 + 全量复跑过 → pass (flaky, 不触发修正)", () => {
    assert.equal(
      assessVerdict({ exitCode: 1, failedCount: 3, rerunPassed: true }),
      "pass"
    );
  });

  it("exit≠0 + 全量复跑仍挂但单跑过 → unstable", () => {
    assert.equal(
      assessVerdict({ exitCode: 1, failedCount: 3, rerunPassed: false }),
      "true-failure"
    );
    assert.equal(
      assessVerdict({
        exitCode: 1,
        failedCount: 3,
        rerunPassed: false,
        singlePassed: true,
      }),
      "unstable"
    );
  });

  it("rerunPassed 未配置 (首次验证) → 真失败 (不可凭空放行)", () => {
    assert.equal(
      assessVerdict({ exitCode: 1, failedCount: 1 }),
      "true-failure"
    );
  });
});

/* ------------------------------ confirmation ladder ------------------------------ */

describe("confirmFailure — 两级确认阶梯", () => {
  it("全量复跑过 → flaky, 不再单跑", () => {
    assert.deepEqual(confirmFailure({ rerunPassed: true }), {
      verdict: "flaky",
      rerunFailed: false,
      singleRunPassed: undefined,
    });
  });

  it("全量复跑不过 + 单跑过 (套件干扰) → unstable", () => {
    assert.deepEqual(
      confirmFailure({ rerunPassed: false, singleRunPassed: true }),
      { verdict: "unstable", rerunFailed: true, singleRunPassed: true }
    );
  });

  it("全不过 → true-failure", () => {
    assert.deepEqual(
      confirmFailure({ rerunPassed: false, singleRunPassed: false }),
      { verdict: "true-failure", rerunFailed: true, singleRunPassed: false }
    );
  });

  it("rerunTemplate 未配置 → 跳过单跑, 全量复跑不过即真失败", () => {
    // The "unset" semantics lives with confirmFailure's caller (verify-loop):
    // without a template no single run is issued and singleRunPassed is undefined.
    assert.deepEqual(
      confirmFailure({ rerunPassed: false, singleRunPassed: undefined }),
      { verdict: "true-failure", rerunFailed: true, singleRunPassed: undefined }
    );
  });
});

/* ------------------------------ failure counting ------------------------------ */

describe("countFailures — 失败数提取", () => {
  const OUTPUT = [
    " FAIL  tests/auth.test.ts:login rejects bad token",
    "  ✗ expected 2 to be 1",
    'error: Cannot find module "x"',
    " RUN  tests/other.test.ts",
    "",
    "  ✓ passes",
  ].join("\n");

  it("内置正则计数 (exit≠0): FAIL / error: 计入, 缩进 ✗ 细节行不计", () => {
    // The indented "  ✗ expected..." does not match the built-in regex — a space follows ✗ so the \b word boundary fails.
    assert.equal(countFailures(OUTPUT), 2);
  });

  it("exit 0 → 0 (pass 分支不数失败行)", () => {
    assert.equal(countFailures(OUTPUT, undefined, 0), 0);
  });

  it("无失败行但 exit≠0 → 0 (签名回退到纯 exit)", () => {
    const noFail = "ok\ncompiled\n";
    assert.equal(countFailures(noFail), 0);
  });

  it("空输出 → 0", () => {
    assert.equal(countFailures(""), 0);
  });

  it("countRegex 优先于内置正则", () => {
    const re = /Tests:\s+(\d+) failed/;
    const output = "Tests: 12 failed, 3 passed\n FAIL  a\n FAIL  b\n";
    assert.equal(countFailures(output, re), 12);
  });

  it("countRegex 不匹配 → undefined (不猜测, 走纯签名路径)", () => {
    assert.equal(
      countFailures("no matches here", /Tests:\s+(\d+) failed/),
      undefined
    );
  });

  it("非法 countRegex (无捕获组) → undefined", () => {
    assert.equal(countFailures("Tests: 12 failed", /failed/), undefined);
  });
});

/* ------------------------------ signature normalization ------------------------------ */

describe("buildFailureSignature — 失败签名归一", () => {
  const OUTPUT = [
    " FAIL  tests/auth.test.ts:login rejects bad token",
    'error: Cannot find module "x"',
  ].join("\n");

  it("exit + 首条失败行行首 (剥 FAIL 标记) → 格式 exit=1|tests/auth.test.ts:login rejects bad token", () => {
    assert.equal(
      buildFailureSignature({ exitCode: 1, outputText: OUTPUT }),
      "exit=1|tests/auth.test.ts:login rejects bad token"
    );
  });

  it("首个失败行为 error: 行 → 签名为该行内容", () => {
    const out = 'error: Cannot find module "x"\n FAIL  b\n';
    assert.equal(
      buildFailureSignature({ exitCode: 1, outputText: out }),
      'exit=1|error: Cannot find module "x"'
    );
  });

  it("countRegex 优先: 失败数+首行 → exit=1|Tests: 12 failed", () => {
    const out = "Tests: 12 failed, 3 passed\n FAIL  tests/auth.test.ts:login\n";
    assert.equal(
      buildFailureSignature({
        exitCode: 1,
        outputText: out,
        countRegex: String.raw`Tests:\s+(\d+) failed`,
      }),
      "exit=1|Tests: 12 failed"
    );
  });

  it("两者均无 → 纯 exit 签名", () => {
    assert.equal(
      buildFailureSignature({ exitCode: 1, outputText: "" }),
      "exit=1"
    );
  });

  it("无失败行但 exit≠0 → 纯 exit 签名", () => {
    assert.equal(
      buildFailureSignature({ exitCode: 2, outputText: "compiled ok\n" }),
      "exit=2"
    );
  });

  it("exit 0 → 签名不含 '|' 后缀", () => {
    assert.equal(
      buildFailureSignature({ exitCode: 0, outputText: "ok" }),
      "exit=0"
    );
  });
});

/* ------------------------------ trend evaluation ------------------------------ */

describe("evaluateTrend — 趋势判定", () => {
  it("进展 (失败数优于历史最好) → progress", () => {
    assert.deepEqual(
      evaluateTrend({
        currentFailed: 1,
        bestFailed: 3,
        lastFailed: 2,
        currentSignature: "exit=1",
        lastSignature: "exit=1",
      }),
      { trend: "progress", action: "continue" }
    );
  });

  it("同签名连续两轮 → stuck", () => {
    assert.deepEqual(
      evaluateTrend({
        currentFailed: 2,
        bestFailed: 2,
        lastFailed: 2,
        currentSignature: "exit=1",
        lastSignature: "exit=1",
      }),
      { trend: "stuck", action: "stop" }
    );
  });

  it("连续两轮差于最好成绩 → regression (签名不同, 非停滞)", () => {
    // Last round (2) and the round before it are both worse than best (1);
    // the signature changed → not a stall, judged regression.
    assert.deepEqual(
      evaluateTrend({
        currentFailed: 3,
        bestFailed: 1,
        lastFailed: 2,
        currentSignature: "exit=1|tests/b.test.ts:boom",
        lastSignature: "exit=1|tests/a.test.ts:fail",
      }),
      { trend: "regression", action: "stop" }
    );
  });

  it("单轮震荡宽容 (一次退化, 签名变, 未达两轮) → oscillation-tolerant", () => {
    // Last round was best (1), this round degraded to 2; the signature changed
    // → not a stall, fewer than two consecutive rounds → continue.
    assert.deepEqual(
      evaluateTrend({
        currentFailed: 2,
        bestFailed: 1,
        lastFailed: 1,
        currentSignature: "exit=1|tests/b.test.ts:boom",
        lastSignature: "exit=1|tests/a.test.ts:fail",
      }),
      { trend: "oscillation-tolerant", action: "continue" }
    );
  });
});
