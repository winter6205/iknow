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
 * messages fixture: claimIndex is the messages index of the last assistant
 * with non-empty text (same backward scan as deriveFinalText), not verify
 * round. GREEN_FIRST keeps bash at index 0 and the claim at index 1 so the
 * window still includes that run. Fixtures that pin "evidence must live in
 * messages[0]" as B4 semantics belong in claim-window.test.ts (SC1).
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
import type {
  EvidenceContext,
  VerifyConfig,
} from "../../../src/harness/verify/types.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  RunResult,
} from "../../../src/harness/model-adapter/types.ts";
import type { LoopTrace } from "../../../src/harness/loop-trace.ts";
import { createRunClassifierFromManager } from "../../../src/harness/verify/run-classifier-adapter.ts";
import { ACI_TOOLSET_NAMES } from "../../../src/harness/aci/tools/registry.ts";
import type { SubAgentDefinition } from "../../../src/harness/subagent/manager.js";
import type { SubAgentEnvelope } from "../../../src/harness/subagent/envelope.js";
import type { SubAgentManager } from "../../../src/harness/subagent/manager.js";
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

/** 绿 bash (index 0) + assistant claim (index 1) → SUFFICIENT。 */
const GREEN_FIRST_MESSAGES: AnthropicNativeMessage[] = [
  {
    role: "assistant",
    content: bashGreenBlocks("g01"),
  },
  { role: "assistant", content: [textBlock("implemented")] },
];

/** 判官路径 probe 成功: write_file 到 pyproject.toml (B5 D2 标志文件) → probeVerifyCommand
 *  返回 "pytest"; 无 bash 测试证据 → INSUFFICIENT + probe 命中 → 触发补跑信封。
 *  pyproject.toml 非测试文件 → 无 CONTRADICTED、无 gamingSignals。 */
const PROBE_OK_MESSAGES: AnthropicNativeMessage[] = [
  {
    role: "assistant",
    content: [
      writeFile("w04", "pyproject.toml", "[project]\nname = 'demo'\n"),
      {
        type: "tool_result",
        tool_use_id: "w04",
        content: JSON.stringify({ code: 0, stdout: "ok", stderr: "" }),
      },
    ],
  },
  { role: "assistant", content: [textBlock("implemented but no tests")] },
];

/** INSUFFICIENT + 有 run (exit≠0) + 软信号: bash fail + git commit --no-verify。
 *  bash 失败跑在 messageIndex 0 (claim assistant later → 计入 runs), hasContradiction=false
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

/** 构造一个调用 spy + 返回脚本的 runClassifier 替身 (与 classifier-loop 同款)。
 *  #449b B6: spy 额外捕获 evidenceContext (判官输入升级断言面)。 */
