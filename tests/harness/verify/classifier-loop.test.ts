/**
 * Verify classifier — integration test for the command-absent branch of verify-loop.
 *
 * Contract under test:
 *   - command absent → classifier spawns; command configured → classifier never
 *     spawns (the command path is exclusive);
 *   - only StopReason=completed triggers it; maxTurns / cancelled / timeout /
 *     protocolError / emptyFinalResponse pass through untouched;
 *   - abort / transport error / schema error → outcome=unstable (fail-open);
 *     a true classifier fail → inject a failure envelope and continue;
 *   - the maxRounds backstop still applies on the classifier path.
 *
 * DI seam: runClassifier is injected alongside VerifyLoopOptions.runVerify and
 * returns fixed ClassifierEnvelopes. Production assembly (build-engine side)
 * adapts SubAgentManager to the seam — process isolation is the seam
 * implementation's job; verify-loop only orchestrates. These tests pin the
 * orchestration contract, not the envelope text.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  runVerifyLoop,
  type ClassifierEnvelope,
  type RunClassifierFn,
  type VerifyLoopOptions,
  type VerifyLoopOutcome,
} from "../../../src/harness/verify/verify-loop.ts";
import type {
  VerifyConfig,
  VerificationRecord,
} from "../../../src/harness/verify/types.ts";
import type {
  AnthropicNativeMessage,
  RunResult,
} from "../../../src/harness/model-adapter/types.ts";
import type { LoopTrace } from "../../../src/harness/loop-trace.ts";
import type { TraceService } from "../../../src/harness/trace/types.ts";

/* ------------------------------ test fixtures ------------------------------ */

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

/**
 * Content-gate signal: an inert non-doc source edit. Opens the upstream
 * verify gate (the judge-path stubs were pure text, which now never enters
 * verify) with zero effect on checkEvidence — still no runs, same
 * INSUFFICIENT reasons, no probe files, no gaming signals.
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

/** stubRun: deterministic run() stub return shape (same as verify-loop.test.ts). */
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

function makeNative(opts: {
  readonly role: "user" | "assistant";
  readonly text: string;
}): AnthropicNativeMessage {
  return { role: opts.role, content: [{ type: "text", text: opts.text }] };
}

/** Shape returned by the delegated run() (structurally identical to RunOutcome in verify-loop.ts). */
interface RunOutcome {
  readonly result: RunResult;
  readonly trace: LoopTrace;
}

interface RecordedCall {
  readonly userText: string;
  readonly priorCount: number;
  readonly lastUserText: string | undefined;
}

/** Scripted runFn stub: returns script text call by call and records each call's history shape. */
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

/** Serializes the judge JSON into the result field of a status:"ok" envelope. */
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

function failEnvelope(reason: string, missing: string[]): ClassifierEnvelope {
  return okEnvelope({
    kind: "fail",
    reason,
    missing,
    evidence: [{ command: "noop", result: "fail" }],
  });
}

function abortEnvelope(reason: string): ClassifierEnvelope {
  return okEnvelope({ kind: "abort", reason });
}

/** runClassifier stub that spies on calls and returns the scripted envelopes. */
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
  readonly signal?: AbortSignal;
  readonly maxRounds?: number;
  readonly userText?: string;
  readonly cwd?: string;
}): VerifyLoopOptions {
  return {
    runFn: over.runFn,
    userText: over.userText ?? "implement goal",
    config: { command: "", ...over.config },
    sessionId: over.sessionId ?? "sess-classifier",
    ...(over.signal !== undefined ? { signal: over.signal } : {}),
    runClassifier: over.runClassifier,
    cwd: over.cwd ?? process.cwd(),
  };
}

/* ------------------------------ command-absent → spawn classifier ------------------------------ */

describe("SC1: command 缺失 → spawn 分类器（A1 填空）", () => {
  it("只调一次 runFn + 一次 classifier，classification=pass → outcome=passed", async () => {
    const { runFn, calls: runFnCalls } = makeRecordingRunFn(["done"]);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("all evidence present"),
    ]);

    const out = await runVerifyLoop(defaultOptions({ runFn, runClassifier }));

    assert.equal(runFnCalls().length, 1, "classifier 路径只跑一次 runFn");
    assert.equal(classifierCalls().length, 1, "分类器被 spawn 一次");
    assert.equal(classifierCalls()[0]?.task, "implement goal");
    assert.equal(classifierCalls()[0]?.finalText, "done");
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 1);
    assert.equal(out.enabled, true, "command 缺失 + 分类器装配 = 启用");
    assert.notEqual(out.outcome as VerifyLoopOutcome, "disabled");
  });

  it("command 已配 → 分类器 NOT spawned（SC1 反向断言）", async () => {
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
      sessionId: "sess-command-present",
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
      "command 已配时分类器绝不触发（A1 路径 X 独占）"
    );
    assert.equal(out.outcome, "passed");
    assert.equal(out.enabled, true);
  });
});

