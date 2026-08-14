/**
 * verify-loop 主循环 + 集成测试 (T7, GH #128 失败自动修正闭环)。
 *
 * spec 11 条 binary Success Criteria 逐条成测试 + 边界 (spec:94):
 *  - 空输出 (exit≠0, 退化签名比对, 不误判 pass);
 *  - exec 启动失败 (spawn error → exit 127 → 真失败分支);
 *  - 真实沙箱默认装配 (runInSandbox 经 bwrap 执行, hasBwrap 守卫)。
 *
 * 编排:
 *  - runFn 缝: 真实 run() + createStubModel (SC1/SC8) 或确定性脚本替身;
 *  - runVerify 缝: 脚本化假验证命令 (不依赖真实 bash 沙箱);
 *  - 确认阶梯每轮固定 初始 + 全量复跑 (+ 单跑, 仅 rerunTemplate 配置);
 *  - 假验证输出按 FAIL 行生成失败签名与失败数, 与 verdict.ts 语义一致。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_TIMEOUT_SEC,
  runVerifyLoop,
  type RunOutcome,
  type RunVerifyFn,
  type VerifyLoopOptions,
  type VerifyLoopOutcome,
} from "../../../src/harness/verify/verify-loop.ts";
import type { VerifyConfig } from "../../../src/harness/verify/types.ts";
import type {
  AnthropicNativeMessage,
  RunResult,
} from "../../../src/harness/model-adapter/types.ts";
import type { LoopTrace } from "../../../src/harness/loop-trace.ts";
import type { TraceService } from "../../../src/harness/trace/index.ts";
import type { VerificationRecord as TraceVerificationRecord } from "../../../src/harness/trace/index.ts";
import type { SandboxCmdRecord } from "../../../src/harness/trace/index.ts";
import type { SandboxRunResult } from "../../../src/harness/sandbox/index.ts";
import type { LoopEngineDeps } from "../../../src/harness/loop-engine.ts";
import { run } from "../../../src/harness/loop-engine.ts";
import { assistantResult, makeDeps, makeNative } from "../../cli/_fixtures.ts";

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

const FAIL_LINE = "tests/auth.test.ts:login rejects bad token";
const FAIL_OUTPUT = `FAIL  ${FAIL_LINE}\n`;
const FIXED_INSTRUCTION =
  "Fix the failures above. Do not claim completion until validation passes.";

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

/** 脚本化 runVerify 替身: 逐次消费处理器, 记录命令串。耗尽即抛错。 */
function makeScriptedVerify(script: ReadonlyArray<() => SandboxRunResult>): {
  readonly runVerify: VerifyLoopOptions["runVerify"];
  readonly callCount: () => number;
  readonly commands: () => ReadonlyArray<string>;
} {
  const commands: string[] = [];
  let call = 0;
  const runVerify: VerifyLoopOptions["runVerify"] = async (command) => {
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

/**
 * 确认阶梯展开: 每轮 exit≠0 时"初始 + 全量复跑"各消耗一次验证调用;
 * exit 0 (pass) 不触发复跑。单跑 (rerunTemplate) 由测试手动追加。
 */
function expandRounds(
  roundSpecs: ReadonlyArray<SandboxRunResult>
): ReadonlyArray<() => SandboxRunResult> {
  const out: Array<() => SandboxRunResult> = [];
  for (const spec of roundSpecs) {
    out.push(() => spec);
    if (spec.exitCode !== 0) out.push(() => spec);
  }
  return out;
}

/** finalText 驱动验证: 验证结果随模型最后一回合文本变化。 */
function makeFinalTextVerify(opts: {
  readonly failWhen: (finalText: string | null) => boolean;
  readonly failOutput: string;
  readonly failExit?: number;
}): {
  readonly runVerify: VerifyLoopOptions["runVerify"];
  /** runFn 委托把 finalText 回传给此 sink, 验证替身据此判定成败。 */
  readonly sink: (t: string | null) => void;
} {
  let lastText: string | null = null;
  const runVerify: VerifyLoopOptions["runVerify"] = async () => {
    if (opts.failWhen(lastText)) {
      return {
        exitCode: opts.failExit ?? 1,
        stdout: opts.failOutput,
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "all good", stderr: "" };
  };
  return {
    runVerify,
    sink: (t) => {
      lastText = t;
    },
  };
}

/** 真实 run() 委托: 消费 stub model 脚本响应, 并把 finalText 回传给验证。 */
function makeRealRunFn(
  deps: LoopEngineDeps,
  finalTextSink: (t: string | null) => void
): VerifyLoopOptions["runFn"] {
  return async (userText, opts) => {
    const out = await run(userText, deps, opts?.signal, {
      priorMessages: opts?.priorMessages,
    });
    finalTextSink(out.result.finalText);
    return out;
  };
}

/** 捕获 TraceService 记录 (SC8)。 */
function makeCapturingTrace(): {
  readonly trace: TraceService;
  readonly records: () => ReadonlyArray<TraceVerificationRecord>;
  readonly sandboxCmds: () => ReadonlyArray<SandboxCmdRecord>;
} {
  const records: TraceVerificationRecord[] = [];
  const sandboxCmds: SandboxCmdRecord[] = [];
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
      async recordSandboxCmd(record) {
        sandboxCmds.push(record);
        return undefined;
      },
      async recordVerification(record) {
        records.push(record);
        return record.id;
      },
    },
    records: () => records,
    sandboxCmds: () => sandboxCmds,
  };
}

function failN(prefix: string, n: number): SandboxRunResult {
  return {
    exitCode: 1,
    stdout:
      Array.from(
        { length: n },
        (_, i) => `FAIL  ${prefix}${i}.ts:case${i}`
      ).join("\n") + "\n",
    stderr: "",
  };
}

function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

function defaultOptions(over: {
  readonly runFn: VerifyLoopOptions["runFn"];
  readonly config?: Partial<VerifyConfig>;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly trace?: TraceService;
  readonly runVerify?: VerifyLoopOptions["runVerify"];
  readonly cwd?: string;
  readonly userText?: string;
}): VerifyLoopOptions {
  return {
    runFn: over.runFn,
    userText: over.userText ?? "implement login",
    config: { command: "npm test", ...over.config },
    sessionId: over.sessionId ?? "sess",
    ...(over.signal !== undefined ? { signal: over.signal } : {}),
    ...(over.trace !== undefined ? { trace: over.trace } : {}),
    ...(over.runVerify !== undefined ? { runVerify: over.runVerify } : {}),
    cwd: over.cwd ?? process.cwd(),
  };
}

/* ------------------------------ SC1 先错后对 ------------------------------ */

describe("SC1: 先错后对 — 闭环零人工干预走通", () => {
  it("完成→验证失败→注入→修正→复验通过→判完成", async () => {
    const deps = makeDeps([
      assistantResult({
        texts: ["I implemented the login handler."],
        toolCalls: [],
        supplierStop: "success",
      }),
      assistantResult({
        texts: ["I fixed the login handler to reject bad tokens."],
        toolCalls: [],
        supplierStop: "success",
      }),
    ]);
    const verify = makeFinalTextVerify({
      failWhen: (t) => !(t ?? "").includes("fixed"),
      failOutput: FAIL_OUTPUT,
    });
    const runFn = makeRealRunFn(deps, verify.sink);

    const out = await runVerifyLoop(
      defaultOptions({ runFn, runVerify: verify.runVerify })
    );

    assert.equal(out.enabled, true);
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 2);
    assert.equal(out.result.stopReason, "completed");
    assert.equal(
      out.result.finalText,
      "I fixed the login handler to reject bad tokens."
    );
    assert.equal(out.records.length, 2);
    assert.equal(out.records[0]!.verdict, "true-failure");
    assert.equal(out.records[0]!.action, "continue");
    assert.equal(out.records[1]!.verdict, "pass");
    assert.equal(out.records[1]!.action, "stop");
    assert.equal(out.records[1]!.finalOutcome, "passed");
    // 修正轮前一轮的失败被注入为一条 user 消息 (append-only)。
    const envelopeUser = out.result.messages.find(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (b) => b.type === "text" && b.text.includes("[VALIDATION FAILED]")
        )
    );
    assert.ok(envelopeUser !== undefined, "历史必须含验证失败注入信封");
  });

  it("多轮 continue 后历史只含一条信封 (stale 信封收敛, code-review High 修复)", async () => {
    // 3 轮真失败 + 1 轮通过: 失败数递减 (progress 放行), 中间 3 轮都应 continue。
    const { runFn, calls } = makeRecordingRunFn([
      "wrong1",
      "wrong2",
      "wrong3",
      "fixed",
    ]);
    let verifyCall = 0;
    const runVerify: VerifyLoopOptions["runVerify"] = async () => {
      verifyCall += 1;
      // 失败数递减 (3→2→1) 驱动趋势 progress 放行; 每轮 exit≠0 触发确认阶梯
      // (初始 + 全量复跑各一击, 同签名但 failedCount 递减 → 不 stuck)。
      const failCount = 3 - Math.floor((verifyCall - 1) / 2);
      if (verifyCall <= 6) {
        const lines = Array.from(
          { length: failCount },
          () => `FAIL  ${FAIL_LINE}\n`
        ).join("");
        return { exitCode: 1, stdout: lines, stderr: "" };
      }
      return { exitCode: 0, stdout: "all pass\n", stderr: "" };
    };
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runVerify, sessionId: "s1-converge" })
    );

    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 4);
    // 中间 continue 轮每轮 runFn 看到的最后 user 消息只含一条信封 (非累积)。
    const envelopeCounts = calls().map((c) => {
      const text = c.lastUserText ?? "";
      return (text.match(/\[VALIDATION FAILED\]/g) ?? []).length;
    });
    assert.deepEqual(
      envelopeCounts,
      [0, 1, 1, 1],
      "首轮无信封; 之后每轮只带最新一条信封 (旧的被滤除)"
    );
    // 最终历史只含一条信封 (不残留多轮 stale 信封)。
    const finalEnvelopeCount = out.result.messages.filter((m) =>
      m.content.some(
        (b) => b.type === "text" && b.text.includes("[VALIDATION FAILED]")
      )
    ).length;
    assert.equal(finalEnvelopeCount, 1, "最终历史信封收敛为一条");
  });
});