function makeClassifierSpy(script: ReadonlyArray<ClassifierEnvelope>): {
  readonly runClassifier: RunClassifierFn;
  readonly calls: () => ReadonlyArray<{
    readonly task: string;
    readonly summary: string;
    readonly finalText: string | null;
    readonly evidenceContext: EvidenceContext | undefined;
  }>;
} {
  const calls: Array<{
    task: string;
    summary: string;
    finalText: string | null;
    evidenceContext: EvidenceContext | undefined;
  }> = [];
  let i = 0;
  const runClassifier: RunClassifierFn = async (args) => {
    calls.push({
      task: args.task,
      summary: args.summary,
      finalText: args.finalText,
      evidenceContext: args.evidenceContext,
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

/* ------------------------------ B5: evidence-rerun envelope + 1-attempt cap ------------------------------ */

describe("evidence-first rerun (B5)", () => {
  const RERUN_INSTRUCTION =
    "Run the command and show the test framework's green-summary line; do not claim completion until verification passes.";

  /** 逐次返回脚本文本消息的 runFn (记录每次 priorMessages), 供补跑轮次断言。 */
  function scriptedRunFn(script: ReadonlyArray<AnthropicNativeMessage[]>): {
    readonly runFn: VerifyLoopOptions["runFn"];
    readonly priors: () => ReadonlyArray<ReadonlyArray<AnthropicNativeMessage>>;
  } {
    const priors: Array<ReadonlyArray<AnthropicNativeMessage>> = [];
    const runFn: VerifyLoopOptions["runFn"] = async (_userText, runOpts) => {
      priors.push(runOpts?.priorMessages ?? []);
      const call = priors.length - 1;
      const messages = script[call];
      if (messages === undefined) {
        throw new Error(`scripted runFn exhausted at call ${call}`);
      }
      return makeSingleOutcome(messages);
    };
    return { runFn, priors: () => priors };
  }

  function lastUserText(prior: ReadonlyArray<AnthropicNativeMessage>): string {
    const lastUser = [...prior].reverse().find((m) => m.role === "user");
    return lastUser
      ? lastUser.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      : "";
  }

  function allText(prior: ReadonlyArray<AnthropicNativeMessage>): string {
    return prior
      .map((m) =>
        m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      )
      .join("\n");
  }

  it("补跑 1 次上限: 判官路径 INSUFFICIENT + probe 成功 → 补跑一轮 → 仍 INSUFFICIENT → 落判官", async () => {
    // 判官路径 (command="") + probeable fixture (pyproject.toml → "pytest")。
    // call 0 (round 1) 与 call 1 (补跑轮, round 2) 都是 PROBE_OK: 两轮均
    // INSUFFICIENT → 补跑 cap 用尽后落判官 (runClassifier 被调, exit 0 → pass)。
    const { runFn, priors } = scriptedRunFn([
      PROBE_OK_MESSAGES,
      PROBE_OK_MESSAGES,
    ]);
    const verify = makeScriptedVerify([
      () => ({ exitCode: 0, stdout: "should not run", stderr: "" }),
    ]);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("still no test evidence, but pass"),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        config: { command: "" },
      })
    );
    // round 1 INSUFFICIENT + probe "pytest" 命中 → 注入补跑信封 (末条), rerunAttempts=1。
    const round1Text = lastUserText(priors()[1]!);
    assert.equal(
      round1Text.startsWith("[VERIFY: rerun needed]"),
      true,
      "round 1 补跑信封注入\n---\n" + round1Text
    );
    assert.equal(
      round1Text.includes("  pytest"),
      true,
      "补跑命令来自 probe (pyproject.toml → pytest)\n---\n" + round1Text
    );
    // round 2 仍 INSUFFICIENT + cap 用尽 → 落判官 (恰 1 次, pass → passed)。
    assert.equal(classifierCalls().length, 1, "补跑用尽后落判官恰 1 次");
    assert.equal(verify.callCount(), 0, "判官路径零命令重跑");
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 2, "补跑不产轮数增量, 仅判官轮记 1");
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]!.round, 2);
    assert.equal(out.records[0]!.evidenceVerdict, "EVIDENCE_INSUFFICIENT");
    assert.equal(
      out.records[0]!.gamingSignals?.length,
      0,
      "PROBE_OK 无 bash 软信号"
    );
  });

  it("补跑后 SUFFICIENT: 补跑轮绿证据 → PASS 零判官零重跑", async () => {
    // 判官路径 (command="") + probeable fixture: round 1 PROBE_OK (INSUFFICIENT) →
    // 补跑; round 2 绿 bash (SUFFICIENT) → PASS, 判官/命令都不触发。
    const { runFn } = scriptedRunFn([PROBE_OK_MESSAGES, GREEN_FIRST_MESSAGES]);
    const verify = makeScriptedVerify([
      () => ({ exitCode: 0, stdout: "should not run", stderr: "" }),
    ]);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("should never be reached"),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runVerify: verify.runVerify,
        runClassifier,
        config: { command: "" },
      })
    );
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 2, "补跑轮 (1) + SUFFICIENT 轮 (2)");
    assert.equal(out.records.length, 1, "仅 SUFFICIENT 轮落 record");
    assert.equal(out.records[0]!.verdict, "pass");
    assert.equal(
      out.records[0]!.evidenceVerdict,
      undefined,
      "SUFFICIENT 不落 evidenceVerdict (Postel)"
    );
    assert.equal(
      verify.callCount(),
      0,
      "SUFFICIENT 短路 produceObservation, 零重跑"
    );
    assert.equal(classifierCalls().length, 0, "SUFFICIENT 短路判官, 零 spawn");
  });

  it("无命令 + probe 失败 → 不补跑直接落判官", async () => {
    // round 1: 消息含 write_file 到非标志路径 src/foo.ts → collectProbeFiles 命中
    // 0 标志文件 → probeVerifyCommand 返回 null → 无命令 → 不补跑 → 落判官。
    const PROBE_FAIL_MESSAGES: AnthropicNativeMessage[] = [
      {
        role: "assistant",
        content: [
          writeFile("w03", "src/foo.ts", "export const x = 1;"),
          {
            type: "tool_result",
            tool_use_id: "w03",
            content: JSON.stringify({ code: 0, stdout: "ok", stderr: "" }),
          },
        ],
      },
      { role: "assistant", content: [textBlock("implemented but no tests")] },
    ];
    const { runFn } = scriptedRunFn([PROBE_FAIL_MESSAGES]);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("weak evidence but pass"),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        config: { command: "" },
      })
    );
    assert.equal(classifierCalls().length, 1, "probe 失败 → 直接落判官");
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 1);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]!.evidenceVerdict, "EVIDENCE_INSUFFICIENT");
  });

  it("补跑信封被 buildNextPriorMessages 滤除 (round 3 prior 不含 [VERIFY: rerun needed])", async () => {
    // 判官路径 (command="") + probeable fixture: round 1 PROBE_OK (INSUFFICIENT) →
    // 补跑信封; round 2 CONTRADICTED → true-failure → [VALIDATION FAILED] 信封;
    // round 3 GREEN (SUFFICIENT) → PASS。round 3 的 priorMessages 必须滤除
    // 补跑信封 (isInjectedEnvelope 扩展), 只留 [VALIDATION FAILED] 信封 ——
    // 模型不得重复读到已失效的旧补跑上下文。
    const { runFn, priors } = scriptedRunFn([
      PROBE_OK_MESSAGES,
      CONTRADICTED_MESSAGES,
      GREEN_FIRST_MESSAGES,
    ]);
    // runVerify 脚本化: 本用例全程短路 (补跑 / CONTRADICTED / SUFFICIENT), 永不
    // 落到 produceCommandObservation; 即使误触也立即返回 exit 0 而不是真的 spawn。
    const verify = makeScriptedVerify([
      () => ({ exitCode: 0, stdout: "should not run", stderr: "" }),
    ]);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("should never be reached"),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runVerify: verify.runVerify,
        runClassifier,
        config: { command: "" },
      })
    );
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 3);
    assert.equal(verify.callCount(), 0, "全程短路, 零命令重跑");
    assert.equal(
      classifierCalls().length,
      0,
      "判官路径零 spawn (补跑/CONTRADICTED/SUFFICIENT 全短路)"
    );
    // round 2 prior 携带补跑信封 (交付给 round 2 的证据核对)。
    assert.equal(
      allText(priors()[1]!).includes("[VERIFY: rerun needed]"),
      true,
      "round 2 收到补跑信封 (供模型补证据)"
    );
    // round 3 prior 必须滤除补跑信封, 且末条 = [VALIDATION FAILED] 修正信封。
    assert.equal(
      allText(priors()[2]!).includes("[VERIFY: rerun needed]"),
      false,
      "round 3 prior 不得残留补跑信封 (isInjectedEnvelope 扩展滤除)\n---\n" +
        allText(priors()[2]!)
    );
    assert.equal(
      lastUserText(priors()[2]!).startsWith("[VALIDATION FAILED]"),
      true,
      "round 3 携带 [VALIDATION FAILED] 信封\n---\n" +
        lastUserText(priors()[2]!)
    );
    assert.equal(
      lastUserText(priors()[2]!).includes(RERUN_INSTRUCTION),
      false,
      "round 3 末条不是补跑信封"
    );
  });
});

