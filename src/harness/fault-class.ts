/**
 * #672 T1: FaultClass 策略表。
 *
 * 闭集 `retry` | `fuse` | `none`，轴 API / 工具 / 上下文 / 控制流（G2）。
 * 只回答传输是否可重试、同参失败是否计入熔断策略；不写入 StopReason。
 * T1 不接 ModelAdapter 重试循环、不接工具环检测。
 */

export type FaultClass = "retry" | "fuse" | "none";

export type FaultEvent =
  | { readonly kind: "llm_http"; readonly status: number }
  | { readonly kind: "llm_network" }
  | { readonly kind: "prompt_too_long" }
  | { readonly kind: "permission_deny" }
  | { readonly kind: "verify_fail" }
  | { readonly kind: "user_cancel" }
  | { readonly kind: "timeout" }
  | {
      readonly kind: "execution_failed";
      /** 同一 tool+参数已出现的 execution_failed 次数（含本次）。 */
      readonly occurrenceCount: number;
    }
  | { readonly kind: "compact_failed" }
  | { readonly kind: "protocol_error" }
  | { readonly kind: "empty_final_response" };

const HTTP_RETRY_MIN = 500;
const HTTP_RETRY_MAX = 599;
const FUSE_MIN_OCCURRENCES = 2;

function isTransientHttpStatus(status: number): boolean {
  if (status === 429) return true;
  return status >= HTTP_RETRY_MIN && status <= HTTP_RETRY_MAX;
}

/**
 * G2 策略：429/5xx/网络 → retry；反复同参 execution_failed → fuse；其余 none。
 */
export function classifyFault(
  event: FaultEvent | null | undefined
): FaultClass {
  if (event == null) return "none";
  switch (event.kind) {
    case "llm_http":
      return isTransientHttpStatus(event.status) ? "retry" : "none";
    case "llm_network":
      return "retry";
    case "execution_failed":
      return event.occurrenceCount >= FUSE_MIN_OCCURRENCES ? "fuse" : "none";
    default:
      return "none";
  }
}