/* ------------------------------ SC2 捕获无漏网 ------------------------------ */

describe("SC2: 捕获无漏网 — 真失败/不稳定永不判完成", () => {
  it("真失败 (同签名停滞) → outcome failed, 永不 passed", async () => {
    const { runFn } = makeRecordingRunFn(["wrong1", "wrong2"]);
    const verify = makeScriptedVerify(
      expandRounds([
        { exitCode: 1, stdout: FAIL_OUTPUT, stderr: "" },
        { exitCode: 1, stdout: FAIL_OUTPUT, stderr: "" },
      ])
    );
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runVerify: verify.runVerify })
    );
    assert.equal(out.outcome, "failed");
    assert.notEqual(out.outcome, "passed");
    assert.equal(out.rounds, 2);
    assert.equal(out.records[1]!.finalOutcome, "failed");
  });

  it("不稳定 (套件干扰) → outcome unstable, 永不 passed", async () => {
    const { runFn } = makeRecordingRunFn(["implemented"]);
    const verify = makeScriptedVerify([
      () => ({ exitCode: 1, stdout: FAIL_OUTPUT, stderr: "" }),
      () => ({ exitCode: 1, stdout: FAIL_OUTPUT, stderr: "" }),
      () => ({ exitCode: 0, stdout: "single passes", stderr: "" }),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runVerify: verify.runVerify,
        config: { rerunTemplate: "npx jest {files}" },
      })
    );
    assert.equal(out.outcome, "unstable");
    assert.notEqual(out.outcome, "passed");
    assert.equal(out.rounds, 1);
  });
});

