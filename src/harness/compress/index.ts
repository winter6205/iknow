// Q3 决议:proactive trigger,reactive 不实现
import type { AnthropicNativeMessage } from "../model-adapter/types.js";
import { estimateMessagesTokens } from "./estimate.js";

/**
 * 判断 messages 当前累计 token 是否到达 proactive auto-compact 阈值。
 * 纯函数;reactive 触发留接口不实现(Q3 决议 B 折中)。
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