/* ------------------------------ B6: judge evidence-aware input + record trace ------------------------------ */

/**
 * #449b B6: 判官输入升级 (EvidenceContext 证据体检单进判官)。
 *   - INSUFFICIENT 落判官时 runClassifier spy 收到 evidenceContext:
 *       checkerVerdict === "EVIDENCE_INSUFFICIENT" + reasons 非空 + 任务
 *       字段首段 = userText 原样 (SC6 task 不重绑);
 *   - record.evidenceVerdict === "EVIDENCE_INSUFFICIENT" 落 trace (CapturingTrace
 *     镜像 verify-loop.test.ts makeCapturingTrace 模式)。
 *
 * fixture: messages 仅含 user + assistant text, 无 bash → checkEvidence
 * INSUFFICIENT, 无可探测命令 → 直接落判官 (B5 rerun cap 不触发)。
 */
describe("evidence-aware judge input + record trace (#449b B6)", () => {
  /** Capturing TraceService: 镜像 verify-loop.test.ts makeCapturingTrace 模式
   *  (recordVerification 落盘, 其它方法 no-op)。 */
  function makeCapturingTrace(): {
    readonly trace: import("../../../src/harness/trace/index.ts").TraceService;
    readonly records: () => ReadonlyArray<
      import("../../../src/harness/trace/index.ts").VerificationRecord
    >;
  } {
    const records: Array<
      import("../../../src/harness/trace/index.ts").VerificationRecord
    > = [];
    return {
      trace: {
        async recordLlmCall() {
          return undefined;
        },
        async recordToolCall() {
          return undefined;
        },
        async recordTurn() {
          return undefined;
        },
        async recordSession() {
          return undefined;
        },
        async recordSandboxCmd() {
          return undefined;
        },
        async recordVerification(record) {
          records.push(record);
          return record.id;
        },
      },
      records: () => records,
    };
  }

  it("INSUFFICIENT 落判官: spy 收到 evidenceContext (checkerVerdict=INSUFFICIENT + reasons 非空)", async () => {
    // 判官路径 (command="") + 无 bash 无探测 → INSUFFICIENT → 直落判官。
    const runFn: VerifyLoopOptions["runFn"] = async (_userText, runOpts) =>
      stubRun({
        text: "implemented but no test output",
        userText: "implement goal",
        priorMessages: runOpts?.priorMessages,
      });
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("evidence weak but pass"),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        config: { command: "" },
        sessionId: "s6",
      })
    );
    assert.equal(classifierCalls().length, 1, "INSUFFICIENT 落判官恰 1 次");
    const call = classifierCalls()[0]!;
    assert.ok(
      call.evidenceContext !== undefined,
      "spy must capture a defined evidenceContext"
    );
    assert.equal(
      call.evidenceContext!.checkerVerdict,
      "EVIDENCE_INSUFFICIENT",
      "evidenceContext.checkerVerdict 来自 checkEvidence 三态"
    );
    assert.ok(
      call.evidenceContext!.reasons.length > 0,
      "evidenceContext.reasons 非空 (B6 体检单语义)"
    );
    assert.deepEqual(
      call.evidenceContext!.executedCommands,
      [],
      "无 bash run → executedCommands 为空数组"
    );
    assert.equal(call.evidenceContext!.rerunAttempted, false);
    assert.equal(
      call.task,
      "implement goal",
      "task 首段 = userText 原样 (SC6)"
    );
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 1);
  });

  it("INSUFFICIENT 落判官 + 软信号: evidenceContext.reasons 含信号", async () => {
    // bash 失败 (INSUFFICIENT_WITH_SIGNAL_MESSAGES) + 无探测 → 直落判官。
    const { runFn } = makeEvidenceRunFn(INSUFFICIENT_WITH_SIGNAL_MESSAGES);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("weak evidence but pass"),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        config: { command: "" },
        sessionId: "s6b",
      })
    );
    assert.equal(classifierCalls().length, 1);
    const ctx = classifierCalls()[0]!.evidenceContext!;
    assert.equal(ctx.checkerVerdict, "EVIDENCE_INSUFFICIENT");
    assert.ok(ctx.reasons.length > 0, "reasons 非空");
    assert.deepEqual(
      ctx.executedCommands,
      ["npx vitest run"],
      "executedCommands = report.runs.map(r => r.command)"
    );
    assert.ok(
      ctx.evidenceSummary.includes("npx vitest run"),
      "evidenceSummary 含 run 行 (每 run 一行 command)"
    );
    assert.equal(out.outcome, "passed");
  });

  it("record.evidenceVerdict === 'EVIDENCE_INSUFFICIENT' 落 trace (CapturingTrace)", async () => {
    const runFn: VerifyLoopOptions["runFn"] = async (_userText, runOpts) =>
      stubRun({
        text: "implemented but no test output",
        userText: "implement goal",
        priorMessages: runOpts?.priorMessages,
      });
    const { runClassifier } = makeClassifierSpy([passEnvelope("pass")]);
    const capture = makeCapturingTrace();
    // defaultOptions 是本地 helper, 旧签名不接 trace; B6 用例直接构造 options。
    const opts: VerifyLoopOptions = {
      runFn,
      userText: "implement goal",
      config: { command: "" },
      sessionId: "s6c",
      runClassifier,
      trace: capture.trace,
      cwd: process.cwd(),
    };
    const out = await runVerifyLoop(opts);
    assert.equal(out.outcome, "passed");
    const records = capture.records();
    assert.equal(records.length, 1);
    assert.equal(
      records[0]!.evidenceVerdict,
      "EVIDENCE_INSUFFICIENT",
      "INSUFFICIENT 轮落盘 evidenceVerdict (B6 trace 双轨)"
    );
    assert.deepEqual(records[0]!.gamingSignals, []);
  });

  it("rerunAttempted 派生: 补跑一轮后落判官 → evidenceContext.rerunAttempted=true (消息扫描)", async () => {
    // 判官路径 (command="") + probeable fixture (pyproject.toml → pytest):
    // round 1 INSUFFICIENT + probe 命中 → 补跑; round 2 仍 INSUFFICIENT + cap
    // 用尽 → 落判官。spy 收到的 evidenceContext.rerunAttempted=true
    // (消息扫描 [VERIFY: rerun needed] 前缀派生)。
    // makeEvidenceRunFn: 后续轮 messages = prior (含补跑信封) + user + assistant,
    // 模拟生产 run() 把 priorMessages 并入 next turn 消息历史。
    const { runFn } = makeEvidenceRunFn(PROBE_OK_MESSAGES);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("still no test evidence"),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        config: { command: "" },
        sessionId: "s6d",
      })
    );
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 2);
    assert.equal(classifierCalls().length, 1, "补跑用尽后落判官恰 1 次");
    const ctx = classifierCalls()[0]!.evidenceContext!;
    assert.equal(
      ctx.rerunAttempted,
      true,
      "evidenceContext.rerunAttempted 派生自消息扫描 [VERIFY: rerun needed] 前缀"
    );
    assert.equal(ctx.checkerVerdict, "EVIDENCE_INSUFFICIENT");
  });
});

