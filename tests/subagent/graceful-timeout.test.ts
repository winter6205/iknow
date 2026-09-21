/**
 * SIGTERM graceful closeout — dedicated tests.
 *
 * Covers three surfaces:
 *   A. worker-side runWorkerOnce: process receives SIGTERM → AbortController.abort
 *      ("subagent-timeout") → run() returns stopReason=cancelled →
 *      self-runs one summary round with a **fresh, unaborted signal** (reason: "timeout")
 *      captures stop_summary → toFailedEnvelope("timeout", summary)
 *      → stdout + exit 0 (runSubagentWorker's existing shape).
 *        - summary round succeeds → non-empty summary;
 *        - summary round throws / times out → envelope still written (failure-skip must not block).
 *   B. manager-side graceful window: after timeout SIGTERM and before SIGKILL(5s),
 *      the child writes a timeout envelope back on stdout → the stdout handler's
 *      `task.envelope = env` **replaces** the fallback envelope with the child's
 *      (child summary wins over generic "timeout after <n>ms"); reason = timeout
 *      is not overwritten by crashed (exit handler `timedOut` guard).
 *   C. SIGKILL fallback regression: child ignores SIGTERM → SIGKILL after 5s,
 *      reason still = timeout.
 *
 * envelope.ts / loop-engine.ts semantics are frozen; tests only assert the
 * worker/manager-side behavior mapping, never touching the frozen surface.
 *
 * SIGTERM trigger: the test process cannot really receive SIGTERM (it would
 * kill the vitest fork itself); following the tests/cli/register-shutdown.test.ts
 * precedent, `process.emit("SIGTERM")` synchronously fires the registered
 * listener — sharing the same listener code path as real delivery.
 * Timing: call runWorkerOnce first (its synchronous preamble registers the
 * SIGTERM handler), then emit synchronously → the controller aborts immediately
 * → run()'s first raceModel sees signal.aborted at the creation point →
 * callerAbort → cancelled (same path as a real SIGTERM).
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
// makeDeps: stub adapter + minimal loop deps (same shape as worker.test.ts).
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

/** scripted adapter: each step call walks the same script (call order = callIndex). */
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
// A1. isSubagentTimeoutAbort — pure predicate (decision line:
//     signal.reason === "subagent-timeout"; cancelled not caused by this
//     abort must not be mislabeled).
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
//     without summary the behavior is bit-identical to the old signature (empty
//     string), not breaking existing callers.
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
// B. runWorkerOnce integration — SIGTERM → graceful closeout envelope:
//    protocol carrier with exit code 0 = stdout newline-JSON envelope (runSubagentWorker
//    shape); here assert envelope content + summary. Manager side: see C.
// ---------------------------------------------------------------------------

describe("subagent graceful timeout: runWorkerOnce SIGTERM 优雅收尾", () => {
  const baseEnvelope: WorkerEnvelope = {
    task: "task that will be timed out",
    sandboxRoot: "/tmp/sb",
  };

  it("摘要轮成功 → envelope {failed, timeout, summary 非空}", async () => {
    // The main-loop step (aborted immediately) and the closeout-summary step
    // return the same summary text; run() observes signal.aborted → callerAbort
    // → cancelled, and the worker runs the summary round itself.
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
    // Triggered synchronously: runWorkerOnce registers its SIGTERM handler during
    // the synchronous prologue, so emitting here is already observable.
    process.emit("SIGTERM");
    const env = await p;
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "timeout");
    assert.equal(env.summary, "completed most of the task before timeout");
  });

  it("摘要轮抛错 → 仍写 {failed, timeout},summary 空,不崩 (D3)", async () => {
    // The main-loop step is discarded; the closeout-summary step throws
    // ProtocolError → runSummaryWithTimeout's catch-all folds it to null → empty
    // summary, and the envelope is written as normal.
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
// C. manager-side graceful window + SIGKILL fallback (reuses the fake-child
//    shape from manager.test.ts).
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

/** Writes a timeout envelope on stdout then exits with SIGTERM (simulates the worker's graceful closeout). */
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
      // 50ms timeout fires → fallback envelope + SIGTERM
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

      // Within the graceful window the child writes its own timeout envelope (with a real progress summary)
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
      // The SIGKILL fallback window (5s) has not fired yet → no second signal
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
      // child does not exit (it ignores SIGTERM) → the SIGKILL fallback fires 5s later
      await vi.advanceTimersByTimeAsync(5000);
      const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      // Killed by SIGKILL → the exit handler's timedOut guard preserves the reason
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
// D. emitStateChange self-loop guard: on the timeout path, the timer fire
//    (running→failed) is followed by the stdout handler receiving the worker's
//    timeout envelope and calling emitStateChange again (failed→failed). That
//    is a spurious self-loop and must not persist another subagent_state_change
//    with from_state === to_state === "failed". Assert the real jsonl contains
//    no such record and the transition sequence holds only genuine moves.
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
      // Short timeout fires the timer: starting→running (spawn) → failed (timer)
      const { taskId } = manager.spawn({ timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      // Within the graceful window the child writes back its timeout envelope →
      // the stdout handler calls emitStateChange("failed") again — the self-loop
      // should be swallowed by the guard and not persisted.
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
      // The real transition sequence is still complete: one starting→running and one running→failed.
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
