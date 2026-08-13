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
  | { type: "stop_summary"; text: string };
