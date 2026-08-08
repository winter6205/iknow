// Q3 决议(proactive 估算触发)+ ADR-0013(reactive PromptTooLongError 触发,
// plan T3):proactive(shouldAutoCompact)+ reactive(loop-engine 兜底,
// 每 run 限 1 次)双保险共存,共用 `compactMessages`,无阈值/优先级冲突。
import type { AnthropicNativeMessage } from "../model-adapter/types.js";
import { estimateMessagesTokens } from "./estimate.js";

/**
 * 判断 messages 当前累计 token 是否到达 proactive auto-compact 阈值。
 * 纯函数。reactive 触发由 loop-engine 的 `PromptTooLongError` 分支持有
 * (ADR-0013,plan T3),同一模块的 `compactMessages` 是双保险共用的压缩函数
 * —— proactive 与 reactive 不分叉阈值与压缩逻辑,各自独立触发,共用输出。
 * 共存语义断言见 `tests/harness/compress/dual-insurance.test.ts`。
 */
export function shouldAutoCompact(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  ctx: { contextWindow: number; threshold: number }
): boolean {
  return estimateMessagesTokens(messages) >= ctx.threshold;
}

// Re-export 公共 API:让 `import { ... } from "src/harness/compress/"` 一站式可用
// 注:strict noUnusedLocals 下,仅 re-export 的符号不能先 import 再 re-export,
// 直接 `export ... from` 保持单一 write(T6 deviation)。
export {
  COMPACTION_BOUNDARY_PLACEHOLDER,
  DEFAULT_KEEP_RECENT,
} from "./constant.js";
export { compactMessages } from "./window.js";
export { estimateMessagesTokens, estimateTokens } from "./estimate.js";
export { getAutoCompactThreshold, validateThreshold } from "./threshold.js";
