/**
 * Plan T1: HITL completion module skips the completion-facing LLM judge.
 * Checker still runs (SUFFICIENT / CONTRADICTED / rerun); produceObservation
 * does not spawn. Named EXIT reason, no new StopReason.
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
import { REASON_HITL_SKIP_COMPLETION_JUDGE } from "../../../src/harness/verify/types.ts";
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

const GREETING_MESSAGES: AnthropicNativeMessage[] = [
  { role: "assistant", content: [textBlock("你好")] },
];

const GREEN_FIRST_MESSAGES: AnthropicNativeMessage[] = [
  { role: "assistant", content: bashGreenBlocks("g01") },
  { role: "assistant", content: [textBlock("implemented")] },
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

function makeEvidenceRunFn(
  firstMessages: AnthropicNativeMessage[],
  opts: {
    readonly stopReasonFor?: (call: number) => RunResult["stopReason"];
  } = {}
): {
  readonly runFn: VerifyLoopOptions["runFn"];
  readonly calls: () => ReadonlyArray<{
    readonly lastUserText: string | undefined;
  }>;
} {
  const calls: Array<{ lastUserText: string | undefined }> = [];
  const runFn: VerifyLoopOptions["runFn"] = async (userText, runOpts) => {
    const prior = runOpts?.priorMessages ?? [];
    const lastUserMsg = [...prior].reverse().find((m) => m.role === "user");
    const lastUserText = lastUserMsg
      ? lastUserMsg.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
      : undefined;
    const call = calls.length;
    calls.push({ lastUserText });
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
  return { runFn, calls: () => calls };
}

function makeClassifierSpy(script: ReadonlyArray<ClassifierEnvelope>): {
  readonly runClassifier: RunClassifierFn;
  readonly calls: () => ReadonlyArray<unknown>;
} {
  const calls: unknown[] = [];
  let i = 0;
  const runClassifier: RunClassifierFn = async (args) => {
    calls.push(args);
    const next = script[i];
    if (next === undefined) {
      throw new Error(`classifier script exhausted at call ${i}`);
    }
    i += 1;
    return next;
  };
  return { runClassifier, calls: () => calls };
}

function hitlOptions(over: {
  readonly runFn: VerifyLoopOptions["runFn"];
  readonly runClassifier: RunClassifierFn;
}): VerifyLoopOptions {
  return {
    runFn: over.runFn,
    userText: "你好",
    config: { command: "" },
    sessionId: "hitl",
    runClassifier: over.runClassifier,
    completionMode: "hitl",
    cwd: process.cwd(),
  };
}

describe("HITL completion module (plan T1)", () => {
  it("greeting completed + INSUFFICIENT: spawn = 0, named skip EXIT, StopReason stays completed", async () => {
    const { runFn } = makeEvidenceRunFn(GREETING_MESSAGES);
    const { runClassifier, calls } = makeClassifierSpy([
      {
        status: "ok",
        result: JSON.stringify({
          kind: "pass",
          reason: "should never spawn",
          evidence: [],
        }),
        summary: "no",
      },
    ]);
    const out = await runVerifyLoop(hitlOptions({ runFn, runClassifier }));
    assert.equal(
      calls().length,
      0,
      "HITL greeting must not spawn completion judge"
    );
    assert.equal(out.outcome, "passed");
    assert.equal(out.result.stopReason, "completed");
    assert.equal(out.records[0]?.reason, REASON_HITL_SKIP_COMPLETION_JUDGE);
  });

  it("HITL + SUFFICIENT: still no spawn", async () => {
    const { runFn } = makeEvidenceRunFn(GREEN_FIRST_MESSAGES);
    const { runClassifier, calls } = makeClassifierSpy([
      {
        status: "ok",
        result: JSON.stringify({
          kind: "pass",
          reason: "should never spawn",
          evidence: [],
        }),
        summary: "no",
      },
    ]);
    const out = await runVerifyLoop(hitlOptions({ runFn, runClassifier }));
    assert.equal(calls().length, 0);
    assert.equal(out.outcome, "passed");
    assert.equal(out.result.stopReason, "completed");
  });

  it("HITL hard fail: inject envelope to main model, spawn = 0", async () => {
    const { runFn, calls: runCalls } = makeEvidenceRunFn(
      CONTRADICTED_MESSAGES,
      {
        stopReasonFor: (call) => (call === 0 ? "completed" : "maxTurns"),
      }
    );
    const { runClassifier, calls } = makeClassifierSpy([
      {
        status: "ok",
        result: JSON.stringify({
          kind: "pass",
          reason: "should never spawn",
          evidence: [],
        }),
        summary: "no",
      },
    ]);
    const out = await runVerifyLoop(hitlOptions({ runFn, runClassifier }));
    assert.equal(
      calls().length,
      0,
      "hard fail must not spawn completion judge"
    );
    assert.equal(out.records[0]?.verdict, "true-failure");
    assert.equal(
      runCalls()[1]?.lastUserText?.includes("[VALIDATION FAILED]"),
      true,
      "next runFn must receive failure envelope"
    );
  });
});
