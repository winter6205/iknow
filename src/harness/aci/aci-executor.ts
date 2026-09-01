/**
 * ACI 能力层：装饰执行器（毕业过渡）。
 *
 * 5-step middleware (preToolUse → checkPermission → askUser → inner → postToolUse)
 * 现已在 `src/harness/permission/permission-executor.ts` 实现；本文件保留
 * 原型 API（createAciExecutor / AciExecutorOptions / onDecision 观测钩子），
 * 内部转调到新的 PermissionExecutor。
 *
 * 124/T5 增量：包一层 per-tool tier + interruptBehavior 路由:
 *   - 工具 catalog 中声明的 `timeoutTier` 覆盖 Loop Engine 传入的 timeoutMs(#124 决策 3-4)。
 *   - interruptBehavior="cancel" 透传 caller 的 AbortSignal 到 inner;caller abort
 *     立即抢占等待并返 "cancelled";若 handler 未收尾则标记后台运行并通知
 *     host,timeout 命中返 "timeout"。
 *   - interruptBehavior="block" 不透传 caller signal(只透传由 tier timeout 控制的
 *     新 AbortController),handler 跑完自然完成;若 caller signal 在等待期内 abort,
 *     收尾时把 ok 结果转换成 execution_failed { message: "cancelled" }(无 partial,
 *     因 handler 是干净的),并通过 host 状态通道说明该等待不可中止。
 *   - bash handler 在被中断/超时前可能已 flush 部分 stdout/stderr;把这些 partial
 *     内容塞到 execution_failed.partial,以便 Anthropic Adapter 编码为额外的
 *     [partial stdout] / [partial stderr] 文本块(SC13)。
 */

import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
  Registry,
} from "../tools/types.js";
import type { HarnessStreamEvent } from "../stream.js";
import { safeEmitStream } from "../stream.js";
import type { PermissionOutcome } from "../permission/types.js";
import {
  createPermissionRuntime,
  type PermissionExecutorOptions,
  type PermissionRuntime,
} from "../permission/permission-executor.js";
import { partitionConcurrencyWaves } from "../tools/concurrency-waves.js";
import { createAciCatalog } from "../permission/permission-executor.js";
import { checkPermission } from "../permission/policy.js";
import { errorMessage } from "../errors.js";
import { createPermissionPolicy } from "./permission.js";
import { TIMEOUT_TIER_MS, type AciCatalog, type AciToolDef } from "./types.js";

export interface AciBackgroundRejection {
  readonly kind: "background_handler_rejection";
  readonly toolUseId: string;
  readonly toolName: string;
  readonly error: unknown;
}

export type AciDiagnosticSink = (
  diagnostic: AciBackgroundRejection
) => void | Promise<void>;

/**
 * Host-visible notice for a caller abort that detached an uncooperative
 * handler. The stream event is the existing status channel available to TUI.
 */
export const BACKGROUND_OPERATION_NOTICE =
  "界面已停止等待，但底层操作仍在后台运行";
export const BLOCK_OPERATION_NOTICE =
  "界面已停止等待，但 block 操作仍在后台收尾";

export interface AciExecutorOptions {
  readonly inner: Executor;
  readonly catalog?: import("./types.js").AciCatalog;
  readonly policy?: ReturnType<typeof createPermissionPolicy>;
  /** Legacy shape compat: when no registry/catalog passed, build catalog from registry. */
  readonly registry?: Registry;
  /** Optional askUser injection (defaults to no-ask for prototype/test callers). */
  readonly askUser?: PermissionExecutorOptions["askUser"];
  /** Optional hooks; default no-op. */
  readonly hooks?: {
    readonly preToolUse?: PermissionExecutorOptions["preToolUse"];
    readonly postToolUse?: PermissionExecutorOptions["postToolUse"];
  };
  /** 观测钩子：每次权限决策回调（demo/测试用，不参与决策）。 */
  readonly onDecision?: (call: ToolCall, outcome: PermissionOutcome) => void;
  /**
   * Diagnostic sink for a handler rejection observed after the caller has
   * already received a cancellation result. Omitted callers still get a
   * sanitized stderr record.
   */
  readonly onDiagnostic?: AciDiagnosticSink;
  /**
   * Test seam:per-tool tier 覆盖为该固定毫秒值(测试 tier timeout 不必等真值)。
   * 默认 undefined = 走真实 TIMEOUT_TIER_MS。生产调用方不传。
   */
  readonly timeoutMsOverride?: number;
}

