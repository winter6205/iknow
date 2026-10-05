/**
 * verify-loop main loop + integration tests: the automatic fix-up closed loop.
 *
 * Each binary success criterion gets its own test, plus edge cases:
 *  - empty output (exit!=0 falls back to degraded signature comparison, never
 *    misjudged as pass);
 *  - exec launch failure (spawn error -> exit 127 -> true-failure branch);
 *  - real-sandbox default assembly (runInSandbox executes via bwrap, guarded
 *    by a canRunSandbox() fence probe).
 *
 * Orchestration:
 *  - runFn seam: real run() + stub model, or a deterministic scripted stand-in;
 *  - runVerify seam: scripted fake verification commands (no real bash sandbox
 *    dependency);
 *  - the confirmation ladder runs initial + full rerun on every failing round
 *    (plus a single-file rerun only when rerunTemplate is configured);
 *  - fake verification output yields failure signatures and counts from FAIL
 *    lines, consistent with verdict.ts semantics.
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
  type ClassifierEnvelope,
  type RunClassifierFn,
  type RunOutcome,
  type RunVerifyFn,
  type VerifyLoopOptions,
  type VerifyLoopOutcome,
} from "../../../src/harness/verify/verify-loop.ts";
import {
  REASON_HITL_SKIP_COMPLETION_JUDGE,
  type VerifyConfig,
} from "../../../src/harness/verify/types.ts";
import { projectVerifyHumanView } from "../../../src/session-api/verify-human-view.ts";
import {
  EVIDENCE_RERUN_PREFIX,
  isVerifyInjectedText,
  NOT_RUN_PREFIX,
} from "../../../src/harness/verify/inject.ts";
import { isHostInjectedUserText } from "../../../src/harness/agent-status-instruction.ts";
import { isTuiHiddenUserMessage } from "../../../src/tui/session-state.ts";
import type {
  AnthropicContentBlock,
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
import {
  message,
  toolResult,
  toolUse,
  VITEST_GREEN,
  writeFile,
} from "./evidence-checker/_fixtures.ts";

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

const FAIL_LINE = "tests/auth.test.ts:login rejects bad token";
const FAIL_OUTPUT = `FAIL  ${FAIL_LINE}\n`;
const FIXED_INSTRUCTION =
  "Fix the failures above. Do not claim completion until validation passes.";

let gateSeq = 0;
/**
 * Content-gate signal: a failing (`exit 1`) bash test-run transcript block.
 * Opens the gate (a test command was run) while keeping checkEvidence
 * INSUFFICIENT, so the command path still does its own sandbox rerun. The
 * loop consumes result.messages as the turn content, so the stub carries it.
 */
function gateRunMessage(): AnthropicNativeMessage {
  const id = `gate-${(gateSeq += 1)}`;
  return {
    role: "assistant",
    content: [
      { type: "tool_use", id, name: "bash", input: { command: "npm test" } },
      {
        type: "tool_result",
        tool_use_id: id,
        content: JSON.stringify({ code: 1, stdout: "", stderr: "" }),
      },
    ],
  };
}

function stubRun(opts: {
  readonly text: string;
  readonly userText: string;
  readonly stopReason?: RunResult["stopReason"];
  readonly priorMessages?: ReadonlyArray<AnthropicNativeMessage>;
  /** Chit-chat shape: pure text messages, no gate signal (gate tests). */
  readonly noEvidence?: boolean;
}): RunOutcome {
  const messages: AnthropicNativeMessage[] = [
    ...(opts.priorMessages ?? []),
    makeNative({ role: "user", text: opts.userText }),
    ...(opts.noEvidence ? [] : [gateRunMessage()]),
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

/** Scripted runFn stub: returns script text call by call and records the history shape of each invocation. */
function makeRecordingRunFn(
  script: ReadonlyArray<string>,
  opts: {
    readonly stopReasonFor?: (call: number) => RunResult["stopReason"];
    readonly noEvidence?: boolean;
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
    return stubRun({
      text,
      stopReason,
      priorMessages: prior,
      userText,
      noEvidence: opts.noEvidence,
    });
  };
  return { runFn, calls: () => calls };
}

/** Scripted runVerify stub: consumes handlers one by one and records command strings; throws when exhausted. */
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
 * Confirmation-ladder expansion: every exit!=0 round consumes one verification
 * call each for the initial run and the full rerun; exit 0 (pass) triggers no
 * rerun. Single-file reruns (rerunTemplate) are appended manually by tests.
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

/** Final-text-driven verification: the verify result follows the model's last-turn text. */
function makeFinalTextVerify(opts: {
  readonly failWhen: (finalText: string | null) => boolean;
  readonly failOutput: string;
  readonly failExit?: number;
}): {
  readonly runVerify: VerifyLoopOptions["runVerify"];
  /** The runFn delegation feeds finalText into this sink; the verify stub judges success/failure from it. */
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

/** Real run() delegation: consumes stub-model scripted responses and feeds finalText back to the verifier. */
function makeRealRunFn(
  deps: LoopEngineDeps,
  finalTextSink: (t: string | null) => void
): VerifyLoopOptions["runFn"] {
  return async (userText, opts) => {
    const out = await run(userText, deps, opts?.signal, {
      priorMessages: opts?.priorMessages,
    });
    finalTextSink(out.result.finalText);
    // The stub model answers with text only; simulate that the turn really
    // ran a failing test command (content-gate signal) by inserting the
    // transcript before the final claim message.
    const msgs = out.result.messages;
    const last = msgs[msgs.length - 1];
    const messages =
      last === undefined
        ? [gateRunMessage()]
        : [...msgs.slice(0, -1), gateRunMessage(), last];
    return { result: { ...out.result, messages }, trace: out.trace };
  };
}

/** TraceService stand-in that captures VerificationRecord and SandboxCmdRecord writes. */
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

/**
 * Physical-sandbox capability probe for the default-runVerify test below.
 * `hasBwrap()` (binary presence) is the wrong gate: a GitHub Actions runner
 * installs bwrap but disallows user-namespace network isolation, so the fence's
 * constant `--unshare-net` fails at spawn (RTM_NEWADDR) and the default
 * runVerify throws. Require an actual fence spawn to succeed so this case only
 * runs on a host that can really build the sandbox (local WSL).
 */
function canRunSandbox(): boolean {
  const r = spawnSync(
    "bwrap",
    [
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--unshare-net",
      "--",
      "/bin/true",
    ],
    { stdio: "ignore" }
  );
  return r.status === 0;
}

function defaultOptions(over: {
  readonly runFn: VerifyLoopOptions["runFn"];
  readonly config?: Partial<VerifyConfig>;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly trace?: TraceService;
  readonly runVerify?: VerifyLoopOptions["runVerify"];
  readonly runClassifier?: VerifyLoopOptions["runClassifier"];
  readonly completionMode?: VerifyLoopOptions["completionMode"];
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
    ...(over.runClassifier !== undefined
      ? { runClassifier: over.runClassifier }
      : {}),
    ...(over.completionMode !== undefined
      ? { completionMode: over.completionMode }
      : {}),
    cwd: over.cwd ?? process.cwd(),
  };
}

/* ------------------------------ fail first, pass later ------------------------------ */

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
    // The failed round's outcome is injected before the fix round as one user message (append-only).
    const envelopeUser = out.result.messages.find(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (b) => b.type === "text" && b.text.includes("[VALIDATION FAILED]")
        )
    );
    assert.ok(envelopeUser !== undefined, "历史必须含验证失败注入信封");
    // ADR-0112 Decision 1 / invariant 2: the verify envelope is a host-injected
    // commit and must carry a provenance stamp invisible to the model —
    // otherwise the outbound [VALIDATION FAILED] official prefix anchor gets
    // stripped by our own transcription layer.
    assert.equal(envelopeUser.hostInjected, true);
  });

  it("多轮 continue 后历史只含一条信封 (stale 信封收敛, code-review High 修复)", async () => {
    // Three true-failure rounds + one passing round: fail counts decrease (trend progress lets
    // them through), so all three middle rounds continue.
    const { runFn, calls } = makeRecordingRunFn([
      "wrong1",
      "wrong2",
      "wrong3",
      "fixed",
    ]);
    let verifyCall = 0;
    const runVerify: VerifyLoopOptions["runVerify"] = async () => {
      verifyCall += 1;
      // Decreasing fail counts (3→2→1) drive the trend's progress release; each exit!=0
      // round triggers the confirmation ladder (initial + full rerun, same signature but
      // decreasing failedCount → never stuck).
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
    // Each middle continue round's runFn sees a last user message holding exactly one envelope (no accumulation).
    const envelopeCounts = calls().map((c) => {
      const text = c.lastUserText ?? "";
      return (text.match(/\[VALIDATION FAILED\]/g) ?? []).length;
    });
    assert.deepEqual(
      envelopeCounts,
      [0, 1, 1, 1],
      "首轮无信封; 之后每轮只带最新一条信封 (旧的被滤除)"
    );
    // The final history holds a single envelope (no stale multi-round leftovers).
    const finalEnvelopeCount = out.result.messages.filter((m) =>
      m.content.some(
        (b) => b.type === "text" && b.text.includes("[VALIDATION FAILED]")
      )
    ).length;
    assert.equal(finalEnvelopeCount, 1, "最终历史信封收敛为一条");
  });
});