/* ------------------------------ SC3 flaky ------------------------------ */

describe("SC3: flaky — 全量复跑通过不触发修正轮", () => {
  it("exit≠0 + 全量复跑通过 → 判 pass, 只 run 一次", async () => {
    const { runFn, calls } = makeRecordingRunFn(["implemented"]);
    const verify = makeScriptedVerify([
      () => ({ exitCode: 1, stdout: FAIL_OUTPUT, stderr: "" }),
      () => ({ exitCode: 0, stdout: "rerun ok", stderr: "" }),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runVerify: verify.runVerify })
    );
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 1);
    assert.equal(calls().length, 1, "flaky 不得触发修正轮 (runFn 只调一次)");
    assert.equal(out.records[0]!.verdict, "pass");
    assert.equal(out.records[0]!.finalOutcome, "passed");
    assert.equal(out.records.length, 1);
  });
});

/* ------------------------------ SC4 套件干扰 ------------------------------ */

describe("SC4: 套件干扰 — 单跑通过判不稳定", () => {
  it("全量复跑仍挂 + 单跑通过 → unstable, 不修正", async () => {
    const { runFn, calls } = makeRecordingRunFn(["implemented"]);
    const verify = makeScriptedVerify([
      () => ({ exitCode: 1, stdout: FAIL_OUTPUT, stderr: "" }),
      () => ({ exitCode: 1, stdout: FAIL_OUTPUT, stderr: "" }),
      () => ({ exitCode: 0, stdout: "single passes", stderr: "" }),
    ]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runVerify: verify.runVerify,
        config: { rerunTemplate: "npx jest {files}" },
      })
    );
    assert.equal(out.outcome, "unstable");
    assert.equal(out.rounds, 1);
    assert.equal(calls().length, 1, "unstable 不触发修正轮");
    assert.equal(out.records[0]!.verdict, "unstable");
    assert.equal(out.records[0]!.action, "stop");
    assert.equal(out.records[0]!.finalOutcome, "unstable");
    // 单跑命令: {files} 被替换为签名提取的失败用例名。
    assert.equal(verify.commands()[2], `npx jest ${FAIL_LINE}`);
  });
});