/**
 * Decorate inner Executor with the 5-step permission middleware + T5 per-tool
 * tier + interruptBehavior routing. Back-compat shim: built on top of
 * permission/permission-executor so the prototype tests (which import from
 * aci/) keep passing without changing their call sites.
 *
 * #653 T2 (P 包):安全批可重叠 — executeAll 在 catalog 标注的 `isConcurrencySafe`
 * 维度上做 wave 调度:同一 wave 内连续 `isConcurrencySafe: true` 的 call 通过
 * Promise.all 并发启动;`isConcurrencySafe: false`(以及 catalog miss 的保守默认)
 * 的 call 必须独占一个 singleton wave,与任何其它 call 不重叠。结果顺序按输入
 * calls 顺序保持,per-call pre/permission/post 步骤仍在各自 routeOneCall 内逐
 * 调用走(5-step 中间件不变)。
 */
export function createAciExecutor(opts: AciExecutorOptions): Executor {
  const policy = opts.policy ?? createPermissionPolicy();
  // Build a registry-compatible surface: if catalog was passed, wrap it as a
  // Registry. Otherwise expect opts.registry to have been provided.
  let registry: Registry | undefined = opts.registry;
  if (!registry && opts.catalog) {
    const all = opts.catalog.all();
    registry = Object.freeze({
      list: () => all,
      get: (name: string) => opts.catalog!.get(name),
    });
  }
  if (!registry) {
    throw new Error(
      "createAciExecutor: either `catalog` or `registry` must be provided"
    );
  }
  const askUser = opts.askUser ?? (async () => true); // prototype default: no-ask approve
  const perm = createPermissionRuntime({
    inner: opts.inner,
    registry,
    policy,
    askUser,
    preToolUse: (ctx) => {
      return opts.hooks?.preToolUse?.(ctx);
    },
    postToolUse: opts.hooks?.postToolUse,
  });
  const catalogForT5: AciCatalog = opts.catalog ?? createAciCatalog(registry);
  return Object.freeze({
    executeAll: async (
      calls: ReadonlyArray<ToolCall>,
      signal?: AbortSignal,
      _timeoutMs?: number,
      conversationId?: string,
      onSettled?: (
        result: ToolExecutionResult,
        index: number
      ) => void | Promise<void>,
      turnId?: string,
      onStream?: (event: HarnessStreamEvent) => void
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      if (calls.length === 0) return [];
      const waves = partitionConcurrencyWaves(
        calls.map((call) =>
          toWaveItem(call, catalogForT5, opts, _timeoutMs, policy)
        ),
        (item) => item.doesNotBreakWave
      );
      const out: ToolExecutionResult[] = [];
      let indexBase = 0;
      for (const wave of waves) {
        const part = await runWave({
          wave,
          perm,
          policy,
          onDecision: opts.onDecision,
          onDiagnostic: opts.onDiagnostic,
          signal,
          conversationId,
          turnId,
          onSettled,
          indexBase,
          onStream,
        });
        for (const r of part) out.push(r);
        indexBase += wave.length;
      }
      return out;
    },
  });
}

type WaveItem = {
  readonly call: ToolCall;
  readonly def: AciToolDef | undefined;
  readonly tierTimeoutMs: number | undefined;
  readonly doesNotBreakWave: boolean;
};

function toWaveItem(
  call: ToolCall,
  catalog: AciCatalog,
  opts: AciExecutorOptions,
  fallbackTimeoutMs: number | undefined,
  policy: ReturnType<typeof createPermissionPolicy>
): WaveItem {
  const def = catalog.get(call.name);
  const predictedDeny =
    def !== undefined &&
    checkPermission({
      def,
      input: call.input,
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    }).decision === "deny";
  return {
    call,
    def,
    tierTimeoutMs:
      opts.timeoutMsOverride ??
      (def ? TIMEOUT_TIER_MS[def.aci.timeoutTier] : fallbackTimeoutMs),
    doesNotBreakWave: def?.aci.isConcurrencySafe === true || predictedDeny,
  };
}

