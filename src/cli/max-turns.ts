/**
 * plan T6 / ADR-0011: maxTurns 超限的 surface 呈现函数。
 *
 * 纯函数,可被 chat / ask 直接 import 复用。cli.ts 自身有 main() side-effect
 * 不可 import,故纯呈现层下沉到本模块。测试从 src/ 路径导入,不受 side-effect
 * 影响。
 *
 * 入口契约:
 *   - chat REPL 用 maxTurnsNotice 拿 stderr + output 两段文;
 *   - ask oneshot 用 maxTurnsEnvelope 拿 JSON 字符串写到 stderr + exitCode=1。
 */
import { MaxTurnsExceeded } from "../harness/errors.js";

/**
 * chat REPL 的 maxTurns 呈现:stderr 通知行 + output 摘要文本。
 *
 * 摘要缺失(摘要 epilogue 失败/超时/skip)→ output 为空串(避免显示"收尾
 * 摘要:"空头)。stopSummary 长度 > 0 才视为有摘要。
 */
export function maxTurnsNotice(
  err: MaxTurnsExceeded,
  stopSummary?: string
): { readonly stderr: string; readonly output: string } {
  const stderr = `已达 maxTurns=${err.turnsRan} 轮上限（${err.reason}），终止`;
  const output =
    stopSummary !== undefined && stopSummary.length > 0
      ? `收尾摘要：\n${stopSummary}`
      : "";
  return { stderr, output };
}

/**
 * ask oneshot 的 maxTurns JSON envelope(stderr + exitCode=1)。
 *
 * stopSummary 缺席时整字段缺席(byte-stable,与 thinking/toolCalls/lastUsage
 * 同模式)。message 字段携带人类可读通知行(对齐 chat 面的 stderr 文本)。
 */
export function maxTurnsEnvelope(
  err: MaxTurnsExceeded,
  stopSummary?: string
): string {
  const payload: {
    error: "max_turns_exceeded";
    turnsRan: number;
    reason: string;
    message: string;
    stopSummary?: string;
  } = {
    error: "max_turns_exceeded",
    turnsRan: err.turnsRan,
    reason: err.reason,
    message: `已达 maxTurns=${err.turnsRan} 轮上限（${err.reason}），终止`,
  };
  if (stopSummary !== undefined && stopSummary.length > 0) {
    payload.stopSummary = stopSummary;
  }
  return JSON.stringify(payload);
}
