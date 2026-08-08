/**
 * T2 (#175): Harness 流式事件契约 SSOT (D1 最小集, 阶段二扩展)。
 *
 * 事件集:
 *   - text_delta / thinking_delta:增量文本 (answer / thinking);
 *   - tool_call_start:工具调用开始, 携带 `id` (tool_use block id, 供
 *     host 与 postToolUse 完成事件配对, T4 实时状态依赖);
 *   - stop_summary:终态事件 (plan T4 / ADR-0011) — 异常停后 best-effort
 *     模型收尾摘要的纯文本载荷, 由 loop-engine run() 在返回前 emit;
 *     不携带结构 / 元数据 (摘要文本即载荷)。
 *
 * 为什么用这三件(+ 终态):
 *   - 原生 SSE 事件 (SDK 0.115 message_stream) 不出 adapter 边界
 *     (#147 D1 裁决), 经 wireStreamEvents 翻译;
 *   - input_json_delta 留位不发:关联 tool_call 的 input 流——T3 末态以
 *     `finalMessage()` 的 `interpretMessage` 现有 SSOT 零改动路径交付,
 *     D8 整回合不提交要求下, 不增量逐步交付 tool input 字节 (v1+ 项)。
 *   - SDK 0.115 无 wire 级 ping/error 事件, 契约不承诺。
 *
 * 扩展点: 加新成员只需扩本联合 (消费者按 `type` 窄化), 无需改 emit / 消费点。
 */

export type HarnessStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; name: string; id: string }
  | { type: "stop_summary"; text: string };