function emitOnDecision(
  item: WaveItem,
  policy: ReturnType<typeof createPermissionPolicy>,
  onDecision: AciExecutorOptions["onDecision"]
): void {
  if (!onDecision) return;
  if (!item.def) {
    onDecision(item.call, {
      decision: "allow",
      reason: "unknown tool — delegated to inner",
    });
    return;
  }
  onDecision(
    item.call,
    checkPermission({
      def: item.def,
      input: item.call.input,
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    })
  );
}

async function runWave(opts: {
  readonly wave: ReadonlyArray<WaveItem>;
  readonly perm: PermissionRuntime;
  readonly policy: ReturnType<typeof createPermissionPolicy>;
  readonly onDecision: AciExecutorOptions["onDecision"];
  readonly onDiagnostic: AciExecutorOptions["onDiagnostic"];
  readonly signal: AbortSignal | undefined;
  readonly conversationId: string | undefined;
  readonly turnId: string | undefined;
  readonly onSettled:
    | ((result: ToolExecutionResult, index: number) => void | Promise<void>)
    | undefined;
  readonly indexBase: number;
  readonly onStream: ((event: HarnessStreamEvent) => void) | undefined;
}): Promise<ReadonlyArray<ToolExecutionResult>> {
  const gated: Array<{
    readonly item: WaveItem;
    readonly blocked: ToolExecutionResult | undefined;
    readonly def: AciToolDef | undefined;
  }> = [];
  for (const item of opts.wave) {
    emitOnDecision(item, opts.policy, opts.onDecision);
    const gate = await opts.perm.gateOne(item.call, opts.signal);
    gated.push({
      item,
      blocked: gate.kind === "blocked" ? gate.result : undefined,
      def: gate.kind === "proceed" ? gate.def : item.def,
    });
  }
  return Promise.all(
    gated.map((g, i) => {
      const work =
        g.blocked !== undefined
          ? Promise.resolve(g.blocked)
          : routeOneCall({
              runInner: (effectiveSignal) =>
                opts.perm.runAllowed(
                  g.item.call,
                  g.def,
                  effectiveSignal,
                  undefined,
                  opts.conversationId,
                  opts.turnId,
                  opts.onStream
                ),
              call: g.item.call,
              def: g.item.def,
              tierTimeoutMs: g.item.tierTimeoutMs,
              callerSignal: opts.signal,
              onDiagnostic: opts.onDiagnostic,
              onStream: opts.onStream,
            });
      return work.then(async (result) => {
        await opts.onSettled?.(result, opts.indexBase + i);
        return result;
      });
    })
  );
}

/**
 * tier timeout 命中后,给 inner 的"收尾窗口"(SC13 partial salvage)。
 *
 * tier abort 已经把 abort 透传给 handler(bash/grep/glob 经
 * spawnWithStopSignal 收到 SIGTERM→2s→SIGKILL;block 工具经 tierAbort signal
 * 自行收尾)。良性 handler 会在这个窗口内 settle 并交出已 flush 的
 * stdout/stderr,我们据此把 partial 塞进 execution_failed。窗口到点仍未
 * settle 则放弃 partial,直接返回裸 timeout(handler 拒绝收尾,不可等)。
 *
 * 取 3 s:bash 的 kill grace 是 2 s(SIGTERM→SIGKILL),加 1 s 收尾余量。
 */
const SALVAGE_GRACE_MS = 3_000;
/**
 * Give non-bash handlers one event-loop turn to honor caller abort before
 * declaring that the operation is still running in the background.
 */
const CALLER_SETTLE_GRACE_MS = 10;

/**
 * T5:单次调用的 tier + interruptBehavior 路由。返回一个与 call 身份匹配的
 * ToolExecutionResult,且与 `message === "timeout"` / `"cancelled"` 的
 * strict-equal 契约兼容(loop-engine.computeToolStopFlags 不需改动)。
 *
 * race 设计:inner.executeAll 与 tierAbort 触发 Promise.race。tier 先命中
 * 时不无限等 handler(防 handler 拒收尾),但给一个有界的 salvage 窗口
 * 取回已 flush 的 partial(SC13)。
 */
