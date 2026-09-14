/**
 * tests/harness/sandbox/violation-executor.test.ts
 *
 * T6 wiring: Executor observer wrapper + CLI wiring convenience.
 * Verifies the chat/ask kill-session path end-to-end at the executor level:
 * inner executor produces [permission_denied]/[hard_wall] execution_failed
 * results → wrapper observes them → counter escalates → onKill fires once.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  wrapWithViolationHook,
  buildViolationWiring,
} from "../../../src/harness/sandbox/violation-executor.js";
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

describe("wrapWithViolationHook", () => {
  it("passes results through unchanged (observer, not modifier)", async () => {
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

  it("forwards signal and timeoutMs to the inner executor", async () => {
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
    assert.equal(sawSignal, controller.signal);
    assert.equal(sawTimeout, 1234);
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

describe("buildViolationWiring", () => {
  // The kill path sets process.exitCode = 1 by design; save/restore so the
  // assertion suite doesn't leak an exit code into the vitest worker.
  let savedExitCode: number | string | undefined;
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
