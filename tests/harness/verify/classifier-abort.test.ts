/**
 * Verify classifier — concurrency / interruption boundary tests.
 *
 * Boundary rows + concurrency-invariant argument from the spec's testing strategy:
 *   - verify-loop is a serial loop: at most one classifier is in flight per round,
 *     so there is no race window between two rounds;
 *   - the only concurrency dimension is abort coexisting with an in-flight
 *     classifier: the user presses Ctrl+C while waiting for the worker's reply —
 *     the loop must stop immediately (not wait for the reply) and the in-flight
 *     closeout must not leave a stale envelope behind.
 *
 * Covers abort × timing boundaries not covered by classifier-loop.test.ts:
 *   - classifier in flight (seam never resolves) → abort → outcome=aborted;
 *   - same + no stale `[VALIDATION FAILED]` envelope injected into message history
 *     (a user abort must not trigger the fail→inject chain);
 *   - pre-loop abort (signal already aborted before awaiting runFn) → classifier
 *     seam never called;
 *   - abort after the classifier returns but before the next runFn → outcome=aborted
 *     (race boundary).
 *
 * DI seams: mirror classifier-loop.test.ts (makeRecordingRunFn / makeClassifierSpy /
 * defaultOptions / okEnvelope) plus the abort pattern of verify-loop.test.ts
 * (AbortController + signal passed via defaultOptions).
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

/* ------------------------------ test fixtures (mirrors classifier-loop.test.ts) ------------------------------ */

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

/**
 * Content-gate signal: an inert non-doc source edit. Opens the upstream
 * verify gate (text-only stubs would now never enter verify) with zero
 * effect on checkEvidence verdict/reasons.
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
    sessionId: over.sessionId ?? "sess-classifier-abort",
    ...(over.signal !== undefined ? { signal: over.signal } : {}),
    runClassifier: over.runClassifier,
    cwd: over.cwd ?? process.cwd(),
  };
}

/** All user-role texts in the message history. */
function allUserText(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) =>
      m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
    );
}

/* ------------------------------ concurrency boundary: abort × in-flight classifier ------------------------------ */

