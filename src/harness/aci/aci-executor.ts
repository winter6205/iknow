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
 *   - interruptBehavior="cancel" 透传 caller 的 AbortSignal 到 inner;timeout 命中返 "timeout"。
 *   - interruptBehavior="block" 不透传 caller signal(只透传由 tier timeout 控制的
 *     新 AbortController),handler 跑完自然完成;若 caller signal 在等待期内 abort,
 *     收尾时把 ok 结果转换成 execution_failed { message: "cancelled" }(无 partial,
 *     因 handler 是干净的)。
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
import type { PermissionOutcome } from "../permission/types.js";
import {
  createPermissionExecutor,
  type PermissionExecutorOptions,
} from "../permission/permission-executor.js";
import { createAciCatalog } from "../permission/permission-executor.js";
import { checkPermission } from "../permission/policy.js";
import { createPermissionPolicy } from "./permission.js";
import { TIMEOUT_TIER_MS, type AciCatalog, type AciToolDef } from "./types.js";

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
  const executor = createPermissionExecutor({
    inner: opts.inner,
    registry,
    policy,
    askUser,
    preToolUse: (ctx) => {
      // prototype had no preToolUse; v0 keeps backward behavior (always undefined).
      // onDecision is recorded separately via middleware below.
      return opts.hooks?.preToolUse?.(ctx);
    },
    postToolUse: opts.hooks?.postToolUse,
  });
  const catalogForT5: AciCatalog = opts.catalog ?? createAciCatalog(registry);
  return Object.freeze({
    executeAll: async (
      calls: ReadonlyArray<ToolCall>,
      signal?: AbortSignal,
      _timeoutMs?: number
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      const out: ToolExecutionResult[] = [];
      for (const call of calls) {
        const def = catalogForT5.get(call.name);
        const tierTimeoutMs =
          opts.timeoutMsOverride ??
          (def ? TIMEOUT_TIER_MS[def.aci.timeoutTier] : _timeoutMs);
        if (opts.onDecision) {
          // M2 fix: `checkPermission` is statically imported at the top of
          // this module. The previous dynamic `await import(...)` was a hot-
          // path smell (per-call module load) and risked divergence between
          // this observation and the middleware's authoritative decision.
          // The middleware remains the decision authority; `onDecision` is
          // observation-only.
          if (!def) {
            opts.onDecision(call, {
              decision: "allow",
              reason: "unknown tool — delegated to inner",
            });
          } else {
            const outcome = checkPermission({
              def,
              input: call.input,
              sources: policy.sources,
              hardWalls: policy.hardWalls,
              defaultByCategory: policy.defaultByCategory,
            });
            opts.onDecision(call, outcome);
          }
        }
        const result = await routeOneCall({
          executor,
          call,
          def,
          tierTimeoutMs,
          callerSignal: signal,
        });
        out.push(result);
      }
      return out;
    },
  });
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
 * T5:单次调用的 tier + interruptBehavior 路由。返回一个与 call 身份匹配的
 * ToolExecutionResult,且与 `message === "timeout"` / `"cancelled"` 的
 * strict-equal 契约兼容(loop-engine.computeToolStopFlags 不需改动)。
 *
 * race 设计:inner.executeAll 与 tierAbort 触发 Promise.race。tier 先命中
 * 时不无限等 handler(防 handler 拒收尾),但给一个有界的 salvage 窗口
 * 取回已 flush 的 partial(SC13)。
 */
async function routeOneCall(opts: {
  readonly executor: Executor;
  readonly call: ToolCall;
  readonly def: AciToolDef | undefined;
  readonly tierTimeoutMs: number | undefined;
  readonly callerSignal: AbortSignal | undefined;
}): Promise<ToolExecutionResult> {
  const { executor, call, def, tierTimeoutMs, callerSignal } = opts;
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

  const innerPromise = executor.executeAll([call], effectiveSignal, undefined);

  let result: ToolExecutionResult;
  try {
    result = await awaitInnerOrTier({
      innerPromise,
      tierSignal: tierAbort.signal,
      call,
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
      // block 工具:caller abort 不打断 handler;收尾后归一 cancelled(无 partial)。
      return {
        kind: "execution_failed",
        toolUseId: call.id,
        message: "cancelled",
      };
    }
    const partial =
      result.kind === "ok" ? extractBashPartial(result, def) : undefined;
    return withPartial(
      { kind: "execution_failed", toolUseId: call.id, message: "cancelled" },
      partial
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
 * await inner,但 tier abort 先到时进入有界 salvage 窗口(取回 handler 已
 * flush 的 partial)。返回最终的 ToolExecutionResult:
 *   - inner 先 settle → 其结果;
 *   - tier 先到 + salvage 内 inner settle → 其结果(由调用方按 tierAbort.aborted 归一 timeout + partial);
 *   - tier 先到 + salvage 超时 inner 未 settle → execution_failed { timeout }(无 partial)。
 */
async function awaitInnerOrTier(opts: {
  readonly innerPromise: Promise<ReadonlyArray<ToolExecutionResult>>;
  readonly tierSignal: AbortSignal;
  readonly call: ToolCall;
  /** salvage 窗口(ms);0 = 不 salvage,tier 命中即返回 timeout。 */
  readonly salvageMs: number;
}): Promise<ToolExecutionResult> {
  const { innerPromise, tierSignal, call, salvageMs } = opts;

  const tierFired = abortPromise(tierSignal);
  const winner = await Promise.race<
    | { kind: "inner"; arr: ReadonlyArray<ToolExecutionResult> }
    | { kind: "timer" }
  >([innerPromise.then((arr) => ({ kind: "inner" as const, arr })), tierFired]);

  if (winner.kind === "inner") {
    return winner.arr[0] as ToolExecutionResult;
  }

  // tier 先到:abort 已透传给 handler。salvageMs>0 时给有界窗口取回 partial。
  if (salvageMs > 0) {
    const salvageGrace = new Promise<{ kind: "grace" }>((resolveGrace) => {
      const t = setTimeout(() => resolveGrace({ kind: "grace" }), salvageMs);
      if (t.unref) t.unref();
    });
    const salvaged = await Promise.race<
      | { kind: "inner"; arr: ReadonlyArray<ToolExecutionResult> }
      | { kind: "grace" }
    >([
      innerPromise.then((arr) => ({ kind: "inner" as const, arr })),
      salvageGrace,
    ]);

    if (salvaged.kind === "inner") {
      // handler 在 salvage 窗口内收尾了 — 交出它已 flush 的结果,调用方按
      // tierAbort.aborted 归一 timeout 并注入 partial。
      return salvaged.arr[0] as ToolExecutionResult;
    }
  }

  // salvage 超时(或未开启 salvage):handler 拒绝收尾。不再等,返回裸 timeout。
  void innerPromise.catch(() => undefined); // 防 unhandled rejection
  return {
    kind: "execution_failed",
    toolUseId: call.id,
    message: "timeout",
  };
}

/** signal abort 时 resolve 的 promise(已 abort 立即 resolve)。 */
function abortPromise(signal: AbortSignal): Promise<{ kind: "timer" }> {
  return new Promise((resolveTimer) => {
    if (signal.aborted) {
      resolveTimer({ kind: "timer" });
      return;
    }
    signal.addEventListener("abort", () => resolveTimer({ kind: "timer" }), {
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
  partial: { stdout?: string; stderr?: string } | undefined
): ToolExecutionResult {
  if (partial === undefined) return base;
  return { ...base, partial };
}
