/**
 * verify-claim-window T1 — claim window is a messages index, not verify round.
 * SC1 / SC5 / SC6 (three-stage-flow B4 comment is updated separately).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  runVerifyLoop,
  type RunClassifierFn,
  type RunOutcome,
  type RunVerifyFn,
  type VerifyLoopOptions,
} from "../../../src/harness/verify/verify-loop.ts";
import { checkEvidence } from "../../../src/harness/verify/evidence-checker.ts";
import { deriveClaimIndex } from "../../../src/harness/last-nonempty-assistant.ts";
import type { VerifyConfig } from "../../../src/harness/verify/types.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  RunResult,
} from "../../../src/harness/model-adapter/types.ts";
import type { LoopTrace } from "../../../src/harness/loop-trace.ts";
import { textBlock, toolUse } from "./evidence-checker/_fixtures.js";

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

/** Green vitest at messages[2]; claim assistant later. First-round verify is still round===1. */
const GREEN_AT_INDEX_2: AnthropicNativeMessage[] = [
  { role: "user", content: [textBlock("implement the feature")] },
  { role: "assistant", content: [textBlock("starting")] },
  { role: "assistant", content: bashGreenBlocks("g-sc1") },
  { role: "assistant", content: [textBlock("implemented")] },
];

/** Green bash at [0] but no assistant with non-empty text (claim point missing). */
const NO_NONEMPTY_ASSISTANT: AnthropicNativeMessage[] = [
  { role: "assistant", content: bashGreenBlocks("g-sc5") },
  { role: "assistant", content: [textBlock("   ")] },
];

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

function makeEvidenceRunFn(firstMessages: AnthropicNativeMessage[]): {
  readonly runFn: VerifyLoopOptions["runFn"];
} {
  const runFn: VerifyLoopOptions["runFn"] = async () =>
    makeSingleOutcome(firstMessages);
  return { runFn };
}

function makeClassifierSpy(): {
  readonly runClassifier: RunClassifierFn;
  readonly callCount: () => number;
} {
  let n = 0;
  const runClassifier: RunClassifierFn = async () => {
    n += 1;
    return {
      status: "ok",
      result: JSON.stringify({
        kind: "pass",
        reason: "should not decide the window",
        evidence: [{ command: "noop", result: "pass" }],
      }),
      summary: "judge done",
    };
  };
  return { runClassifier, callCount: () => n };
}

function makeScriptedVerify(): {
  readonly runVerify: RunVerifyFn;
  readonly callCount: () => number;
} {
  let n = 0;
  const runVerify: RunVerifyFn = async () => {
    n += 1;
    return { exitCode: 0, stdout: "should not run", stderr: "" };
  };
  return { runVerify, callCount: () => n };
}

function defaultOptions(over: {
  readonly runFn: VerifyLoopOptions["runFn"];
  readonly config?: Partial<VerifyConfig>;
  readonly runVerify?: VerifyLoopOptions["runVerify"];
  readonly runClassifier?: RunClassifierFn;
}): VerifyLoopOptions {
  return {
    runFn: over.runFn,
    userText: "implement goal",
    config: { command: "npm test", ...over.config },
    sessionId: "claim-window",
    ...(over.runVerify !== undefined ? { runVerify: over.runVerify } : {}),
    ...(over.runClassifier !== undefined
      ? { runClassifier: over.runClassifier }
      : {}),
    cwd: process.cwd(),
  };
}

describe("claim window coordinates (SC1 / SC5)", () => {
  it("SC1: green at messages[2] + later claim + round===1 → SUFFICIENT via loop", async () => {
    assert.equal(deriveClaimIndex(GREEN_AT_INDEX_2), 3);
    const { runFn } = makeEvidenceRunFn(GREEN_AT_INDEX_2);
    const { runClassifier, callCount: classifierCalls } = makeClassifierSpy();
    const verify = makeScriptedVerify();
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        runVerify: verify.runVerify,
      })
    );
    assert.equal(out.records[0]!.round, 1, "round still records verify cycle");
    assert.equal(out.outcome, "passed");
    assert.equal(out.records[0]!.verdict, "pass");
    assert.equal(
      out.records[0]!.evidenceVerdict,
      undefined,
      "SUFFICIENT does not persist evidenceVerdict"
    );
    assert.equal(classifierCalls(), 0, "SUFFICIENT skips judge");
    assert.equal(verify.callCount(), 0, "SUFFICIENT skips command rerun");
  });

  it("SC1 regression: same fixture with claimIndex:1 is not SUFFICIENT", () => {
    const report = checkEvidence({
      messages: GREEN_AT_INDEX_2,
      claimIndex: 1,
    });
    assert.notEqual(report.verdict, "EVIDENCE_SUFFICIENT");
  });

  it("SC5: no non-empty-text assistant → INSUFFICIENT (fail-closed)", async () => {
    assert.equal(deriveClaimIndex(NO_NONEMPTY_ASSISTANT), -1);
    const { runFn } = makeEvidenceRunFn(NO_NONEMPTY_ASSISTANT);
    const { runClassifier, callCount: classifierCalls } = makeClassifierSpy();
    const verify = makeScriptedVerify();
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        runVerify: verify.runVerify,
      })
    );
    assert.equal(out.records[0]!.evidenceVerdict, "EVIDENCE_INSUFFICIENT");
    assert.equal(
      classifierCalls(),
      0,
      "command path: INSUFFICIENT falls through to runVerify, not judge"
    );
    assert.equal(
      verify.callCount(),
      1,
      "INSUFFICIENT uses command observation"
    );
  });
});
