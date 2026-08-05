/**
 * T2 (#175): Harness 流式事件契约 SSOT (D1 最小集)。
 *
 * 为什么只发 `text_delta` + `tool_call_start`:
 *   - 原生 SSE 事件 (SDK 0.115 message_stream) 不出 adapter 边界
 *     (#147 D1 裁决);
 *   - thinking_delta / input_json_delta 留位不发:thinking 流式下发需要
 *     单独的承载设计 (留 v1+ 扩展位),input_json_delta 关联 tool_call
 *     的 input 流——T3 末态以 `finalMessage()` 的 `interpretMessage`
 *     现有 SSOT 零改动路径交付,D8 整回合不提交要求下,不增量逐步交付
 *     tool input 字节。
 *   - SDK 0.115 无 wire 级 ping/error 事件,契约不承诺。
 *
 * 扩展点:加新成员只需扩本联合 (消费者按 `type` 窄化),无需改 emit / 消费点。
 */

export type HarnessStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; name: string };
