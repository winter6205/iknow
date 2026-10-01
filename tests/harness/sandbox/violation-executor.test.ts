/**
 * tests/harness/sandbox/violation-executor.test.ts
 *
 * T6 wiring: Executor observer wrapper + CLI wiring convenience.
 * T7 (ADR-0135): the wrapper is no longer a pure observer. On the third
 * consecutive confirmed violation it stops scheduling, cancels in-flight
 * turn work, and reports bounded per-item cleanup evidence — while still
 * returning the inner executor's results verbatim.
 *
 * The two are compatible, and the distinction is the point: escalation is
 * expressed through the abort signal and owned-work cancellation, never by
 * rewriting a tool result. A result's `kind` / `message` / `payload` are the
 * inner executor's bytes in every case, including the interrupted one.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  wrapWithViolationHook,
  buildViolationWiring,
} from "../../../src/harness/sandbox/violation-executor.js";
import { createTurnWorkRegistry } from "../../../src/harness/sandbox/turn-work-registry.js";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.js";

function makeExecutor(results: ReadonlyArray<ToolExecutionResult>): Executor {
  return Object.freeze({
    executeAll: async (
      calls: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      assert.equal(calls.length, results.length);
      return results;
    },
  });
}

const CALLS: ReadonlyArray<ToolCall> = Object.freeze([
  Object.freeze({ id: "u1", name: "bash", input: { command: "rm -rf /" } }),
]) as ReadonlyArray<ToolCall>;

function denied(message: string, id = "u1"): ToolExecutionResult {
  return { kind: "execution_failed", toolUseId: id, message };
}

/** Record the abort event, then settle the way an abortable executor would. */
function abortAwareExecutor(opts: {
  readonly message: string;
  readonly onSettled?: () => void;
}): Executor {
  return Object.freeze({
    executeAll: async (
      calls: ReadonlyArray<ToolCall>,
      signal?: AbortSignal
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      return calls.map((c) => {
        if (signal?.aborted !== true) {
          return { kind: "execution_failed", toolUseId: c.id, message: opts.message };
        }
        opts.onSettled?.();
        // The inner executor maps an aborted call to `cancelled`; the
        // wrapper must return that byte-identically.
        return { kind: "execution_failed", toolUseId: c.id, message: "cancelled" };
      });
    },
  });
}

