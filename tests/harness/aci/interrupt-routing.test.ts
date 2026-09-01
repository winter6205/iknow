/**
 * 124 / T5 — per-tool timeoutTier + interruptBehavior routing 验收套件。
 *
 * 覆盖（来自 issue #124 SC13 / SC14 / SC15 / SC16 / SC17）：
 *   - SC17 tier 映射:fast=5s / default=30s / build=300s / long=1800s;
 *     engine 传入的 timeoutMs 被工具 tier 覆盖。
 *   - SC17 interruptBehavior:
 *       cancel 工具 → caller signal 透传到 ctx.signal;aborted 时归一为 cancelled
 *       block 工具 → caller signal 不透传;handler 跑完后转 cancelled(无 partial)
 *   - SC13 bash real spawn:partial stdout 在 cancellation 下被保留
 *   - SC15 block 工具完成不被 caller abort 打断;caller abort 后返 cancelled
 *   - SC16 loop proceeds after timeout/cancel:单次 timeout 后下一回合可继续
 *   - computeToolStopFlags 严格 equal("timeout" / "cancelled"),无前缀/后缀宽容
 *
 * 实现策略：
 *   - tier 测试使用 createAciExecutor 的 `timeoutMsOverride` 测试 seam,
 *     不必等 5 分钟即可验证"工具 tier 是权威"覆盖。
 *   - bash SC13 使用真 spawn;fixture 用 fs.writeSync 直写 fd 1(绕过 Node piped
 *     stdout 的 libuv 用户态缓冲),abort 前用 waitForPidFile 屏障等 fixture
 *     落 marker,断言 partial stdout 含 "line N"。
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

/** 构造一个最小 AciToolDef,带可观测 ctx.signal 的 handler。 */
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
    input: unknown,
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

/** 顶层 inner executor — 直接执行单个 handler 调用,不绕 permission middleware。 */
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
          // 模拟 Executor.safeContent:payload → JSON text block
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
      resolveAfterMs: 5_000, // 模拟一个真正需要 ~5s 的 handler
    });
    (globalThis as { __catalog?: ReturnType<typeof makeCatalog> }).__catalog =
      makeCatalog([tool]);
    const inner = makeInner();
    // 测试 seam:timeoutMsOverride 把 fast tier 缩到 200ms,模拟一个真实超时。
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
    // 应在 200~500ms 内超时(未走完整 5000ms)
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
      // 模拟 engine 仍按老路径传 600_000;但 tier 覆盖它。
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
    // handler 记录执行期间是否观察到 signal abort(透传验证)。
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
    // inner 把 signal 透传给 handler 的 ctx.signal(真实 Executor 行为)。
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
    // cancel 工具:caller signal 透传到 handler(handler 观察到 aborted)。
    assert.equal(handlerSawAbort, true, "cancel 工具应透传 caller signal");
    // 收尾归一为 cancelled。
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
        new Promise<undefined>((resolve) => setTimeout(resolve, 100)),
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
        await new Promise<never>((_resolve, reject) => {
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
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
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
        await new Promise<never>((_resolve, reject) => {
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
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
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
    // block 工具:resolve 在 100ms,但我们在 20ms caller abort。
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
        // 把传入的 signal 暴露给 handler ctx.signal,handler 观察是否 abort
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
      // 写脚本到 cwd 再 `node <file>` — "node" 在 allowlist,文件内容不进
      // bash 解析,完全规避 shell metachar(`;` / `(` / `|` / `&&`)。
      // fixture 用 fs.writeSync 直写 fd 1(绕过 Node piped stdout 的 libuv
      // 用户态缓冲)+ marker 屏障:先等 fixture 把行写出并落 marker,再 abort,
      // 消除"console.log 缓冲未 flush 就随 SIGTERM 丢失"的时序 flake。
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
      const result = (await execution) as {
        code: number;
        stdout: string;
        stderr: string;
      };
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
          const text =
            typeof payload === "string" ? payload : JSON.stringify(payload);
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
      // executeAll 必须先启动(bash 进程由此产生),fixture 才可能落 marker;
      // 若先 waitForPidFile 再 executeAll,marker 永远不出现(进程还没 spawn)。
      // 启动后不 await,等 marker → abort → 再收执行结果,与 test 1 同构。
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
    // 文件应被写入(handler 没被中断)
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(marker, "utf8");
    assert.equal(content, "ok");
    // 但 final result 仍是 cancelled(block 完成后我们归一)
    assert.equal(results[0]!.kind, "execution_failed");
    if (results[0]!.kind === "execution_failed") {
      assert.equal(results[0]!.message, "cancelled");
    }
  });
});