async function routeOneCall(opts: {
  readonly runInner: (
    signal: AbortSignal | undefined
  ) => Promise<ToolExecutionResult>;
  readonly call: ToolCall;
  readonly def: AciToolDef | undefined;
  readonly tierTimeoutMs: number | undefined;
  readonly callerSignal: AbortSignal | undefined;
  readonly onDiagnostic: AciExecutorOptions["onDiagnostic"];
  readonly onStream: ((event: HarnessStreamEvent) => void) | undefined;
}): Promise<ToolExecutionResult> {
  const {
    runInner,
    call,
    def,
    tierTimeoutMs,
    callerSignal,
    onDiagnostic,
    onStream,
  } = opts;
  const isBlock = def !== undefined && def.aci.interruptBehavior === "block";

  const tierAbort = new AbortController();
  const tierTimer: NodeJS.Timeout | undefined =
    tierTimeoutMs !== undefined && tierTimeoutMs > 0
      ? setTimeout(() => {
          tierAbort.abort(new Error("tier timeout"));
        }, tierTimeoutMs)
      : undefined;
  if (tierTimer && tierTimer.unref) tierTimer.unref();

  const effectiveSignal: AbortSignal | undefined = isBlock
    ? tierAbort.signal
    : callerSignal !== undefined
      ? AbortSignal.any([callerSignal, tierAbort.signal])
      : tierAbort.signal;

  const notifyBackground = (
    notice: string = BACKGROUND_OPERATION_NOTICE
  ): void => {
    safeEmitStream(onStream, {
      type: "stop_summary",
      text: notice,
    });
  };
  let blockNoticeSent = false;
  const notifyBlock = (): void => {
    if (blockNoticeSent) return;
    blockNoticeSent = true;
    notifyBackground(BLOCK_OPERATION_NOTICE);
  };
  let blockAbortListener: (() => void) | undefined;
  if (isBlock && callerSignal !== undefined) {
    blockAbortListener = notifyBlock;
    if (callerSignal.aborted) {
      notifyBlock();
    } else {
      callerSignal.addEventListener("abort", blockAbortListener, {
        once: true,
      });
    }
  }
  const innerPromise = runInner(effectiveSignal).then(
    (result) => [result] as const
  );

  let result: ToolExecutionResult;
  try {
    result = await awaitInnerOrTier({
      innerPromise,
      tierSignal: tierAbort.signal,
      callerSignal: isBlock ? undefined : callerSignal,
      call,
      onDiagnostic,
      onBackground: notifyBackground,
      // partial salvage 只对会产出 partial 的工具(bash)开放;其余工具 tier
      // 命中即返回 timeout,不等 handler 收尾(防 stub/良性 handler 拖慢路径)。
      salvageMs: def?.name === "bash" ? SALVAGE_GRACE_MS : 0,
    });
  } catch (err) {
    // inner 抛错(非 tier 触发):rethrow。
    if (tierAbort.signal.aborted) {
      result = {
        kind: "execution_failed",
        toolUseId: call.id,
        message: "timeout",
      };
    } else if (callerSignal?.aborted && isBlock) {
      result = {
        kind: "execution_failed",
        toolUseId: call.id,
        message: "cancelled",
      };
    } else {
      if (tierTimer !== undefined) clearTimeout(tierTimer);
      throw err;
    }
  } finally {
    if (tierTimer !== undefined) clearTimeout(tierTimer);
    if (blockAbortListener !== undefined && callerSignal !== undefined) {
      callerSignal.removeEventListener("abort", blockAbortListener);
    }
  }

  // 归一化(顺序即优先级):
  //   1. tier timeout 命中 → timeout(权威,覆盖 block/cancel 一切)。partial 若
  //      有(salvage 取回)保留。
  //   2. caller signal abort:
  //        block → cancelled(无 partial,handler 干净完成);
  //        cancel → cancelled(保留 bash partial)。
  //   3. 其余原样返回。

  if (tierAbort.signal.aborted) {
    const partial =
      result.kind === "ok" ? extractBashPartial(result, def) : undefined;
    return withPartial(
      { kind: "execution_failed", toolUseId: call.id, message: "timeout" },
      partial
    );
  }

  if (callerSignal?.aborted === true) {
    if (isBlock) {
      // block 工具:caller abort 不打断 handler;收尾后归一 cancelled(无 partial),
      // 同时经 host 状态通道说明不可中止等待。
      notifyBlock();
      return {
        kind: "execution_failed",
        toolUseId: call.id,
        message: "cancelled",
      };
    }
    const partial =
      result.kind === "ok" ? extractBashPartial(result, def) : undefined;
    const background =
      result.kind === "execution_failed" && result.background === true;
    return withPartial(
      { kind: "execution_failed", toolUseId: call.id, message: "cancelled" },
      partial,
      background
    );
  }

  // 未 abort / 未超时:若 inner 已回 cancelled/timeout(executor.runOne 在
  // signal.aborted 时的归一),补上 bash partial(若有)后原样返回。
  if (
    result.kind === "execution_failed" &&
    (result.message === "cancelled" || result.message === "timeout")
  ) {
    return result; // partial 只能从 ok payload 提取;这里 result 已是 failed
  }

  return result;
}

