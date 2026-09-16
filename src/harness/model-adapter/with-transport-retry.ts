/**
 * #672 T2: 有界传输重试，装饰 ModelAdapter.step。
 *
 * 不进 loop 状态机、不绑 SDK maxRetries。供应商 adapter 只负责把 thrown
 * 译成 FaultEvent；本模块只根据 classifyFault === "retry" 退避。
 *
 * transport-continue-persist T1 / spec inv 4:退避从毫秒级抬到**秒级指数**
 * (1s / 2s / 4s / 8s,上限 16s),尝试次数 3 → 5(settings 无该旋钮,取
 * spec 允许的 5–10 下沿);`retry-after` 在场时不得早于服务器给的时刻重发。
 * 时钟到点(不可见 idle/硬顶)的重试不在这里 —— 它由 loop-engine 重新发起
 * 整次 race(见 runModelPhase),本模块只暴露同一份退避表供其复用。
 */

import { classifyFault, type FaultEvent } from "../fault-class.js";
import { TransportRetryExhaustedError } from "../errors.js";
import type { ModelAdapter } from "./types.js";
import { safeEmitStream } from "../stream.js";

export { TransportRetryExhaustedError };

/**
 * spec inv 4 的有界尝试预算。settings 今日没有该旋钮（不新开），取 spec
 * 许可区间 5–10 的下沿：至少能扛过「一次部署抖动 + 一条慢链路」，又不至于
 * 把一次坏回合拖到分钟级。
 */
export const TRANSPORT_MAX_ATTEMPTS = 5;

/** 秒级指数退避表（第 n 次失败后等 `TRANSPORT_BACKOFF_MS[n-1]`）。 */
export const TRANSPORT_BACKOFF_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000,
];

/** 单次退避上限；`retry-after` 更长时也压到这里（不无限等）。 */
export const TRANSPORT_BACKOFF_CAP_MS = 16_000;

/**
 * 第 `attempt` 次失败后的退避时长:表值逐次翻倍、封顶 `CAP`。
 *
 * `retryAfterMs`(adapter 从 `retry-after` 头翻出的毫秒)在场时取两者较大值,
 * 再封顶 —— 早于服务器给的时刻重发等于白烧一次 attempt;但仍受 `CAP` 约束,
 * 避免一个畸大的 header 把回合挂死。非有限 / 负数视为缺席。
 */
export function backoffDelayMs(
  attempt: number,
  retryAfterMs?: number,
  backoffMs: readonly number[] = TRANSPORT_BACKOFF_MS
): number {
  const tableMs =
    backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0;
  const floor =
    retryAfterMs !== undefined &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
      ? retryAfterMs
      : 0;
  return Math.min(Math.max(tableMs, floor), TRANSPORT_BACKOFF_CAP_MS);
}

export type TransportRetryOptions = {
  /** `signal` = 本次 attempt 的 signal(时钟 abort 的来源标记在其 reason 上)。 */
  readonly translate: (err: unknown, signal?: AbortSignal) => FaultEvent;
  readonly maxAttempts?: number;
  readonly backoffMs?: readonly number[];
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const DEFAULT_MAX_ATTEMPTS = TRANSPORT_MAX_ATTEMPTS;
const DEFAULT_BACKOFF_MS: readonly number[] = TRANSPORT_BACKOFF_MS;

function abortError(): DOMException {
  return new DOMException("This operation was aborted", "AbortError");
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "AbortError";
  }
  return err instanceof Error && err.name === "AbortError";
}

export async function sleepWithAbort(
  ms: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 人读 fault 短码（`llm_http: 429` / `llm_network`）——仅 transport_retry 事件文案用。 */
function statusOf(fault: FaultEvent): string {
  return fault.kind === "llm_http" ? `llm_http: ${fault.status}` : fault.kind;
}

/** 本次失败后的退避:秒级指数表,`retry-after` 在场则取较大值(仍封顶)。 */
function delayFor(
  fault: FaultEvent,
  attempt: number,
  backoffMs: readonly number[]
): number {
  const retryAfterMs =
    fault.kind === "llm_http" ? fault.retryAfterMs : undefined;
  return backoffDelayMs(attempt, retryAfterMs, backoffMs);
}

export function withTransportRetry<T extends Pick<ModelAdapter, "step">>(
  adapter: T,
  options: TransportRetryOptions
): T {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = options.sleep ?? sleepWithAbort;
  const { translate } = options;

  const step: T["step"] = async (state, request, signal) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) throw abortError();
      try {
        return await adapter.step(state, request, signal);
      } catch (err) {
        lastErr = err;
        if (isAbort(err, signal)) throw err;
        const rawFault = translate(err, signal);
        const fault = classifyFault(rawFault);
        const canRetry = fault === "retry" && attempt < maxAttempts;
        if (!canRetry) {
          if (fault === "retry") {
            throw new TransportRetryExhaustedError(attempt, err);
          }
          throw err;
        }
        // Bug（2026-09-07）:重试进度不再静默 —— 退避前向宿主流事件通道发
        // transport_retry（detail 供「连接重试」类指示文案）。观察者错误被
        // safeEmitStream 吞掉,绝不反流回重试路径。
        safeEmitStream(request.onStream, {
          type: "transport_retry",
          attempt,
          maxAttempts,
          detail: statusOf(rawFault),
        });
        await sleep(delayFor(rawFault, attempt, backoffMs), signal);
      }
    }
    throw new TransportRetryExhaustedError(maxAttempts, lastErr);
  };

  return { ...adapter, step };
}