/* ------------------------------ B7: 判官四态停法 (unverified/abort/pass) ------------------------------ */

/**
 * #449b B7: runClassifierOnce 四态映射 + unverified/abort 停法 (SC7/SC8)。
 *   - 判官 unverified → { verdict: "unstable", signature: "classifier-unverified",
 *     reason: "unverified" } → decideRoundAction stop → outcome=unstable,
 *     零信封注入 (runFn 恰 1 次, 无第 2 轮);
 *   - 判官 abort (schema 降级) / transport 错 → { verdict: "unstable",
 *     signature: "classifier-abort" / "classifier-transport-error",
 *     reason: "abort" } → outcome=unstable, 零信封注入 (reason 与 unverified
 *     区分落盘, SC7);
 *   - 判官 pass → outcome=passed + reason 缺席 (Postel, pass 不落 reason)。
 *
 * fixture: 判官路径 (command="") + 无 bash 无探测 (text-only) → INSUFFICIENT
 * 直落判官, 不触发补跑信封 (probeVerifyCommand([]) = null)。
 */
describe("judge four-state stop behavior (#449b B7)", () => {
  /** text-only 判官路径 runFn: 每次调用都返回 completed (含 priorMessages)。 */
  function judgePathRunFn(): {
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
      calls.push({ userText, priorCount: prior.length, lastUserText });
      return stubRun({
        text: "implemented but no test output",
        stopReason: "completed",
        priorMessages: prior,
        userText,
      });
    };
    return { runFn, calls: () => calls };
  }

  it("判官 unverified → outcome=unstable + reason='unverified' + 0 信封注入 (runFn 恰 1 次)", async () => {
    const { runFn, calls } = judgePathRunFn();
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      okEnvelope({
        kind: "unverified",
        reason: "evidence insufficient to decide PASS or FAIL",
      }),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        config: { command: "" },
        sessionId: "b7-unverified",
      })
    );
    assert.equal(classifierCalls().length, 1, "INSUFFICIENT 落判官恰 1 次");
    assert.equal(out.outcome, "unstable", "unverified → fail-open unstable");
    assert.equal(out.rounds, 1);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]!.verdict, "unstable");
    assert.equal(
      out.records[0]!.signature,
      "classifier-unverified",
      "signature 区分 unverified (SC7)"
    );
    assert.equal(
      out.records[0]!.reason,
      "unverified",
      "typed reason REASON_UNVERIFIED 落盘 (SC7)"
    );
    assert.equal(
      out.records[0]!.finalOutcome,
      "unstable",
      "decideRoundAction stop finalOutcome"
    );
    // 0 信封注入: unstable 走 stop, 不进 buildFailureEnvelope (decideRoundAction
    // 只在 continue 调它); runFn 恰 1 次 = 无第 2 轮。首轮无 priorMessages →
    // lastUserText 为 undefined (无任何注入), 用 ?? "" 归一后断言无信封文本。
    assert.equal(calls().length, 1, "runFn 只调 1 次, 无修正/补跑轮");
    assert.equal(
      (calls()[0]!.lastUserText ?? "").includes("[VALIDATION FAILED]"),
      false,
      "unverified 不注入失败信封"
    );
    assert.equal(
      (calls()[0]!.lastUserText ?? "").includes("[VERIFY: rerun needed]"),
      false,
      "unverified 不注入补跑信封 (无 probe 命令, text-only fixture)"
    );
    // 终局消息历史也无任何信封 (unstable 停法零注入, 与 classifier-loop SC5 同款断言面)。
    const allUserText = out.result.messages
      .filter((m) => m.role === "user")
      .map((m) =>
        m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      )
      .join("\n");
    assert.equal(allUserText.includes("[VALIDATION FAILED]"), false);
    assert.equal(allUserText.includes("[VERIFY: rerun needed]"), false);
  });

  it("判官 abort (schema 降级 {kind:'abort'}) → outcome=unstable + reason='abort' + 0 信封注入", async () => {
    const { runFn, calls } = judgePathRunFn();
    const { runClassifier } = makeClassifierSpy([
      okEnvelope({ kind: "abort", reason: "judge could not decide" }),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        config: { command: "" },
        sessionId: "b7-abort",
      })
    );
    assert.equal(out.outcome, "unstable", "abort → fail-open unstable");
    assert.equal(out.rounds, 1);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]!.verdict, "unstable");
    assert.equal(
      out.records[0]!.signature,
      "classifier-abort",
      "signature 区分 abort (SC7)"
    );
    assert.equal(
      out.records[0]!.reason,
      "abort",
      "typed reason REASON_ABORT_TYPED 落盘 (SC7)"
    );
    assert.equal(
      out.records[0]!.reason,
      "abort",
      "reason 与 unverified 区分落盘"
    );
    assert.equal(calls().length, 1, "abort 零信封注入, runFn 恰 1 次");
  });

  it("判官 abort (畸形 JSON, schema 降级) → outcome=unstable + reason='abort' + 0 信封注入", async () => {
    const { runFn, calls } = judgePathRunFn();
    const { runClassifier } = makeClassifierSpy([
      { status: "ok", result: "not-json-at-all", summary: "judge done" },
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        config: { command: "" },
        sessionId: "b7-abort-json",
      })
    );
    assert.equal(out.outcome, "unstable");
    assert.equal(out.records.length, 1);
    assert.equal(
      out.records[0]!.reason,
      "abort",
      "schema 降级 reason 统一 abort"
    );
    assert.equal(out.records[0]!.signature, "classifier-abort");
    assert.equal(calls().length, 1, "schema 降级零信封注入");
  });

  it("transport 错 (envelope.status='failed') → outcome=unstable + reason='abort' (判官自身故障统一 abort)", async () => {
    const { runFn, calls } = judgePathRunFn();
    const { runClassifier } = makeClassifierSpy([
      {
        status: "failed",
        reason: "crashed",
        summary: "worker died",
        result: "",
      },
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        config: { command: "" },
        sessionId: "b7-transport",
      })
    );
    assert.equal(out.outcome, "unstable", "transport 错 → fail-open unstable");
    assert.equal(out.records.length, 1);
    assert.equal(
      out.records[0]!.signature,
      "classifier-transport-error",
      "signature 区分 transport 错"
    );
    assert.equal(
      out.records[0]!.reason,
      "abort",
      "transport 与 schema 降级同为判官自身故障, reason 统一 abort"
    );
    assert.equal(calls().length, 1, "transport 错零信封注入");
  });

  it("判官 unverified: evidenceVerdict 仍是 checker 态 EVIDENCE_INSUFFICIENT (INSUFFICIENT 轮 B4 合并, Postel)", async () => {
    // unverified 是判官态, 不是 checker 态: evidenceVerdict 反映的是 B4 前级
    // checkEvidence 的 INSUFFICIENT (判官只在 INSUFFICIENT 分支被调), 两者是
    // 不同字段, 并存于 record —— judge reason=unverified + checker
    // evidenceVerdict=INSUFFICIENT 互不覆盖。
    const { runFn } = judgePathRunFn();
    const { runClassifier } = makeClassifierSpy([
      okEnvelope({ kind: "unverified", reason: "cannot decide" }),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        config: { command: "" },
        sessionId: "b7-unverified-evidence",
      })
    );
    assert.equal(out.outcome, "unstable");
    assert.equal(out.records[0]!.reason, "unverified");
    assert.equal(
      out.records[0]!.evidenceVerdict,
      "EVIDENCE_INSUFFICIENT",
      "INSUFFICIENT 轮 B4 合并 evidenceVerdict (unverified ≠ checker 态)"
    );
    assert.deepEqual(out.records[0]!.gamingSignals, []);
  });

  it("判官 pass → outcome=passed + records[0].reason 缺席 (Postel, pass 不落 reason)", async () => {
    const { runFn, calls } = judgePathRunFn();
    const { runClassifier } = makeClassifierSpy([
      passEnvelope("evidence shows build green"),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        config: { command: "" },
        sessionId: "b7-pass",
      })
    );
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 1);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]!.verdict, "pass");
    assert.equal(
      out.records[0]!.reason,
      undefined,
      "pass 不落 reason (Postel 可选字段仅存在时写盘)"
    );
    assert.equal(calls().length, 1, "pass 终局, runFn 恰 1 次");
  });
});

