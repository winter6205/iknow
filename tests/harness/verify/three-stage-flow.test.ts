/**
 * Three-stage flow integration tests for the evidence-first loop.
 *
 * First group: the evidence-first front stage wired into the
 * produceObservation seam — the three checker states map onto the existing
 * closed-loop Verdict:
 *   - EVIDENCE_SUFFICIENT → { verdict: "pass", exitCode: 0 }, zero judge
 *     spawns and zero reruns (even when config.command is set: runVerify spy
 *     stays at 0 calls);
 *   - EVIDENCE_CONTRADICTED → true-failure, handled by the existing
 *     true-failure path (trend allows continue / maxRounds stops it),
 *     record.verdict = "true-failure", no evidenceVerdict persisted;
 *   - EVIDENCE_INSUFFICIENT → falls through to the original
 *     produceObservation (judge / command mechanisms unchanged), record
 *     carries evidenceVerdict="EVIDENCE_INSUFFICIENT" + gamingSignals (Postel).
 *
 * messages fixture: claimIndex is the messages index of the last assistant
 * with non-empty text (same backward scan as deriveFinalText), not verify
 * round. GREEN_FIRST keeps bash at index 0 and the claim at index 1 so the
 * window still includes that run. Fixtures that pin "evidence must live in
 * messages[0]" as evidence-first semantics belong in claim-window.test.ts.
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

/* ------------------------------ test doubles ------------------------------ */

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

/** bash tool_use + tool_result pair (vitest green summary, exit 0, framework summary matched). */
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

/** bash tool_use + tool_result pair (vitest failure, exit 1, no green summary). */
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

/** Green bash (index 0) + assistant claim (index 1) → SUFFICIENT. */
const GREEN_FIRST_MESSAGES: AnthropicNativeMessage[] = [
  {
    role: "assistant",
    content: bashGreenBlocks("g01"),
  },
  { role: "assistant", content: [textBlock("implemented")] },
];

/** Judge-path probe success: write_file to pyproject.toml (a probe marker file)
 *  → probeVerifyCommand returns "pytest"; no bash test evidence → INSUFFICIENT +
 *  probe hit → rerun envelope triggered. pyproject.toml is not a test file →
 *  no CONTRADICTED, no gamingSignals. */
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

/** INSUFFICIENT + a run (exit≠0) + soft signal: bash fail + git commit --no-verify.
 *  The failed bash sits at messageIndex 0 (claim assistant later → counted in runs);
 *  hasContradiction=false (no rm/write_file clearing test files); computeVerdict
 *  lands INSUFFICIENT on exit 1; gamingSignals pass through via collectGamingSignals. */
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

/** CONTRADICTED: green bash (index 0) + write_file clearing a test file (any
 *  position) → hasContradiction binary hard veto. The checker reasons normalized
 *  signature buildFailureSignature({ exitCode: 1, outputText: "test files
 *  cleared or removed (binary contradiction)", countRegex: undefined }) → no
 *  FAIL lines → signature = "exit=1". */
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

/**
 * Content-gate signal: an inert non-doc source edit. Opens the upstream
 * verify gate (text-only stubs would now never enter verify) with zero
 * effect on checkEvidence verdict/reasons (still zero runs → the same
 * INSUFFICIENT reasons; not a probe flag file → rerun behavior unchanged).
 */
function gateSignalMessage(): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "gate-edit",
        name: "edit_file",
        input: { filePath: "src/app.ts" },
      },
    ],
  };
}

