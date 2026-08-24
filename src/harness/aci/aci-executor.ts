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
import { VIOLATION_PREFIXES } from "../permission/prefixes.js";
import { createPermissionPolicy } from "./permission.js";
import { TIMEOUT_TIER_MS, type AciCatalog, type AciToolDef } from "./types.js";

// permission_denied message prefix(同 permission-executor 内契约一致)。
const PERMISSION_DENIED_PREFIX = VIOLATION_PREFIXES.permissionDenied;

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
      _timeoutMs?: number,
      conversationId?: string
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      // AC48 empty: 短路返回空数组,避免构造空 wave 触发 Promise.all([])。
      if (calls.length === 0) return [];

      // 1. 按输入顺序把 calls 分组成 wave:
      //    - safe(call.isConcurrencySafe === true 且预测非 deny) → 进入 currentWave;
      //    - unsafe(isConcurrencySafe === false 且非 deny, 含 catalog miss 保守默认)
      //      → flush currentWave,作为 singleton wave 单独执行;
      //    - denied(checkPermission 预测 outcome = "deny") → 与 safe 同 wave 处理,
      //      但「执行」路径是直接合成 execution_failed(不调 routeOneCall,
      //      也不进 inner executor,达成 spec P「deny 不进入并行集」——
      //      这里的并行集指的是「实际跑 routeOneCall 的 call」)。
      //      denied 是 0 时间成本的占位,与 safe 同 wave 不影响并发节奏。
      //    wave 维度:每个 wave 内的 call 在 executeAll 阶段并发启动;
      //    wave 之间严格串行 — 因此 unsafe call 必不与任何其它 call 重叠。
      type WaveItem = {
        readonly call: ToolCall;
        readonly def: AciToolDef | undefined;
        readonly tierTimeoutMs: number | undefined;
        readonly isConcurrencySafe: boolean;
        readonly isDenied: boolean;
        readonly denyReason: string | undefined;
      };
      const waves: WaveItem[][] = [];
      let currentWave: WaveItem[] = [];
      for (const call of calls) {
        const def = catalogForT5.get(call.name);
        const tierTimeoutMs =
          opts.timeoutMsOverride ??
          (def ? TIMEOUT_TIER_MS[def.aci.timeoutTier] : _timeoutMs);
        const isConcurrencySafe = def?.aci.isConcurrencySafe === true;
        // 预测 deny:仅当 def 存在且 checkPermission 确定性 deny 时纳入
        // "denied" 路径(catalog miss → 内层 middleware 决定;
        // ask 路径 → askUser 结果动态,此处不预测,以「safe」进入 wave —
        // 若 askUser 拒绝,permission-executor 内部仍产 execution_failed,
        // 不破坏整体「不抛裸 Error」契约)。
        let isDenied = false;
        let denyReason: string | undefined;
        if (def) {
          const predicted = checkPermission({
            def,
            input: call.input,
            sources: policy.sources,
            hardWalls: policy.hardWalls,
            defaultByCategory: policy.defaultByCategory,
          });
          if (predicted.decision === "deny") {
            isDenied = true;
            denyReason = predicted.reason;
          }
        }
        const item: WaveItem = {
          call,
          def,
          tierTimeoutMs,
          isConcurrencySafe,
          isDenied,
          denyReason,
        };
        // denied 进 currentWave 与 safe 同 wave(0 成本,不打断并行节奏);
        // unsafe(且非 deny)是 wave-breaker,单独 wave 串行。
        if (isConcurrencySafe || isDenied) {
          currentWave.push(item);
        } else {
          if (currentWave.length > 0) {
            waves.push(currentWave);
            currentWave = [];
          }
          waves.push([item]); // singleton wave — unsafe 单独处理
        }
      }
      if (currentWave.length > 0) {
        waves.push(currentWave);
      }

      // 2. 逐 wave 执行,装配结果(顺序 = 输入顺序)。
      //    onDecision 仍在每次 routeOneCall 之前触发:wave 内逐 call 顺序触发,
      //    顺序与原 for-of 一致;permission/pre/post 步骤在 routeOneCall
      //    → permission-executor 内逐 call 进行(per-call 语义不变)。
      const out: ToolExecutionResult[] = [];
      for (const wave of waves) {
        if (opts.onDecision) {
          for (const item of wave) {
            if (!item.def) {
              opts.onDecision(item.call, {
                decision: "allow",
                reason: "unknown tool — delegated to inner",
              });
            } else {
              // M2:checkPermission 静态导入;middleware 仍是决策权威,
              // onDecision 仅观测。outcome 与 permission-executor 内
              // checkPermission 走同一份解析路径,保持一致。
              const outcome = checkPermission({
                def: item.def,
                input: item.call.input,
                sources: policy.sources,
                hardWalls: policy.hardWalls,
                defaultByCategory: policy.defaultByCategory,
              });
              opts.onDecision(item.call, outcome);
            }
          }
        }
        if (wave.length === 1) {
          const item = wave[0]!;
          // 预测 deny 的 call 不进 routeOneCall(middleware 也会 deny,
          // 结果相同;此处直接合成 execution_failed 省一次中间件解析),
          // 保证 deny 不进入并行集(spec P:并行集 = 真正调 routeOneCall 的 call)。
          if (item.isDenied) {
            out.push({
              kind: "execution_failed",
              toolUseId: item.call.id,
              message:
                `${PERMISSION_DENIED_PREFIX} ${item.denyReason ?? ""}`.trimEnd(),
            });
            continue;
          }
          const result = await routeOneCall({
            executor,
            call: item.call,
            def: item.def,
            tierTimeoutMs: item.tierTimeoutMs,
            callerSignal: signal,
            conversationId,
          });
          out.push(result);
        } else {
          // size ≥ 2:Promise.all 启动同一 wave 内的「非 deny」call,
          // 装配结果(顺序 = 输入顺序)。denied item 在这里直接合成
          // execution_failed(0 时间成本,不打断并行节奏)— 同时满足
          // spec「deny 不进入并行集(指 routeOneCall 并行集)」的契约。
          // 每个非 deny routeOneCall 仍接收自身的 def / tierTimeoutMs /
          // callerSignal,signal 不共享 — wave 内 call 的 abort 由各自
          // tier / caller 独立处理。
          const results = await Promise.all(
            wave.map((item) =>
              item.isDenied
                ? Promise.resolve({
                    kind: "execution_failed" as const,
                    toolUseId: item.call.id,
                    message:
                      `${PERMISSION_DENIED_PREFIX} ${item.denyReason ?? ""}`.trimEnd(),
                  })
                : routeOneCall({
                    executor,
                    call: item.call,
                    def: item.def,
                    tierTimeoutMs: item.tierTimeoutMs,
                    callerSignal: signal,
                    conversationId,
                  })
            )
          );
          for (const r of results) out.push(r);
        }
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
  readonly conversationId?: string;
}): Promise<ToolExecutionResult> {
  const { executor, call, def, tierTimeoutMs, callerSignal, conversationId } =
    opts;
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

  const innerPromise = executor.executeAll(
    [call],
    effectiveSignal,
    undefined,
    conversationId
  );

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