/* ------------------------------ SC5 趋势三规则 ------------------------------ */

describe("SC5: 趋势三规则", () => {
  it("同签名连续两轮 → 停 (stuck)", async () => {
    const { runFn } = makeRecordingRunFn(["wrong1", "wrong2"]);
    const verify = makeScriptedVerify(
      expandRounds([
        { exitCode: 1, stdout: FAIL_OUTPUT, stderr: "" },
        { exitCode: 1, stdout: FAIL_OUTPUT, stderr: "" },
      ])
    );
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runVerify: verify.runVerify })
    );
    assert.equal(out.outcome, "failed");
    assert.equal(out.rounds, 2);
    assert.equal(out.records[0]!.action, "continue");
    assert.equal(out.records[1]!.action, "stop");
    assert.equal(out.records[1]!.finalOutcome, "failed");
  });

  it("连续两轮差于最好成绩 → 停 (regression)", async () => {
    const { runFn } = makeRecordingRunFn(["wrong1", "wrong2", "wrong3"]);
    const verify = makeScriptedVerify(
      expandRounds([failN("a", 1), failN("b", 2), failN("c", 3)])
    );
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runVerify: verify.runVerify })
    );
    assert.equal(out.outcome, "failed");
    assert.equal(out.rounds, 3);
    // r1 (1) → 首次 best; r2 (2) → 单轮震荡放行; r3 (3) → 连续两轮退化停。
    assert.equal(out.records[2]!.action, "stop");
    assert.equal(out.records[2]!.finalOutcome, "failed");
  });

  it("失败数递减 → 继续放行至通过", async () => {
    const { runFn } = makeRecordingRunFn(["w3", "w1", "done"]);
    const verify = makeScriptedVerify(
      expandRounds([
        failN("a", 3),
        failN("b", 1),
        { exitCode: 0, stdout: "all good", stderr: "" },
      ])
    );
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runVerify: verify.runVerify })
    );
    assert.equal(out.outcome, "passed");
    assert.equal(out.rounds, 3);
    assert.equal(out.records[0]!.action, "continue");
    assert.equal(out.records[1]!.action, "continue");
    assert.equal(out.records[2]!.verdict, "pass");
    assert.equal(out.records[2]!.finalOutcome, "passed");
  });
});

/* ------------------------------ SC6 耗尽处置 ------------------------------ */

