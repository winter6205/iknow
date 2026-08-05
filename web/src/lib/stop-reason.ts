/**
 * stopReason 显示文案（T6）— 纯函数层，全值域映射。
 * 仅非 completed 停止原因有展示文案；completed 与未知值一律返回 null（不显示）。
 * 参数放宽为 string：wire 值域可能随后端演进漂移，展示层须容忍未知值（fail quiet）。
 */

/** 非 completed 停止原因 → 中文提示文案（quiet mono / warn 色展示）。 */
export const STOP_REASON_LABELS: Record<string, string> = {
  maxTurns: "已达轮次上限，回答可能不完整",
  nonSuccessStop: "模型未正常完成回答",
  protocolError: "回答协议异常",
  emptyFinalResponse: "模型返回了空回答",
  cancelled: "请求已取消",
  timeout: "请求超时",
};

/** completed / 缺失 / 未知值 → null（调用方不渲染）。 */
export function stopReasonLabel(
  reason: string | null | undefined
): string | null {
  if (!reason) return null;
  return STOP_REASON_LABELS[reason] ?? null;
}
