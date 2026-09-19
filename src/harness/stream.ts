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
import type { AgentStatusSnapshot } from "./agent-status.js";
import type { EnvSnapshot } from "./env-snapshot.js";
import type { GraphProgressSnapshot } from "./graph/progress.js";

export type HarnessStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; name: string; id: string }
  | { type: "tool_input_delta"; id: string; partialJson: string }
  | { type: "stop_summary"; text: string }
  // #467:LLM 结构化摘要压缩(full-compact)生命周期事件。宿主层据此渲染
  // "Compacting…"指示 / 透出摘要 latency。compact 期间 turn 仍在继续(主 loop
  // 等摘要完成才进入下一 step),故宿主收到 compaction_started 时可显示进度
  // 指示器;收到 completed / failed / cancelled 中任一终态事件后清除指示器
  // (cancelled = wait 中用户取消,非错误,语义对齐 Claude Code:压缩中 Esc =
  // 会话原样 + 无失败呈现)。事件形状保持最小:仅携带宿主渲染 / 日志所需字段。
  | { type: "compaction_started"; droppedCount: number }
  | { type: "compaction_completed"; summaryLen: number; durationMs: number }
  | { type: "compaction_failed"; reason: string; durationMs: number }
  | { type: "compaction_cancelled" }
  // #550:压缩摘要的流式文本轨道。runFullCompact 不再把 adapter 的原始
  // text_delta 直透宿主,而是重映射为本事件——宿主若把它当 text_delta 追加进
  // 主回答草稿,摘要文本会污染 assistant 回复(渲染污染 latent bug)。宿主
  // 按 `type` 窄化路由到独立压缩草稿;thinking_delta 在压缩上下文内被
  // runFullCompact 吞咽(scratchpad,不暴露)。
  | { type: "compaction_text_delta"; text: string }
  // #647 T3 / ADR-0028 / CONTEXT「状态栏」:现势快照事件 —— TUI 只读最新现势
  // 的读口。loop-engine 在每次即将调用模型前、注入 `<agent_status>` 栏的同一
  // 计算点发出,字段与栏同源(AgentStatusSnapshot 的数据字段,见
  // agent-status.ts;不携带栏 text —— text 由同一快照派生,两处若可能分叉
  // 即设计缺陷)。deps.agentStatus 缺席(ask / worker 路径)→ 栏不注入,本
  // 事件也随之不发。事件只给宿主 UI,绝不进模型栏(in-flight 属
  // tool_call_start 等既有事件,与本事件分开)。字段形状经 Pick 直接取自
  // AgentStatusSnapshot(不内联重声明,单一真源;per-field 文档见
  // agent-status.ts,本处不重复)。spec agent-status-instruction-echo T3:
  // Pick 随快照加性扩 instruction / reconcile 两槽 —— 条件在场语义沿用快照
  // 字段本身(缺席 → key 不出现,F1 形态退回旧三件);reconcile 结算已经
  // loop-engine run 作用域装箱接线(子弹 4 完成):事件 reconcile 槽随结算
  // 条件在场(本栏已结算 → key 在场,含 false;无判定对象 → 槽缺席)。
  | ({
      type: "agent_status";
    } & Pick<
      AgentStatusSnapshot,
      "lastTool" | "openTodoLines" | "instruction" | "reconcile"
    >)
  // #653 G1 T5 / DESIGN-ENVIRONMENT-PRESENT:环境现势快照事件 —— 与
  // `agent_status` 平行的**独立**事件流(人读 chrome 的数据源,给 TUI
  // EnvironmentPane;给人不给模型)。loop-engine 在每次即将调用模型前、
  // `agent_status` 事件之后的同一回合边界计算点发出。**不**复用
  // agent_status 事件 / 快照结构(字段零重叠),**不**进 messages、
  // **不**进 verify 输入、**不**写 ADR-0028 状态栏。deps.envSnapshot 缺席
  // (ask / worker 路径)→ 本事件不发。snapshot 即 readEnvSnapshot 产物:
  // git 失败 → git 字段全 null + degradeReason 分型(degraded,cwd 保留),永不 throw。
  | { type: "env_snapshot"; snapshot: EnvSnapshot }
  // TUI run_graph 执行视图：scheduler onWave/onNode 累加快照。snapshot
  // null = 本次 run_graph 结束或取消，宿主应撤掉 graph chrome。
  | { type: "graph_progress"; snapshot: GraphProgressSnapshot | null }
  // ADR-0041 / plans/model-prefix-layering.md B3:graph 模式切换流事件
  // —— 仅当 loop-engine 在两次相邻 step 边界检测到 graphAssembly
  // 翻转(开→关 / 关→开)时发出,与消息尾部追加的 `<graph_mode>` 单行
  // 文本同源(SSOT 在 graph/notification.ts)。宿主层据此更新人读
  // chrome(标题栏 / status bar);模型面的切换提示只走 messages 尾部
  // 追加(appendGraphModeChange 走 appendMessage),不走 stream event。
  // 字段仅保留 `enabled` —— 翻转方向与文本方向 1:1 对应,文本本身由
  // messages 序列承载。
  | { type: "graph_mode_changed"; enabled: boolean }
  // Bug（2026-09-07）:传输重试进度 —— withTransportRetry 每次退避重试前
  // 发出,宿主渲染「连接重试 attempt/max」类指示。此前重试完全静默,429/
  // 网络故障期间用户看不到任何活动。`detail` 为 fault 的短描述(状态码/
  // 错误类),仅给人看,不进模型面。
  | {
      type: "transport_retry";
      attempt: number;
      maxAttempts: number;
      detail: string;
    };

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
