/**
 * 449b 三级流集成测试 (B4-B9 共用追加文件, #449b evidence-first loop)。
 *
 * B4 范围 (本文件首组用例): evidence-first 前级接线进 produceObservation 缝 —
 * 三态映射到既有闭环 Verdict:
 *   - EVIDENCE_SUFFICIENT → { verdict: "pass", exitCode: 0 } 零判官零重跑
 *     (SC2 / SC3: 即便 config.command 已配, runVerify spy 0 调用);
 *   - EVIDENCE_CONTRADICTED → true-failure 走既有真失败处置 (trend 放行继续 /
 *     maxRounds 截停), record.verdict = "true-failure", 不落 evidenceVerdict;
 *   - EVIDENCE_INSUFFICIENT → 落原 produceObservation (判官 / 命令既有机制),
 *     record 落 evidenceVerdict="EVIDENCE_INSUFFICIENT" + gamingSignals (Postel)。
 *
 * 后续 bullet (B5 补跑信封 / B7 四态停法 / B9 只读复断言) 追加用例到此文件。
 *
 * messages fixture: B4 精确语义 claimIndex = round; 首轮 round=1 → checker 只计
 * messageIndex < 1 的 run → bash 证据必须在 messageIndex 0。沿用
 * evidence-checker/_fixtures 的 VITEST_GREEN + toolUse/toolResult 构造法。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  runVerifyLoop,
  type ClassifierEnvelope,
  type RunClassifierFn,
  type RunOutcome,
  type RunVerifyFn,
  type VerifyLoopOptions,
} from "../../../src/harness/verify/verify-loop.ts";
import type { VerifyConfig } from "../../../src/harness/verify/types.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  RunResult,
} from "../../../src/harness/model-adapter/types.ts";
import type { LoopTrace } from "../../../src/harness/loop-trace.ts";
import { textBlock, toolUse, writeFile } from "./evidence-checker/_fixtures.js";

/* ------------------------------ 测试替身 ------------------------------ */

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

const VITEST_GREEN = " ✓ Tests  3 passed (3)\n";

/** 构造 bash tool_use + tool_result 块对 (vitest 绿摘要, 退 0, 框架摘要命中)。 */
function bashGreenBlocks(toolUseId: string): AnthropicContentBlock[] {
  return [
    toolUse(toolUseId, "npx vitest run"),
    {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" }),
    },
  ];
}

/** 构造 bash tool_use + tool_result 块对 (vitest 失败, 退 1, 不命中绿摘要)。 */
function bashFailBlocks(toolUseId: string): AnthropicContentBlock[] {
  return [
    toolUse(toolUseId, "npx vitest run"),
    {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: JSON.stringify({ code: 1, stdout: "FAIL\n", stderr: "" }),
    },
  ];
}

/** claimIndex=round=1 时, bash 证据须在 messageIndex 0 (< 1) 才被计入。
 *  绿 bash (index 0) + assistant "done" claim (index 1) → SUFFICIENT。 */
const GREEN_FIRST_MESSAGES: AnthropicNativeMessage[] = [
  {
    role: "assistant",
    content: bashGreenBlocks("g01"),
  },
  { role: "assistant", content: [textBlock("implemented")] },
];

/** 无 bash 证据 → INSUFFICIENT (runs.length === 0 → 早退 fail-closed)。 */
const NO_EVIDENCE_MESSAGES: AnthropicNativeMessage[] = [
  { role: "user", content: [textBlock("task")] },
  { role: "assistant", content: [textBlock("implemented but no test output")] },
];

/** INSUFFICIENT + 有 run (exit≠0) + 软信号: bash fail + git commit --no-verify。
 *  bash 失败跑在 messageIndex 0 (claimIndex=1 → 计入 runs), hasContradiction=false
 *  (无 rm/write_file 清空测试文件), computeVerdict 因 exit 1 落 INSUFFICIENT,
 *  gamingSignals 经 collectGamingSignals 透传。 */
