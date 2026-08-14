/**
 * #128 verify 分类器 — SC7 回归语义反转测试 (T6, spec §SC9)。
 *
 * spec/128-verify-classifier.md SC9:
 *   未配 `verify.command` 时闭环**不再透明关闭**（对照 128 spec SC7 废除新语义）
 *   ——分类器路径行为 ≠ 裸 run 逐字节一致。
 *
 * 本文件对照 verify-loop.test.ts 既有的"透明关闭"基线
 * （command="" + 未装配 seam → outcome=disabled, result 与裸 run 逐字节一致）
 * 验证反转：command="" + 装配 runClassifier seam → 分类器接管闭环,
 *   outcome=passed / failed / aborted (而非 disabled), 行为 ≠ 裸 run。
 *
 * 校验目标:
 *   - 真 spawn 一个产出 pass verdict 的 stub → outcome=passed, enabled=true;
 *   - 结果逐字节不等于裸 run (classification 记录 + rounds 存在);
 *   - 对照 SC7 旧语义的 disabled 基线, 证明分类器接管 (非逐字节一致)。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  runVerifyLoop,
  type ClassifierEnvelope,
  type RunClassifierFn,
  type VerifyLoopOptions,
} from "../../../src/harness/verify/verify-loop.ts";
import type { VerifyConfig } from "../../../src/harness/verify/types.ts";
import type {
  AnthropicNativeMessage,
  RunResult,
} from "../../../src/harness/model-adapter/types.ts";
import type { LoopTrace } from "../../../src/harness/loop-trace.ts";

/* ------------------------------ 测试 fixture (镜像 classifier-loop.test.ts) ------------------------------ */

const EMPTY_TRACE: LoopTrace = Object.freeze({
  turns: Object.freeze([]),
  totals: Object.freeze({
    totalDurationMs: 0,
    cancelKindCounts: Object.freeze({
      none: 0,
      callerAbort: 0,
      timerTimeout: 0,
      hostCancel: 0,
    }),
    toolErrorTotals: Object.freeze({
      ok: 0,
      validation_failed: 0,
      tool_not_found: 0,
      execution_failed: 0,
    }),
  }),
});

function makeNative(opts: {
  readonly role: "user" | "assistant";
  readonly text: string;
}): AnthropicNativeMessage {
  return { role: opts.role, content: [{ type: "text", text: opts.text }] };
}

function stubRun(opts: {
  readonly text: string;
  readonly userText: string;
  readonly stopReason?: RunResult["stopReason"];
  readonly priorMessages?: ReadonlyArray<AnthropicNativeMessage>;
}): RunOutcome {
  const messages: AnthropicNativeMessage[] = [
    ...(opts.priorMessages ?? []),
    makeNative({ role: "user", text: opts.userText }),
    makeNative({ role: "assistant", text: opts.text }),
  ];
  const stopReason = opts.stopReason ?? "completed";
  return {
    result: {
      finalText: stopReason === "completed" ? opts.text : null,
      messages,
      turnCount: 1,
      stopReason,
      lastUsage: null,
    },
    trace: EMPTY_TRACE,
  };
}

/** run() 委托返回形状 (与 verify-loop.ts 的 RunOutcome 同构)。 */
interface RunOutcome {
  readonly result: RunResult;
  readonly trace: LoopTrace;
}

/** 裸 run 基线替身: 复用 stubRun, 只调一次 (SC7 旧语义的对照基准)。 */
function makeBare(
  text: string,
  userText: string
): {
  readonly runFn: VerifyLoopOptions["runFn"];
  readonly bare: RunOutcome;
} {
  const bare = stubRun({ text, userText });
  return { runFn: async () => bare, bare };
}

/** 脚本化 runFn 替身: 逐次返回脚本文本, 记录每次调用的历史形状 (同 T3 测试)。 */
function makeRecordingRunFn(script: ReadonlyArray<string>): {
  readonly runFn: VerifyLoopOptions["runFn"];
  readonly calls: () => ReadonlyArray<RecordedCall>;
} {
  const calls: RecordedCall[] = [];
  const runFn: VerifyLoopOptions["runFn"] = async (userText, runOpts) => {
    const prior = runOpts?.priorMessages ?? [];
    const lastUserMsg = [...prior].reverse().find((m) => m.role === "user");
    const lastUserText = lastUserMsg
      ? lastUserMsg.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
      : undefined;
    const call = calls.length;
    calls.push({ userText, priorCount: prior.length, lastUserText });
    const text = script[call];
    if (text === undefined) {
      throw new Error(`scripted runFn exhausted at call ${call}`);
    }
    return stubRun({
      text,
      stopReason: "completed",
      priorMessages: prior,
      userText,
    });
  };
  return { runFn, calls: () => calls };
}