/* ------------------------------ no true failure escapes as pass ------------------------------ */

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

/* ------------------------------ flaky: full rerun green, no fix round ------------------------------ */

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

/* ------------------------------ suite interference: single rerun green ------------------------------ */

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
    // Single-file rerun command: {files} is replaced by the failing test name extracted from the signature.
    assert.equal(verify.commands()[2], `npx jest ${FAIL_LINE}`);
  });
});

/* ------------------------------ trend rules ------------------------------ */

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
    // r1 (1) sets the first best; r2 (2) is a one-round oscillation, allowed; r3 (3) is two consecutive regressions → stop.
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

/* ------------------------------ exhaustion handling ------------------------------ */

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
    // The escalate instruction is injected after round 2 exhausts the budget (the 3rd runFn's lastUserText).
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
    // Distinct signature per round + constant fail count 1 → the trend keeps releasing; only the backstop round limit stops the loop.
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

/* ------------------------------ unconfigured passthrough ------------------------------ */

describe("SC7: 未配 verify.command → 行为与现状逐字节一致", () => {
  it("只调 runFn 一次, 不执行验证, 结果透传", async () => {
    // The stub builds a "bare run" outcome reference up front, independent of the
    // loop's call, for the byte-for-byte comparison; only the loop's own runFn
    // invocation is counted, not this construction.
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

/* ------------------------------ TraceService records ------------------------------ */

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
    // The persisted records and the returned records share one source (trace is on disk).
    assert.equal(out.records.length, 2);

    // Every verification command execution writes a SandboxCmdRecord whose
    // parentTurnId points at the completed turn that triggered the round's verification.
    const cmds = capture.sandboxCmds();
    assert.ok(cmds.length >= 2, "至少初始 + 全量复跑两条 SandboxCmdRecord");
    assert.equal(cmds[0]!.command, "npm test");
    assert.equal(cmds[0]!.exitCode, 1);
    assert.equal(cmds[0]!.status, "ok");
    assert.match(cmds[0]!.parentTurnId, /^[0-9]+$|^round-/);
    // The verification command of the passing re-check exits 0.
    const lastCmd = cmds[cmds.length - 1]!;
    assert.equal(lastCmd.exitCode, 0);
  });
});

/* ------------------------------ only completed triggers verification ------------------------------ */

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

/* ------------------------------ verification timeout ------------------------------ */