const INSUFFICIENT_WITH_SIGNAL_MESSAGES: AnthropicNativeMessage[] = [
  {
    role: "assistant",
    content: bashFailBlocks("s01"),
  },
  {
    role: "assistant",
    content: [
      toolUse("s02", "git commit --no-verify -m 'x'"),
      {
        type: "tool_result",
        tool_use_id: "s02",
        content: JSON.stringify({ code: 0, stdout: "committed", stderr: "" }),
      },
    ],
  },
  { role: "assistant", content: [textBlock("implemented")] },
];

/** CONTRADICTED: 绿 bash (index 0) + write_file 清空测试文件 (任意位置) →
 *  hasContradiction 二进制硬否决。checker reasons 归一化签名
 *  buildFailureSignature({ exitCode: 1, outputText: "test files cleared or
 *  removed (binary contradiction)", countRegex: undefined }) → 无 FAIL 行 →
 *  signature = "exit=1"。 */
const CONTRADICTED_MESSAGES: AnthropicNativeMessage[] = [
  {
    role: "assistant",
    content: bashGreenBlocks("g02"),
  },
  {
    role: "assistant",
    content: [writeFile("w02", "src/foo.test.ts", "")],
  },
  { role: "assistant", content: [textBlock("implemented")] },
];

function makeNative(opts: {
  readonly role: "user" | "assistant";
  readonly text: string;
}): AnthropicNativeMessage {
  return { role: opts.role, content: [{ type: "text", text: opts.text }] };
}

/** stubRun: 确定性 run() 替身返回形状 (与 verify-loop.test.ts 同款)。 */
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

interface RecordedCall {
  readonly userText: string;
  readonly priorCount: number;
  readonly lastUserText: string | undefined;
}

/** 脚本化 runFn 替身: 逐次返回脚本文本, 记录每次调用的历史形状。 */
function makeRecordingRunFn(
  script: ReadonlyArray<string>,
  opts: {
    readonly stopReasonFor?: (call: number) => RunResult["stopReason"];
  } = {}
): {
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
    const stopReason = opts.stopReasonFor?.(call) ?? "completed";
    return stubRun({ text, stopReason, priorMessages: prior, userText });
  };
  return { runFn, calls: () => calls };
}

/** 单条 RunOutcome (固定 messages; 单轮 verify-loop 适用)。 */
function makeSingleOutcome(
  messages: AnthropicNativeMessage[],
  stopReason: RunResult["stopReason"] = "completed"
): RunOutcome {
  return {
    result: {
      finalText: stopReason === "completed" ? "implemented" : null,
      messages: [...messages],
      turnCount: 1,
      stopReason,
      lastUsage: null,
    },
    trace: EMPTY_TRACE,
  };
}

/** 首轮返回固定 messages (含 evidence transcript); 后续轮走 priorMessages。 */
function makeEvidenceRunFn(
  firstMessages: AnthropicNativeMessage[],
  opts: {
    readonly stopReasonFor?: (call: number) => RunResult["stopReason"];
  } = {}
): {
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
    const stopReason = opts.stopReasonFor?.(call) ?? "completed";
    const messages =
      call === 0
        ? [...firstMessages]
        : [
            ...prior,
            makeNative({ role: "user", text: userText }),
            makeNative({ role: "assistant", text: "implemented" }),
          ];
    return makeSingleOutcome(messages, stopReason);
  };
  return { runFn, calls: () => calls };
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

/** 构造一个调用 spy + 返回脚本的 runClassifier 替身 (与 classifier-loop 同款)。 */
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

/** 脚本化 runVerify 替身: 逐次消费处理器, 记录命令串。耗尽即抛错。 */
function makeScriptedVerify(
  script: ReadonlyArray<
    () => { exitCode: number; stdout: string; stderr: string }
  >
): {
  readonly runVerify: VerifyLoopOptions["runVerify"];
  readonly callCount: () => number;
  readonly commands: () => ReadonlyArray<string>;
} {
  const commands: string[] = [];
  let call = 0;
  const runVerify: RunVerifyFn = async (command) => {
    commands.push(command);
    const handler = script[call];
    if (handler === undefined) {
      throw new Error(`scripted verify exhausted at call ${call}`);
    }
    call += 1;
    return handler();
  };
  return { runVerify, callCount: () => call, commands: () => commands };
}

