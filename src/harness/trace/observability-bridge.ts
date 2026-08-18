import type {
  LlmCallRecord,
  ToolCallRecord,
  TurnRecord,
  SubagentSpawnRecord,
  SubagentStopRecord,
  SubagentStateChangeRecord,
} from "./types.js";

/**
 * Observability backend 翻译器 (B-scope deferred, GH #64 ADR Decision 3 + spec 判据 16)。
 *
 * A-scope 仅留位: 函数体 throw 占位 stub,禁止实现。
 * 真值映射表 (gen_ai.* 属性、命名策略等) 是 B-scope 工作,在后续 ADR
 * 与 spec 阶段定义。A-scope 期间调用方应用 safeTrace 包裹,保证不破坏 harness。
 *
 * 入参是 trace record 联合 —— 接收任何已收集的领域记录,集中翻译逻辑,
 * 保持调用方只看见 domain 类型,不看见 observability SDK 类型。
 */
export function translateToObservability(
  // 下划线前缀满足 noUnusedParameters (B-scope 不消费 record,只占位)。
  // 调用方按 record 类型传参,类型检查即承担 "是否穷举" 的作用。
  _record:
    | LlmCallRecord
    | ToolCallRecord
    | TurnRecord
    | SubagentSpawnRecord
    | SubagentStopRecord
    | SubagentStateChangeRecord
): never {
  throw new Error("B-scenario not implemented");
}