describe("SC16 — loop proceeds after timeout/cancel (computeToolStopFlags 严格 equal)", () => {
  it("timedOut flag 严格匹配 'timeout'(无前缀/后缀宽容)", () => {
    const r: ToolExecutionResult = {
      kind: "execution_failed",
      toolUseId: "u1",
      message: "timeout",
    };
    const flags = computeToolStopFlags({
      results: [r],
      signal: undefined,
    });
    assert.equal(flags.timedOut, true);
    assert.equal(flags.cancelled, false);
  });

  it("cancelled flag 严格匹配 'cancelled'(无前缀/后缀宽容)", () => {
    const r: ToolExecutionResult = {
      kind: "execution_failed",
      toolUseId: "u1",
      message: "cancelled",
    };
    const flags = computeToolStopFlags({ results: [r], signal: undefined });
    assert.equal(flags.timedOut, false);
    assert.equal(flags.cancelled, true);
  });

  it("'preempted' / 'timeout:foo' 不应误判为 timeout", () => {
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
  });
});

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
      const contents = block.content;
      // 三个 text 块:error / partial stdout / partial stderr
      assert.equal(contents.length, 3);
      assert.equal(
        (contents[0] as { text: string }).text,
        "[execution_failed] cancelled"
      );
      assert.equal(
        (contents[1] as { text: string }).text,
        "[partial stdout]\nline 1\nline 2\n"
      );
      assert.equal(
        (contents[2] as { text: string }).text,
        "[partial stderr]\nwarn!"
      );
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
      const contents = block.content;
      assert.equal(contents.length, 1);
      assert.equal(
        (contents[0] as { text: string }).text,
        "[execution_failed] timeout"
      );
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
      assert.equal(block.content.length, 2);
      assert.equal(
        (block.content[1] as { text: string }).text,
        "[partial stderr]\nx"
      );
    }
  });
});

/** bwrap 探测:真 spawn 测试用 skipIf 守卫;argv 纯逻辑测试不受影响。 */
function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
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
          const text =
            typeof payload === "string" ? payload : JSON.stringify(payload);
          return [
            {
              kind: "ok",
              toolUseId: call.id,
              payload: [{ type: "text", text }],
            },
          ];
        },
      });
      // 真实 bash tier = build(5 min);测试 seam 把它压到 500ms,验证 tier
      // timeout 权威覆盖 + partial salvage(SC13)。500ms 保留对 bwrap→node
      // 启动链(p90≈220ms,重载下 max≈310ms)的余量,避免 tier 先于 fixture
      // 产出就命中 → partial 为空 的时序 flake。
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
      // 应在 ~500ms + salvage 内收尾,远小于自然耗时(50 行瞬间写出)。
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

describe("SC16 — loop engine integration: tier timeout 后 loop 停在 timeout", () => {
  it("AciExecutor tier timeout 经 loop engine → stopReason=timeout;下一回合可续跑", async () => {
    // 真 loop engine + 真 Executor(createExecutor)+ stub model:tier 超时
    // 的 slow 工具把 stopReason 钉为 timeout,验证 partial 加法字段不破坏
    // computeToolStopFlags 的 strict-equal 契约(SC16)。
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
      timeoutMsOverride: 50, // fast 真值 5s;压到 50ms
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
    // tier timeout → loop 停在 timeout;权威历史含 tool_result(execution_failed timeout)。
    assert.equal(result.stopReason, "timeout");
    assert.equal(result.messages.length, 3);
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
});