describe("SC10: 验证命令超时判不稳定", () => {
  it("超时不判真失败, 不触发修正轮", async () => {
    const { runFn } = makeRecordingRunFn(["implemented"]);
    const runVerify: VerifyLoopOptions["runVerify"] = async (_cmd, ctx) => {
      // Hang until the signal aborts (timeout and user cancellation both land here).
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

/* ------------------------------ user abort terminates the loop ------------------------------ */

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
        // Round 1: initial run and full rerun both fail.
        return { exitCode: 1, stdout: FAIL_OUTPUT, stderr: "" };
      }
      // Round 2: verification in flight, waiting for the user's abort.
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
    // In-flight closeout: return the current result; the message history still holds the round-1 envelope.
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

/* ------------------------------ edge cases ------------------------------ */

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
    if (!canRunSandbox()) {
      console.warn("skip: bwrap fence cannot run here (no user-namespace)");
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

/* ------------------------------ content gate (upstream verify gate, spec SC6-SC9) ------------------------------ */

describe("内容门: 无可用内容信号的 turn 不进入 verify 子系统", () => {
  function unusedClassifier(): {
    readonly runClassifier: RunClassifierFn;
    readonly calls: () => number;
  } {
    let n = 0;
    const envelope: ClassifierEnvelope = {
      status: "ok",
      result: JSON.stringify({
        kind: "pass",
        reason: "should never spawn",
        evidence: [],
      }),
      summary: "no",
    };
    return {
      runClassifier: async () => {
        n += 1;
        return envelope;
      },
      calls: () => n,
    };
  }

  it("SC6 缝合点: 闲聊 turn 仍执行 round-1 runFn, 恰一次; 随后 disabled 与未配置逐字节一致", async () => {
    const { runFn, calls } = makeRecordingRunFn(["今天天气不错"], {
      noEvidence: true,
    });
    let verifyCalled = 0;
    const gated = await runVerifyLoop(
      defaultOptions({
        runFn,
        runVerify: async () => {
          verifyCalled += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      })
    );
    assert.equal(
      calls().length,
      1,
      "round 1 的 runFn 必须执行 (结果是模型真实输出)"
    );
    assert.equal(verifyCalled, 0, "门关 → verify.command 已配置也不得执行");
    assert.equal(gated.enabled, false);
    assert.equal(gated.outcome, "disabled");
    assert.equal(gated.rounds, 0);
    assert.equal(gated.records.length, 0);
    assert.equal(gated.result.finalText, "今天天气不错");
    assert.equal(gated.result.stopReason, "completed");
    // SC8 loop 级: 零记录之外, 历史里没有任何注入信封。
    const injected = gated.result.messages.some((m) =>
      m.content.some(
        (b) =>
          b.type === "text" &&
          (b.text.includes("[VALIDATION FAILED]") ||
            b.text.includes("[VERIFY: rerun needed]"))
      )
    );
    assert.equal(injected, false, "门关 turn 零注入信封");
    // 与 verifyConfig 缺席的裸 run 逐字节一致 (同一 runFn 形状, command 未配)。
    const { runFn: bareFn } = makeRecordingRunFn(["今天天气不错"], {
      noEvidence: true,
    });
    const bare = await runVerifyLoop(
      defaultOptions({ runFn: bareFn, config: { command: "" } })
    );
    assert.deepEqual(gated, bare, "门关结果与未配置裸 run 逐字节一致");
    assert.equal(
      projectVerifyHumanView(bare),
      undefined,
      "门关 turn 无 wire verify 字段"
    );
  });

  it("SC9 非 doc 编辑 + 零测试执行: 门开 → 进入 verify → 人类视图诚实 not_run, 永不见 passed", async () => {
    const messages: AnthropicNativeMessage[] = [
      makeNative({ role: "user", text: "改 src/foo.ts" }),
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "e1",
            name: "edit_file",
            input: { filePath: "src/foo.ts" },
          },
        ],
      },
      makeNative({ role: "assistant", text: "已改好" }),
    ];
    const runFn: VerifyLoopOptions["runFn"] = async () => ({
      result: {
        finalText: "已改好",
        messages,
        turnCount: 1,
        stopReason: "completed",
        lastUsage: null,
      },
      trace: EMPTY_TRACE,
    });
    const judge = unusedClassifier();
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        config: { command: "" },
        runClassifier: judge.runClassifier,
        completionMode: "hitl",
      })
    );
    assert.equal(judge.calls(), 0, "HITL 跳过完成判官");
    // Loop 侧诚实终态词表：HITL skip 的 EXIT 直出 not_run（不再 passed），
    // 读时投影同时仍映射 legacy passed+skip 记录（免迁移）。
    assert.equal(out.outcome, "not_run");
    assert.equal(out.records.length, 1, "门开 turn 进入 verify 子系统");
    assert.equal(out.records[0]?.reason, REASON_HITL_SKIP_COMPLETION_JUDGE);
    assert.equal(out.records[0]?.evidenceVerdict, "EVIDENCE_INSUFFICIENT");
    assert.deepEqual(
      projectVerifyHumanView({
        outcome: out.outcome,
        rounds: out.rounds,
        records: out.records,
      }),
      { outcome: "not_run", rounds: out.rounds, notRunReason: "insufficient" }
    );
  });

  // Same SC9 scenario with the PRODUCTION ACI input key (`path`, per
  // edit-file.ts / write-file.ts ALLOWED_KEYS): the gate must open on real
  // code-edit turns, not only on legacy filePath fixtures.
  it("SC9 生产形态 {input:{path}} edit-only turn: 门开 → INSUFFICIENT → wire not_run + insufficient", async () => {
    const messages: AnthropicNativeMessage[] = [
      makeNative({ role: "user", text: "改 src/foo.ts" }),
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "ep1",
            name: "edit_file",
            input: { path: "src/foo.ts", old_str: "a", new_str: "b" },
          },
        ],
      },
      makeNative({ role: "assistant", text: "已改好" }),
    ];
    const runFn: VerifyLoopOptions["runFn"] = async () => ({
      result: {
        finalText: "已改好",
        messages,
        turnCount: 1,
        stopReason: "completed",
        lastUsage: null,
      },
      trace: EMPTY_TRACE,
    });
    const judge = unusedClassifier();
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        config: { command: "" },
        runClassifier: judge.runClassifier,
        completionMode: "hitl",
      })
    );
    assert.equal(judge.calls(), 0, "HITL 跳过完成判官");
    assert.equal(out.outcome, "not_run");
    assert.equal(out.records.length, 1, "生产形态编辑信号必须开门");
    assert.equal(out.records[0]?.reason, REASON_HITL_SKIP_COMPLETION_JUDGE);
    assert.equal(out.records[0]?.evidenceVerdict, "EVIDENCE_INSUFFICIENT");
    assert.deepEqual(
      projectVerifyHumanView({
        outcome: out.outcome,
        rounds: out.rounds,
        records: out.records,
      }),
      { outcome: "not_run", rounds: out.rounds, notRunReason: "insufficient" }
    );
  });

  it("门每轮重评: round-2 消息无信号 → 门关 (禁用结果), 不再跑验证", async () => {
    let call = 0;
    const runFn: VerifyLoopOptions["runFn"] = async (userText) => {
      call += 1;
      const messages =
        call === 1
          ? [
              makeNative({ role: "user", text: userText }),
              gateRunMessage(),
              makeNative({ role: "assistant", text: "w1" }),
            ]
          : [
              // round-2 数组不含任何信号 (prior 被丢弃 — 直接构造当前轮消息)。
              makeNative({ role: "user", text: userText }),
              makeNative({ role: "assistant", text: "w2" }),
            ];
      return {
        result: {
          finalText: call === 1 ? "w1" : "w2",
          messages,
          turnCount: 1,
          stopReason: "completed",
          lastUsage: null,
        },
        trace: EMPTY_TRACE,
      };
    };
    const verify = makeScriptedVerify(
      expandRounds([{ exitCode: 1, stdout: FAIL_OUTPUT, stderr: "" }])
    );
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runVerify: verify.runVerify })
    );
    assert.equal(call, 2, "round 1 门开并 continue");
    assert.equal(verify.callCount(), 2, "只有 round 1 执行了验证阶梯");
    assert.equal(out.outcome, "disabled");
    assert.equal(out.enabled, false);
    assert.equal(out.records.length, 0);
  });

  it("门每轮重评: round-2 编辑信号被看见 (round-1 信号是测试执行, round-2 只有编辑)", async () => {
    let call = 0;
    const runFn: VerifyLoopOptions["runFn"] = async (userText) => {
      call += 1;
      const messages: AnthropicNativeMessage[] =
        call === 1
          ? [
              makeNative({ role: "user", text: userText }),
              gateRunMessage(),
              makeNative({ role: "assistant", text: "w1" }),
            ]
          : [
              makeNative({ role: "user", text: userText }),
              {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "e2",
                    name: "edit_file",
                    input: { filePath: "src/bar.ts" },
                  },
                ],
              },
              makeNative({ role: "assistant", text: "w2" }),
            ];
      return {
        result: {
          finalText: call === 1 ? "w1" : "w2",
          messages,
          turnCount: 1,
          stopReason: "completed",
          lastUsage: null,
        },
        trace: EMPTY_TRACE,
      };
    };
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
    assert.notEqual(out.outcome, "disabled", "round-2 的编辑信号必须开门");
    assert.equal(verify.callCount(), 4, "round 2 照常跑验证阶梯");
  });
});