/** 每次 runFn 调用的历史形状 (与 classifier-loop.test.ts / verify-loop.test.ts 同构)。 */
interface RecordedCall {
  readonly userText: string;
  readonly priorCount: number;
  readonly lastUserText: string | undefined;
}

/** 判官 JSON 序列化进 status:"ok" envelope 的 result 字段。 */
function okEnvelope(result: unknown): ClassifierEnvelope {
  return {
    status: "ok",
    result: JSON.stringify(result),
    summary: "judge done",
  };
}

function passEnvelope(reason: string): ClassifierEnvelope {
  return okEnvelope({
    kind: "pass",
    reason,
    evidence: [{ command: "noop", result: "pass" }],
  });
}

/** 构造一个调用 spy + 返回脚本的 runClassifier 替身 (同 T3 测试)。 */
function makeClassifierSpy(script: ReadonlyArray<ClassifierEnvelope>): {
  readonly runClassifier: RunClassifierFn;
  readonly calls: () => ReadonlyArray<{
    readonly task: string;
    readonly summary: string;
    readonly finalText: string | null;
  }>;
} {
  const calls: Array<{
    task: string;
    summary: string;
    finalText: string | null;
  }> = [];
  let i = 0;
  const runClassifier: RunClassifierFn = async (args) => {
    calls.push({
      task: args.task,
      summary: args.summary,
      finalText: args.finalText,
    });
    const next = script[i];
    if (next === undefined) {
      throw new Error(`classifier script exhausted at call ${i}`);
    }
    i += 1;
    return next;
  };
  return { runClassifier, calls: () => calls };
}

function defaultOptions(over: {
  readonly runFn: VerifyLoopOptions["runFn"];
  readonly runClassifier: RunClassifierFn;
  readonly config?: Partial<VerifyConfig>;
  readonly sessionId?: string;
  readonly userText?: string;
  readonly cwd?: string;
}): VerifyLoopOptions {
  return {
    runFn: over.runFn,
    userText: over.userText ?? "implement goal",
    config: { command: "", ...over.config },
    sessionId: over.sessionId ?? "sess-classifier-sc7",
    runClassifier: over.runClassifier,
    cwd: over.cwd ?? process.cwd(),
  };
}

/* ------------------------------ SC9: SC7 透明关闭的语义反转 ------------------------------ */