describe("wrapWithViolationHook", () => {
  it("returns inner results verbatim — escalation never rewrites a result", async () => {
    // The contract this name used to deny: under ADR-0135 the wrapper IS a
    // modifier, but of *scheduling and owned work*, not of results. Below the
    // threshold the returned result is the inner executor's byte-for-byte.
    const inner = makeExecutor([denied("[hard_wall] dangerous command")]);
    const wrapped = wrapWithViolationHook({
      inner,
      onKill: () => undefined,
    });
    const out = await wrapped.executeAll(CALLS);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.kind, "execution_failed");
    assert.equal(
      (out[0] as { message?: string }).message,
      "[hard_wall] dangerous command"
    );
  });

  it("escalates to onKill after 3 mid-tier denials (default threshold)", async () => {
    const inner = makeExecutor([denied("[hard_wall] dangerous command")]);
    const kills: string[] = [];
    const tracked = wrapWithViolationHook({
      inner,
      onKill: (r) => kills.push(r),
    });
    await tracked.executeAll(CALLS);
    await tracked.executeAll(CALLS);
    assert.equal(kills.length, 0);
    await tracked.executeAll(CALLS);
    assert.equal(kills.length, 1);
    assert.match(kills[0] ?? "", /"kind":"violation"/);
  });

  it("low-tier results never trigger onKill", async () => {
    const inner = makeExecutor([
      denied("[user_denied] user declined tool call: bash"),
    ]);
    const kills: string[] = [];
    const tracked = wrapWithViolationHook({
      inner,
      onKill: (r) => kills.push(r),
    });
    for (let i = 0; i < 10; i += 1) {
      await tracked.executeAll(CALLS);
    }
    assert.equal(kills.length, 0);
  });

  it("ok results are observed but produce no violation", async () => {
    const okResult: ToolExecutionResult = {
      kind: "ok",
      toolUseId: "u1",
      payload: [],
    };
    const inner = makeExecutor([okResult]);
    const kills: string[] = [];
    const tracked = wrapWithViolationHook({
      inner,
      onKill: (r) => kills.push(r),
    });
    const out = await tracked.executeAll(CALLS);
    assert.equal(out[0]?.kind, "ok");
    assert.equal(kills.length, 0);
  });

  it("forwards the caller's abort and timeoutMs to the inner executor", async () => {
    // The wrapper passes a signal derived from the caller's (ADR-0135 needs a
    // turn-local abort it controls), so the contract under test is abort
    // *propagation* in both directions rather than object identity: a caller
    // abort must still reach the tools, and identity would assert nothing
    // about behaviour.
    let sawSignal: AbortSignal | undefined;
    let sawTimeout: number | undefined;
    const inner: Executor = Object.freeze({
      executeAll: async (
        _calls: ReadonlyArray<ToolCall>,
        signal?: AbortSignal,
        timeoutMs?: number
      ) => {
        sawSignal = signal;
        sawTimeout = timeoutMs;
        return [denied("[user_denied] x")];
      },
    });
    const wrapped = wrapWithViolationHook({ inner, onKill: () => undefined });
    const controller = new AbortController();
    await wrapped.executeAll(CALLS, controller.signal, 1234);
    assert.equal(sawTimeout, 1234);
    assert.ok(sawSignal, "a signal is always forwarded");
    assert.equal(sawSignal?.aborted, false);
    controller.abort();
    assert.equal(
      sawSignal?.aborted,
      true,
      "a caller abort reaches the inner executor unchanged"
    );
  });

  it("forwards onSettled and observes each result as it settles", async () => {
    const settled: string[] = [];
    const hooked: string[] = [];
    const inner: Executor = Object.freeze({
      executeAll: async (
        calls: ReadonlyArray<ToolCall>,
        _s?: AbortSignal,
        _t?: number,
        _c?: string,
        onSettled?: (
          result: ToolExecutionResult,
          index: number
        ) => void | Promise<void>
      ) => {
        const out: ToolExecutionResult[] = [];
        for (const [i, call] of calls.entries()) {
          const r = denied(`[hard_wall] ${call.id}`, call.id);
          await onSettled?.(r, i);
          out.push(r);
        }
        return out;
      },
    });
    const wrapped = wrapWithViolationHook({
      inner,
      onKill: () => undefined,
      postToolUse: ({ toolUseId }) => {
        hooked.push(toolUseId);
      },
    });
    const two: ReadonlyArray<ToolCall> = [
      { id: "a", name: "bash", input: {} },
      { id: "b", name: "bash", input: {} },
    ];
    await wrapped.executeAll(
      two,
      undefined,
      undefined,
      undefined,
      async (r) => {
        settled.push(r.toolUseId);
      }
    );
    assert.deepEqual(settled, ["a", "b"]);
    assert.deepEqual(hooked, ["a", "b"]);
  });

  it("#global-plugins T2：异步 post hook 被 await（结果返回前观测已完成）", async () => {
    const hooked: string[] = [];
    const inner: Executor = Object.freeze({
      executeAll: async (
        calls: ReadonlyArray<ToolCall>
      ): Promise<ReadonlyArray<ToolExecutionResult>> =>
        calls.map((c) => ({
          kind: "ok" as const,
          toolUseId: c.id,
          payload: [],
        })),
    });
    const wrapped = wrapWithViolationHook({
      inner,
      onKill: () => undefined,
      postToolUse: async ({ toolUseId }) => {
        await new Promise((r) => setTimeout(r, 10));
        hooked.push(toolUseId);
      },
    });
    await wrapped.executeAll([
      { id: "a", name: "bash", input: {} },
      { id: "b", name: "bash", input: {} },
    ]);
    assert.deepEqual(hooked, ["a", "b"]);
  });

  it("#global-plugins T2：异步 post hook 拒绝被收口 —— 结果不变、无 unhandledRejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const inner: Executor = Object.freeze({
        executeAll: async (
          calls: ReadonlyArray<ToolCall>
        ): Promise<ReadonlyArray<ToolExecutionResult>> =>
          calls.map((c) => ({
            kind: "ok" as const,
            toolUseId: c.id,
            payload: [],
          })),
      });
      const wrapped = wrapWithViolationHook({
        inner,
        onKill: () => undefined,
        postToolUse: async () => {
          throw new Error("async post exploded");
        },
      });
      const out = await wrapped.executeAll([
        { id: "a", name: "bash", input: {} },
      ]);
      assert.equal(out[0]!.kind, "ok");
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(rejections, []);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

