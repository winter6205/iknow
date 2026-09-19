/**
 * #672 T1: FaultClass 策略表。
 *
 * 闭集 `retry` | `fuse` | `none`，轴 API / 工具 / 上下文 / 控制流（G2）。
 * 只回答传输是否可重试、同参失败是否计入熔断策略；不写入 StopReason。
 * T1 不接 ModelAdapter 重试循环、不接工具环检测。
 */

export type FaultClass = "retry" | "fuse" | "none";

/** 到点的是哪根钟（与 race-timers 的 `RaceExpirySource` 同值域）。 */
export type ClockAbortSource = "idle" | "hardCap";

/**
 * transport-continue-persist T1 / spec inv 2:时钟 abort 的 typed 标记。
 *
 * 两根钟与宿主 Ctrl+C 走同一条 `AbortSignal` 通道,而 SDK 的
 * `APIUserAbortError` **不携带** `signal.reason`（fetch 不转发）—— 单看
 * thrown error 分不出「钟到点」与「人按了 Ctrl+C」。因此来源必须刻在
 * `signal.reason` 上,翻译层（`translateAnthropicTransportFault`）先认
 * 这个标记再归类,时钟 abort 才不会误标成 `user_cancel`。
 *
 * `visible` = 到点前本次 attempt 是否已有模型输出增量（race-timers 的
 * `hadVisibleDelta`）:不可见才允许整回合重试（spec inv 1）。
 */
export interface ClockAbortReason {
  readonly kind: "clock_abort";
  readonly source: ClockAbortSource;
  readonly visible: boolean;
}

const CLOCK_ABORT_KIND = "clock_abort";

export function clockAbortReasonOf(
  source: ClockAbortSource,
  visible: boolean
): ClockAbortReason {
  return Object.freeze({
    kind: CLOCK_ABORT_KIND,
    source,
    visible,
  }) satisfies ClockAbortReason;
}

/**
 * `signal.reason` → ClockAbortReason;非钟 abort（无 reason / 宿主 reason）
 * → undefined。结构判别而非 `instanceof`:reason 是跨 `AbortSignal.any`
 * 传递的普通值,不走错误类层级。
 */
export function clockAbortOf(
  signal: AbortSignal | undefined
): ClockAbortReason | undefined {
  if (signal?.aborted !== true) return undefined;
  const reason: unknown = signal.reason;
  if (typeof reason !== "object" || reason === null) return undefined;
  const candidate = reason as {
    readonly kind?: unknown;
    readonly source?: unknown;
    readonly visible?: unknown;
  };
  if (candidate.kind !== CLOCK_ABORT_KIND) return undefined;
  const source = candidate.source;
  if (source !== "idle" && source !== "hardCap") return undefined;
  return {
    kind: CLOCK_ABORT_KIND,
    source,
    visible: candidate.visible === true,
  };
}

export type FaultEvent =
  | {
      readonly kind: "llm_http";
      readonly status: number;
      readonly retryAfterMs?: number;
    }
  /**
   * 时钟到点（idle / 硬顶）。可见 = 已出字,不得自动重试;不可见 = 本次
   * attempt 无任何模型输出,属可重试的传输失败（spec inv 1–2）。
   */
  | {
      readonly kind: "clock_timeout";
      readonly source: ClockAbortSource;
      readonly visible: boolean;
    }
  /**
   * ADR-0111 不变式 (a)：上游流结束但未产出完整 assistant Message（空流 /
   * 断流，`ModelStreamIncompleteError` 的 fault 格）。`visible` 判据同
   * `clock_timeout`：不可见 = 本次 attempt 无任何模型输出增量，整 step 重试
   * 安全；已出字 = 不自动重试，落 typed 失败。
   */
  | { readonly kind: "stream_incomplete"; readonly visible: boolean }
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

/**
 * `retry-after` 头 → 毫秒（spec inv 4 的 "honor retry-after"）。只认两种形态：
 *   - delta-seconds（`"3"`、`"3.5"`，RFC 9110 允许小数）；
 *   - HTTP-date（`"Wed, 21 Oct 2015 07:28:00 GMT"`）→ 与 `nowMs` 之差。
 * 其余（空串 / 非数 / 已过去的日期 / 负数）→ undefined = 视作缺席，回落本地
 * 退避表：宁可自己说了算，也不因为一个畸形 header 当场重发。
 *
 * 放在本模块（而非重试装饰器）是因为它只决定 FaultEvent 的**形状**，与
 * 「退避多久」的策略无关；translator（anthropic-adapter）与重试循环各自
 * 只依赖本模块。
 */
export function parseRetryAfterMs(
  rawValue: string | null | undefined,
  nowMs: number = Date.now()
): number | undefined {
  if (rawValue === null || rawValue === undefined) return undefined;
  const raw = rawValue.trim();
  if (raw === "") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1_000 : undefined;
  }
  const epoch = Date.parse(raw);
  if (!Number.isFinite(epoch)) return undefined;
  const deltaMs = epoch - nowMs;
  return deltaMs >= 0 ? deltaMs : undefined;
}

const HTTP_RETRY_MIN = 500;
const HTTP_RETRY_MAX = 599;
const FUSE_MIN_OCCURRENCES = 2;

function isTransientHttpStatus(status: number): boolean {
  if (status === 429) return true;
  return status >= HTTP_RETRY_MIN && status <= HTTP_RETRY_MAX;
}

/**
 * G2 策略：429/5xx/网络 → retry；反复同参 execution_failed → fuse；其余 none。
 *
 * transport-continue-persist T1:时钟到点**不可见**（本次 attempt 无任何模型
 * 输出增量）→ retry —— 卡死的连接不是「回合已失败」,重发整次调用是安全的
 * （spec inv 1）;已出字则不得自动重试,落 none 由 loop-engine 走既有 timeout
 * 收场。可见与否是 race-timers 从流事件推出的 `hadVisibleDelta`,不在本层判断。
 *
 * ADR-0111 不变式 (a):上游流未完成（`stream_incomplete`）与 `clock_timeout`
 * 同判据 —— 不可见 → retry（整 step 重试安全,由 withTransportRetry 既有预算
 * 承载）;已出字 → none（不自动重试,typed 错误直抛落 loop 收口）。
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
    // visible 纪律单实现（两格同判据，出处见上方 doc：clock_timeout =
    // transport-continue-persist inv 1；stream_incomplete = ADR-0111 不变式 a）。
    case "clock_timeout":
    case "stream_incomplete":
      return event.visible ? "none" : "retry";
    case "execution_failed":
      return event.occurrenceCount >= FUSE_MIN_OCCURRENCES ? "fuse" : "none";
    default:
      return "none";
  }
}
