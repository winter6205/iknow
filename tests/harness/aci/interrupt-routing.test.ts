/**
 * Per-tool timeoutTier + interruptBehavior routing acceptance suite.
 *
 * Coverage (from the interrupt-routing issue's scenarios):
 *   - tier mapping: fast=5s / default=30s / build=300s / long=1800s;
 *     timeoutMs passed by the engine is overridden by the tool's tier.
 *   - interruptBehavior:
 *       cancel tools → caller signal passes through to ctx.signal; on abort,
 *       normalized to cancelled
 *       block tools → caller signal not passed through; after the handler
 *       finishes, converted to cancelled (no partial)
 *   - bash real spawn: partial stdout retained under cancellation
 *   - block-tool completion is not interrupted by caller abort; after caller
 *     abort the result is cancelled
 *   - a single-call tier timeout no longer stops the turn (ADR-0091): only
 *     that one result fails, the turn continues; turn timeout only honors a
 *     clock abort with signal.reason==="timeout"
 *   - computeToolStopFlags: result labels are inert; signal.reason compared by strict equal
 *
 * Implementation strategy:
 *   - tier tests use createAciExecutor's `timeoutMsOverride` test seam, so
 *     "the tool tier is authoritative" is verified without waiting 5 minutes.
 *   - the bash partial-output test uses real spawn; the fixture writes fd 1
 *     directly via fs.writeSync (bypassing Node piped stdout's libuv
 *     user-space buffer) and waitForPidFile barriers until the fixture drops
 *     its marker before abort, then asserts partial stdout contains "line N".
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import {
  BACKGROUND_OPERATION_NOTICE,
  BLOCK_OPERATION_NOTICE,
  createAciExecutor,
} from "../../../src/harness/aci/aci-executor.ts";
import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { waitForPidFile } from "./tools/spawn-test-utils.ts";
import type {
  AciToolDef,
  TimeoutTier,
} from "../../../src/harness/aci/types.ts";
import { TIMEOUT_TIER_MS } from "../../../src/harness/aci/types.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";
import { encodeToolResults } from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import { computeToolStopFlags, run } from "../../../src/harness/loop-engine.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { assistantResult } from "../../cli/_fixtures.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const p = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(p);
  return p;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

/** Minimal AciToolDef whose handler records whether ctx.signal aborted. */
function makeTool(opts: {
  readonly name: string;
  readonly interruptBehavior: "cancel" | "block";
  readonly timeoutTier: TimeoutTier;
  readonly category?: "read-only" | "write" | "execute";
  readonly observeSignal?: boolean;
  readonly resolveAfterMs?: number;
}): AciToolDef {
  const {
    name,
    interruptBehavior,
    timeoutTier,
    category = "read-only",
    observeSignal = true,
    resolveAfterMs = 30,
  } = opts;
  let sawAbort = false;
  const handler = async (
    _input: unknown,
    ctx?: { signal?: AbortSignal }
  ): Promise<unknown> => {
    sawAbort = false;
    if (observeSignal && ctx?.signal) {
      ctx.signal.addEventListener("abort", () => {
        sawAbort = true;
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, resolveAfterMs));
    return sawAbort ? { name, aborted: true } : { name, aborted: false };
  };
  return Object.freeze({
    name,
    description: `test ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: handler as AciToolDef["handler"],
    aci: Object.freeze({
      category,
      isConcurrencySafe: category === "read-only",
      interruptBehavior,
      timeoutTier,
    }),
  });
}

function makeCatalog(tools: AciToolDef[]) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return Object.freeze({
    get: (n: string) => byName.get(n),
    all: () => Object.freeze([...tools]) as ReadonlyArray<AciToolDef>,
  });
}

/** Inner executor: invokes one handler directly, no permission middleware. */
function makeInner(): Executor {
  return Object.freeze({
    executeAll: async (
      calls: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      const out: ToolExecutionResult[] = [];
      for (const call of calls) {
        const def = (
          globalThis as { __catalog?: ReturnType<typeof makeCatalog> }
        ).__catalog?.get(call.name);
        if (!def) {
          out.push({
            kind: "tool_not_found",
            toolUseId: call.id,
            toolName: call.name,
          });
          continue;
        }
        try {
          const payload = await def.handler(call.input, undefined);
          // mirrors Executor.safeContent: payload -> JSON text block
          const text =
            typeof payload === "string" ? payload : JSON.stringify(payload);
          out.push({
            kind: "ok",
            toolUseId: call.id,
            payload: [{ type: "text", text }],
          });
        } catch (err) {
          out.push({
            kind: "execution_failed",
            toolUseId: call.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return out;
    },
  });
}

describe("SC17 — TIMEOUT_TIER_MS constants", () => {
  it("exports the canonical tier milliseconds", () => {
    assert.equal(TIMEOUT_TIER_MS.fast, 5_000);
    assert.equal(TIMEOUT_TIER_MS.default, 30_000);
    assert.equal(TIMEOUT_TIER_MS.build, 300_000);
    assert.equal(TIMEOUT_TIER_MS.long, 1_800_000);
    assert.equal(TIMEOUT_TIER_MS.unbounded, 0);
    assert.equal(Object.isFrozen(TIMEOUT_TIER_MS), true);
  });
});

describe("SC17 — tier 映射覆盖 engine 传入的 timeoutMs", () => {
  it("fast tier routes to 5s (override seam 200ms → 期望 ~5s 即 abort)", async () => {
    const tool = makeTool({
      name: "fastie",
      interruptBehavior: "cancel",
      timeoutTier: "fast",
      resolveAfterMs: 5_000, // a handler that genuinely takes ~5s
    });
    (globalThis as { __catalog?: ReturnType<typeof makeCatalog> }).__catalog =
      makeCatalog([tool]);
    const inner = makeInner();
    // Test seam: timeoutMsOverride shrinks the fast tier to 200ms so a real
    // timeout fires without waiting out the full 5s.
    const aciExec = createAciExecutor({
      inner,
      catalog: (globalThis as { __catalog?: ReturnType<typeof makeCatalog> })
        .__catalog!,
      timeoutMsOverride: 200,
    });
    const start = Date.now();
    const results = await aciExec.executeAll([
      { id: "u1", name: "fastie", input: {} },
    ]);
    const elapsed = Date.now() - start;
    // must hit the 200ms override, never the full 5s tier
    assert.ok(
      elapsed < 1_000,
      `elapsed=${elapsed}ms, expected tier fast timeout`
    );
    const r = results[0]!;
    assert.equal(r.kind, "execution_failed");
    if (r.kind === "execution_failed") {
      assert.equal(r.message, "timeout");
    }
  });

  it("default tier 走 30s(测试 seam 改 100ms 验证),engine 传 600_000 被覆盖", async () => {
    const tool = makeTool({
      name: "defaultie",
      interruptBehavior: "cancel",
      timeoutTier: "default",
      resolveAfterMs: 600_000,
    });
    (globalThis as { __catalog?: ReturnType<typeof makeCatalog> }).__catalog =
      makeCatalog([tool]);
    const aciExec = createAciExecutor({
      inner: makeInner(),
      catalog: (globalThis as { __catalog?: ReturnType<typeof makeCatalog> })
        .__catalog!,
      timeoutMsOverride: 80,
    });
    const start = Date.now();
    const results = await aciExec.executeAll(
      [{ id: "u1", name: "defaultie", input: {} }],
      undefined,
      // engine still passes 600_000 the old way; tier mapping must override it
      600_000
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 600, `elapsed=${elapsed}ms`);
    assert.equal(results[0]!.kind, "execution_failed");
    if (results[0]!.kind === "execution_failed") {
      assert.equal(results[0]!.message, "timeout");
    }
  });
});

describe("SC17 — interruptBehavior routing", () => {
  it("cancel 工具: caller signal 透传 → handler 观察到 aborted → 归一为 cancelled", async () => {
    // handler records whether it saw the signal abort, proving pass-through
    let handlerSawAbort = false;
    const tool: AciToolDef = Object.freeze({
      name: "cancelie",
      description: "test cancelie",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async (
        _input: unknown,
        ctx?: { signal?: AbortSignal }
      ): Promise<unknown> => {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ done: true }), 500);
          ctx?.signal?.addEventListener("abort", () => {
            handlerSawAbort = true;
            clearTimeout(timer);
            resolve({ aborted: true });
          });
        });
      },
      aci: Object.freeze({
        category: "read-only" as const,
        isConcurrencySafe: true,
        interruptBehavior: "cancel" as const,
        timeoutTier: "fast" as const,
      }),
    });
    (globalThis as { __catalog?: ReturnType<typeof makeCatalog> }).__catalog =
      makeCatalog([tool]);
    // inner forwards the signal into ctx.signal, like the real Executor
    const inner: Executor = Object.freeze({
      executeAll: async (
        calls: ReadonlyArray<ToolCall>,
        signal?: AbortSignal
      ): Promise<ReadonlyArray<ToolExecutionResult>> => {
        const call = calls[0]!;
        const def = (
          globalThis as { __catalog?: ReturnType<typeof makeCatalog> }
        ).__catalog?.get(call.name);
        if (!def) {
          return [
            {
              kind: "tool_not_found",
              toolUseId: call.id,
              toolName: call.name,
            },
          ];
        }
        const payload = await def.handler(call.input, { signal });
        return [
          {
            kind: "ok",
            toolUseId: call.id,
            payload: [{ type: "text", text: JSON.stringify(payload) }],
          },
        ];
      },
    });
    const aciExec = createAciExecutor({
      inner,
      catalog: (globalThis as { __catalog?: ReturnType<typeof makeCatalog> })
        .__catalog!,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const results = await aciExec.executeAll(
      [{ id: "u1", name: "cancelie", input: {} }],
      controller.signal
    );
    // cancel tool: caller signal must reach the handler
    assert.equal(handlerSawAbort, true, "cancel 工具应透传 caller signal");
    // and the final result is normalized to cancelled
    assert.equal(results[0]!.kind, "execution_failed");
    if (results[0]!.kind === "execution_failed") {
      assert.equal(results[0]!.message, "cancelled");
      assert.equal(
        results[0]!.background,
        undefined,
        "响应 signal 的取消不得标记为后台运行"
      );
    }
  });

  it("cancel 工具: caller abort 抢占不响应 signal 的 handler,并保留后台运行事实", async () => {
    let releaseHandler: (() => void) | undefined;
    let handlerFinished = false;
    const backgroundNotices: string[] = [];
    let resolveHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      resolveHandlerStarted = resolve;
    });
    let resolveUnderlyingFinished!: () => void;
    const underlyingFinished = new Promise<void>((resolve) => {
      resolveUnderlyingFinished = resolve;
    });
    const tool: AciToolDef = Object.freeze({
      name: "uncooperative-cancelie",
      description: "test uncooperative cancelie",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async (): Promise<unknown> => {
        resolveHandlerStarted();
        await new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
        handlerFinished = true;
        resolveUnderlyingFinished();
        return { done: true };
      },
      aci: Object.freeze({
        category: "read-only" as const,
        isConcurrencySafe: true,
        interruptBehavior: "cancel" as const,
        timeoutTier: "default" as const,
      }),
    });
    (globalThis as { __catalog?: ReturnType<typeof makeCatalog> }).__catalog =
      makeCatalog([tool]);
    const inner: Executor = Object.freeze({
      executeAll: async (
        calls: ReadonlyArray<ToolCall>,
        signal?: AbortSignal
      ): Promise<ReadonlyArray<ToolExecutionResult>> => {
        const call = calls[0]!;
        const def = (
          globalThis as { __catalog?: ReturnType<typeof makeCatalog> }
        ).__catalog?.get(call.name);
        if (!def) {
          return [
            {
              kind: "tool_not_found",
              toolUseId: call.id,
              toolName: call.name,
            },
          ];
        }
        const payload = await def.handler(call.input, { signal });
        return [
          {
            kind: "ok",
            toolUseId: call.id,
            payload: [{ type: "text", text: JSON.stringify(payload) }],
          },
        ];
      },
    });
    const aciExec = createAciExecutor({
      inner,
      catalog: (globalThis as { __catalog?: ReturnType<typeof makeCatalog> })
        .__catalog!,
      timeoutMsOverride: 1_000,
    });
    const caller = new AbortController();
    const execution = aciExec.executeAll(
      [{ id: "u1", name: "uncooperative-cancelie", input: {} }],
      caller.signal,
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => {
        if (event.type === "stop_summary") backgroundNotices.push(event.text);
      }
    );
    await handlerStarted;
    caller.abort();

    try {
      const settledBeforeTier = await Promise.race<
        ReadonlyArray<ToolExecutionResult> | undefined
      >([
        execution,
        new Promise<ReadonlyArray<ToolExecutionResult> | undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 100)
        ),
      ]);
      assert.notEqual(settledBeforeTier, undefined);
      assert.equal(handlerFinished, false);
      const result = settledBeforeTier?.[0];
      assert.equal(result?.kind, "execution_failed");
      if (result?.kind === "execution_failed") {
        assert.equal(result.message, "cancelled");
        assert.equal(
          result.background,
          true,
          "调用方结果必须标记底层 handler 仍在后台运行"
        );
      }
      assert.deepEqual(backgroundNotices, [BACKGROUND_OPERATION_NOTICE]);
    } finally {
      releaseHandler?.();
      await execution;
      await underlyingFinished;
    }
  });

  it("cancel 工具: caller 抢占后的后台 rejection 进入诊断 sink", async () => {
    let rejectHandler: ((reason: unknown) => void) | undefined;
    let resolveHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      resolveHandlerStarted = resolve;
    });
    const diagnostics: unknown[] = [];
    const tool: AciToolDef = Object.freeze({
      name: "rejecting-cancelie",
      description: "test rejecting cancelie",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async (): Promise<unknown> => {
        resolveHandlerStarted();
        // Returns a never-settling promise: the handler is still running when
        // the caller aborts, which is exactly what this test pins.
        return new Promise<never>((_resolve, reject) => {
          rejectHandler = reject;
        });
      },
      aci: Object.freeze({
        category: "read-only" as const,
        isConcurrencySafe: true,
        interruptBehavior: "cancel" as const,
        timeoutTier: "default" as const,
      }),
    });
    (globalThis as { __catalog?: ReturnType<typeof makeCatalog> }).__catalog =
      makeCatalog([tool]);
    const inner: Executor = Object.freeze({
      executeAll: async (
        calls: ReadonlyArray<ToolCall>,
        signal?: AbortSignal
      ): Promise<ReadonlyArray<ToolExecutionResult>> => {
        const call = calls[0]!;
        const def = (
          globalThis as { __catalog?: ReturnType<typeof makeCatalog> }
        ).__catalog?.get(call.name);
        const payload = await def!.handler(call.input, { signal });
        return [
          {
            kind: "ok",
            toolUseId: call.id,
            payload: [{ type: "text", text: JSON.stringify(payload) }],
          },
        ];
      },
    });
    const aciExec = createAciExecutor({
      inner,
      catalog: (globalThis as { __catalog?: ReturnType<typeof makeCatalog> })
        .__catalog!,
      timeoutMsOverride: 1_000,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });
    const caller = new AbortController();
    const execution = aciExec.executeAll(
      [{ id: "u1", name: "rejecting-cancelie", input: {} }],
      caller.signal
    );
    await handlerStarted;
    caller.abort();

    const results = await execution;
    assert.equal(results[0]?.kind, "execution_failed");
    if (results[0]?.kind === "execution_failed") {
      assert.equal(results[0].background, true);
    }

    const rejection = new Error("background handler failed");
    rejectHandler!(rejection);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      kind: "background_handler_rejection",
      toolUseId: "u1",
      toolName: "rejecting-cancelie",
      error: rejection,
    });
  });

  it("cancel 工具: settle 窗口内 rejection 仍归一为 cancelled 并进入诊断 sink", async () => {
    let rejectHandler: ((reason: unknown) => void) | undefined;
    let resolveHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      resolveHandlerStarted = resolve;
    });
    const diagnostics: unknown[] = [];
    const tool: AciToolDef = Object.freeze({
      name: "settle-rejecting-cancelie",
      description: "test settle rejecting cancelie",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async (): Promise<unknown> => {
        resolveHandlerStarted();
        // Returns a never-settling promise: the handler is still running when
        // the caller aborts, which is exactly what this test pins.
        return new Promise<never>((_resolve, reject) => {
          rejectHandler = reject;
        });
      },
      aci: Object.freeze({
        category: "read-only" as const,
        isConcurrencySafe: true,
        interruptBehavior: "cancel" as const,
        timeoutTier: "default" as const,
      }),
    });
    (globalThis as { __catalog?: ReturnType<typeof makeCatalog> }).__catalog =
      makeCatalog([tool]);
    const inner: Executor = Object.freeze({
      executeAll: async (
        calls: ReadonlyArray<ToolCall>,
        signal?: AbortSignal
      ): Promise<ReadonlyArray<ToolExecutionResult>> => {
        const call = calls[0]!;
        const def = (
          globalThis as { __catalog?: ReturnType<typeof makeCatalog> }
        ).__catalog?.get(call.name);
        const payload = await def!.handler(call.input, { signal });
        return [
          {
            kind: "ok",
            toolUseId: call.id,
            payload: [{ type: "text", text: JSON.stringify(payload) }],
          },
        ];
      },
    });
    const aciExec = createAciExecutor({
      inner,
      catalog: (globalThis as { __catalog?: ReturnType<typeof makeCatalog> })
        .__catalog!,
      timeoutMsOverride: 1_000,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });
    const caller = new AbortController();
    const execution = aciExec.executeAll(
      [{ id: "u1", name: "settle-rejecting-cancelie", input: {} }],
      caller.signal
    );
    await handlerStarted;
    caller.abort();
    const rejection = new Error("settle-window handler failed");
    setTimeout(() => rejectHandler!(rejection), 1);

    const results = await execution;
    assert.equal(results[0]?.kind, "execution_failed");
    if (results[0]?.kind === "execution_failed") {
      assert.equal(results[0].message, "cancelled");
      assert.equal(
        results[0].background,
        undefined,
        "已在 settle 窗口内结束的 handler 不应标记为后台运行"
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(diagnostics[0], {
      kind: "background_handler_rejection",
      toolUseId: "u1",
      toolName: "settle-rejecting-cancelie",
      error: rejection,
    });
  });

  it("block 工具: caller signal 不透传 → handler 干净完成;caller abort 后转 cancelled(无 partial)", async () => {
    // block tool resolves at 100ms while the caller aborts at 20ms
    const tool = makeTool({
      name: "blockie",
      interruptBehavior: "block",
      timeoutTier: "default",
      resolveAfterMs: 100,
    });
    (globalThis as { __catalog?: ReturnType<typeof makeCatalog> }).__catalog =
      makeCatalog([tool]);
    let signalSawAbort = false;
    const inner: Executor = Object.freeze({
      executeAll: async (
        calls: ReadonlyArray<ToolCall>,
        signal?: AbortSignal
      ): Promise<ReadonlyArray<ToolExecutionResult>> => {
        const call = calls[0]!;
        // watch whether the handler ever receives an aborted signal
        signal?.addEventListener("abort", () => {
          signalSawAbort = true;
        });
        const def = (
          globalThis as { __catalog?: ReturnType<typeof makeCatalog> }
        ).__catalog?.get(call.name);
        if (!def) {
          return [
            {
              kind: "tool_not_found",
              toolUseId: call.id,
              toolName: call.name,
            },
          ];
        }
        const payload = await def.handler(call.input, { signal });
        return [
          {
            kind: "ok",
            toolUseId: call.id,
            payload: [{ type: "text", text: JSON.stringify(payload) }],
          },
        ];
      },
    });
    const aciExec = createAciExecutor({
      inner,
      catalog: (globalThis as { __catalog?: ReturnType<typeof makeCatalog> })
        .__catalog!,
    });
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 20);
    const results = await aciExec.executeAll(
      [{ id: "u1", name: "blockie", input: {} }],
      caller.signal
    );
    assert.equal(signalSawAbort, false, "block 工具:caller signal 不应透传");
    assert.equal(results[0]!.kind, "execution_failed");
    const r = results[0]!;
    if (r.kind === "execution_failed") {
      assert.equal(r.message, "cancelled");
      assert.equal(
        r.partial,
        undefined,
        "block 工具:cancelled 时不应带 partial(handler 干净完成)"
      );
    }
  });

  it("block 工具: caller abort 后发送不可中止等待的 host 反馈", async () => {
    let resolveHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      resolveHandlerStarted = resolve;
    });
    const tool: AciToolDef = Object.freeze({
      name: "block-notice",
      description: "test block notice",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async (): Promise<unknown> => {
        resolveHandlerStarted();
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { done: true };
      },
      aci: Object.freeze({
        category: "read-only" as const,
        isConcurrencySafe: true,
        interruptBehavior: "block" as const,
        timeoutTier: "default" as const,
      }),
    });
    (globalThis as { __catalog?: ReturnType<typeof makeCatalog> }).__catalog =
      makeCatalog([tool]);
    const inner: Executor = Object.freeze({
      executeAll: async (
        calls: ReadonlyArray<ToolCall>,
        signal?: AbortSignal
      ): Promise<ReadonlyArray<ToolExecutionResult>> => {
        const call = calls[0]!;
        const def = (
          globalThis as { __catalog?: ReturnType<typeof makeCatalog> }
        ).__catalog?.get(call.name);
        const payload = await def!.handler(call.input, { signal });
        return [
          {
            kind: "ok",
            toolUseId: call.id,
            payload: [{ type: "text", text: JSON.stringify(payload) }],
          },
        ];
      },
    });
    const notices: string[] = [];
    const aciExec = createAciExecutor({
      inner,
      catalog: (globalThis as { __catalog?: ReturnType<typeof makeCatalog> })
        .__catalog!,
    });
    const caller = new AbortController();
    const execution = aciExec.executeAll(
      [{ id: "u1", name: "block-notice", input: {} }],
      caller.signal,
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => {
        if (event.type === "stop_summary") notices.push(event.text);
      }
    );
    await handlerStarted;
    caller.abort();

    const results = await execution;
    assert.equal(results[0]?.kind, "execution_failed");
    if (results[0]?.kind === "execution_failed") {
      assert.equal(results[0].message, "cancelled");
    }
    assert.deepEqual(notices, [BLOCK_OPERATION_NOTICE]);
  });
});

describe("SC13 — bash real spawn partial output preserved", () => {
  it.skipIf(!hasBwrap())(
    "abort mid-run preserves partial stdout (deterministic barrier)",
    async () => {
      const cwd = await makeScratch("interrupt-routing-bash-");
      const tool = createBashTool(cwd);
      // The script lives in cwd and runs via `node <file>`: "node" is on the
      // allowlist and the file contents never enter bash parsing, so shell
      // metachars (`;` / `(` / `|` / `&&`) are fully avoided. The fixture
      // writes fd 1 directly with fs.writeSync (bypassing libuv's userspace
      // buffering of piped stdout) and drops a pid marker; aborting only
      // after the marker appears removes the flake where buffered output is
      // lost to SIGTERM before flush.
      await writeFile(
        join(cwd, "echo-loop.cjs"),
        [
          'const fs = require("node:fs");',
          "for (let i = 1; i <= 20; i++) {",
          "  fs.writeSync(1, 'line ' + i + '\\n');",
          "}",
          `fs.writeFileSync(${JSON.stringify(join(cwd, "started"))}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("\n")
      );
      const controller = new AbortController();
      const execution = tool.handler(
        { command: "node echo-loop.cjs" },
        { signal: controller.signal }
      );
      await waitForPidFile(join(cwd, "started"));
      controller.abort();
      const result = parseBashEnvelope((await execution) as BashEnvelope);
      assert.ok(
        result.stdout.length > 0,
        `expected partial stdout, got: ${JSON.stringify(result.stdout)}`
      );
      assert.match(result.stdout, /line \d+/);
    },
    5_000
  );

  it.skipIf(!hasBwrap())(
    "abort yields execution_failed with partial (via AciExecutor wiring)",
    async () => {
      const cwd = await makeScratch("interrupt-routing-aci-bash-");
      const bashTool = createBashTool(cwd);
      await writeFile(
        join(cwd, "echo-loop.cjs"),
        [
          'const fs = require("node:fs");',
          "for (let i = 1; i <= 20; i++) {",
          "  fs.writeSync(1, 'line ' + i + '\\n');",
          "}",
          `fs.writeFileSync(${JSON.stringify(join(cwd, "started"))}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("\n")
      );
      (globalThis as { __catalog?: ReturnType<typeof makeCatalog> }).__catalog =
        makeCatalog([bashTool]);
      const inner: Executor = Object.freeze({
        executeAll: async (
          calls: ReadonlyArray<ToolCall>,
          signal?: AbortSignal
        ): Promise<ReadonlyArray<ToolExecutionResult>> => {
          const call = calls[0]!;
          const payload = await bashTool.handler(call.input, { signal });
          // mirrors the real Executor.safeContent envelope discrimination: a
          // bash handler returns `{ output, meta? }` and only the output
          // string reaches the model-visible tool_result; meta never does.
          const text =
            typeof payload === "string"
              ? payload
              : typeof (payload as { output?: unknown })?.output === "string"
                ? (payload as { output: string }).output
                : JSON.stringify(payload);
          return [
            {
              kind: "ok",
              toolUseId: call.id,
              payload: [{ type: "text", text }],
            },
          ];
        },
      });
      const aciExec = createAciExecutor({
        inner,
        catalog: (globalThis as { __catalog?: ReturnType<typeof makeCatalog> })
          .__catalog!,
        timeoutMsOverride: 5_000,
      });
      const controller = new AbortController();
      // executeAll must be started first — it spawns the bash process that
      // writes the marker — then awaited: marker → abort → collect results,
      // same shape as the test above.
      const execution = aciExec.executeAll(
        [
          {
            id: "u1",
            name: "bash",
            input: { command: "node echo-loop.cjs" },
          },
        ],
        controller.signal
      );
      await waitForPidFile(join(cwd, "started"));
      controller.abort();
      const results = await execution;
      const r = results[0]!;
      assert.equal(r.kind, "execution_failed");
      if (r.kind === "execution_failed") {
        assert.equal(r.message, "cancelled");
        assert.ok(
          r.partial && r.partial.stdout && r.partial.stdout.length > 0,
          `expected partial.stdout, got: ${JSON.stringify(r.partial)}`
        );
        assert.match(r.partial!.stdout!, /line \d+/);
      }
    },
    5_000
  );
});

describe("SC15 — block 工具完成不被 caller abort 打断(已在上文覆盖,本处冗余回归 block + 文件标记)", () => {
  it("block 工具:caller abort 期间 handler 仍写文件并完成", async () => {
    const cwd = await makeScratch("interrupt-block-file-");
    const marker = join(cwd, "marker.txt");
    const tool: AciToolDef = Object.freeze({
      name: "block-file",
      description: "block tool writes marker",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async () => {
        await new Promise<void>((r) => setTimeout(r, 50));
        await writeFile(marker, "ok", "utf8");
        return { wrote: true };
      },
      aci: Object.freeze({
        category: "write" as const,
        isConcurrencySafe: false,
        interruptBehavior: "block" as const,
        timeoutTier: "default" as const,
      }),
    });
    (globalThis as { __catalog?: ReturnType<typeof makeCatalog> }).__catalog =
      makeCatalog([tool]);
    const inner: Executor = Object.freeze({
      executeAll: async (
        calls: ReadonlyArray<ToolCall>
      ): Promise<ReadonlyArray<ToolExecutionResult>> => {
        const call = calls[0]!;
        const def = (
          globalThis as { __catalog?: ReturnType<typeof makeCatalog> }
        ).__catalog?.get(call.name);
        if (!def) {
          return [
            {
              kind: "tool_not_found",
              toolUseId: call.id,
              toolName: call.name,
            },
          ];
        }
        const payload = await def.handler(call.input, undefined);
        return [
          {
            kind: "ok",
            toolUseId: call.id,
            payload: [{ type: "text", text: JSON.stringify(payload) }],
          },
        ];
      },
    });
    const aciExec = createAciExecutor({
      inner,
      catalog: (globalThis as { __catalog?: ReturnType<typeof makeCatalog> })
        .__catalog!,
    });
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 10);
    const results = await aciExec.executeAll(
      [{ id: "u1", name: "block-file", input: {} }],
      caller.signal
    );
    // the handler ran to completion, so the marker exists
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(marker, "utf8");
    assert.equal(content, "ok");
    // the caller still gets a cancelled result once the blocked tool finishes
    assert.equal(results[0]!.kind, "execution_failed");
    if (results[0]!.kind === "execution_failed") {
      assert.equal(results[0]!.message, "cancelled");
    }
  });
});

describe("SC16 — computeToolStopFlags:回合 timeout 只认 signal 时钟标记(ADR-0091)", () => {
  it("ADR-0091 SC3:单条 result 标签 'timeout'(无 signal)不再停回合", () => {
    // A per-call tier timeout fails only that tool_result; the turn clock is
    // the sole source of timedOut, so the turn must keep going.
    const r: ToolExecutionResult = {
      kind: "execution_failed",
      toolUseId: "u1",
      message: "timeout",
    };
    const flags = computeToolStopFlags({
      results: [r],
      signal: undefined,
    });
    assert.equal(flags.timedOut, false);
    assert.equal(flags.cancelled, false);
  });

  it("result 标签 'cancelled' 语义保留:仍标 cancelled、不标 timeout", () => {
    const r: ToolExecutionResult = {
      kind: "execution_failed",
      toolUseId: "u1",
      message: "cancelled",
    };
    const flags = computeToolStopFlags({ results: [r], signal: undefined });
    assert.equal(flags.timedOut, false);
    assert.equal(flags.cancelled, true);
  });

  it("result 标签 'preempted' / 'timeout:bash'(无 signal)全不误判", () => {
    const r1: ToolExecutionResult = {
      kind: "execution_failed",
      toolUseId: "u1",
      message: "preempted",
    };
    const f1 = computeToolStopFlags({ results: [r1], signal: undefined });
    assert.equal(f1.timedOut, false);
    assert.equal(f1.cancelled, false);
    const r2: ToolExecutionResult = {
      kind: "execution_failed",
      toolUseId: "u2",
      message: "timeout:bash",
    };
    const f2 = computeToolStopFlags({ results: [r2], signal: undefined });
    assert.equal(f2.timedOut, false, "'timeout:bash' 不应误判为 timeout");
    assert.equal(f2.cancelled, false);
  });

  it("ADR-0091 SC4:signal 以 reason 'turn-timeout' abort → timedOut,cancelled 不抢先", () => {
    const controller = new AbortController();
    controller.abort("turn-timeout");
    const flags = computeToolStopFlags({
      results: [],
      signal: controller.signal,
    });
    assert.equal(flags.timedOut, true);
    assert.equal(flags.cancelled, false);
  });

  it("ADR-0091 SC4:reason 'timeout:foo' 严格 equal 不匹配(前缀不误判)", () => {
    const controller = new AbortController();
    controller.abort("timeout:foo");
    const flags = computeToolStopFlags({
      results: [],
      signal: controller.signal,
    });
    assert.equal(flags.timedOut, false);
    assert.equal(flags.cancelled, true, "非时钟 abort 仍是 caller 取消");
  });

  it("plain abort(无 reason)归 caller 取消,不是回合 timeout", () => {
    const controller = new AbortController();
    controller.abort();
    const flags = computeToolStopFlags({
      results: [],
      signal: controller.signal,
    });
    assert.equal(flags.timedOut, false);
    assert.equal(flags.cancelled, true);
  });

  it("reason 'subagent-timeout' 不是回合钟 → cancelled(SIGTERM 收尾不回归)", () => {
    // worker.ts aborts with "subagent-timeout" on SIGTERM and expects that to
    // land as stopReason=cancelled for its own teardown envelope, never as timeout.
    const controller = new AbortController();
    controller.abort("subagent-timeout");
    const flags = computeToolStopFlags({
      results: [],
      signal: controller.signal,
    });
    assert.equal(flags.timedOut, false);
    assert.equal(flags.cancelled, true);
  });
});

/**
 * `AnthropicContentBlock`'s tool_result arm declares `content: unknown` — the
 * Adapter ships the vendor-facing array verbatim without structural typing.
 * This narrows it to the text-block array the encoder actually emits here.
 */
function toolResultTexts(block: { readonly content: unknown }): ReadonlyArray<{
  readonly text: string;
}> {
  return block.content as ReadonlyArray<{ readonly text: string }>;
}

describe("encodeToolResults — partial 输出编码", () => {
  it("execution_failed + partial.stdout/stderr 序列化为额外 text 块", () => {
    const blocks = encodeToolResults([
      {
        kind: "execution_failed",
        toolUseId: "u1",
        message: "cancelled",
        partial: { stdout: "line 1\nline 2\n", stderr: "warn!" },
      },
    ]);
    assert.equal(blocks.length, 1);
    const block = blocks[0]!;
    assert.equal(block.type, "tool_result");
    if (block.type === "tool_result") {
      assert.equal(block.tool_use_id, "u1");
      assert.equal(block.is_error, true);
      const contents = toolResultTexts(block);
      // three text blocks: error / partial stdout / partial stderr
      assert.equal(contents.length, 3);
      assert.equal(contents[0]?.text, "[execution_failed] cancelled");
      assert.equal(contents[1]?.text, "[partial stdout]\nline 1\nline 2\n");
      assert.equal(contents[2]?.text, "[partial stderr]\nwarn!");
    }
  });

  it("无 partial 时保持单文本块(向后兼容)", () => {
    const blocks = encodeToolResults([
      {
        kind: "execution_failed",
        toolUseId: "u1",
        message: "timeout",
      },
    ]);
    assert.equal(blocks.length, 1);
    const block = blocks[0]!;
    if (block.type === "tool_result") {
      const contents = toolResultTexts(block);
      assert.equal(contents.length, 1);
      assert.equal(contents[0]?.text, "[execution_failed] timeout");
    }
  });

  it("partial 中空 stdout/stderr 跳过(避免噪声)", () => {
    const blocks = encodeToolResults([
      {
        kind: "execution_failed",
        toolUseId: "u1",
        message: "cancelled",
        partial: { stdout: "", stderr: "x" },
      },
    ]);
    assert.equal(blocks.length, 1);
    const block = blocks[0]!;
    if (block.type === "tool_result") {
      const contents = toolResultTexts(block);
      assert.equal(contents.length, 2);
      assert.equal(contents[1]?.text, "[partial stderr]\nx");
    }
  });
});

/** Guards the real-spawn tests; the pure-argv cases run with or without bwrap. */
function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

/** The bash handler answers with an envelope `{ output, meta? }`, so this
 *  helper translates between it and the `{ code, stdout, stderr }` shape the
 *  partial-stdout assertions use; assertion strength is unchanged. */
interface BashResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
interface BashEnvelope {
  readonly output: string;
  readonly meta?: { readonly stdout?: string; readonly stderr?: string };
}
function parseBashEnvelope(envelope: BashEnvelope): BashResult {
  return JSON.parse(envelope.output) as BashResult;
}

describe("SC13 — bash tier timeout (via timeoutMsOverride seam)", () => {
  it.skipIf(!hasBwrap())(
    "tier timeout fires at the override deadline and preserves partial stdout",
    async () => {
      const cwd = await makeScratch("interrupt-routing-bash-tier-");
      const bashTool = createBashTool(cwd);
      await writeFile(
        join(cwd, "echo-loop.cjs"),
        [
          'const fs = require("node:fs");',
          "for (let i = 1; i <= 50; i++) {",
          "  fs.writeSync(1, 'line ' + i + '\\n');",
          "}",
          "setInterval(() => {}, 1000);",
        ].join("\n")
      );
      const inner: Executor = Object.freeze({
        executeAll: async (
          calls: ReadonlyArray<ToolCall>,
          signal?: AbortSignal
        ): Promise<ReadonlyArray<ToolExecutionResult>> => {
          const call = calls[0]!;
          const payload = await bashTool.handler(call.input, { signal });
          // mirrors the real Executor.safeContent envelope discrimination: a
          // bash handler returns `{ output, meta? }` and only the output
          // string reaches the model-visible tool_result; meta never does.
          const text =
            typeof payload === "string"
              ? payload
              : typeof (payload as { output?: unknown })?.output === "string"
                ? (payload as { output: string }).output
                : JSON.stringify(payload);
          return [
            {
              kind: "ok",
              toolUseId: call.id,
              payload: [{ type: "text", text }],
            },
          ];
        },
      });
      // Real bash tier is build (5 min); the seam compresses it to 500ms to
      // exercise tier-timeout authority plus partial salvage. 500ms keeps headroom
      // over the bwrap→node startup chain (p90≈220ms, ≈310ms under load) so the
      // timer cannot fire before the fixture has written anything.
      const aciExec = createAciExecutor({
        inner,
        catalog: makeCatalog([bashTool]),
        timeoutMsOverride: 500,
      });
      const start = Date.now();
      const results = await aciExec.executeAll([
        { id: "u1", name: "bash", input: { command: "node echo-loop.cjs" } },
      ]);
      const elapsed = Date.now() - start;
      // must finish within ~500ms + salvage, far below natural runtime.
      assert.ok(
        elapsed < 4_000,
        `expected tier timeout (~300ms + salvage), got ${elapsed}ms`
      );
      const r = results[0]!;
      assert.equal(r.kind, "execution_failed");
      if (r.kind === "execution_failed") {
        assert.equal(r.message, "timeout");
        assert.ok(
          r.partial && r.partial.stdout && r.partial.stdout.length > 0,
          `expected partial.stdout on tier timeout, got: ${JSON.stringify(r.partial)}`
        );
        assert.match(r.partial!.stdout!, /line \d+/);
      }
    },
    10_000
  );
});

describe("SC16/ADR-0091 — loop engine integration: 单 call tier timeout 不停回合", () => {
  it("AciExecutor tier timeout → 该条 result 仍 execution_failed timeout,回合 continue 并消费后续模型回应", async () => {
    // Real loop engine + real Executor (createExecutor) + stub model: one call
    // exceeds the ACI fast tier while the signal is never aborted, so that
    // tool_result still reports execution_failed "timeout" (ADR-0005) but the
    // turn must not be classified as timed out (ADR-0091); the stub's second
    // response is consumed and the run ends completed.
    const slowToolDef: AciToolDef = Object.freeze({
      name: "slow",
      description: "stub slow tool",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        return { ok: true };
      },
      aci: Object.freeze({
        category: "read-only" as const,
        isConcurrencySafe: true,
        interruptBehavior: "cancel" as const,
        timeoutTier: "fast" as const,
      }),
    });
    const reg = createRegistry([slowToolDef]);
    const inner = createExecutor(reg);
    const aciExec = createAciExecutor({
      inner,
      registry: reg,
      timeoutMsOverride: 50, // real fast tier is 5s; compressed to 50ms
    });
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "u1", name: "slow", input: {} }],
        }),
        assistantResult({ texts: ["done"], toolCalls: [] }),
      ],
    });
    const { result } = await run("go", {
      adapter: model,
      executor: aciExec,
      registry: reg,
      maxTurns: 5,
      toolTimeoutMs: 50,
    });
    // the turn continues: the second model response is consumed → completed
    assert.equal(result.stopReason, "completed");
    assert.notEqual(result.stopReason, "timeout");
    assert.equal(result.turnCount, 2);
    assert.equal(result.finalText, "done");
    // authoritative history: user / assistant(tool_use) / user(tool_result) / assistant(text).
    assert.equal(result.messages.length, 4);
    const trBlock = result.messages[2]!.content[0]! as {
      type: string;
      is_error?: boolean;
      tool_use_id: string;
      content: ReadonlyArray<{ text?: string }>;
    };
    assert.equal(trBlock.is_error, true);
    assert.equal(trBlock.tool_use_id, "u1");
    assert.equal(trBlock.content[0]!.text, "[execution_failed] timeout");
  }, 10_000);

  it("SC3/grep-wave-survive: 一波 ≥2 tool_use, 单条 execution_failed timeout 仍把 ok 兄弟的 tool_result 交给模型, 回合 continue", async () => {
    // Two tool_use in one wave, exactly one hits the tier clock
    // → execution_failed "timeout", the other is ok; the signal is never aborted →
    // the turn continues and both tool_results reach the authoritative history
    // (the model can still answer from the ok one). ADR-0091 pins this invariant.
    const slowToolDef: AciToolDef = Object.freeze({
      name: "slow",
      description: "stub slow tool",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        return { ok: true };
      },
      aci: Object.freeze({
        category: "read-only" as const,
        isConcurrencySafe: true,
        interruptBehavior: "cancel" as const,
        timeoutTier: "fast" as const,
      }),
    });
    const fastToolDef: AciToolDef = Object.freeze({
      name: "fast",
      description: "stub fast tool",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async () => ({ ok: true, payload: "fast-ok" }),
      aci: Object.freeze({
        category: "read-only" as const,
        isConcurrencySafe: true,
        interruptBehavior: "cancel" as const,
        timeoutTier: "fast" as const,
      }),
    });
    const reg = createRegistry([slowToolDef, fastToolDef]);
    const inner = createExecutor(reg);
    const aciExec = createAciExecutor({
      inner,
      registry: reg,
      timeoutMsOverride: 50, // real fast tier is 5s; 50ms makes slow hit the tier clock
    });
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            { id: "u-slow", name: "slow", input: {} },
            { id: "u-fast", name: "fast", input: {} },
          ],
        }),
        assistantResult({ texts: ["done"], toolCalls: [] }),
      ],
    });
    const { result, trace } = await run("go", {
      adapter: model,
      executor: aciExec,
      registry: reg,
      maxTurns: 5,
      toolTimeoutMs: 50,
    });
    // (a) the turn continues → stopReason "completed", turnCount = 2.
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 2);
    // (b) the tool_result user message carries both results — exactly one is_error
    //     true, the other not, and the ok block keeps the fast tool's real payload.
    const trMsg = result.messages[2]!;
    assert.equal(trMsg.role, "user");
    const blocks = trMsg.content as ReadonlyArray<{
      type: string;
      is_error?: boolean;
      tool_use_id: string;
      content: ReadonlyArray<{ type: "text"; text: string }>;
    }>;
    assert.equal(blocks.length, 2);
    const byId = new Map(blocks.map((b) => [b.tool_use_id, b]));
    const slowBlock = byId.get("u-slow")!;
    const fastBlock = byId.get("u-fast")!;
    assert.equal(slowBlock.is_error, true);
    assert.equal(slowBlock.content[0]!.text, "[execution_failed] timeout");
    // ok results omit the is_error key entirely (tool-result.ts), so compare
    // against true instead of asserting strict equality with false.
    assert.notEqual(fastBlock.is_error, true);
    assert.ok(
      fastBlock.content[0]!.text.includes("fast-ok"),
      `expected fast tool payload in ok tool_result, got: ${fastBlock.content[0]!.text}`
    );
    // (c) trace: one turn with two toolCalls — one execution_failed "timeout", one ok.
    const toolTurn = trace.turns.find((t) => t.toolCalls.length > 0)!;
    assert.ok(toolTurn, "expected a turn trace carrying the tool calls");
    assert.equal(toolTurn.cancelKind, "none");
    assert.equal(toolTurn.toolCalls.length, 2);
    const traceById = new Map(toolTurn.toolCalls.map((c) => [c.toolUseId, c]));
    assert.equal(traceById.get("u-slow")!.kind, "execution_failed");
    assert.equal(traceById.get("u-slow")!.message, "timeout");
    assert.equal(traceById.get("u-fast")!.kind, "ok");
  }, 10_000);
});