describe("SC6: 耗尽处置", () => {
  it("report 模式: 停止且报告含轮数 + 最终输出", async () => {
    const { runFn } = makeRecordingRunFn(["w1", "w2"]);
    const verify = makeScriptedVerify(
      expandRounds([failN("a", 1), failN("b", 2)])
    );
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runVerify: verify.runVerify,
        config: { maxRounds: 2, onExhausted: "report" },
      })
    );
    assert.equal(out.outcome, "failed");
    assert.equal(out.rounds, 2);
    assert.equal(out.records[1]!.round, 2);
    assert.equal(out.records[1]!.action, "stop");
    assert.equal(out.records[1]!.finalOutcome, "failed");
    assert.equal(out.result.finalText, "w2", "报告承载最终模型输出");
  });

  it("escalate 模式: 注入升级指令且总预算不重置", async () => {
    const { runFn, calls } = makeRecordingRunFn(["w1", "w2", "w3", "w4"]);
    const verify = makeScriptedVerify(
      expandRounds([failN("a", 1), failN("b", 1), failN("c", 1), failN("d", 1)])
    );
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runVerify: verify.runVerify,
        config: { maxRounds: 2, onExhausted: "escalate" },
      })
    );
    assert.equal(out.outcome, "escalated");
    assert.equal(out.rounds, 4, "escalate 给新预算继续, 总预算不重置");
    // 升级指令在第 2 轮耗尽后注入 (第 3 次 runFn 的 lastUserText)。
    assert.equal(
      calls()[1]!.lastUserText?.includes("[VALIDATION FAILED]"),
      true
    );
    assert.equal(
      calls()[1]!.lastUserText?.includes("Do not repeat the same fix"),
      false,
      "第 2 轮前注入的是普通信封, 不是升级指令"
    );
    assert.equal(
      calls()[2]!.lastUserText?.includes(
        "Do not repeat the same fix — re-read the task and take a different approach"
      ),
      true,
      "耗尽后注入升级指令 (禁止重复同一修复)"
    );
    assert.equal(out.records[1]!.action, "escalate");
    assert.equal(out.records[3]!.action, "stop");
    assert.equal(out.records[3]!.finalOutcome, "escalated");
  });

  it("兜底上限: 默认 12 轮生效", async () => {
    const n = DEFAULT_MAX_ROUNDS;
    const { runFn } = makeRecordingRunFn(
      Array.from({ length: n + 1 }, (_, i) => `w${i}`)
    );
    // 每轮不同签名 + 失败数恒定 1 → 趋势一直放行, 只能被兜底上限截停。
    const verify = makeScriptedVerify(
      expandRounds(Array.from({ length: n }, (_, i) => failN(`s${i}`, 1)))
    );
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runVerify: verify.runVerify,
        config: { command: "npm test" },
      })
    );
    assert.equal(out.outcome, "failed");
    assert.equal(out.rounds, n);
    assert.equal(out.records.length, n);
    assert.equal(DEFAULT_MAX_ROUNDS, 12);
    assert.equal(DEFAULT_TIMEOUT_SEC, 600);
  });
});

/* ------------------------------ SC7 未配置 ------------------------------ */

describe("SC7: 未配 verify.command → 行为与现状逐字节一致", () => {
  it("只调 runFn 一次, 不执行验证, 结果透传", async () => {
    // runFn 替身直接造出"裸 run 形状"的引用 (独立于闭环内那次调用),
    // 供逐字节对比 —— 只调一次闭环内的 runFn, 不计替身自跑。
    const makeBare = (): RunOutcome =>
      stubRun({ text: "hello", userText: "hi" });
    const bare = makeBare();
    const calls: Array<{ userText: string; priorCount: number }> = [];
    const runFn: VerifyLoopOptions["runFn"] = async (userText, runOpts) => {
      calls.push({
        userText,
        priorCount: (runOpts?.priorMessages ?? []).length,
      });
      return bare;
    };
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        userText: "hi",
        config: { command: "" },
        runVerify: async () => {
          throw new Error("未配置时不得执行验证命令");
        },
      })
    );
    assert.equal(out.enabled, false);
    assert.equal(out.rounds, 0);
    assert.equal(out.outcome, "disabled");
    assert.equal(out.records.length, 0);
    assert.deepEqual(out.result, bare.result, "结果与裸 run 逐字节一致");
    assert.deepEqual(out.trace, bare.trace, "trace 与裸 run 逐字节一致");
    assert.deepEqual(
      calls,
      [{ userText: "hi", priorCount: 0 }],
      "只调一次 runFn"
    );
  });
});

/* ------------------------------ SC8 TraceService ------------------------------ */