/** Deterministic run() stub return shape (same as verify-loop.test.ts). */
function stubRun(opts: {
  readonly text: string;
  readonly userText: string;
  readonly stopReason?: RunResult["stopReason"];
  readonly priorMessages?: ReadonlyArray<AnthropicNativeMessage>;
}): RunOutcome {
  const messages: AnthropicNativeMessage[] = [
    ...(opts.priorMessages ?? []),
    makeNative({ role: "user", text: opts.userText }),
    gateSignalMessage(),
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

/** Scripted runFn stub: returns script text call by call and records the
 *  history shape (prior length, last user text) of each invocation. */
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

/** A single RunOutcome with fixed messages (suits the single-round verify-loop). */
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

/** First call returns the fixed messages (including the evidence transcript);
 *  later calls continue from priorMessages. */
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

/** Judge JSON serialized into the result field of a status:"ok" envelope. */
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

/** runClassifier stub that spies on calls and returns scripted envelopes
 *  (same as classifier-loop). The spy also captures evidenceContext, the
 *  assertion surface for judge-input upgrades. */
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

/** Scripted runVerify stub: consumes handlers one by one and records command
 *  strings; throws once the script is exhausted. */
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

/* ------------------------------ evidence-first three-stage flow ------------------------------ */

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
    // Postel discipline: SUFFICIENT leaves evidenceVerdict / gamingSignals off
    // the record (only INSUFFICIENT persists them).
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
    // Round 1: CONTRADICTED → true-failure → trend lets it through (continue) →
    // envelope injected → runFn call 2 → stopReason=maxTurns → outcome "failed"
    // (a non-completed second round passes through verbatim and never enters the
    // evidence-first prefix).
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
    // Same shape as a true failure: the correction round gets the
    // [VALIDATION FAILED] envelope injected (call 1's lastUserText).
    assert.equal(
      calls()[1]!.lastUserText?.includes("[VALIDATION FAILED]"),
      true,
      "下一轮 runFn 携带失败信封"
    );
  });
});

/* ------------------------------ evidence-rerun envelope + 1-attempt cap ------------------------------ */