/* ------------------------------ only completed triggers the classifier ------------------------------ */

describe("SC6: 仅 StopReason=completed 触发分类器（A6 completed-only）", () => {
  const cases: ReadonlyArray<{
    readonly stop: RunResult["stopReason"];
    readonly outcome: VerifyLoopOutcome;
  }> = [
    { stop: "maxTurns", outcome: "failed" },
    { stop: "cancelled", outcome: "aborted" },
    { stop: "timeout", outcome: "failed" },
    { stop: "protocolError", outcome: "failed" },
    { stop: "emptyFinalResponse", outcome: "failed" },
  ];

  for (const c of cases) {
    it(`${c.stop} → 分类器 NOT spawned, 原样透传`, async () => {
      const { runFn } = makeRecordingRunFn(["x"], {
        stopReasonFor: () => c.stop,
      });
      const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
        passEnvelope("should not be called"),
      ]);

      const out = await runVerifyLoop(defaultOptions({ runFn, runClassifier }));

      assert.equal(
        classifierCalls().length,
        0,
        `${c.stop} 不触发分类器（A6 completed-only）`
      );
      assert.equal(out.outcome, c.outcome);
      assert.equal(out.rounds, 0);
      assert.equal(out.records.length, 0);
      assert.equal(out.result.stopReason, c.stop);
    });
  }
});

/* ------------------------------ abort/transport/schema → unstable ------------------------------ */

describe("SC5: abort / transport / schema 错 → outcome=unstable（fail-open）", () => {
  it("classifier abort → outcome=unstable, 不注入信封, 不继续", async () => {
    const { runFn } = makeRecordingRunFn(["done"]);
    const { runClassifier } = makeClassifierSpy([
      abortEnvelope("判官跑完了但判不了"),
    ]);

    const out = await runVerifyLoop(defaultOptions({ runFn, runClassifier }));

    assert.equal(out.outcome, "unstable");
    assert.equal(out.rounds, 1);
    // abort means the judge ran but could not decide: no failure envelope injected.
    const envUser = out.result.messages.filter(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (b) => b.type === "text" && b.text.includes("[VALIDATION FAILED]")
        )
    );
    assert.equal(envUser.length, 0, "abort 不注入信封");
  });

  it("transport 错 (status=failed reason=crashed) → unstable（fail-open）", async () => {
    const { runFn } = makeRecordingRunFn(["done"]);
    const { runClassifier } = makeClassifierSpy([
      {
        status: "failed",
        reason: "crashed",
        summary: "worker died",
        result: "",
      },
    ]);

    const out = await runVerifyLoop(defaultOptions({ runFn, runClassifier }));

    assert.equal(out.outcome, "unstable");
    assert.equal(out.rounds, 1);
    const envUser = out.result.messages.filter(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (b) => b.type === "text" && b.text.includes("[VALIDATION FAILED]")
        )
    );
    assert.equal(envUser.length, 0, "transport 错不注入信封（fail-open）");
  });

  it("transport 错 (status=failed reason=protocolError) → unstable", async () => {
    const { runFn } = makeRecordingRunFn(["done"]);
    const { runClassifier } = makeClassifierSpy([
      {
        status: "failed",
        reason: "protocolError",
        summary: "envelope protocol error",
        result: "",
      },
    ]);

    const out = await runVerifyLoop(defaultOptions({ runFn, runClassifier }));

    assert.equal(out.outcome, "unstable");
    assert.equal(out.rounds, 1);
  });

  it("schema 错 (status=ok 但 result 非判官 JSON) → unstable（fail-open）", async () => {
    const { runFn } = makeRecordingRunFn(["done"]);
    const { runClassifier } = makeClassifierSpy([
      { status: "ok", result: "not-json-at-all", summary: "judge done" },
    ]);

    const out = await runVerifyLoop(defaultOptions({ runFn, runClassifier }));

    assert.equal(out.outcome, "unstable");
    assert.equal(out.rounds, 1);
  });

  it("runClassifier throw (seam 层 transport 错) → unstable", async () => {
    const { runFn } = makeRecordingRunFn(["done"]);
    const runClassifier: RunClassifierFn = async () => {
      throw new Error("subagent transport failure");
    };

    const out = await runVerifyLoop(defaultOptions({ runFn, runClassifier }));

    assert.equal(out.outcome, "unstable");
    assert.equal(out.rounds, 1);
  });

  it("分类器在飞时用户 abort → outcome=aborted（in-flight closeout, 不判 unstable）", async () => {
    const controller = new AbortController();
    const { runFn } = makeRecordingRunFn(["done"]);
    let resolveSpawnStarted!: () => void;
    const spawnStarted = new Promise<void>((resolve) => {
      resolveSpawnStarted = resolve;
    });
    const runClassifier: RunClassifierFn = async (args) => {
      resolveSpawnStarted();
      // suspends until the user aborts (the seam is waiting for the worker reply).
      await new Promise<void>((resolve) => {
        if (args.signal?.aborted) {
          resolve();
          return;
        }
        args.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      // when the user aborts, the worker is killed → the seam rejects with AbortError.
      throw new Error("AbortError: subagent aborted");
    };

    const promise = runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        signal: controller.signal,
      })
    );
    await spawnStarted;
    controller.abort();
    const out = await promise;

    assert.equal(
      out.outcome,
      "aborted",
      "在飞 abort 必须判 aborted 而非 unstable"
    );
    assert.equal(out.rounds, 1);
    // in-flight closeout: no stale injected envelope left behind.
    const envUser = out.result.messages.filter(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (b) => b.type === "text" && b.text.includes("[VALIDATION FAILED]")
        )
    );
    assert.equal(envUser.length, 0, "closeout 不注入失败信封");
  });
});

