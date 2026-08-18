/**
 * T2 (#175): Harness 流式事件契约 SSOT (D1 最小集, 阶段二扩展)。
 *
 * 事件集:
 *   - text_delta / thinking_delta:增量文本 (answer / thinking);
 *   - tool_call_start:工具调用开始, 携带 `id` (tool_use block id, 供
 *     host 与 postToolUse 完成事件配对, T4 实时状态依赖);
 *   - tool_input_delta:工具调用 input 增量 (partial_json 逐段), 携带
 *     `id` (tool_use block id, 与 tool_call_start 同一来源) — 增量只服务
 *     展示层 (T1 tui-render-optimization), 权威 input 仍由
 *     `finalMessage()` 一次性交付;
 *   - stop_summary:终态事件 (plan T4 / ADR-0011) — 异常停后 best-effort
 *     模型收尾摘要的纯文本载荷, 由 loop-engine run() 在返回前 emit;
 *     不携带结构 / 元数据 (摘要文本即载荷)。
 *
 * 为什么用这些事件:
 *   - 原生 SSE 事件 (SDK 0.115 message_stream) 不出 adapter 边界
 *     (#147 D1 裁决), 经 wireStreamEvents 翻译;
 *   - v1+ 已实现:tool input 增量流通过 `tool_input_delta` 事件逐段 emit
 *     (增量只服务展示层, 权威 input 仍由 `finalMessage()` 一次性交付 —
 *     T3 末态经 `interpretMessage` 现有 SSOT 零改动路径, D8 整回合不提交
 *     不受影响)。
 *   - SDK 0.115 无 wire 级 ping/error 事件, 契约不承诺。
 *
 * 扩展点: 加新成员只需扩本联合 (消费者按 `type` 窄化), 无需改 emit / 消费点。
 */

export type HarnessStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; name: string; id: string }
  | { type: "tool_input_delta"; id: string; partialJson: string }
  | { type: "stop_summary"; text: string }
  // #467:LLM 结构化摘要压缩(full-compact)生命周期事件。宿主层据此渲染
  // "Compacting…"指示 / 透出摘要 latency(text_delta 经 adapter request.onStream
  // 直透)。compact 期间 turn 仍在继续(主 loop 等摘要完成才进入下一 step),
  // 故宿主收到 compaction_started 时可显示进度指示器;收到 completed / failed /
  // cancelled 中任一终态事件后清除指示器(cancelled = wait 中用户取消,非错误,
  // 语义对齐 Claude Code:压缩中 Esc = 会话原样 + 无失败呈现)。事件形状保持
  // 最小:仅携带宿主渲染 / 日志所需字段。
  | { type: "compaction_started"; droppedCount: number }
  | { type: "compaction_completed"; summaryLen: number; durationMs: number }
  | { type: "compaction_failed"; reason: string; durationMs: number }
  | { type: "compaction_cancelled" };

/**
 * 观察者错误不得反流回 emit 路径(对齐 ADR-0003 `safeTrace` MUST NOT throw
 * 与 wireStreamEvents D3 先例)。统一封装:anthropic-adapter stream 翻译 + full
 * compact 压缩生命周期事件均消费此函数,避免各处 try/catch 复制粘贴。
 */
export function safeEmitStream(
  onStream: ((event: HarnessStreamEvent) => void) | undefined,
  event: HarnessStreamEvent
): void {
  if (onStream === undefined) return;
  try {
    onStream(event);
  } catch {
    // D3:swallow observer exceptions,host faults must not back-flow into
    // the stream arm (aligned with ADR-0003 `safeTrace` MUST NOT throw).
  }
}