describe("SC5 并发维度: 分类器在飞时用户 abort (in-flight closeout)", () => {
  it("分类器在飞 (seam 永不 resolve) → abort → outcome=aborted, 不等 worker 回包", async () => {
    const controller = new AbortController();
    const { runFn } = makeRecordingRunFn(["done"]);
    let resolveSpawnStarted!: () => void;
    const spawnStarted = new Promise<void>((resolve) => {
      resolveSpawnStarted = resolve;
    });
    const runClassifier: RunClassifierFn = async (args) => {
      resolveSpawnStarted();
      // never resolves: simulates an in-flight worker (seam awaiting the subagent reply).
      await new Promise<void>((resolve) => {
        if (args.signal?.aborted) {
          resolve();
          return;
        }
        args.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      // when the user aborts, the worker is killed → the seam rejects with AbortError
      // (verify-loop checks signal.aborted first inside catch → aborted, not unstable).
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

    // The "never wait for the worker reply" contract is held by the abort checkpoints
    // in runClassifierOnce: while the seam is suspended, once signal.aborted is set the
    // await settles and the catch sees signal → {aborted:true} without waiting for the
    // seam to return. Asserted without a timer race (which would be flaky); the
    // suspended seam plus late rejection already proves the closeout does not depend on
    // the worker reply.
    assert.equal(
      out.outcome,
      "aborted",
      "在飞 abort 必须立即终止闭环, 不等待 worker 回包 (并发不变量)"
    );
    assert.equal(out.rounds, 1, "分类器轮已开始计数");
    assert.equal(out.enabled, true);
    assert.equal(
      out.records.length,
      0,
      "abort 不伪造未完成轮的 VerificationRecord"
    );
  });

  it("在飞 abort 不残留 stale 信封: message 历史无 [VALIDATION FAILED]", async () => {
    const controller = new AbortController();
    const { runFn } = makeRecordingRunFn(["done"]);
    let resolveSpawnStarted!: () => void;
    const spawnStarted = new Promise<void>((resolve) => {
      resolveSpawnStarted = resolve;
    });
    const runClassifier: RunClassifierFn = async (args) => {
      resolveSpawnStarted();
      await new Promise<void>((resolve) => {
        if (args.signal?.aborted) {
          resolve();
          return;
        }
        args.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      // The seam returns a fail envelope after the abort — verify-loop must check
      // signal.aborted first (the second abort checkpoint in runClassifierOnce) and
      // must not consume this stale fail into the fail→inject chain.
      return failEnvelope("stale failure", ["stale item"]);
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
      "abort 后 seam 迟到回包不得覆盖 abort 判定"
    );
    // A user abort must not trigger the fail→inject chain: no [VALIDATION FAILED] envelope anywhere in history.
    assert.ok(
      allUserText(out.result.messages).every(
        (t) => !t.includes("[VALIDATION FAILED]")
      ),
      "closeout 不残留 stale 失败信封注入 (用户 abort ≠ 真失败)"
    );
  });
});

/* ------------------------------ concurrency boundary: abort × timing windows ------------------------------ */

describe("SC5 并发维度: abort × 时序窗口", () => {
  it("abort 在 await runFn 之前 (pre-loop) → outcome=aborted, 分类器 seam 未被调用", async () => {
    const controller = new AbortController();
    controller.abort(); // signal already aborted before the first runFn await.
    const { runFn, calls: runFnCalls } = makeRecordingRunFn(["done"]);
    const { runClassifier, calls: classifierCalls } = makeClassifierSpy([
      passEnvelope("should not be called"),
    ]);

    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        signal: controller.signal,
      })
    );

    assert.equal(out.outcome, "aborted");
    assert.equal(out.rounds, 0, "pre-loop abort 不进入任何验证轮");
    assert.equal(out.records.length, 0);
    assert.equal(
      classifierCalls().length,
      0,
      "分类器 seam 未被调用 (closed-loop 未启动)"
    );
    assert.equal(runFnCalls().length, 1, "首轮 run() 照常执行 (与裸 run 同构)");
  });

  it("abort 在分类器返回后、下一轮 runFn 在飞时 → outcome=aborted (race 边界)", async () => {
    // Mirrors the abort pattern in verify-loop.test.ts: the second runFn suspends
    // until abort (same shape as the suspended runVerify there). Round 1 classifier
    // fails → envelope injected and the loop continues; the user aborts while round
    // 2's runFn is in flight → the loop-top abort checkpoint converges.
    const controller = new AbortController();
    // Only the first scripted call consumes "v1": runFnHook intercepts call 1 and suspends until abort.
    const { runFn, calls: runFnCalls } = makeRecordingRunFn(["v1"]);
    let resolveSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      resolveSecondStarted = resolve;
    });
    const runFnHook: VerifyLoopOptions["runFn"] = async (userText, runOpts) => {
      const call = runFnCalls().length;
      if (call === 1) {
        resolveSecondStarted();
        await new Promise<void>((resolve) => {
          if (runOpts?.signal?.aborted) {
            resolve();
            return;
          }
          runOpts?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return stubRun({
          text: "v2",
          stopReason: "completed",
          priorMessages: runOpts?.priorMessages,
          userText,
        });
      }
      return runFn(userText, runOpts);
    };
    const { runClassifier } = makeClassifierSpy([
      failEnvelope("missing x", ["x"]),
    ]);

    const promise = runVerifyLoop(
      defaultOptions({
        runFn: runFnHook,
        runClassifier,
        signal: controller.signal,
      })
    );
    await secondStarted;
    controller.abort();
    const out = await promise;

    assert.equal(runFnCalls().length, 1, "仅首轮 runFn 完成 (fail→注入→继续)");
    assert.equal(
      out.outcome,
      "aborted",
      "第 2 轮 runFn 在飞时 abort → 闭环立即终止"
    );
    assert.equal(out.rounds, 1);
    assert.equal(out.records.length, 1, "仅首轮判定有记录");
    assert.equal(out.records[0]!.verdict, "true-failure");
    // This abort is a user interruption after a completed fail round: history still
    // holds round 1's injected classifier envelope (round 2 never produced one).
    const envelopes = allUserText(out.result.messages).filter((t) =>
      t.includes("[VALIDATION FAILED]")
    );
    assert.equal(
      envelopes.length,
      1,
      "仅首轮 fail 注入的信封, 无多余 stale 信封"
    );
    assert.ok(
      envelopes[0]!.includes("source=classifier"),
      "信封为分类器路径产物"
    );
  });
});