/* ------------------------------ true classifier fail → inject + continue ------------------------------ */

describe("A5: true classifier fail → 注入失败信封 + 继续下一轮", () => {
  it("fail → 第二轮 runFn 携带注入的信封重跑, 第二轮 classifier pass → outcome=passed", async () => {
    const { runFn, calls: runFnCalls } = makeRecordingRunFn(["v1", "v2"]);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      failEnvelope("missing deploy step", ["deploy to staging"]),
      passEnvelope("evidence present now"),
    ]);

    const out = await runVerifyLoop(defaultOptions({ runFn, runClassifier }));

    assert.equal(
      runFnCalls().length,
      2,
      "fail 后注入信封 → 下一轮再跑一次 runFn"
    );
    assert.equal(classifierCalls().length, 2, "每轮各 spawn 一次分类器");
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 2);
    // round 2's runFn receives priorMessages (the injected envelope); round 1 has none.
    assert.equal(
      runFnCalls()[0]?.priorCount,
      0,
      "首轮 runFn 不带 priorMessages"
    );
    assert.ok(
      (runFnCalls()[1]?.priorCount ?? 0) > 0,
      "第二轮 runFn 必携带注入信封 (A5 注入继续)"
    );
    // The envelope is buildClassifierEnvelope's fixed-shape output: fixed marker +
    // source=classifier + task + missing[] + reason + fixed trailer.
    const envelope = runFnCalls()[1]?.lastUserText ?? "";
    assert.ok(
      envelope.includes("[VALIDATION FAILED]"),
      "信封含固定验证失败标记"
    );
    assert.ok(
      envelope.includes("verdict=true-failure source=classifier"),
      "信封标注来源 = classifier (区别于命令路径)"
    );
    assert.ok(envelope.includes("task: implement goal"), "信封含 task 字段");
    assert.ok(
      envelope.includes('missing: ["deploy to staging"]'),
      "信封含判官列出的 missing[]"
    );
    assert.ok(
      envelope.includes("reason: missing deploy step"),
      "信封含判官一句话立论"
    );
    assert.ok(
      envelope.includes(
        "Fix the failures above. Do not claim completion until validation passes."
      ),
      "信封含固定修正指令尾行"
    );
  });

  it("fail 后再次 fail → maxRounds 截停, outcome=failed", async () => {
    const { runFn } = makeRecordingRunFn(["v1", "v2", "v3"]);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      failEnvelope("missing deploy", ["deploy"]),
      failEnvelope("missing deploy", ["deploy"]),
    ]);

    const out = await runVerifyLoop(
      defaultOptions({ runFn, runClassifier, maxRounds: 2 })
    );

    assert.equal(out.outcome, "failed");
    assert.equal(out.rounds, 2);
    assert.equal(
      classifierCalls().length,
      2,
      "maxRounds 截停后不再 spawn 分类器"
    );
  });
});

/* ------------------------------ maxRounds backstop ------------------------------ */

