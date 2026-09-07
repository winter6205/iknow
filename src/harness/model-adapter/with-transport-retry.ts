/**
 * #672 T2: 有界传输重试，装饰 ModelAdapter.step。
 *
 * 不进 loop 状态机、不绑 SDK maxRetries。供应商 adapter 只负责把 thrown
 * 译成 FaultEvent；本模块只根据 classifyFault === "retry" 退避。
 */

import { classifyFault, type FaultEvent } from "../fault-class.js";
import { TransportRetryExhaustedError } from "../errors.js";
import type { ModelAdapter } from "./types.js";
import { safeEmitStream } from "../stream.js";

export { TransportRetryExhaustedError };

export type TransportRetryOptions = {
  readonly translate: (err: unknown) => FaultEvent;
  readonly maxAttempts?: number;
  readonly backoffMs?: readonly number[];
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS: readonly number[] = [200, 400];

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
        const rawFault = translate(err);
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
        const delay =
          backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0;
        await sleep(delay, signal);
      }
    }
    throw new TransportRetryExhaustedError(maxAttempts, lastErr);
  };

  return { ...adapter, step };
}