/* ------------------------------ B9: SC9 只读判官 + 补跑 abort + 命令路径冻结 ------------------------------ */

/**
 * #449b B9 三级流集成测试收口 (plan B9):
 *   - SC9 只读判官集成层复断言: runVerifyLoop → createRunClassifierFromManager
 *     → stubManager 捕获 spawn def —— 声明面 (disallowedTools 5 项 / systemPrompt
 *     零 evidenceContext 泄漏) 在真实装配路径下完整保留, task === userText
 *     (evidenceContext 不拼进 def.task);
 *   - 补跑中 abort: round 1 INSUFFICIENT + probe 命中 → rerun 分支第 2 次 runFn
 *     挂起 → 用户 abort → while 顶部检查点收敛 outcome=aborted, records 零伪造
 *     (rerun 轮未 produceObservation), runFn 恰 2 次 (无 stale 第三轮);
 *   - 命令路径冻结重申: SUFFICIENT + config.command 已配 → runVerify spy 0 +
 *     runClassifier spy 0 + outcome passed (入口级 1 例, B4 既有机制防回归)。
 */

/**
 * #357 T2 — 判官 allow-list 推导真值（与 judge-input.test.ts 同源同公式）。
 *
 * 判官白名单基线 = {read_file, grep, glob}（spec 357 Objective 2 「只许本地
 * 纯只读」）。fail-closed: deny = 全量面 − 白名单。加白名单 = 显式改白名单常量
 * + operator 拍板，不接受运行时配置。
 */