/* ------------------------------ turn-scoped gate + checker ------------------------------ */

// The loop seeds result.messages from priorMessages, so a previous turn's green
// run sits in the array before the current turn's query. The content gate and
// the evidence checker must judge ONLY the current turn — a prior turn's green
// test cannot open this turn's gate or supply this turn's evidence.
describe("verify 门与 checker 只读当前 turn (跨 turn 绿测不越权开门)", () => {
  const greenAssistant = (id: string): AnthropicNativeMessage =>
    message(
      "assistant",
      toolUse(id, "npx vitest run"),
      toolResult(
        id,
        JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
      )
    );

  // A bash run split across the assistant tool_use and the paired user
  // tool_result, matching production message order: the tool_result-carrying
  // user message reads as a continuation, never as a new turn query.
  const bashRound = (
    id: string,
    code: number,
    stdout: string
  ): AnthropicNativeMessage[] => [
    message("assistant", toolUse(id, "npx vitest run")),
    message(
      "user",
      toolResult(id, JSON.stringify({ code, stdout, stderr: "" }))
    ),
  ];

  const outcome = (
    messages: AnthropicNativeMessage[],
    finalText: string
  ): RunOutcome => ({
    result: {
      finalText,
      messages,
      turnCount: 1,
      stopReason: "completed",
      lastUsage: null,
    },
    trace: EMPTY_TRACE,
  });

  it("上一轮的绿测不为本轮纯文本解释开门: 门关 → disabled, 与未配置逐字节一致", async () => {
    const messages: AnthropicNativeMessage[] = [
      makeNative({ role: "user", text: "跑一下测试" }),
      greenAssistant("prev-green"),
      makeNative({ role: "assistant", text: "上一轮全绿" }),
      makeNative({ role: "user", text: "那给我讲讲原理" }),
      makeNative({ role: "assistant", text: "原理是这样……" }),
    ];
    let verifyCalled = 0;
    const gated = await runVerifyLoop(
      defaultOptions({
        runFn: async () => outcome(messages, "原理是这样……"),
        runVerify: async () => {
          verifyCalled += 1;
          return { exitCode: 0, stdout: VITEST_GREEN, stderr: "" };
        },
      })
    );
    assert.equal(verifyCalled, 0, "本轮无信号 → 门关, 不得执行 verify 阶梯");
    assert.equal(gated.enabled, false);
    assert.equal(gated.outcome, "disabled");
    assert.equal(gated.rounds, 0);
    assert.equal(gated.records.length, 0);
    assert.equal(
      projectVerifyHumanView({
        outcome: gated.outcome,
        rounds: gated.rounds,
        records: gated.records,
      }),
      undefined,
      "门关 turn 无 wire verify 字段"
    );
    const bare = await runVerifyLoop(
      defaultOptions({
        runFn: async () => outcome(messages, "原理是这样……"),
        config: { command: "" },
      })
    );
    assert.deepEqual(gated, bare, "门关结果与未配置裸 run 逐字节一致");
  });

  it("绿测落在本轮: 门开且判 EVIDENCE_SUFFICIENT (防过度切片丢本轮证据)", async () => {
    const messages: AnthropicNativeMessage[] = [
      makeNative({ role: "user", text: "先闲聊一句" }),
      makeNative({ role: "assistant", text: "嗯嗯" }),
      makeNative({ role: "user", text: "帮我跑测试" }),
      greenAssistant("cur-green"),
      makeNative({ role: "assistant", text: "本轮全绿了" }),
    ];
    let verifyCalled = 0;
    const out = await runVerifyLoop(
      defaultOptions({
        runFn: async () => outcome(messages, "本轮全绿了"),
        runVerify: async () => {
          verifyCalled += 1;
          return { exitCode: 0, stdout: VITEST_GREEN, stderr: "" };
        },
      })
    );
    assert.equal(out.enabled, true, "本轮绿测必须开门");
    assert.equal(out.outcome, "passed", "本轮绿测短路判 pass");
    assert.equal(
      verifyCalled,
      0,
      "checkEvidence SUFFICIENT 短路, 不进沙箱阶梯"
    );
    assert.equal(out.rounds, 1);
  });

  it("复验轮 tool_result 续写不移动边界: 本轮先编辑不足 → 第 2 轮增长切片判绿", async () => {
    const currentTurnStart: AnthropicNativeMessage[] = [
      makeNative({ role: "user", text: "给登录加个测试" }),
    ];
    const round1: AnthropicNativeMessage[] = [
      makeNative({ role: "user", text: "先看看别的项目" }),
      greenAssistant("prior-leak-green"),
      makeNative({ role: "assistant", text: "那边全绿" }),
      ...currentTurnStart,
      ...bashRound("r1", 1, "Tests 1 failed (1)"),
      makeNative({ role: "assistant", text: "先看到失败" }),
    ];
    const round2: AnthropicNativeMessage[] = [
      ...round1,
      ...bashRound("r2", 0, VITEST_GREEN),
      makeNative({ role: "assistant", text: "这轮把测试也跑绿了" }),
    ];
    let call = 0;
    const runFn: VerifyLoopOptions["runFn"] = async () => {
      call += 1;
      return call === 1
        ? outcome(round1, "先看到失败")
        : outcome(round2, "这轮把测试也跑绿了");
    };
    const verify = makeScriptedVerify(
      expandRounds([{ exitCode: 1, stdout: FAIL_OUTPUT, stderr: "" }])
    );
    const out = await runVerifyLoop(
      defaultOptions({ runFn, runVerify: verify.runVerify })
    );
    assert.equal(call, 2, "上一轮绿测不得短路本轮, 必须真正进入第 2 轮");
    assert.equal(out.enabled, true, "增长轮仍透明运行, 切片不得塌成空数组");
    assert.equal(out.outcome, "passed", "第 2 轮在本轮增长切片上判 SUFFICIENT");
    assert.equal(out.rounds, 2);
    assert.equal(out.records[0]?.evidenceVerdict, "EVIDENCE_INSUFFICIENT");
  });
});

