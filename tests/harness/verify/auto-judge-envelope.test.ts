/**
 * Plan T2: auto-mode judge envelope — task is goal.text only; SUFFICIENT still
 * spawns; CONTRADICTED still does not; omitted completionMode keeps SUFFICIENT skip.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  runVerifyLoop,
  type ClassifierEnvelope,
  type RunClassifierFn,
  type RunOutcome,
  type VerifyLoopOptions,
} from "../../../src/harness/verify/verify-loop.ts";
import type { EvidenceContext } from "../../../src/harness/verify/types.ts";
import type { LoopTrace } from "../../../src/harness/loop-trace.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  RunResult,
} from "../../../src/harness/model-adapter/types.ts";
import { textBlock, toolUse, writeFile } from "./evidence-checker/_fixtures.js";

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
const GOAL_TEXT = "ship the verify goal gate";
const DISTINCT_FINAL = "DISTINCT_FINAL_TEXT_NOT_IN_TASK";

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

const GREEN_FIRST_MESSAGES: AnthropicNativeMessage[] = [
  { role: "assistant", content: bashGreenBlocks("g01") },
  { role: "assistant", content: [textBlock("implemented")] },
];

const TEXT_ONLY_MESSAGES: AnthropicNativeMessage[] = [
  { role: "assistant", content: [textBlock("implemented but no tests")] },
];

const CONTRADICTED_MESSAGES: AnthropicNativeMessage[] = [
  { role: "assistant", content: bashGreenBlocks("g02") },
  {
    role: "assistant",
    content: [writeFile("w02", "src/foo.test.ts", "")],
  },
  { role: "assistant", content: [textBlock("implemented")] },
];

function makeSingleOutcome(
  messages: AnthropicNativeMessage[],
  stopReason: RunResult["stopReason"] = "completed",
  finalText: string | null = DISTINCT_FINAL
): RunOutcome {
  return {
    result: {
      finalText: stopReason === "completed" ? finalText : null,
      messages: [...messages],
      turnCount: 1,
      stopReason,
      lastUsage: null,
    },
    trace: EMPTY_TRACE,
  };
}

function makeEvidenceRunFn(
  firstMessages: AnthropicNativeMessage[],
  opts: {
    readonly stopReasonFor?: (call: number) => RunResult["stopReason"];
  } = {}
): VerifyLoopOptions["runFn"] {
  const runFn: VerifyLoopOptions["runFn"] = async (userText, runOpts) => {
    const prior = runOpts?.priorMessages ?? [];
    const call = prior.length === 0 ? 0 : 1;
    const stopReason = opts.stopReasonFor?.(call) ?? "completed";
    const messages =
      call === 0
        ? [...firstMessages]
        : [
            ...prior,
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: userText }],
            },
            {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: "implemented" }],
            },
          ];
    return makeSingleOutcome(messages, stopReason);
  };
  return runFn;
}

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

function passEnvelope(): ClassifierEnvelope {
  return {
    status: "ok",
    result: JSON.stringify({
      kind: "pass",
      reason: "goal met",
      evidence: [{ command: "noop", result: "pass" }],
    }),
    summary: "ok",
  };
}

function autoOptions(over: {
  readonly runFn: VerifyLoopOptions["runFn"];
  readonly runClassifier: RunClassifierFn;
  readonly userText?: string;
}): VerifyLoopOptions {
  return {
    runFn: over.runFn,
    userText: over.userText ?? GOAL_TEXT,
    config: { command: "" },
    sessionId: "auto",
    runClassifier: over.runClassifier,
    completionMode: "auto",
    cwd: process.cwd(),
  };
}

describe("auto completion module judge envelope (plan T2)", () => {
  it("auto + completed + SUFFICIENT: spawn >= 1", async () => {
    const runFn = makeEvidenceRunFn(GREEN_FIRST_MESSAGES);
    const { runClassifier, calls } = makeClassifierSpy([passEnvelope()]);
    const out = await runVerifyLoop(autoOptions({ runFn, runClassifier }));
    assert.ok(calls().length >= 1, "auto SUFFICIENT must still spawn judge");
    assert.equal(out.outcome, "passed");
    assert.equal(out.result.stopReason, "completed");
  });

  it("auto + CONTRADICTED: spawn = 0 (hard fail inherits T1)", async () => {
    const runFn = makeEvidenceRunFn(CONTRADICTED_MESSAGES, {
      stopReasonFor: (call) => (call === 0 ? "completed" : "maxTurns"),
    });
    const { runClassifier, calls } = makeClassifierSpy([passEnvelope()]);
    const out = await runVerifyLoop(autoOptions({ runFn, runClassifier }));
    assert.equal(calls().length, 0, "hard fail must not spawn judge");
    assert.equal(out.records[0]?.verdict, "true-failure");
  });

  it("omitted completionMode + SUFFICIENT: still skip judge (legacy)", async () => {
    const runFn = makeEvidenceRunFn(GREEN_FIRST_MESSAGES);
    const { runClassifier, calls } = makeClassifierSpy([passEnvelope()]);
    const out = await runVerifyLoop({
      runFn,
      userText: GOAL_TEXT,
      config: { command: "" },
      sessionId: "omit",
      runClassifier,
      cwd: process.cwd(),
    });
    assert.equal(
      calls().length,
      0,
      "omitted mode keeps SUFFICIENT short-circuit"
    );
    assert.equal(out.outcome, "passed");
  });

  it("auto: task === goal.text, no evidence JSON, finalText stays independent", async () => {
    const runFn = makeEvidenceRunFn(TEXT_ONLY_MESSAGES);
    const { runClassifier, calls } = makeClassifierSpy([passEnvelope()]);
    await runVerifyLoop(autoOptions({ runFn, runClassifier }));
    assert.equal(calls().length, 1);
    const call = calls()[0]!;
    assert.equal(
      call.task,
      GOAL_TEXT,
      "task must equal host userText / goal.text"
    );
    assert.equal(call.task.includes("{"), false, "task must not contain JSON");
    assert.ok(
      !call.task.includes("checkerVerdict"),
      "task must not contain evidenceContext keys"
    );
    assert.ok(
      !call.task.includes(DISTINCT_FINAL),
      "finalText must not be concatenated into task"
    );
    assert.equal(call.finalText, DISTINCT_FINAL);
    assert.ok(
      call.evidenceContext !== undefined,
      "evidenceContext remains a separate RunClassifierFn argument"
    );
    assert.equal(
      JSON.stringify(call.evidenceContext).includes("checkerVerdict"),
      true
    );
  });
});