const JUDGE_ALLOWED_BASELINE: ReadonlyArray<string> = Object.freeze([
  "read_file",
  "grep",
  "glob",
]);

/** 镜像 = ACI_TOOLSET_NAMES − 白名单基线（与 run-classifier-adapter 推导公式同源）。 */
const JUDGE_DISALLOWED_TOOLS: ReadonlyArray<string> = Object.freeze(
  [...ACI_TOOLSET_NAMES].filter((n) => !JUDGE_ALLOWED_BASELINE.includes(n))
);

describe("SC9 只读判官集成层复断言 (#449b B9)", () => {
  /** makeStubManager 镜像 (judge-input.test.ts): spawn 捕获 def, waitFor 回 pass 信封。 */
  function makeCapturingManager(): {
    readonly manager: SubAgentManager;
    readonly captured: () => SubAgentDefinition | undefined;
  } {
    let captured: SubAgentDefinition | undefined;
    const manager: SubAgentManager = {
      spawn(def) {
        captured = def;
        return { taskId: "t1" };
      },
      queryBuffer() {
        return { status: "not_found" };
      },
      async waitFor(
        _taskId: string,
        _timeoutMs?: number,
        _signal?: AbortSignal
      ): Promise<SubAgentEnvelope> {
        return {
          status: "ok",
          result: JSON.stringify({
            kind: "pass",
            reason: "verified",
            evidence: [{ command: "noop", result: "pass" }],
          }),
          summary: "judge done",
        };
      },
      async shutdown() {
        // no-op
      },
      drainCompleted() {
        return [];
      },
      listActive() {
        return [];
      },
      abortTask() {
        return false;
      },
      // #358 T7: 接口新增只读枚举面 —— fake 补全保持结构兼容。
      listSubagents() {
        return [];
      },
    };
    return { manager, captured: () => captured };
  }

  it("INSUFFICIENT 落判官: def 声明面完整保留 + task 二段 (SC9 集成层复断言)", async () => {
    // 判官路径 (command="") + text-only (无 bash 无探测) → INSUFFICIENT 直落判官。
    const runFn: VerifyLoopOptions["runFn"] = async (_userText, runOpts) =>
      stubRun({
        text: "implemented but no test output",
        userText: "implement goal",
        priorMessages: runOpts?.priorMessages,
      });
    const { manager, captured } = makeCapturingManager();
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier: createRunClassifierFromManager({ manager }),
        config: { command: "" },
        sessionId: "b9-sc9",
      })
    );
    assert.equal(
      out.outcome,
      "passed",
      "判官 pass envelope → 集成层收敛 passed"
    );
    assert.equal(out.rounds, 1);
    const def = captured();
    assert.ok(def !== undefined, "判官 seam 必须 spawn");
    // SC9 复断言: 声明面 disallowedTools = 全量面 − 白名单基线（#357 T2
    // allow-list 推导）。实际工具面 = 468 plan 负责 (worker deny-list 裁剪);
    // 本用例只复断言声明面完整保留。
    assert.ok(
      def.disallowedTools !== undefined,
      "JUDGE_ROLE 必须声明 disallowedTools"
    );
    assert.deepEqual(
      [...def.disallowedTools].sort(),
      [...JUDGE_DISALLOWED_TOOLS].sort(),
      "disallowedTools = ACI_TOOLSET_NAMES − JUDGE_ALLOWED_BASELINE (allow-list 推导)"
    );
    // 白名单三件必须缺席（允许判官使用）— fail-closed 推导的护栏。
    for (const allowed of JUDGE_ALLOWED_BASELINE) {
      assert.ok(
        !def.disallowedTools!.includes(allowed),
        `白名单工具 ${allowed} 必须不在 disallowedTools 内`
      );
    }
    assert.equal(def.task, "implement goal", "task === userText (goal.text)");
    assert.ok(
      !def.task.includes("checkerVerdict"),
      "task 不含 evidenceContext JSON"
    );
    // SC9: systemPrompt 零 evidenceContext 泄漏 (声明面零改动)。
    assert.equal(typeof def.systemPrompt, "string");
    assert.ok(
      !def.systemPrompt!.includes("evidence_context"),
      "systemPrompt 不含 evidence_context 段标记"
    );
    assert.ok(
      !def.systemPrompt!.includes("evidenceContext"),
      "systemPrompt 不含 evidenceContext 键 (JUDGE_ROLE 零改动)"
    );
  });
});