/* ------------------------------ not_run 注入 (spec: 未验证诚实回传) ------------------------------ */

describe("not_run 注入: 未验证终态如实回传模型, 成功路径零注入", () => {
  /** HITL edit-only turn → checker INSUFFICIENT → HITL skips the judge →
   *  terminal outcome not_run (the loop's honest vocabulary). */
  function notRunTurn(): VerifyLoopOptions["runFn"] {
    return async () => ({
      result: {
        finalText: "已改好",
        messages: [
          makeNative({ role: "user", text: "改 src/foo.ts" }),
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "e1",
                name: "edit_file",
                input: { filePath: "src/foo.ts" },
              },
            ],
          },
          makeNative({ role: "assistant", text: "已改好" }),
        ],
        turnCount: 1,
        stopReason: "completed",
        lastUsage: null,
      },
      trace: EMPTY_TRACE,
    });
  }

  /** Trailing injected verify envelopes carried by a result's message list. */
  function injectedTexts(
    messages: ReadonlyArray<AnthropicNativeMessage>
  ): ReadonlyArray<string> {
    return messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
      .filter((t) => isVerifyInjectedText(t));
  }

  it("未验证终态: 恰好一条注入信封, 文案说明未验证并建议跑测试", async () => {
    const judge = { calls: 0 };
    const out = await runVerifyLoop(
      defaultOptions({
        runFn: notRunTurn(),
        config: { command: "" },
        completionMode: "hitl",
        runClassifier: async () => {
          judge.calls += 1;
          throw new Error("HITL 不得生成判官");
        },
      })
    );
    assert.equal(judge.calls, 0, "HITL 跳过完成判官");
    assert.equal(out.outcome, "not_run");

    const texts = injectedTexts(out.result.messages);
    assert.equal(texts.length, 1, "not_run 终态恰好注入一条信封");
    const text = texts[0]!;
    assert.ok(
      text.startsWith(NOT_RUN_PREFIX),
      `前缀必须是 ${NOT_RUN_PREFIX}, 实际: ${text.slice(0, 40)}`
    );
    // Honest "not verified" meaning, not a pass and not a failure.
    assert.match(text, /not verified/i);
    assert.match(text, /not passed and not failed/i);
    // Suggests running the tests.
    assert.match(text, /run the project's tests/i);
    // Never reuses the other envelopes' obligations.
    assert.equal(text.includes("VALIDATION FAILED"), false);
    assert.equal(text.includes("[VERIFY: rerun needed]"), false);
    assert.equal(text.includes("Fix the failures above"), false);
  });

  it("成功终态 passed: 零注入 (模型已知自己的命令退出 0, 不加噪)", async () => {
    const deps = makeDeps([
      assistantResult({
        texts: ["ran the suite"],
        toolCalls: [{ id: "g1", name: "bash", input: { command: "npm test" } }],
        supplierStop: "success",
      }),
      assistantResult({
        texts: ["I fixed it, all tests pass."],
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
    assert.equal(out.outcome, "passed", "证据充分 → passed 终态");
    assert.equal(out.rounds, 1, "SUFFICIENT 证据单轮短路");
    // The success terminal injects nothing. (This turn legitimately carries the
    // earlier round's [VALIDATION FAILED] correction envelope — what must never
    // appear is the not-verified one.)
    assert.equal(
      injectedTexts(out.result.messages).some((t) =>
        t.startsWith(NOT_RUN_PREFIX)
      ),
      false,
      "passed 终态绝不注入未验证信封"
    );
  });

  it("无 verify.command 配置时终态: 信封不编造命令 (classifier 分支的 not_run)", async () => {
    // VerifyConfig.command is a required string; the classifier branch (the
    // only producer of not_run) runs with command="" — so THIS is the
    // "no command configured" shape. The copy must say so rather than invent
    // one: naming an unrunnable command would be a second, subtler lie.
    const out = await runVerifyLoop(
      defaultOptions({
        runFn: notRunTurn(),
        config: { command: "" },
        completionMode: "hitl",
        runClassifier: async () => {
          throw new Error("HITL 不得生成判官");
        },
      })
    );
    assert.equal(out.outcome, "not_run");
    const text = injectedTexts(out.result.messages)[0]!;
    assert.match(text, /no verify command is configured/i);
    // And it must not borrow the rerun envelope's `  <command>` indents.
    assert.equal(/\n {2}\S/.test(text), false, "无命令时不得编造命令行");
  });

  it("注入文案被识别为注入信封 (round-2 过滤不当作模型自撰内容)", async () => {
    const out = await runVerifyLoop(
      defaultOptions({
        runFn: notRunTurn(),
        config: { command: "" },
        completionMode: "hitl",
        runClassifier: async () => {
          throw new Error("HITL 不得生成判官");
        },
      })
    );
    const text = injectedTexts(out.result.messages)[0]!;
    // Recognition by the producer's own predicate (single SSOT).
    assert.equal(isVerifyInjectedText(text), true);
    // Host-injection roster: the outbound projection neutralizes untrusted
    // user text, so the prefix only survives if the roster knows it.
    assert.equal(isHostInjectedUserText(text), true);
    // Leading-whitespace tolerance (same trimStart discipline as the siblings).
    assert.equal(isVerifyInjectedText(`\n  ${text}`), true);
    // TUI: never renders as a typed user bubble.
    assert.equal(isTuiHiddenUserMessage(out.result.messages.at(-1)!), true);
    // Host-injected stamp, so the anchor is not stripped on the wire
    // (ADR-0112 Decision 1 invariant 2, same as the failure envelope).
    assert.equal(out.result.messages.at(-1)!.hostInjected, true);
  });

  it("模型真的收到该信封 (真实 run(): 下一轮的输入历史含未验证文案)", async () => {
    // The terminal site returns immediately, so the envelope cannot ride a
    // next-round priorMessages the way the failure envelope does. This case
    // pins the real delivery path instead: the host persists result.messages
    // and the next turn seeds the model from that history. Drive two REAL
    // run() turns — turn 1 produces the not_run terminal, turn 2 is a fresh
    // run seeded from turn 1's persisted history — and assert the model
    // actually READ the text (recorded from the adapter's own input, not from
    // a builder return value).
    const seenByModel: string[][] = [];
    let call = 0;
    const deps: LoopEngineDeps = {
      ...makeDeps([]),
      adapter: {
        ...makeDeps([]).adapter,
        async step(state) {
          call += 1;
          // Record EVERY user frame the model is actually shown on this call
          // (not just the last one): the injected envelope sits in history
          // immediately BEFORE the new query, so a "last user text" probe
          // would miss it and report a false negative.
          seenByModel.push(
            state.messages
              .filter((m) => m.role === "user")
              .map((m) =>
                m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
              )
          );
          if (call === 1) {
            // Turn 1: an edit-only claim (opens the gate, no test evidence).
            return assistantResult({
              texts: ["已改好"],
              toolCalls: [
                {
                  id: "e1",
                  name: "edit_file",
                  input: { filePath: "src/foo.ts" },
                },
              ],
            });
          }
          return assistantResult({ texts: ["已运行测试"] });
        },
      },
      maxTurns: 4,
    };

    // runFn delegates to the REAL run() for the first turn; the loop's own
    // second (nonexistent) round is not reached — not_run terminates.
    const out = await runVerifyLoop({
      runFn: async (text, opts) => {
        const r = await run(text, deps, opts?.signal, {
          ...(opts?.priorMessages !== undefined
            ? { priorMessages: opts.priorMessages }
            : {}),
        });
        return { result: r.result, trace: r.trace };
      },
      userText: "改 src/foo.ts",
      config: { command: "" },
      sessionId: "notrun-seam",
      completionMode: "hitl",
      runClassifier: async () => {
        throw new Error("HITL 不得生成判官");
      },
      cwd: process.cwd(),
    });
    assert.equal(out.outcome, "not_run");

    // Turn 2: a fresh real run seeded from turn 1's persisted history — the
    // host hand-off the terminal injection exists for.
    const turn2 = await run("继续", deps, undefined, {
      priorMessages: out.result.messages,
    });
    assert.equal(turn2.result.stopReason, "completed");
    // The LAST model call is the one seeded from turn 1's history — that is
    // where the envelope must be visible.
    const lastCallFrames = seenByModel[seenByModel.length - 1] ?? [];
    assert.ok(
      lastCallFrames.some((t) => isVerifyInjectedText(t)),
      `模型必须真的读到未验证信封, 实际输入: ${JSON.stringify(seenByModel)}`
    );
    assert.ok(
      lastCallFrames.some((t) => t.startsWith(NOT_RUN_PREFIX)),
      "模型读到的必须是 [VERIFY: not verified] 前缀的那一条"
    );
    // Turn 1 never saw it (it is injected only after that turn terminated) —
    // the honest boundary, and proof this is not a pre-echoed message.
    assert.equal(
      (seenByModel[0] ?? []).some((t) => t.startsWith(NOT_RUN_PREFIX)),
      false,
      "注入发生在终态之后, 第一轮模型不得提前看到"
    );
  });

  it("非触发 turn 仍零注入 (门关 → 与 not_run 严格区分, 不回归)", async () => {
    const { runFn, calls } = makeRecordingRunFn(["今天天气不错"], {
      noEvidence: true,
    });
    const gated = await runVerifyLoop(
      defaultOptions({
        runFn,
        runVerify: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      })
    );
    assert.equal(gated.outcome, "disabled");
    assert.equal(calls().length, 1);
    // Zero verify envelopes of ANY kind — the gate case is transparent, and
    // strictly distinct from not_run (which means the turn DID enter verify).
    assert.deepEqual(injectedTexts(gated.result.messages), []);
  });
});

/* ------------------------------ CONTRADICTED 信封点名实际作者 ------------------------------ */

// The goal-feature CONTRADICTED veto is produced by the checker, before and
// without the completion-facing judge. The correction-round envelope it injects
// must therefore name the checker and carry the checker's own reasons; naming
// the classifier there tells the model a judge read its work when none ran.
describe("goal-mode CONTRADICTED: 修正轮信封点名 checker, 判官零调用", () => {
  /** Green vitest run, then the test file emptied through the production
   *  `path` key — the binary-contradiction shape. */
  function contradictedMessages(
    greenId: string,
    writeId: string
  ): AnthropicNativeMessage[] {
    return [
      makeNative({ role: "user", text: "make the suite green" }),
      message(
        "assistant",
        toolUse(greenId, "npx vitest run"),
        toolResult(
          greenId,
          JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
        )
      ),
      message("assistant", {
        type: "tool_use",
        id: writeId,
        name: "write_file",
        input: { path: "src/foo.test.ts", content: "" },
      }),
      makeNative({ role: "assistant", text: "全部测试通过了" }),
    ];
  }

  /** Injected verify envelopes carried by a result's message list. */
  function injectedEnvelopeTexts(
    messages: ReadonlyArray<AnthropicNativeMessage>
  ): ReadonlyArray<string> {
    return messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
      .filter((t) => isVerifyInjectedText(t));
  }

  it("信封 source=checker + checker 原因; classifier 一次都没跑", async () => {
    const priors: Array<ReadonlyArray<AnthropicNativeMessage>> = [];
    const runFn: VerifyLoopOptions["runFn"] = async (_userText, runOpts) => {
      priors.push(runOpts?.priorMessages ?? []);
      const call = priors.length - 1;
      const stopReason: RunResult["stopReason"] =
        call === 0 ? "completed" : "maxTurns";
      return {
        result: {
          finalText: stopReason === "completed" ? "全部测试通过了" : null,
          messages: contradictedMessages("c-green", "c-clear"),
          turnCount: 1,
          stopReason,
          lastUsage: null,
        },
        trace: EMPTY_TRACE,
      };
    };
    const judge = { calls: 0 };
    const runClassifier: RunClassifierFn = async () => {
      judge.calls += 1;
      throw new Error("CONTRADICTED 否决必须在判官之前短路");
    };

    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier,
        config: { command: "" },
        completionMode: "goal",
      })
    );

    assert.equal(
      judge.calls,
      0,
      "checker 否决的修正轮绝不启动完成判官 (本轮的全部要点)"
    );
    assert.equal(out.outcome, "failed", "第 2 轮 maxTurns 原样透传");
    assert.equal(out.rounds, 1, "CONTRADICTED 短路一轮");
    assert.equal(out.records[0]?.verdict, "true-failure");

    const injected = priors[1] ?? [];
    const lastUser = [...injected].reverse().find((m) => m.role === "user");
    const envelope = lastUser
      ? lastUser.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      : "";
    assert.ok(
      envelope.includes("[VALIDATION FAILED]"),
      `修正轮必须带失败信封, 实际: ${JSON.stringify(envelope)}`
    );
    assert.ok(
      envelope.includes("source=checker"),
      `信封必须点名 checker, 实际: ${envelope}`
    );
    assert.equal(
      envelope.includes("source=classifier"),
      false,
      "判官没跑, 信封不得宣称 source=classifier"
    );
    assert.ok(
      envelope.includes(
        "reason: test files cleared or removed (binary contradiction)"
      ),
      `信封必须携带 checker 自己的原因, 实际: ${envelope}`
    );
    assert.equal(
      envelope.includes("classifier reported failure"),
      false,
      "不得编造判官原因"
    );
  });

  it("HITL CONTRADICTED 终态: 未验证信封报告记录里的冲突, 不再宣称缺配置", async () => {
    // The same contradicted transcript under HITL ends at the not_run terminal
    // (ADR-0073 rule 3). The record's own evidenceVerdict is the conflict, so
    // the envelope must report it — the no-command sentence is a claim about
    // configuration this record never made.
    const runFn: VerifyLoopOptions["runFn"] = async () => ({
      result: {
        finalText: "全部测试通过了",
        messages: contradictedMessages("h-green", "h-clear"),
        turnCount: 1,
        stopReason: "completed",
        lastUsage: null,
      },
      trace: EMPTY_TRACE,
    });
    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        config: { command: "" },
        completionMode: "hitl",
        runClassifier: async () => {
          throw new Error("HITL 不得生成判官");
        },
      })
    );

    assert.equal(out.outcome, "not_run");
    assert.equal(
      out.records[0]?.evidenceVerdict,
      "EVIDENCE_CONTRADICTED",
      "记录本身必须带着冲突判定 (信封叙述的权威来源)"
    );
    const text = injectedEnvelopeTexts(out.result.messages)[0]!;
    assert.ok(
      text.startsWith(NOT_RUN_PREFIX),
      `前缀不变, 实际: ${text.slice(0, 40)}`
    );
    assert.equal(
      text.includes("No verify command is configured"),
      false,
      `冲突记录不得被回一个配置缺失的说法\n---\n${text}`
    );
    assert.ok(
      text.includes("test files cleared or removed (binary contradiction)"),
      `信封必须带上 checker 报出的冲突原因\n---\n${text}`
    );
    assert.match(text, /not passed and not failed/i);
  });
});

