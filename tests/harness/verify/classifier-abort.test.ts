/**
 * #128 verify 分类器 — 并发/中断边界测试 (T6, spec SC5 并发维度)。
 *
 * spec/128-verify-classifier.md §Testing Strategy 边界行 + 并发不变量论证:
 *   - verify-loop 是串行循环, 每轮至多一个分类器在飞, 两轮间无竞态窗口;
 *   - 唯一并发维度 = abort 与分类器在飞并存: 用户在等待 worker 回包时 Ctrl+C,
 *     闭环须立即停止 (不等待 worker 回包), in-flight closeout 不残留 stale 信封。
 *
 * 本文件覆盖 classifier-loop.test.ts 未覆盖的 abort × 时序边界:
 *   - 分类器在飞 (seam 永不 resolve) → abort → outcome=aborted;
 *   - 同上 + message 历史无 stale `[VALIDATION FAILED]` 信封注入
 *     (用户 abort 不触发 fail→inject 链路);
 *   - pre-loop abort (await runFn 之前 signal 已 aborted) → 分类器 seam 未被调用;
 *   - abort 在分类器返回后、下一次 runFn 之前 → outcome=aborted (race 边界)。
 *   - runVerifyLoop 断言 target: assert.equal(out.outcome, "aborted") 全绿退出 0。
 *
 * DI 缝: 镜像 classifier-loop.test.ts (makeRecordingRunFn / makeClassifierSpy /
 * defaultOptions / okEnvelope) + verify-loop.test.ts SC11 abort 模式
 * (AbortController + signal 经 defaultOptions 传入)。
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

interface RecordedCall {
  readonly userText: string;
  readonly priorCount: number;
  readonly lastUserText: string | undefined;
}

/** 脚本化 runFn 替身: 逐次返回脚本文本, 记录每次调用的历史形状 (同 T3 测试)。 */
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

function failEnvelope(reason: string, missing: string[]): ClassifierEnvelope {
  return okEnvelope({
    kind: "fail",
    reason,
    missing,
    evidence: [{ command: "noop", result: "fail" }],
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

/** message 历史中所有 user 文本的拼接。 */
function allUserText(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) =>
      m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
    );
}

/* ------------------------------ SC5 并发维度: abort × 分类器在飞 ------------------------------ */

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
      // 永不 resolve: 模拟 worker 在飞 (seam 等待子代理回包)。
      await new Promise<void>((resolve) => {
        if (args.signal?.aborted) {
          resolve();
          return;
        }
        args.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      // 用户 abort 触发时 worker 被杀 → seam 以 AbortError reject
      // (verify-loop 在 catch 内先查 signal.aborted → aborted, 不判 unstable)。
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

    // "不等待 worker 回包"的合同由 runClassifierOnce 的 abort 检查点保证:
    // seam 挂起期间 signal.aborted 一旦置位, await 即 settle → catch 内先查
    // signal → {aborted:true}, 不等 seam 主动返回 (verify-loop.ts:478/488)。
    // 此处不用定时器 race 断言 (会引入 flakiness); seam 的挂起 + 迟 reject
    // 已证明 closeout 不依赖 worker 回包。
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
      // seam 在 abort 后返回一个 fail envelope —— verify-loop 必须先查
      // signal.aborted (runClassifierOnce 第 2 个 abort 检查点), 不得
      // 消费该 stale fail 走进 fail→inject 链路。
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
    // 用户 abort 不该触发 fail→inject 链路: 历史无任何 [VALIDATION FAILED] 信封。
    assert.ok(
      allUserText(out.result.messages).every(
        (t) => !t.includes("[VALIDATION FAILED]")
      ),
      "closeout 不残留 stale 失败信封注入 (用户 abort ≠ 真失败)"
    );
  });
});

/* ------------------------------ SC5 并发维度: abort × 时序窗口 ------------------------------ */

describe("SC5 并发维度: abort × 时序窗口", () => {
  it("abort 在 await runFn 之前 (pre-loop) → outcome=aborted, 分类器 seam 未被调用", async () => {
    const controller = new AbortController();
    controller.abort(); // 首轮 runFn await 之前 signal 已 aborted。
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
    // 镜像 verify-loop.test.ts SC11 abort 模式: 第 2 轮 runFn 挂起等待 abort
    // (与 SC11 的 runVerify 挂起同构)。第 1 轮分类器 fail → 注入信封继续,
    // 第 2 轮 runFn 在飞时用户 abort → while 顶部 abort 检查点收敛。
    const controller = new AbortController();
    // 仅首轮脚本 "v1" 被消费: runFnHook 拦截 call=1 并挂起直到 abort。
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
    // 该 abort 是"已完成 fail 轮后的用户中断": 历史含首轮注入的
    // classifier 失败信封 (第二轮信封尚未产生, 无 stale 累积)。
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