describe("maxRounds 兜底在分类器路径下仍生效", () => {
  it("maxRounds=2 + classifier 全 fail → outcome=failed, 轮数=2（不超上限）", async () => {
    const { runFn } = makeRecordingRunFn(["v1", "v2", "v3"]);
    const { runClassifier } = makeClassifierSpy([
      failEnvelope("missing x", ["x"]),
      failEnvelope("missing x", ["x"]),
    ]);

    const out = await runVerifyLoop(
      defaultOptions({ runFn, runClassifier, maxRounds: 2 })
    );

    assert.equal(out.outcome, "failed");
    assert.equal(out.rounds, 2);
  });
});

/* ------------------------------ classifier input shape ------------------------------ */

describe("classifier input shape — verify-loop 透传 { task, summary, finalText }（A3）", () => {
  it("task=userText, finalText=last run().finalText, summary=非空 run 摘要", async () => {
    const runFn: VerifyLoopOptions["runFn"] = async (userText) =>
      stubRun({ text: "implemented the requested feature", userText });
    const { runClassifier, calls } = makeClassifierSpy([passEnvelope("ok")]);

    await runVerifyLoop({
      runFn,
      userText: "deploy to staging",
      config: { command: "" },
      sessionId: "s-input",
      runClassifier,
      cwd: process.cwd(),
    });

    assert.equal(calls().length, 1);
    assert.equal(calls()[0]?.task, "deploy to staging");
    assert.equal(calls()[0]?.finalText, "implemented the requested feature");
    // summary = content digest of the completed run's finalText (the judge sees what the model finally claimed).
    assert.equal(
      calls()[0]?.summary,
      "implemented the requested feature",
      "summary 与 completed run 的 finalText 同源"
    );
  });
});

/* ------------------------------ compatibility with existing tests ------------------------------ */

describe("command 已配时分类器路径不参与（与既有 verify-loop 测试兼容）", () => {
  it("注入 runClassifier + command 已配 → 走既有命令路径, 分类器不触发", async () => {
    const { runFn } = makeRecordingRunFn(["x"]);
    let classifierInvoked = false;
    const runVerify: VerifyLoopOptions["runVerify"] = async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });

    const out = await runVerifyLoop({
      runFn,
      userText: "x",
      config: { command: "true" },
      sessionId: "s-cmd-only",
      runVerify,
      runClassifier: async () => {
        classifierInvoked = true;
        return passEnvelope("should not be called");
      },
      cwd: process.cwd(),
    });

    assert.equal(classifierInvoked, false);
    assert.equal(out.outcome, "passed");
  });
});

/* ------------------------------ per-round verdict lands in the Trace (classifier-branch fields) ------------------------------ */

describe("SC10: classifier fail 轮次把 reason/evidence/missing 落进 VerificationRecord", () => {
  it("fail round → trace.recordVerification 收到含分类器字段的记录", async () => {
    const { runFn } = makeRecordingRunFn(["v1", "v2"]);
    const { runClassifier } = makeClassifierSpy([
      failEnvelope("missing deploy step", ["deploy to staging"]),
      passEnvelope("evidence present now"),
    ]);
    const captured: VerificationRecord[] = [];
    const trace: TraceService = {
      recordLlmCall: async () => undefined,
      recordToolCall: async () => undefined,
      recordTurn: async () => undefined,
      recordSession: async () => undefined,
      recordSandboxCmd: async () => undefined,
      recordVerification: async (rec) => {
        captured.push(rec);
        return rec.id;
      },
      recordViolation: async () => undefined,
      recordGoal: async () => undefined,
      recordSubagentSpawn: async () => undefined,
      recordSubagentStop: async () => undefined,
      recordSubagentStateChange: async () => undefined,
      recordSubagentStep: async () => undefined,
    };

    const out = await runVerifyLoop({
      runFn,
      userText: "implement goal",
      config: { command: "" },
      sessionId: "sess-sc10",
      runClassifier,
      trace,
      cwd: process.cwd(),
    });

    assert.equal(out.outcome, "passed");
    // one fail round + one pass round → two records.
    assert.equal(captured.length, 2);
    const failRecord = captured[0]!;
    assert.equal(failRecord.verdict, "true-failure");
    assert.equal(failRecord.reason, "missing deploy step");
    assert.deepEqual(failRecord.missing, ["deploy to staging"]);
    assert.ok(
      Array.isArray(failRecord.evidence),
      "fail round 记录应含 evidence 数组"
    );
    assert.equal(failRecord.evidence?.[0]?.["command"], "noop");
    // the pass record carries none of the classifier fail fields.
    const passRecord = captured[1]!;
    assert.equal(passRecord.verdict, "pass");
  });
});