describe("补跑中 abort 无 stale 信封 (#449b B9)", () => {
  it("round1 INSUFFICIENT + probe 命中 → 补跑轮挂起 → abort → outcome=aborted, records 零伪造", async () => {
    const controller = new AbortController();
    const { runFn, calls } = makeEvidenceRunFn(PROBE_OK_MESSAGES);
    let resolveRerunStarted!: () => void;
    const rerunStarted = new Promise<void>((resolve) => {
      resolveRerunStarted = resolve;
    });
    const runFnHook: VerifyLoopOptions["runFn"] = async (userText, runOpts) => {
      const call = calls().length;
      if (call === 1) {
        // 补跑轮 (rerun branch 第 2 次 runFn) 挂起, 等待用户 abort 信号
        // (mirror classifier-abort.test.ts 在飞挂起模式)。
        resolveRerunStarted();
        await new Promise<void>((resolve) => {
          if (runOpts?.signal?.aborted) {
            resolve();
            return;
          }
          runOpts?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
      return runFn(userText, runOpts);
    };
    // 判官路径 (command="" + runClassifier 在场选 classifier-loop body, B5 补跑
    // 信封在 runVerifyLoopBody 内); 补跑轮在飞时 abort → 判官 seam 永不消费
    // (abort 早于 round 2 produceObservation), spy 脚本保持未消费。
    const { runClassifier } = makeClassifierSpy([]);
    // defaultOptions 不接 signal, 直接构造 options (B6 trace 前置例同款写法)。
    const opts: VerifyLoopOptions = {
      runFn: runFnHook,
      userText: "implement goal",
      config: { command: "" },
      sessionId: "b9-rerun-abort",
      signal: controller.signal,
      cwd: process.cwd(),
      runClassifier,
    };
    const promise = runVerifyLoop(opts);
    await rerunStarted;
    controller.abort();
    const out = await promise;

    assert.equal(
      out.outcome,
      "aborted",
      "补跑轮在飞时 abort → while 顶部检查点收敛 aborted"
    );
    assert.equal(
      out.rounds,
      1,
      "round 1 已计数, rerun 轮未进 produceObservation"
    );
    assert.equal(
      out.records.length,
      0,
      "不伪造 round1/rerun 轮 VerificationRecord (无 stale 判定)"
    );
    assert.equal(
      calls().length,
      2,
      "runFn 恰 2 次 (round1 主轮 + 补跑轮), 无 stale 第三轮续跑"
    );
    assert.equal(
      calls()[1]!.lastUserText?.startsWith("[VERIFY: rerun needed]"),
      true,
      "补跑轮收到 B5 补跑信封"
    );
  });
});

describe("命令路径冻结复跑 (#449b B9)", () => {
  it("SUFFICIENT + config.command 已配 → runVerify spy 0 + runClassifier spy 0 + outcome passed (入口级)", async () => {
    // B4 既有机制 (G3: 证据充分短路零重跑, 即便配 command) 的入口级复跑: 双 spy 0
    // 一次断言齐, 防监管路径 (.command-./.classifier-.) 接线回归。B4 用例已覆盖
    // 命令 / 判官两路各自 spy 0; 本条仅在 the-loop 入口合并重申。
    const { runFn } = makeEvidenceRunFn(GREEN_FIRST_MESSAGES);
    const verify = makeScriptedVerify([
      () => ({ exitCode: 0, stdout: "should not run", stderr: "" }),
    ]);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("should never be reached"),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runVerify: verify.runVerify,
        runClassifier,
      })
    );
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 1);
    assert.equal(
      verify.callCount(),
      0,
      "SUFFICIENT + command 已配 → 零沙箱重跑"
    );
    assert.equal(classifierCalls().length, 0, "SUFFICIENT → 零判官 spawn");
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0]!.verdict, "pass");
  });
});
