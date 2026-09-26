/**
 * stopReason display text — pure function layer, full value-domain mapping.
 * Only non-completed stop reasons have display text; completed and unknown
 * values return null (not shown). The param is widened to string: the wire
 * domain may drift as the backend evolves, so the display layer must
 * tolerate unknown values (fail quiet).
 */

/** Non-completed stop reason → display label (rendered in quiet mono / warn tone). */
export const STOP_REASON_LABELS: Record<string, string> = {
  maxTurns: "已达轮次上限，回答可能不完整",
  nonSuccessStop: "模型未正常完成回答",
  protocolError: "回答协议异常",
  emptyFinalResponse: "模型返回了空回答",
  cancelled: "请求已取消",
  timeout: "请求超时",
  fused: "工具环停滞，本轮已熔断",
};

/** completed / missing / unknown → null (caller renders nothing). */
export function stopReasonLabel(
  reason: string | null | undefined
): string | null {
  if (!reason) return null;
  return STOP_REASON_LABELS[reason] ?? null;
}

/**
 * The warn line under an answer: the hub's own output-limit notice when the
 * turn carries one, otherwise the stop-reason label.
 *
 * The notice string is rendered verbatim — the wire is its only source, so a
 * live turn and a reopened session show identical bytes and this layer never
 * re-composes the copy. The hub attaches the field only to a known outcome
 * whose supplier detail is `truncation`, so no other stop reason can pick it
 * up; an unknown outcome carries neither field and renders nothing (neither a
 * truncation notice nor a completed/incomplete label).
 */
export function stopNoticeLine(
  stopReason: string | null | undefined,
  outputLimitNotice?: string | null
): string | null {
  if (outputLimitNotice) return outputLimitNotice;
  return stopReasonLabel(stopReason);
}
