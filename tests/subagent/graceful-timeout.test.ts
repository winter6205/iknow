/**
 * #358 T3 — SIGTERM 优雅收尾 (graceful closeout) 专项。
 *
 * 覆盖三面:
 *   A. worker 侧 runWorkerOnce:进程收 SIGTERM → AbortController.abort
 *      ("subagent-timeout") → run() 返回 stopReason=cancelled →
 *      以**未中止的新 signal** 自跑一轮收尾摘要(reason: "timeout")
 *      捕获 stop_summary → toFailedEnvelope("timeout", summary)
 *      → stdout + exit 0 (runSubagentWorker 既有形态)。
 *        - 摘要轮成功 → summary 非空;
 *        - 摘要轮抛错 / 超时 → envelope 仍写 (D3 失败跳过不阻塞)。
 *   B. manager 侧优雅窗口:timeout SIGTERM 后、SIGKILL(5s)前,子进程
 *      在 stdout 上写回 timeout envelope → stdout handler 的
 *      `task.envelope = env` 用子进程信封**替换** fallback 信封
 *      (child summary 优先于 generic "timeout after <n>ms"),reason
 *      = timeout 不被 crashed 覆盖 (exit handler `timedOut` guard)。
 *   C. SIGKILL 兜底回归:子进程忽略 SIGTERM → 5s 后 SIGKILL,reason 仍
 *      = timeout (SC6 / #356 高优 fix)。
 *
 * envelope.ts / loop-engine.ts 语义冻结,测试只断言 worker/manager 侧
 * 行为映射,不触碰冻结面。
 *
 * SIGTERM 触发方式: 单测进程不可真发 SIGTERM(会杀掉 vitest fork 自身),
 * 沿用 tests/cli/register-shutdown.test.ts 先例 `process.emit("SIGTERM")`
 * 同步触发已注册 listener —— 与真实投递共享同一 listener 代码路径。
 * 时序: 先调 runWorkerOnce(其同步前奏注册 SIGTERM handler),随后同步
 * emit → controller 立即 abort → run() 首轮 raceModel 在创建点看到
 * signal.aborted → callerAbort → cancelled(与真实收 SIGTERM 同路径)。
 */
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type {
  AssistantTurnResult,
  ModelAdapter,
} from "../../src/harness/model-adapter/types.ts";
import { ProtocolError } from "../../src/harness/errors.ts";
import {
  runWorkerOnce,
  toFailedEnvelope,
  isSubagentTimeoutAbort,
} from "../../src/harness/subagent/worker.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import { assistantResult } from "../cli/_fixtures.ts";

// ---------------------------------------------------------------------------
// makeDeps: stub adapter + 最小 loop deps(与 worker.test.ts 同构)。
// ---------------------------------------------------------------------------

function makeDeps(adapter: ModelAdapter): LoopEngineDeps {
  return {
    adapter,
    executor: undefined as never,
    registry: {
      list: () => [],
      get: () => undefined,
    },
    system: () => undefined,
    promptTools: () => [],
  } as unknown as LoopEngineDeps;
}

/** scripted adapter:每次 step 调用走同一条脚本(调用序 = callIndex)。 */
function createScriptedAdapter(
  script: (callIndex: number) => Promise<AssistantTurnResult>
): ModelAdapter {
  let calls = 0;
  return {
    step: async () => script(calls++),
    streamMode: false,
    encodeUserText: (text: string) => ({
      role: "user",
      content: [{ type: "text", text }],
    }),
    encodeToolResults: () => [],
  } as unknown as ModelAdapter;
}

// ---------------------------------------------------------------------------
// A1. isSubagentTimeoutAbort — 纯谓词(判定线:signal.reason ===
//     "subagent-timeout";非本 abort 的 cancelled 不误标)。
// ---------------------------------------------------------------------------

describe("subagent graceful timeout: isSubagentTimeoutAbort 纯谓词", () => {
  it("abort reason = subagent-timeout → true", () => {
    const ctrl = new AbortController();
    ctrl.abort("subagent-timeout");
    assert.equal(isSubagentTimeoutAbort(ctrl.signal), true);
  });

  it("其他 abort reason / 未 abort → false", () => {
    const other = new AbortController();
    other.abort("user-cancel");
    assert.equal(isSubagentTimeoutAbort(other.signal), false);
    assert.equal(isSubagentTimeoutAbort(new AbortController().signal), false);
  });

  it("run 停因 cancelled 但 signal 未 abort → false(tool 侧 cancelled 不误标)", () => {
    const ctrl = new AbortController();
    assert.equal(isSubagentTimeoutAbort(ctrl.signal), false);
  });
});