describe("SC9: command 缺失 + 分类器 seam → 闭环接管, 非 SC7 透明关闭 (回归反转)", () => {
  it("未配 command + 真 spawn 产出 pass verdict → outcome=passed (而非 disabled)", async () => {
    const { runFn } = makeRecordingRunFn(["implemented"]);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("evidence present"),
    ]);

    const out = await runVerifyLoop(defaultOptions({ runFn, runClassifier }));

    assert.equal(
      out.outcome,
      "passed",
      "command 缺失 + 分类器接管 → passed, 不是 SC7 旧语义的 disabled"
    );
    assert.equal(out.enabled, true, "分类器路径视为启用");
    assert.equal(out.rounds, 1, "分类器判官完成一轮判定");
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]!.verdict, "pass");
    assert.equal(classifierCalls().length, 1, "真 spawn 了一次分类器判官");
  });

  it("闭环状态反转 (SC9): 未配 command + 分类器接管 → passed/enabled/rounds/records 全翻转; 终局 result 仍逐字节透传 (既有约束)", async () => {
    const userText = "implement goal";
    const text = "implemented the requested feature";
    // 对照基准: 未装配分类器 seam (SC7 旧语义) → 裸 run 逐字节透传。
    const { runFn: bareRunFn, bare } = makeBare(text, userText);
    const bareOut = await runVerifyLoop({
      runFn: bareRunFn,
      userText,
      config: { command: "" },
      sessionId: "s-sc7-bare",
      cwd: process.cwd(),
    });
    assert.equal(
      bareOut.outcome,
      "disabled",
      "对照基线: 未装配 seam 仍为 SC7 透明关闭"
    );
    assert.deepEqual(bareOut.result, bare.result, "裸 run result 逐字节一致");
    assert.equal(bareOut.rounds, 0);

    // 被断言方: 装配分类器 seam → 同一输入下 outcome=passed 而非 disabled。
    const { runFn } = makeRecordingRunFn([text]);
    const { runClassifier } = makeClassifierSpy([
      passEnvelope("evidence present"),
    ]);
    const out = await runVerifyLoop(defaultOptions({ runFn, runClassifier }));

    assert.notEqual(
      out.outcome,
      bareOut.outcome,
      "outcome 反转: passed vs disabled (SC9: 不再透明关闭)"
    );
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 1, "分类器路径有判定轮, 裸 run 为 0 轮");
    assert.equal(out.enabled, true, "enabled 反转: true vs false");
    assert.notEqual(
      out.records.length,
      bareOut.records.length,
      "分类器路径产 VerificationRecord, 裸 run 无记录"
    );
    assert.equal(
      out.records.length,
      1,
      "分类器路径的判定轮记录 (证据: verdict=pass)"
    );
    assert.equal(out.records[0]!.verdict, "pass");
    // pass 终局返回触发轮 run 结果原样 (result/trace 与裸 run 逐字节一致是
    // 既有约束, 不证明透明关闭) —— 反转证据是闭环状态
    // (enabled/rounds/records/outcome) 而非 message 历史。
    assert.deepEqual(
      out.result.messages,
      bareOut.result.messages,
      "pass 终局返回触发轮 run 结果原样 (既有约束)"
    );
  });

  it("command 已配 → 分类器不接管, 走命令路径 (A1 路径 X 独占, SC7 反转边界不越界)", async () => {
    const { runFn } = makeRecordingRunFn(["done"]);
    let classifierInvoked = false;
    const runVerify: VerifyLoopOptions["runVerify"] = async () => ({
      exitCode: 0,
      stdout: "all good",
      stderr: "",
    });

    const out = await runVerifyLoop({
      runFn,
      userText: "implement goal",
      config: { command: "npm test" },
      sessionId: "s-sc7-command-present",
      runVerify,
      runClassifier: async () => {
        classifierInvoked = true;
        return passEnvelope("should not be called");
      },
      cwd: process.cwd(),
    });

    assert.equal(
      classifierInvoked,
      false,
      "command 已配时分类器不接管 (A1 路径 X 独占)"
    );
    assert.equal(out.outcome, "passed");
  });

  it("零配置视角: config 无 command 字段 (VerifyConfig command 缺失) → 分类器接管, 非逐字节一致", async () => {
    // 零配置 = 装配层 resolveVerifyConfig(undefined) 已产出 { command: "" };
    // 再进一层: command 字段完全缺席 (verify-loop 内部 `(config.command ?? "").trim()`
    // 兜底) 也必须走分类器接管 —— 与空串字面同语义 (spec Objective 零配置闭环
    // 不再透明关闭)。
    const userText = "implement goal";
    const text = "implemented the requested feature";
    const { runFn: bareRunFn, bare } = makeBare(text, userText);
    const bareOut = await runVerifyLoop({
      runFn: bareRunFn,
      userText,
      config: {} as VerifyConfig,
      sessionId: "s-sc7-zero-bare",
      cwd: process.cwd(),
    });
    assert.equal(bareOut.outcome, "disabled", "对照: 未装配 seam 仍透明关闭");

    const { runFn } = makeRecordingRunFn([text]);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("evidence present"),
    ]);
    const out = await runVerifyLoop({
      runFn,
      userText,
      config: {} as VerifyConfig,
      sessionId: "s-sc7-zero-classifier",
      runClassifier,
      cwd: process.cwd(),
    });
    assert.equal(out.outcome, "passed", "command 缺失 + 分类器 seam → 接管");
    assert.notEqual(out.outcome, bareOut.outcome, "≠ 裸 run disabled 语义");
    assert.equal(out.enabled, true);
    assert.equal(classifierCalls().length, 1, "判官 spawn 一次");
    assert.equal(out.records[0]!.verdict, "pass");
    assert.deepEqual(
      out.result.messages,
      bareOut.result.messages,
      "pass 终局返回触发轮 result 原样 (既有约束, 不证明透明关闭)"
    );
  });
});