function defaultOptions(over: {
  readonly runFn: VerifyLoopOptions["runFn"];
  readonly config?: Partial<VerifyConfig>;
  readonly sessionId?: string;
  readonly runVerify?: VerifyLoopOptions["runVerify"];
  readonly runClassifier?: RunClassifierFn;
  readonly userText?: string;
}): VerifyLoopOptions {
  return {
    runFn: over.runFn,
    userText: over.userText ?? "implement goal",
    config: { command: "npm test", ...over.config },
    sessionId: over.sessionId ?? "sess",
    ...(over.runVerify !== undefined ? { runVerify: over.runVerify } : {}),
    ...(over.runClassifier !== undefined
      ? { runClassifier: over.runClassifier }
      : {}),
    cwd: process.cwd(),
  };
}

/* ------------------------------ B4: evidence-first 三级流 ------------------------------ */

describe("evidence-first three-stage flow", () => {
  it("SUFFICIENT: 零判官零重跑直接 PASS (rounds=1, runVerify spy 0 调用)", async () => {
    const { runFn, calls } = makeEvidenceRunFn(GREEN_FIRST_MESSAGES);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("should never be reached"),
    ]);
    const verify = makeScriptedVerify([
      () => ({ exitCode: 0, stdout: "should not run", stderr: "" }),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        runVerify: verify.runVerify,
      })
    );
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 1);
    assert.equal(classifierCalls().length, 0, "SUFFICIENT 零判官 spawn");
    assert.equal(verify.callCount(), 0, "SUFFICIENT 零命令重跑");
    assert.equal(calls().length, 1, "只调一次 runFn (无修正轮)");
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]!.verdict, "pass");
    assert.equal(out.records[0]!.finalOutcome, "passed");
    // Postel: SUFFICIENT 不落 evidenceVerdict / gamingSignals (仅 INSUFFICIENT 写盘)。
    assert.equal(out.records[0]!.evidenceVerdict, undefined);
    assert.equal(out.records[0]!.gamingSignals, undefined);
  });

  it("SUFFICIENT + config.command 已配: 仍直接 PASS, runVerify spy 0 调用 (SC3 反向断言)", async () => {
    const { runFn } = makeEvidenceRunFn(GREEN_FIRST_MESSAGES);
    const verify = makeScriptedVerify([
      () => ({ exitCode: 0, stdout: "should not run", stderr: "" }),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runVerify: verify.runVerify })
    );
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 1);
    assert.equal(verify.callCount(), 0, "配 command 但证据充分 → 不重跑 (G3)");
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]!.verdict, "pass");
    assert.equal(out.records[0]!.evidenceVerdict, undefined);
  });

  it("SUFFICIENT 时 runClassifier 不被调用 (classifier 路径 spy 0)", async () => {
    const { runFn } = makeEvidenceRunFn(GREEN_FIRST_MESSAGES);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("should never be reached"),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runClassifier, config: { command: "" } })
    );
    assert.equal(out.outcome, "passed");
    assert.equal(classifierCalls().length, 0);
    assert.equal(out.records[0]!.evidenceVerdict, undefined);
  });

  it("INSUFFICIENT: 落原 produceObservation, record 落 evidenceVerdict=INSUFFICIENT (classifier 路)", async () => {
    const runFn: VerifyLoopOptions["runFn"] = async (_userText, runOpts) =>
      stubRun({
        text: "implemented but no test output",
        userText: "implement goal",
        priorMessages: runOpts?.priorMessages,
      });
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("evidence is weak but I'll pass it"),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runClassifier, config: { command: "" } })
    );
    assert.equal(classifierCalls().length, 1, "INSUFFICIENT 落判官");
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 1);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]!.verdict, "pass");
    assert.equal(
      out.records[0]!.evidenceVerdict,
      "EVIDENCE_INSUFFICIENT",
      "INSUFFICIENT 轮落盘 evidenceVerdict"
    );
    assert.deepEqual(out.records[0]!.gamingSignals, []);
  });

  it("INSUFFICIENT + 软信号: record.gamingSignals 从 report 透传落盘", async () => {
    const { runFn } = makeEvidenceRunFn(INSUFFICIENT_WITH_SIGNAL_MESSAGES);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("weak evidence but pass"),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runClassifier, config: { command: "" } })
    );
    assert.equal(classifierCalls().length, 1, "INSUFFICIENT 落判官");
    assert.equal(out.records[0]!.evidenceVerdict, "EVIDENCE_INSUFFICIENT");
    assert.deepEqual(
      out.records[0]!.gamingSignals,
      ["git commit --no-verify/-n (skipped pre-commit checks)"],
      "gamingSignals 从 report 透传落盘"
    );
  });

  it("INSUFFICIENT: 命令路照旧重跑但 record 带 evidenceVerdict=INSUFFICIENT", async () => {
    const runFn: VerifyLoopOptions["runFn"] = async (_userText, runOpts) =>
      stubRun({
        text: "implemented but no test output",
        userText: "implement goal",
        priorMessages: runOpts?.priorMessages,
      });
    const verify = makeScriptedVerify([
      () => ({ exitCode: 0, stdout: "all pass\n", stderr: "" }),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runVerify: verify.runVerify })
    );
    assert.equal(verify.callCount(), 1, "INSUFFICIENT + command → 重跑");
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 1);
    assert.equal(out.records[0]!.verdict, "pass");
    assert.equal(
      out.records[0]!.evidenceVerdict,
      "EVIDENCE_INSUFFICIENT",
      "命令路重跑轮也落盘 evidenceVerdict"
    );
  });

  it("CONTRADICTED: 真失败处置 (trend 放行 continue), record.verdict=true-failure 不落 evidenceVerdict", async () => {
    // round 1: CONTRADICTED → true-failure → trend 兜底 continue → inject 信封 →
    // runFn call 2 → stopReason=maxTurns → outcome "failed" (第二轮非 completed
    // 原样透传, 不进 evidence-first 前级)。
    const { runFn, calls } = makeEvidenceRunFn(CONTRADICTED_MESSAGES, {
      stopReasonFor: (call) => (call === 0 ? "completed" : "maxTurns"),
    });
    const { runClassifier } = makeClassifierSpy([
      passEnvelope("should never be reached"),
    ]);
    const verify = makeScriptedVerify([
      () => ({ exitCode: 0, stdout: "should not run", stderr: "" }),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        runVerify: verify.runVerify,
      })
    );
    assert.equal(out.outcome, "failed", "call 1 stopReason=maxTurns 原样透传");
    assert.equal(out.rounds, 1, "CONTRADICTED 短路一轮, 第二轮不触发验证");
    assert.equal(out.records.length, 1);
    assert.equal(
      out.records[0]!.verdict,
      "true-failure",
      "CONTRADICTED 映射 true-failure"
    );
    assert.equal(out.records[0]!.exitCode, 1);
    assert.equal(
      out.records[0]!.signature,
      "exit=1",
      "reasons 归一化签名 (无 FAIL 行 → 纯 exit 签名)"
    );
    assert.equal(out.records[0]!.action, "continue", "趋势放行 → 修正轮");
    assert.equal(out.records[0]!.finalOutcome, undefined);
    assert.equal(
      verify.callCount(),
      0,
      "CONTRADICTED 短路 produceObservation, 零 runVerify"
    );
    assert.equal(
      out.records[0]!.evidenceVerdict,
      undefined,
      "CONTRADICTED 不落 evidenceVerdict (Postel)"
    );
    // 真失败同构: 修正轮注入 [VALIDATION FAILED] 信封 (call 1 的 lastUserText)。
    assert.equal(
      calls()[1]!.lastUserText?.includes("[VALIDATION FAILED]"),
      true,
      "下一轮 runFn 携带失败信封"
    );
  });
});