/* ------------------------------ 自动探测取路径: 生产键端到端 ------------------------------ */

describe("自动探测取路径: 标志文件经 loop 派生复验命令并注入复验信封", () => {
  /** Loop 注入的 verify 信封文本 (user 角色消息)。 */
  function injectedUserTexts(
    messages: ReadonlyArray<AnthropicNativeMessage>
  ): ReadonlyArray<string> {
    return messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
      .filter((t) => isVerifyInjectedText(t));
  }

  /**
   * Round 1 = only `blocks` (the probe turn, no test execution), round 2
   * answers whatever the loop injected with the green run of `green`. The
   * priorMessages of every call are recorded so a case can read what the loop
   * actually injected into the model's next turn.
   */
  function probeThenGreen(opts: {
    readonly blocks: ReadonlyArray<AnthropicContentBlock>;
    readonly green: { readonly command: string; readonly stdout: string };
  }): {
    readonly runFn: VerifyLoopOptions["runFn"];
    readonly priors: Array<ReadonlyArray<AnthropicNativeMessage>>;
  } {
    const priors: Array<ReadonlyArray<AnthropicNativeMessage>> = [];
    const runFn: VerifyLoopOptions["runFn"] = async (_userText, runOpts) => {
      const prior = runOpts?.priorMessages ?? [];
      priors.push(prior);
      const id = `green-${priors.length}`;
      const messages: AnthropicNativeMessage[] =
        priors.length === 1
          ? [
              makeNative({ role: "user", text: "把这个项目跑起来" }),
              message("assistant", ...opts.blocks),
              makeNative({ role: "assistant", text: "改完了" }),
            ]
          : [
              ...prior,
              message(
                "assistant",
                toolUse(id, opts.green.command),
                toolResult(
                  id,
                  JSON.stringify({
                    code: 0,
                    stdout: opts.green.stdout,
                    stderr: "",
                  })
                )
              ),
              makeNative({ role: "assistant", text: "测试跑完了" }),
            ];
      return {
        result: {
          finalText: "改完了",
          messages,
          turnCount: 1,
          stopReason: "completed",
          lastUsage: null,
        },
        trace: EMPTY_TRACE,
      };
    };
    return { runFn, priors };
  }

  /** 判官计数桩: 复验信封短路时它一次都不该被唤起。 */
  function countingJudge(calls: { n: number }): RunClassifierFn {
    return async () => {
      calls.n += 1;
      return {
        status: "ok",
        result: JSON.stringify({
          kind: "pass",
          reason: "判官不该被唤起",
          evidence: [],
        }),
        summary: "no",
      };
    };
  }

  it("生产键 {input:{path}} 写 package.json(vitest): 经 loop 派生复验命令并注入复验信封", async () => {
    const content = JSON.stringify({
      name: "x",
      devDependencies: { vitest: "^1.0.0" },
    });
    const write = writeFile("p1", "package.json", content);
    // fixture 必须真的发生产键, 否则本例悄悄退化成 legacy 路径的复测。
    const input = (write as { input: Record<string, unknown> }).input;
    assert.equal(input.path, "package.json", "fixture 发出的必须是生产键 path");
    assert.equal(input.filePath, undefined, "生产形态不发 legacy 键");

    const { runFn, priors } = probeThenGreen({
      blocks: [write],
      green: { command: "npx vitest run", stdout: VITEST_GREEN },
    });
    const judge = { n: 0 };

    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier: countingJudge(judge),
        config: { command: "" },
      })
    );

    assert.equal(priors.length, 2, "派生出复验命令 → 恰好一次复验续跑");
    const envelope = injectedUserTexts(priors[1] ?? [])[0] ?? "";
    assert.ok(
      envelope.startsWith(EVIDENCE_RERUN_PREFIX),
      `复验轮必须收到复验信封, 实际: ${JSON.stringify(envelope.slice(0, 40))}`
    );
    assert.ok(
      envelope.includes("\n  npx vitest run\n"),
      `信封必须点名派生的复验命令, 实际: ${envelope}`
    );
    assert.equal(judge.n, 0, "复验信封短路本轮, 判官零调用");
    assert.equal(out.outcome, "passed", "复验轮补上绿灯 → 直接通过");
    assert.deepEqual(
      injectedUserTexts(out.result.messages),
      [envelope],
      "复验信封留在 loop 的注入输出里"
    );
  });

  it("legacy {input:{filePath}} 写 pyproject.toml: 仍派生 pytest 复验命令并注入复验信封", async () => {
    // 内联构造: fixture builder 现在发生产键, 走它就测不到 legacy 分支。
    const { runFn, priors } = probeThenGreen({
      blocks: [
        {
          type: "tool_use",
          id: "l1",
          name: "write_file",
          input: {
            filePath: "pyproject.toml",
            content: "[tool.pytest.ini_options]",
          },
        },
      ],
      green: { command: "pytest", stdout: "3 passed in 0.20s\n" },
    });
    const judge = { n: 0 };

    const out = await runVerifyLoop(
      defaultOptions({
        runFn,
        runClassifier: countingJudge(judge),
        config: { command: "" },
      })
    );

    assert.equal(
      priors.length,
      2,
      "legacy 键同样派生出复验命令 → 一次复验续跑"
    );
    const envelope = injectedUserTexts(priors[1] ?? [])[0] ?? "";
    assert.ok(
      envelope.startsWith(EVIDENCE_RERUN_PREFIX),
      `复验轮必须收到复验信封, 实际: ${JSON.stringify(envelope.slice(0, 40))}`
    );
    assert.ok(
      envelope.includes("\n  pytest\n"),
      `信封必须点名派生的 pytest 复验命令, 实际: ${envelope}`
    );
    assert.equal(judge.n, 0, "复验信封短路本轮, 判官零调用");
    assert.equal(out.outcome, "passed", "复验轮补上绿灯 → 直接通过");
  });

  it("普通源文件路径不贡献探测候选: 不派生复验命令, 本轮直接落完成判官", async () => {
    let runCalls = 0;
    const runFn: VerifyLoopOptions["runFn"] = async () => {
      runCalls += 1;
      return {
        result: {
          finalText: "改完了",
          messages: [
            makeNative({ role: "user", text: "改一下 src/foo.ts" }),
            message("assistant", {
              type: "tool_use",
              id: "n1",
              name: "edit_file",
              input: { path: "src/foo.ts", old_str: "a", new_str: "b" },
            }),
            makeNative({ role: "assistant", text: "改完了" }),
          ],
          turnCount: 1,
          stopReason: "completed",
          lastUsage: null,
        },
        trace: EMPTY_TRACE,
      };
    };
    let judgeCalls = 0;
    const runClassifier: RunClassifierFn = async () => {
      judgeCalls += 1;
      return {
        status: "ok",
        result: JSON.stringify({
          kind: "unverified",
          reason: "证据不足, 不猜",
        }),
        summary: "no",
      };
    };

    const out = await runVerifyLoop(
      defaultOptions({ runFn, runClassifier, config: { command: "" } })
    );

    assert.equal(runCalls, 1, "无探测候选 → 没有复验续跑, runFn 只跑一次");
    assert.equal(judgeCalls, 1, "派生出 null → 本轮直接落完成判官");
    assert.equal(out.outcome, "unstable", "判官拒判 → unstable 停机");
    assert.equal(
      out.records[0]?.evidenceVerdict,
      "EVIDENCE_INSUFFICIENT",
      "本轮证据判定原样落记录"
    );
    assert.deepEqual(
      injectedUserTexts(out.result.messages),
      [],
      "零注入信封 (既不复验也不训斥)"
    );
  });
});