describe("evidence-first rerun (B5)", () => {
  const RERUN_INSTRUCTION =
    "Run the command and show the test framework's green-summary line; do not claim completion until verification passes.";

  /** runFn returning scripted message arrays call by call (records each call's
   *  priorMessages), for asserting the rerun round sequence. */
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
    // Judge path (command="") plus a probeable fixture (pyproject.toml → "pytest").
    // Call 0 (round 1) and call 1 (rerun round, round 2) both return PROBE_OK:
    // INSUFFICIENT both times → once the rerun cap is spent, defer to the judge
    // (runClassifier called once; exit 0 → pass).
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
    // Round 1: INSUFFICIENT + probe hit "pytest" → rerun envelope injected as the
    // last message, rerunAttempts=1.
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
    // Round 2 still INSUFFICIENT + cap spent → defer to judge (exactly 1 call, pass → passed).
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
    // Judge path (command="") + probeable fixture: round 1 PROBE_OK (INSUFFICIENT)
    // → rerun; round 2 green bash (SUFFICIENT) → PASS without triggering the
    // judge or a command rerun.
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
    // Round 1: a write_file to a non-marker path (src/foo.ts) → collectProbeFiles
    // hits 0 marker files → probeVerifyCommand returns null → no command →
    // skip the rerun and defer straight to the judge.
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
    // Judge path (command="") + probeable fixture: round 1 PROBE_OK
    // (INSUFFICIENT) → rerun envelope; round 2 CONTRADICTED → true-failure →
    // [VALIDATION FAILED] envelope; round 3 GREEN (SUFFICIENT) → PASS. Round 3's
    // priorMessages must filter the rerun envelope out (isInjectedEnvelope
    // extension) and keep only the [VALIDATION FAILED] one — the model must not
    // re-read stale rerun context that has already expired.
    const { runFn, priors } = scriptedRunFn([
      PROBE_OK_MESSAGES,
      CONTRADICTED_MESSAGES,
      GREEN_FIRST_MESSAGES,
    ]);
    // Scripted runVerify: every path in this case short-circuits (rerun /
    // CONTRADICTED / SUFFICIENT) and never reaches produceCommandObservation;
    // even an accidental hit returns exit 0 instead of really spawning.
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
    // Round 2's prior carries the rerun envelope (evidence handed to round 2).
    assert.equal(
      allText(priors()[1]!).includes("[VERIFY: rerun needed]"),
      true,
      "round 2 收到补跑信封 (供模型补证据)"
    );
    // Round 3's prior must filter the rerun envelope out, and its last message
    // must be the [VALIDATION FAILED] correction envelope.
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

/* ------------------------------ judge evidence-aware input + record trace ------------------------------ */

/**
 * Judge-input upgrade: the EvidenceContext health report enters the judge.
 *   - When INSUFFICIENT defers to the judge, the runClassifier spy receives an
 *     evidenceContext whose checkerVerdict === "EVIDENCE_INSUFFICIENT" and
 *     reasons is non-empty, and whose first task segment is userText verbatim
 *     (the task is not re-bound);
 *   - record.evidenceVerdict === "EVIDENCE_INSUFFICIENT" lands in the trace
 *     (CapturingTrace mirrors the makeCapturingTrace pattern in
 *     verify-loop.test.ts).
 *
 * Fixture: messages contain only user + assistant text, no bash → checkEvidence
 * says INSUFFICIENT and no command is probeable → defer straight to the judge
 * (the rerun cap never triggers).
 */
describe("evidence-aware judge input + record trace (#449b B6)", () => {
  /** Capturing TraceService mirroring makeCapturingTrace in verify-loop.test.ts
   *  (persists recordVerification, no-ops everything else). */
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
    // Judge path (command="") + no bash and nothing probeable → INSUFFICIENT →
    // defer straight to the judge.
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
    // bash failure (INSUFFICIENT_WITH_SIGNAL_MESSAGES) + nothing probeable →
    // defer straight to the judge.
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
    // defaultOptions is a local helper whose older signature takes no trace;
    // this case builds options directly.
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
    // Judge path (command="") + probeable fixture (pyproject.toml → pytest):
    // round 1 INSUFFICIENT + probe hit → rerun; round 2 still INSUFFICIENT with
    // the cap spent → defer to the judge. The evidenceContext the spy receives
    // has rerunAttempted=true, derived by scanning messages for the
    // [VERIFY: rerun needed] prefix.
    // makeEvidenceRunFn: later rounds' messages = prior (rerun envelope included)
    // + user + assistant, mimicking how production run() folds priorMessages
    // into the next turn's history.
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

/* ------------------------------ judge four-state stop (unverified/abort/pass) ------------------------------ */

/**
 * runClassifierOnce four-state mapping + how unverified/abort stop the loop.
 *   - judge unverified → { verdict: "unstable", signature: "classifier-unverified",
 *     reason: "unverified" } → decideRoundAction stop → outcome=unstable,
 *     zero envelope injection (runFn exactly 1 call, no round 2);
 *   - judge abort (schema downgrade) / transport error → { verdict: "unstable",
 *     signature: "classifier-abort" / "classifier-transport-error",
 *     reason: "abort" } → outcome=unstable, zero envelope injection (the
 *     persisted reason distinguishes abort from unverified);
 *   - judge pass → outcome=passed + no reason (Postel: pass never persists one).
 *
 * Fixture: judge path (command="") + text-only, no bash and nothing probeable
 * → INSUFFICIENT defers straight to the judge, no rerun envelope
 * (probeVerifyCommand([]) = null).
 */
describe("judge four-state stop behavior (#449b B7)", () => {
  /** Text-only judge-path runFn: every call returns completed (records priorMessages). */
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
    // Zero envelope injection: unstable takes the stop path, so
    // buildFailureEnvelope is never built (decideRoundAction only calls it on
    // continue); runFn called exactly once = no round 2. With no priorMessages
    // on the first round, lastUserText is undefined (nothing injected);
    // normalize with ?? "" before asserting the absence of envelope text.
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
    // The final message history carries no envelope either (the unstable stop
    // injects nothing, same assertion surface as classifier-loop.test.ts).
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
    // unverified is a judge state, not a checker state: evidenceVerdict reflects
    // the upstream checkEvidence verdict (the judge is only ever called on the
    // INSUFFICIENT branch). The two are distinct fields that coexist on the
    // record — judge reason=unverified and checker
    // evidenceVerdict=INSUFFICIENT never overwrite each other.
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

/* ------------------------------ read-only judge + abort during rerun + command-path freeze ------------------------------ */

/**
 * Closing integration tests for the three-stage flow:
 *   - Read-only judge re-asserted at the integration layer: runVerifyLoop →
 *     createRunClassifierFromManager → stubManager captures the spawn def — the
 *     declaration surface (derived disallowedTools / zero evidenceContext
 *     leakage into systemPrompt) survives intact under the real assembly path,
 *     and task === userText (evidenceContext is never concatenated into
 *     def.task);
 *   - abort during a rerun: round 1 INSUFFICIENT + probe hit → the rerun
 *     branch's 2nd runFn call hangs → user aborts → the checkpoint at the top of
 *     the while loop converges to outcome=aborted with zero fabricated records
 *     (the rerun round never produced an observation), runFn called exactly
 *     twice (no stale third round);
 *   - command-path freeze re-stated: SUFFICIENT + a configured config.command →
 *     runVerify spy 0 + runClassifier spy 0 + outcome passed (one entry-level
 *     case guarding the existing short-circuit against regressions).
 */

/**
 * Truth of the judge allow-list derivation (same source and formula as
 * judge-input.test.ts).
 *
 * The judge whitelist baseline = {read_file, grep, glob}: the judge may only
 * use local, purely read-only tools. fail-closed: deny = full toolset −
 * whitelist. Widening the whitelist means explicitly editing the whitelist
 * constant plus operator sign-off; runtime configuration is not accepted.
 */
const JUDGE_ALLOWED_BASELINE: ReadonlyArray<string> = Object.freeze([
  "read_file",
  "grep",
  "glob",
]);

/** Mirror = ACI_TOOLSET_NAMES − whitelist baseline (same derivation formula as run-classifier-adapter). */
const JUDGE_DISALLOWED_TOOLS: ReadonlyArray<string> = Object.freeze(
  [...ACI_TOOLSET_NAMES].filter((n) => !JUDGE_ALLOWED_BASELINE.includes(n))
);

describe("SC9 只读判官集成层复断言 (#449b B9)", () => {
  /** Mirror of the judge-input.test.ts stub manager: spawn captures the def, waitFor returns a pass envelope. */
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
      // The interface gained a read-only enumeration surface; the fake
      // implements it to stay structurally compatible.
      listSubagents() {
        return [];
      },
      getCapacity() {
        return 15;
      },
      subscribe() {
        return () => {};
      },
    };
    return { manager, captured: () => captured };
  }

  it("INSUFFICIENT 落判官: def 声明面完整保留 + task 二段 (SC9 集成层复断言)", async () => {
    // Judge path (command="") + text-only (no bash, nothing probeable) →
    // INSUFFICIENT defers straight to the judge.
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
    // Re-assertion: declared disallowedTools = full toolset − whitelist
    // baseline (allow-list derivation). Enforcing the real tool surface is the
    // worker's deny-list pruning job; this case only re-asserts that the
    // declaration surface survives intact.
    assert.ok(
      def.disallowedTools !== undefined,
      "JUDGE_ROLE 必须声明 disallowedTools"
    );
    assert.deepEqual(
      [...def.disallowedTools].sort(),
      [...JUDGE_DISALLOWED_TOOLS].sort(),
      "disallowedTools = ACI_TOOLSET_NAMES − JUDGE_ALLOWED_BASELINE (allow-list 推导)"
    );
    // The three whitelisted tools must be absent (the judge may use them) —
    // the guardrail of the fail-closed derivation.
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
    // Zero evidenceContext leakage into systemPrompt (declaration surface unchanged).
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
        // The rerun round (rerun branch's 2nd runFn call) hangs, waiting for
        // the user's abort signal (mirrors the in-flight hang pattern of
        // classifier-abort.test.ts).
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
    // Judge path (command="" + the presence of runClassifier selects the
    // classifier-loop body, where the rerun envelope lives inside
    // runVerifyLoopBody); aborting while the rerun round is in flight means the
    // judge seam is never consumed (the abort arrives before round 2's
    // produceObservation), so the spy's script stays unconsumed.
    const { runClassifier } = makeClassifierSpy([]);
    // defaultOptions does not accept signal, so options are built directly
    // (same style as the trace case above).
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
    // Entry-level re-run of an existing mechanism: sufficient evidence
    // short-circuits to zero reruns even with command configured. Asserting both
    // spies at 0 in one place guards the supervisor-path wiring
    // (.command-./.classifier-.) against regressions. The command and judge
    // paths each already have spy-0 coverage elsewhere; this case only
    // re-asserts the joint at the-loop entry.
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