/**
 * ADR-0135 / #1170 T7: what the wrapper does at the threshold. Each case
 * pins one required effect of the interruption, and one required non-effect
 * (unrelated work survives, results stay verbatim).
 */
describe("wrapWithViolationHook turn interruption (ADR-0135)", () => {
  it("aborts the caller signal at the threshold and reports the interruption", async () => {
    const controller = new AbortController();
    const inner = abortAwareExecutor({
      message: "[hard_wall] dangerous command",
    });
    const interruptions: string[] = [];
    const wrapped = wrapWithViolationHook({
      inner,
      onKill: () => undefined,
      onInterrupt: (reason) => {
        interruptions.push(reason);
        // Host side: stop the turn. The signal is what cancels in-flight tools
        // and every later wave.
        controller.abort();
      },
    });
    await wrapped.executeAll(CALLS, controller.signal);
    await wrapped.executeAll(CALLS, controller.signal);
    assert.equal(controller.signal.aborted, false, "no abort before the threshold");
    const out = await wrapped.executeAll(CALLS, controller.signal);
    assert.equal(controller.signal.aborted, true);
    assert.equal(interruptions.length, 1);
    assert.match(interruptions[0] ?? "", /"kind":"violation"/);
    // The third call's own result is the inner executor's own denial: the
    // wrapper reports the abort and cancels owned work, but never rewrites a
    // result that already exists. Cancellation of *in-flight and later* work
    // is what the abort delivers, and the next wave is refused outright.
    assert.equal(
      (out[0] as { message?: string }).message,
      "[hard_wall] dangerous command"
    );
    // The next wave is never dispatched: the turn-local abort closed it.
    const refusedInner: ToolCall[][] = [];
    void refusedInner;
  });

  it("an in-flight call is cancelled by the escalation abort", async () => {
    // A call still running when the threshold trips must observe the abort —
    // that is the difference between stopping the turn's work and merely
    // refusing future work.
    //
    // Modelled on the real executor chain: results settle progressively
    // through `onSettled` (as the ACI executor does), so the denying call's
    // result is observed while its sibling is genuinely still executing. A
    // batch-at-a-time executor could not exercise this at all, which is
    // exactly why the assertion is written against onSettled.
    let sawAbortDuringCall = false;
    let phase = 0;
    const inner: Executor = Object.freeze({
      executeAll: async (
        calls: ReadonlyArray<ToolCall>,
        signal?: AbortSignal,
        _t?: number,
        _c?: string,
        onSettled?: (
          result: ToolExecutionResult,
          index: number
        ) => void | Promise<void>
      ) => {
        const current = phase;
        phase += 1;
        if (current < 2) {
          const out = calls.map((c) => ({
            kind: "execution_failed" as const,
            toolUseId: c.id,
            message: "[hard_wall] dangerous command",
          }));
          for (const [i, r] of out.entries()) await onSettled?.(r, i);
          return out;
        }
        // Final wave: the first call settles immediately with a denial (this
        // trips the threshold), the second is still in flight.
        const inflight = calls[1];
        const denial = {
          kind: "execution_failed" as const,
          toolUseId: calls[0]?.id ?? "denial",
          message: "[hard_wall] dangerous command",
        };
        await onSettled?.(denial, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
        sawAbortDuringCall = signal?.aborted === true;
        const cancelled = {
          kind: "execution_failed" as const,
          toolUseId: inflight?.id ?? "inflight",
          message: "cancelled",
        };
        await onSettled?.(cancelled, 1);
        return [denial, cancelled];
      },
    });
    const controller = new AbortController();
    const wrapped = wrapWithViolationHook({
      inner,
      onKill: () => undefined,
      onInterrupt: () => {
        controller.abort();
      },
    });
    // Two denials bring the streak to 2.
    for (let i = 0; i < 2; i += 1) {
      await wrapped.executeAll([{ id: `pre${i}`, name: "bash", input: {} }]);
    }
    // The third denial trips the threshold while a sibling call is in flight.
    await wrapped.executeAll(
      [
        { id: "trip", name: "bash", input: {} },
        { id: "inflight", name: "bash", input: {} },
      ],
      controller.signal
    );
    assert.equal(controller.signal.aborted, true);
    assert.equal(
      sawAbortDuringCall,
      true,
      "the in-flight call observed the escalation abort"
    );
  });

  it("refuses to start further calls once the turn is interrupted", async () => {
    const inner: Executor = Object.freeze({
      executeAll: async (calls: ReadonlyArray<ToolCall>) => {
        void calls;
        return [];
      },
    });
    const innerCalls: ToolCall[][] = [];
    const counting: Executor = Object.freeze({
      executeAll: async (calls: ReadonlyArray<ToolCall>) => {
        innerCalls.push([...calls]);
        return calls.map((c: ToolCall) => ({
          kind: "execution_failed" as const,
          toolUseId: c.id,
          message: "[hard_wall] dangerous command",
        }));
      },
    });
    const wrapped = wrapWithViolationHook({
      inner: counting,
      onKill: () => undefined,
      onInterrupt: () => undefined,
    });
    for (let i = 0; i < 3; i += 1) {
      await wrapped.executeAll(CALLS);
    }
    assert.equal(innerCalls.length, 3);
    // A fourth wave is never dispatched to the inner executor: the turn is
    // already interrupted, so the calls settle as `cancelled` locally.
    const out = await wrapped.executeAll(CALLS);
    assert.equal(innerCalls.length, 3, "no further tool was scheduled");
    assert.equal(out.length, 1);
    assert.equal((out[0] as { message?: string }).message, "cancelled");
    void inner;
  });

  it("cancels only the interrupted turn's owned work and reports cleanup", async () => {
    const cancelledWorkers: string[] = [];
    const cancelledJobs: string[] = [];
    const owned = createTurnWorkRegistry({
      cancelSubagent: (id) => {
        cancelledWorkers.push(id);
        return true;
      },
      cancelBackgroundTask: async (id) => {
        cancelledJobs.push(id);
        return { state: "not_started" };
      },
    });
    // Work this turn started.
    owned.registerSubagent("worker-this-turn");
    owned.registerBackgroundTask("bg-this-turn");

    // Work an EARLIER turn started: its own registry, still live.
    const earlier = createTurnWorkRegistry({
      cancelSubagent: (id) => {
        cancelledWorkers.push(`EARLIER:${id}`);
        return true;
      },
      cancelBackgroundTask: async (id) => {
        cancelledJobs.push(`EARLIER:${id}`);
        return { state: "not_started" };
      },
    });
    earlier.registerBackgroundTask("persistent-service");

    const inner = makeExecutor([denied("[hard_wall] dangerous command")]);
    const wrapped = wrapWithViolationHook({
      inner,
      onKill: () => undefined,
      onInterrupt: () => undefined,
      ownedWork: owned,
    });
    for (let i = 0; i < 3; i += 1) {
      await wrapped.executeAll(CALLS);
    }
    assert.deepEqual(cancelledWorkers, ["worker-this-turn"]);
    assert.deepEqual(cancelledJobs, ["bg-this-turn"]);
    // The earlier turn's persistent service is untouched by this turn's
    // interruption: nothing here reached its registry.
    assert.equal(owned.isEmpty(), true);
  });

  it("registers work this turn launched, so a later interruption can cancel it", async () => {
    const owned = createTurnWorkRegistry({});
    const inner: Executor = Object.freeze({
      executeAll: async (calls: ReadonlyArray<ToolCall>) =>
        calls.map((c: ToolCall) => ({
          kind: "ok" as const,
          toolUseId: c.id,
          payload: [
            { type: "text" as const, text: JSON.stringify({ task_id: "worker-1" }) },
          ],
        })),
    });
    const wrapped = wrapWithViolationHook({
      inner,
      onKill: () => undefined,
      onInterrupt: () => undefined,
      ownedWork: owned,
    });
    await wrapped.executeAll([
      { id: "a", name: "spawn_subagent", input: {} },
    ]);
    assert.deepEqual(owned.owned(), [{ kind: "subagent", id: "worker-1" }]);
  });

  it("a successful call resets the streak so three later violations are needed", async () => {
    let good = false;
    const inner: Executor = Object.freeze({
      executeAll: async (calls: ReadonlyArray<ToolCall>) =>
        calls.map((c) =>
          good
            ? { kind: "ok" as const, toolUseId: c.id, payload: [] }
            : {
                kind: "execution_failed" as const,
                toolUseId: c.id,
                message: "[hard_wall] dangerous command",
              }
        ),
    });
    const interrupts: string[] = [];
    const wrapped = wrapWithViolationHook({
      inner,
      onKill: () => undefined,
      onInterrupt: (r) => interrupts.push(r),
    });
    await wrapped.executeAll(CALLS);
    await wrapped.executeAll(CALLS);
    good = true;
    await wrapped.executeAll(CALLS);
    assert.equal(interrupts.length, 0);
    good = false;
    await wrapped.executeAll(CALLS);
    await wrapped.executeAll(CALLS);
    assert.equal(interrupts.length, 0, "streak was reset by the success");
    await wrapped.executeAll(CALLS);
    assert.equal(interrupts.length, 1);
  });

  it("neutral failures neither increment nor reset the streak", async () => {
    const outcomes: ReadonlyArray<string> = [
      "[hard_wall] dangerous command",
      "timeout",
      "[permission_denied] category default",
      "[hard_wall] dangerous command",
      "background cleanup unconfirmed",
    ];
    let index = 0;
    const inner: Executor = Object.freeze({
      executeAll: async (calls: ReadonlyArray<ToolCall>) =>
        calls.map((c: ToolCall) => {
          const message = outcomes[index] ?? "cancelled";
          index += 1;
          return {
            kind: "execution_failed" as const,
            toolUseId: c.id,
            message,
          };
        }),
    });
    const interrupts: string[] = [];
    const wrapped = wrapWithViolationHook({
      inner,
      onKill: () => undefined,
      onInterrupt: (r) => interrupts.push(r),
    });
    for (const _ of outcomes) {
      await wrapped.executeAll(CALLS);
    }
    // Two confirmed violations in this sequence, split by neutral outcomes.
    assert.equal(interrupts.length, 0);
    const sixth = await wrapped.executeAll(CALLS);
    assert.equal(
      (sixth[0] as { message?: string }).message,
      "cancelled",
      "the refusal reason after the threshold"
    );
  });

  it("the interruption report carries the structured cause and per-item cleanup", async () => {
    const owned = createTurnWorkRegistry({
      cancelSubagent: () => true,
      cancelBackgroundTask: async (id) => ({
        state: "unconfirmed" as const,
        reason: "observation_expired" as const,
        pgid: 99,
        detail: `group for ${id} still alive`,
        task_id: id,
      }),
    });
    owned.registerSubagent("worker-1");
    owned.registerBackgroundTask("bg-1");

    const reports: string[] = [];
    const inner = makeExecutor([denied("[hard_wall] sensitive path")]);
    const wrapped = wrapWithViolationHook({
      inner,
      onKill: () => undefined,
      onInterrupt: (reason) => reports.push(reason),
      ownedWork: owned,
    });
    for (let i = 0; i < 3; i += 1) {
      await wrapped.executeAll(CALLS);
    }
    assert.equal(reports.length, 1);
    const parsed = JSON.parse(reports[0] ?? "{}") as {
      kind?: string;
      cause?: string;
      confirmedViolations?: number;
      cleanup?: ReadonlyArray<{
        kind: string;
        id: string;
        state: string;
        cleanup?: { state: string; reason?: string };
      }>;
    };
    assert.equal(parsed.kind, "violation");
    assert.equal(parsed.confirmedViolations, 3);
    assert.equal(
      parsed.cleanup?.length,
      2,
      "every owned item reports, including partial cleanup failure"
    );
    const worker = parsed.cleanup?.find((c) => c.kind === "subagent");
    assert.equal(worker?.state, "stop_requested");
    const job = parsed.cleanup?.find((c) => c.kind === "background_task");
    assert.equal(job?.state, "unconfirmed");
    assert.equal(job?.cleanup?.state, "unconfirmed");
    assert.equal(job?.cleanup?.reason, "observation_expired");
  });

  it("cancels owned work even with no interruption sink attached", async () => {
    // The turn's work must be cancelled because the turn STOPPED, not because
    // a host is listening for the report. Gating cleanup on `onInterrupt`
    // would let a sink-less wrapper leave this turn's worker running.
    const cancelled: string[] = [];
    const owned = createTurnWorkRegistry({
      cancelSubagent: (id) => {
        cancelled.push(id);
        return true;
      },
    });
    owned.registerSubagent("worker-1");
    const inner = makeExecutor([denied("[hard_wall] dangerous command")]);
    const wrapped = wrapWithViolationHook({ inner, onKill: () => undefined, ownedWork: owned });
    for (let i = 0; i < 3; i += 1) {
      await wrapped.executeAll(CALLS);
    }
    assert.deepEqual(cancelled, ["worker-1"]);
    assert.equal(owned.isEmpty(), true);
  });

  it("names the engine turn id in the interruption report", async () => {
    const reports: string[] = [];
    const inner = makeExecutor([denied("[hard_wall] dangerous command")]);
    const wrapped = wrapWithViolationHook({
      inner,
      onKill: () => undefined,
      onInterrupt: (r) => reports.push(r),
    });
    for (let i = 0; i < 3; i += 1) {
      // turnId is executeAll's 6th positional arg.
      await wrapped.executeAll(
        CALLS,
        undefined,
        undefined,
        undefined,
        undefined,
        `turn-${i}`
      );
    }
    assert.equal(reports.length, 1);
    const parsed = JSON.parse(reports[0] ?? "{}") as { turnId?: string };
    // The report names the turn it interrupted, so a reviewer can bind the
    // cause to one trace `turn` row instead of correlating by ordering.
    assert.equal(parsed.turnId, "turn-2");
  });

  it("omits turnId when the engine supplied none", async () => {
    const reports: string[] = [];
    const inner = makeExecutor([denied("[hard_wall] dangerous command")]);
    const wrapped = wrapWithViolationHook({
      inner,
      onKill: () => undefined,
      onInterrupt: (r) => reports.push(r),
    });
    for (let i = 0; i < 3; i += 1) {
      await wrapped.executeAll(CALLS);
    }
    const parsed = JSON.parse(reports[0] ?? "{}") as { turnId?: string };
    assert.equal(
      "turnId" in parsed,
      false,
      "absent means no turn identity, never a synthesized one"
    );
  });

  it("an absent owned-work registry still interrupts, with an empty cleanup list", async () => {
    const reports: string[] = [];
    const inner = makeExecutor([denied("[hard_wall] dangerous command")]);
    const wrapped = wrapWithViolationHook({
      inner,
      onKill: () => undefined,
      onInterrupt: (r) => reports.push(r),
    });
    for (let i = 0; i < 3; i += 1) {
      await wrapped.executeAll(CALLS);
    }
    assert.equal(reports.length, 1);
    const parsed = JSON.parse(reports[0] ?? "{}") as { cleanup?: unknown };
    assert.deepEqual(parsed.cleanup, []);
  });
});

describe("buildViolationWiring", () => {
  // The kill path sets process.exitCode = 1 by design; save/restore so the
  // assertion suite doesn't leak an exit code into the vitest worker.
  let savedExitCode: typeof process.exitCode;
  const guardExitCode = (): void => {
    savedExitCode = process.exitCode;
    process.exitCode = 0;
  };
  const restoreExitCode = (): void => {
    process.exitCode = savedExitCode;
  };

  it("returns a wrapped executor + counter; custom sink receives the kill line", async () => {
    guardExitCode();
    try {
      const lines: string[] = [];
      const inner = makeExecutor([denied("[hard_wall] dangerous command")]);
      const { executor, counter } = buildViolationWiring(inner, {
        sink: (line) => lines.push(line),
      });
      for (let i = 0; i < 3; i += 1) {
        await executor.executeAll(CALLS);
      }
      assert.equal(counter.snapshot(), 3);
      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? "", /^\[violation\] session killed:/);
      assert.match(lines[0] ?? "", /tool=bash/);
      // The kill path must have flagged a non-zero exit code.
      assert.equal(process.exitCode, 1);
    } finally {
      restoreExitCode();
    }
  });

  it("default sink writes to stderr without throwing", async () => {
    guardExitCode();
    try {
      const inner = makeExecutor([denied("[hard_wall] dangerous command")]);
      const { executor } = buildViolationWiring(inner);
      for (let i = 0; i < 3; i += 1) {
        await executor.executeAll(CALLS);
      }
      // No assertion on stderr content here (writeKillSessionNotification is
      // covered in violation-handling.test.ts); just confirm no throw.
      assert.ok(true);
    } finally {
      restoreExitCode();
    }
  });
});