// ---------------------------------------------------------------------------
// A2. toFailedEnvelope(reason, summary?) — optional summary additive:
//     无 summary 时行为与旧签名逐位一致(空串),不 breaking 既有 callers。
// ---------------------------------------------------------------------------

describe("subagent graceful timeout: toFailedEnvelope 携带 summary (additive)", () => {
  it("带 summary → 透传", () => {
    const env = toFailedEnvelope("timeout", "partial progress captured");
    assert.deepEqual(env, {
      status: "failed",
      reason: "timeout",
      summary: "partial progress captured",
      result: "",
    });
  });

  it("不带 summary → 空串(旧行为不变)", () => {
    const env = toFailedEnvelope("timeout");
    assert.deepEqual(env, {
      status: "failed",
      reason: "timeout",
      summary: "",
      result: "",
    });
  });
});

// ---------------------------------------------------------------------------
// B. runWorkerOnce 集成 — SIGTERM → 优雅收尾信封 (SC6 核心):
//    exit code 0 的协议承载 = stdout newline-JSON envelope (runSubagentWorker
//    形态);此处断言 envelope 内容 + 摘要。manager 侧见 C。
// ---------------------------------------------------------------------------

describe("subagent graceful timeout: runWorkerOnce SIGTERM 优雅收尾", () => {
  const baseEnvelope: WorkerEnvelope = {
    task: "task that will be timed out",
    sandboxRoot: "/tmp/sb",
  };

  it("摘要轮成功 → envelope {failed, timeout, summary 非空}", async () => {
    // 主回路 step(被立即 abort 丢弃)与收尾摘要 step 都返回同一摘要文本;
    // run() 因 signal.aborted → callerAbort → cancelled;worker 自跑摘要轮。
    const adapter = createScriptedAdapter(async () =>
      assistantResult({
        texts: ["completed most of the task before timeout"],
        toolCalls: [],
      })
    );
    const p = runWorkerOnce({
      workerEnvelope: baseEnvelope,
      deps: makeDeps(adapter),
    });
    // 同步触发:runWorkerOnce 同步前奏已注册 SIGTERM handler。
    process.emit("SIGTERM");
    const env = await p;
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "timeout");
    assert.equal(env.summary, "completed most of the task before timeout");
  });

  it("摘要轮抛错 → 仍写 {failed, timeout},summary 空,不崩 (D3)", async () => {
    // 主回路 step 被丢弃;收尾摘要 step 抛 ProtocolError → runSummaryWithTimeout
    // catch-all 收敛 null → summary 空,envelope 照常写。
    const adapter = createScriptedAdapter(async (callIndex) => {
      if (callIndex >= 1) {
        throw new ProtocolError("summary round synthetic failure");
      }
      return assistantResult({ texts: ["main"], toolCalls: [] });
    });
    const p = runWorkerOnce({
      workerEnvelope: baseEnvelope,
      deps: makeDeps(adapter),
    });
    process.emit("SIGTERM");
    const env = await p;
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "timeout");
    assert.equal(env.summary, "");
  });
});

// ---------------------------------------------------------------------------
// C. manager 侧优雅窗口 + SIGKILL 兜底(沿用 manager.test.ts fake child 形态)。
// ---------------------------------------------------------------------------

interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  once: (event: string | symbol, ...args: unknown[]) => unknown;
}

function makeFakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    kill,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as FakeChild;
}