describe("SC8: 每轮判定写 TraceService VerificationRecord", () => {
  it("先错后对两轮: 字段含轮次/三态/签名/趋势/终态", async () => {
    const deps = makeDeps([
      assistantResult({ texts: ["wrong implementation"], toolCalls: [] }),
      assistantResult({ texts: ["fixed implementation"], toolCalls: [] }),
    ]);
    const verify = makeFinalTextVerify({
      failWhen: (t) => !(t ?? "").includes("fixed"),
      failOutput: FAIL_OUTPUT,
    });
    const runFn = makeRealRunFn(deps, verify.sink);
    const capture = makeCapturingTrace();
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runVerify: verify.runVerify,
        sessionId: "s8",
        trace: capture.trace,
      })
    );
    const records = capture.records();
    assert.equal(records.length, 2);
    const r1 = records[0]!;
    assert.equal(r1.sessionId, "s8");
    assert.equal(r1.round, 1);
    assert.equal(r1.verdict, "true-failure");
    assert.equal(r1.exitCode, 1);
    assert.equal(r1.failedCount, 1);
    assert.equal(r1.signature, `exit=1|${FAIL_LINE}`);
    assert.equal(r1.action, "continue");
    assert.equal(r1.finalOutcome, undefined);
    assert.ok(!Number.isNaN(Date.parse(r1.ts)), "ts 为 ISO 时间串");
    const r2 = records[1]!;
    assert.equal(r2.round, 2);
    assert.equal(r2.verdict, "pass");
    assert.equal(r2.exitCode, 0);
    assert.equal(r2.action, "stop");
    assert.equal(r2.finalOutcome, "passed");
    // 写盘记录与返回值 records 同源 (trace 已落盘)。
    assert.equal(out.records.length, 2);

    // spec:67 / plan §Decisions: 每次验证命令执行落 SandboxCmdRecord,
    // parentTurnId 挂触发本轮验证的 completed turn id。
    const cmds = capture.sandboxCmds();
    assert.ok(cmds.length >= 2, "至少初始 + 全量复跑两条 SandboxCmdRecord");
    assert.equal(cmds[0]!.command, "npm test");
    assert.equal(cmds[0]!.exitCode, 1);
    assert.equal(cmds[0]!.status, "ok");
    assert.match(cmds[0]!.parentTurnId, /^[0-9]+$|^round-/);
    // 复验通过那轮的验证命令 exit 0。
    const lastCmd = cmds[cmds.length - 1]!;
    assert.equal(lastCmd.exitCode, 0);
  });
});

/* ------------------------------ SC9 仅 completed 触发 ------------------------------ */

describe("SC9: 仅 StopReason=completed 触发验证", () => {
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
    it(`${c.stop} → 不触发验证, 原样透传`, async () => {
      let verifyCalled = false;
      const { runFn } = makeRecordingRunFn(["x"], {
        stopReasonFor: () => c.stop,
      });
      const out = await runVerifyLoop(
        defaultOptions({
          runFn,
          runVerify: async () => {
            verifyCalled = true;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        })
      );
      assert.equal(verifyCalled, false, "非 completed 不得执行验证命令");
      assert.equal(out.rounds, 0);
      assert.equal(out.records.length, 0);
      assert.equal(out.result.stopReason, c.stop);
      assert.equal(out.outcome, c.outcome);
    });
  }
});

/* ------------------------------ SC10 超时 ------------------------------ */

describe("SC10: 验证命令超时判不稳定", () => {
  it("超时不判真失败, 不触发修正轮", async () => {
    const { runFn } = makeRecordingRunFn(["implemented"]);
    const runVerify: VerifyLoopOptions["runVerify"] = async (_cmd, ctx) => {
      // 挂起直至信号 abort (timeout 或用户取消都会走到这里)。
      await new Promise<void>((resolve) => {
        if (ctx?.signal?.aborted) {
          resolve();
          return;
        }
        ctx?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { exitCode: 143, stdout: "", stderr: "" };
    };
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runVerify,
        config: { timeoutSec: 0.05 },
      })
    );
    assert.equal(out.outcome, "unstable");
    assert.equal(out.rounds, 1);
    assert.equal(out.records[0]!.verdict, "unstable");
    assert.equal(out.records[0]!.action, "stop");
    assert.equal(out.records[0]!.finalOutcome, "unstable");
  });
});