/**
 * await inner; tier/caller abort 先到时按需进入有界 salvage 窗口(取回
 * handler 已 flush 的 partial)。返回最终的 ToolExecutionResult:
 *   - inner 先 settle → 其结果;
 *   - caller 先到 + settle 内 inner settle → 其结果(由调用方归一 cancelled + partial);
 *   - tier 先到 + salvage 内 inner settle → 其结果(由调用方归一 timeout + partial);
 *   - abort 先到 + salvage 超时 inner 未 settle → 对应 execution_failed(无 partial)。
 */
async function awaitInnerOrTier(opts: {
  readonly innerPromise: Promise<ReadonlyArray<ToolExecutionResult>>;
  readonly tierSignal: AbortSignal;
  /** cancel tier 的 caller signal;block tier 刻意不传。 */
  readonly callerSignal: AbortSignal | undefined;
  readonly call: ToolCall;
  readonly onDiagnostic: AciExecutorOptions["onDiagnostic"];
  readonly onBackground: (() => void) | undefined;
  /** salvage 窗口(ms);caller 的 0 使用短 settle grace, tier 的 0 立即返回。 */
  readonly salvageMs: number;
}): Promise<ToolExecutionResult> {
  const {
    innerPromise,
    tierSignal,
    callerSignal,
    call,
    onDiagnostic,
    onBackground,
    salvageMs,
  } = opts;

  const tierFired = abortPromise(tierSignal);
  const callerFired =
    callerSignal === undefined
      ? undefined
      : abortPromise(callerSignal, "caller");
  const winner = await Promise.race<
    | { kind: "inner"; arr: ReadonlyArray<ToolExecutionResult> }
    | { kind: "timer" }
    | { kind: "caller" }
  >([
    innerPromise.then((arr) => ({ kind: "inner" as const, arr })),
    tierFired,
    ...(callerFired === undefined ? [] : [callerFired]),
  ]);

  if (winner.kind === "inner") {
    return winner.arr[0] as ToolExecutionResult;
  }

  if (winner.kind === "caller") {
    // caller 抢占只结束界面等待。bash 仍给既有 salvage 窗口取回 partial;
    // 其它工具给一个极短收尾窗口，仍未 settle 才视为后台运行。
    const settleGraceMs = salvageMs > 0 ? salvageMs : CALLER_SETTLE_GRACE_MS;
    const salvaged = await awaitDuringSalvage(innerPromise, settleGraceMs);
    if (salvaged.kind === "inner") return salvaged.result;
    if (salvaged.kind === "rejected") {
      void reportDetachedRejection(call, onDiagnostic, salvaged.error);
      return {
        kind: "execution_failed",
        toolUseId: call.id,
        message: "cancelled",
      };
    }
    observeDetachedRejection(innerPromise, call, onDiagnostic);
    onBackground?.();
    return {
      kind: "execution_failed",
      toolUseId: call.id,
      message: "cancelled",
      background: true,
    };
  }

  // tier 先到:abort 已透传给 handler。salvageMs>0 时给有界窗口取回 partial。
  if (salvageMs > 0) {
    const salvaged = await awaitDuringSalvage(innerPromise, salvageMs);
    if (salvaged.kind === "inner") {
      // handler 在 salvage 窗口内收尾了 — 交出它已 flush 的结果,调用方按
      // tierAbort.aborted 归一 timeout 并注入 partial。
      return salvaged.result;
    }
    if (salvaged.kind === "rejected") {
      void reportDetachedRejection(call, onDiagnostic, salvaged.error);
      return {
        kind: "execution_failed",
        toolUseId: call.id,
        message: "timeout",
      };
    }
  }

  // salvage 超时(或未开启 salvage):handler 拒绝收尾。不再等,返回裸 timeout。
  observeDetachedRejection(innerPromise, call, onDiagnostic);
  return {
    kind: "execution_failed",
    toolUseId: call.id,
    message: "timeout",
  };
}