function makeHarness(opts: { readonly taskTimeoutMs?: number } = {}) {
  const spawned: FakeChild[] = [];
  const manager = createSubAgentManager({
    spawn: () => {
      const child = makeFakeChild();
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
    ...(opts.taskTimeoutMs !== undefined
      ? { taskTimeoutMs: opts.taskTimeoutMs }
      : {}),
  });
  return { manager, spawned };
}

/** 在 stdout 上写 timeout envelope 后随 SIGTERM 退出(模拟 worker 优雅收尾)。 */
function emitTimeoutEnvelope(child: FakeChild, summary: string): void {
  const env: SubAgentEnvelope = {
    status: "failed",
    reason: "timeout",
    summary,
    result: "",
  };
  child.stdout.write(JSON.stringify(env) + "\n");
  child.emit("exit", null, "SIGTERM");
}

describe("subagent graceful timeout: manager 优雅窗口 (子信封替换 fallback)", () => {
  it("timeout 后、SIGKILL 前 child stdout 写回 timeout envelope → summary = child 的 (非 generic)", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({ timeoutMs: 50 });
      // 50ms timeout 触发 → fallback envelope + SIGTERM
      await vi.advanceTimersByTimeAsync(50);
      let q = manager.queryBuffer(taskId);
      assert.equal(q.status, "failed");
      if (q.status === "failed") {
        assert.equal(q.reason, "timeout");
        assert.match(q.summary, /timeout after 50ms/);
      }
      assert.deepEqual(
        spawned[0]!.kill.mock.calls.map((c) => c[0]),
        ["SIGTERM"]
      );

      // 优雅窗口内 child 写出自己的 timeout envelope(含真实进度摘要)
      emitTimeoutEnvelope(
        spawned[0]!,
        "worker-level graceful summary: got half the way"
      );
      q = manager.queryBuffer(taskId);
      assert.equal(q.status, "failed");
      if (q.status === "failed") {
        assert.equal(q.reason, "timeout", "reason 不被 crashed 覆盖");
        assert.equal(
          q.summary,
          "worker-level graceful summary: got half the way",
          "summary = child envelope(替换 generic fallback)"
        );
      }
      // SIGKILL 兜底窗口(5s)尚未执行 → 无第二信号
      assert.deepEqual(
        spawned[0]!.kill.mock.calls.map((c) => c[0]),
        ["SIGTERM"]
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("SIGKILL 兜底回归:child 忽略 SIGTERM → 5s 后 SIGKILL,reason 仍 = timeout", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({ timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      // child 不退出(忽略 SIGTERM)→ SIGKILL 兜底 5s 后发
      await vi.advanceTimersByTimeAsync(5000);
      const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      // SIGKILL 被杀 → exit handler timedOut guard 保 reason
      spawned[0]!.emit("exit", null, "SIGKILL");
      const q = manager.queryBuffer(taskId);
      assert.equal(q.status, "failed");
      if (q.status === "failed") {
        assert.equal(q.reason, "timeout");
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// D. review-fix (Fix 2): emitStateChange self-loop guard —— timeout 路径
//    timer fire (running→failed) 后, stdout handler 收到 worker 的 timeout
//    envelope 再次 emitStateChange (failed→failed) 是 spurious 自环, 不得
//    再落一条 from_state === to_state === "failed" 的 subagent_state_change。
//    断言真实 jsonl 中不存在该 spurious 记录, 且迁移序列只含真实迁移。
// ---------------------------------------------------------------------------

describe("subagent graceful timeout: emitStateChange self-loop guard (Fix 2)", () => {
  it("timeout → failed→failed 自环不落盘 (jsonl 无 from_state===to_state==='failed')", async () => {
    vi.useFakeTimers();
    const scratchDir = mkdtempSync(join(tmpdir(), "iknow-trace-sloop-"));
    try {
      const trace = createJsonlTraceService({
        filePath: scratchDir,
        conversationId: "conv-self-loop",
      });
      const spawned: FakeChild[] = [];
      const manager = createSubAgentManager({
        spawn: (_def, _taskId, _payload) => {
          const child = makeFakeChild();
          spawned.push(child);
          return child as unknown as ChildProcess;
        },
        trace,
      });
      // 短 timeout 触发 timer fire: starting→running (spawn) → failed (timer)
      const { taskId } = manager.spawn({ timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      // 优雅窗口内 child 写回 timeout envelope → stdout handler 再次
      // emitStateChange("failed") —— 自环应被 guard 吞掉, 不落盘。
      emitTimeoutEnvelope(spawned[0]!, "worker graceful summary");
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(manager.queryBuffer(taskId).status, "failed");
      const filePath = join(scratchDir, "conv-self-loop.jsonl");
      const content = readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      const stateChanges = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((r) => r.record_type === "subagent_state_change");
      assert.ok(
        stateChanges.length >= 1,
        `expected >=1 state_change, got ${stateChanges.length}`
      );
      for (const rec of stateChanges) {
        assert.notEqual(
          rec.from_state,
          rec.to_state,
          `no self-loop state_change (found from=${rec.from_state} to=${rec.to_state})`
        );
        assert.ok(
          !(rec.from_state === "failed" && rec.to_state === "failed"),
          "failed→failed 自环记录存在"
        );
      }
      // 真实迁移序列仍完整: starting→running + running→failed 各一条。
      assert.ok(
        stateChanges.some(
          (r) => r.from_state === "starting" && r.to_state === "running"
        ),
        "starting→running 迁移存在"
      );
      assert.ok(
        stateChanges.some(
          (r) => r.from_state === "running" && r.to_state === "failed"
        ),
        "running→failed 迁移存在"
      );
    } finally {
      vi.useRealTimers();
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