/* ------------------------------ SC11 abort ------------------------------ */

describe("SC11: 用户 abort 终止整个闭环 (in-flight closeout)", () => {
  it("验证 in-flight 时 abort → outcome aborted, 历史含已注入信封", async () => {
    const controller = new AbortController();
    const { runFn } = makeRecordingRunFn(["wrong", "attempt2"]);
    let verifyCall = 0;
    let resolveSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      resolveSecondStarted = resolve;
    });
    const runVerify: VerifyLoopOptions["runVerify"] = async (_cmd, ctx) => {
      verifyCall += 1;
      if (verifyCall <= 2) {
        // 第 1 轮: 初始 + 全量复跑均失败。
        return { exitCode: 1, stdout: FAIL_OUTPUT, stderr: "" };
      }
      // 第 2 轮: 验证 in-flight, 等待用户 abort。
      resolveSecondStarted();
      await new Promise<void>((resolve) => {
        if (ctx?.signal?.aborted) {
          resolve();
          return;
        }
        ctx?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { exitCode: 143, stdout: "", stderr: "" };
    };

    const promise = runVerifyLoop(
      defaultOptions({
        runFn,
        runVerify,
        signal: controller.signal,
        sessionId: "s11",
      })
    );
    await secondStarted;
    controller.abort();
    const out = await promise;

    assert.equal(out.outcome, "aborted");
    assert.equal(out.rounds, 2, "第 2 轮已开始验证");
    assert.equal(out.records.length, 1, "abort 不伪造未完成轮的记录");
    // in-flight closeout: 返回当前 result, 消息历史含第 1 轮注入的信封。
    const allUserText = out.result.messages
      .filter((m) => m.role === "user")
      .map((m) =>
        m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      );
    assert.ok(
      allUserText.some((t) => t.includes("[VALIDATION FAILED]")),
      "closeout 历史必须保留已 append 的验证失败信封"
    );
  });
});

/* ------------------------------ 边界 ------------------------------ */

describe("边界: 空输出 / exec 启动失败 / 真实沙箱", () => {
  it("空输出 + exit≠0 → 退化签名比对, 不误判 pass", async () => {
    const { runFn } = makeRecordingRunFn(["w1", "w2"]);
    const verify = makeScriptedVerify(
      expandRounds([
        { exitCode: 1, stdout: "", stderr: "" },
        { exitCode: 1, stdout: "", stderr: "" },
      ])
    );
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runVerify: verify.runVerify })
    );
    assert.notEqual(out.outcome, "passed", "空输出不得判完成");
    assert.equal(out.outcome, "failed");
    assert.equal(out.rounds, 2);
    assert.equal(out.records[0]!.signature, "exit=1", "退化纯 exit 签名");
    assert.equal(out.records[0]!.failedCount, 0);
  });

  it("exec 启动失败 (spawn error) → exit 127 → 真失败分支", async () => {
    const { runFn } = makeRecordingRunFn(["w1", "w2"]);
    const verify = makeScriptedVerify([
      () => {
        throw new Error("ENOENT: no such command");
      },
      () => {
        throw new Error("ENOENT: no such command");
      },
      () => {
        throw new Error("ENOENT: no such command");
      },
      () => {
        throw new Error("ENOENT: no such command");
      },
    ]);
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runVerify: verify.runVerify })
    );
    assert.equal(out.outcome, "failed");
    assert.equal(
      out.records[0]!.exitCode,
      127,
      "spawn error 归入 exit 127 真失败"
    );
    assert.equal(out.records[0]!.verdict, "true-failure");
  });

  it("默认 runVerify 经 bwrap 沙箱执行验证命令", async () => {
    if (!hasBwrap()) {
      console.warn("skip: bwrap not available");
      return;
    }
    const cwd = mkdtempSync(join(tmpdir(), "verify-loop-"));
    const script = join(cwd, "check.sh");
    writeFileSync(script, "#!/bin/sh\necho 'all good'\nexit 0\n", "utf8");
    chmodSync(script, 0o755);
    const { runFn } = makeRecordingRunFn(["implemented"]);
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        cwd,
        config: { command: script },
      })
    );
    assert.equal(out.outcome, "passed", "沙箱内验证命令 exit 0 → pass");
    assert.equal(out.rounds, 1);
  });
});