type SalvageOutcome =
  | { readonly kind: "inner"; readonly result: ToolExecutionResult }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "grace" };

async function awaitDuringSalvage(
  innerPromise: Promise<ReadonlyArray<ToolExecutionResult>>,
  salvageMs: number
): Promise<SalvageOutcome> {
  const salvageGrace = new Promise<{ kind: "grace" }>((resolveGrace) => {
    const t = setTimeout(() => resolveGrace({ kind: "grace" }), salvageMs);
    if (t.unref) t.unref();
  });
  const salvaged = await Promise.race<
    | {
        kind: "inner";
        result: ToolExecutionResult;
      }
    | { kind: "rejected"; error: unknown }
    | { kind: "grace" }
  >([
    innerPromise.then(
      (arr) => ({
        kind: "inner" as const,
        result: arr[0] as ToolExecutionResult,
      }),
      (error: unknown) => ({ kind: "rejected" as const, error })
    ),
    salvageGrace,
  ]);
  return salvaged;
}

/** signal abort 时 resolve 的 promise(已 abort 立即 resolve)。 */
function abortPromise(
  signal: AbortSignal,
  kind: "timer" | "caller" = "timer"
): Promise<{ kind: "timer" } | { kind: "caller" }> {
  return new Promise((resolveTimer) => {
    if (signal.aborted) {
      resolveTimer({ kind });
      return;
    }
    signal.addEventListener("abort", () => resolveTimer({ kind }), {
      once: true,
    });
  });
}

/**
 * Bash ok payload 的形状:`[{ type: "text", text: JSON.stringify({ code, stdout, stderr }) }]`。
 * 把 JSON 解析出来,stdout / stderr 放回 partial(SC13)。
 */
function extractBashPartial(
  result: ToolExecutionResult,
  def: AciToolDef | undefined
): { stdout?: string; stderr?: string } | undefined {
  if (def?.name !== "bash") return undefined;
  if (result.kind !== "ok") return undefined;
  const first = result.payload[0];
  if (!first || first.type !== "text") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as { stdout?: unknown; stderr?: unknown };
  const out: { stdout?: string; stderr?: string } = {};
  if (typeof obj.stdout === "string" && obj.stdout.length > 0) {
    out.stdout = obj.stdout;
  }
  if (typeof obj.stderr === "string" && obj.stderr.length > 0) {
    out.stderr = obj.stderr;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function withPartial(
  base: { kind: "execution_failed"; toolUseId: string; message: string },
  partial: { stdout?: string; stderr?: string } | undefined,
  background: boolean = false
): ToolExecutionResult {
  if (partial === undefined && !background) return base;
  return {
    ...base,
    ...(partial !== undefined ? { partial } : {}),
    ...(background ? { background: true } : {}),
  };
}

function observeDetachedRejection(
  innerPromise: Promise<ReadonlyArray<ToolExecutionResult>>,
  call: ToolCall,
  onDiagnostic: AciExecutorOptions["onDiagnostic"]
): void {
  void innerPromise.catch((error: unknown) =>
    reportDetachedRejection(call, onDiagnostic, error)
  );
}

async function reportDetachedRejection(
  call: ToolCall,
  onDiagnostic: AciExecutorOptions["onDiagnostic"],
  error: unknown
): Promise<void> {
  const diagnostic: AciBackgroundRejection = {
    kind: "background_handler_rejection",
    toolUseId: call.id,
    toolName: call.name,
    error,
  };
  try {
    if (onDiagnostic !== undefined) {
      await onDiagnostic(diagnostic);
    } else {
      console.error(
        `[aci] ${diagnostic.kind} tool=${call.name} toolUseId=${call.id}: ${errorMessage(error)}`
      );
    }
  } catch (sinkError) {
    // EXIT: a diagnostic sink must not create a second unhandled rejection.
    console.error(
      `[aci] diagnostic sink failed for tool=${call.name} toolUseId=${call.id}: original=${errorMessage(
        error
      )}; sink=${errorMessage(sinkError)}`
    );
  }
}
