// Q3 决议(proactive 估算触发)+ ADR-0013(reactive PromptTooLongError 触发,
// plan T3):proactive(shouldAutoCompact)+ reactive(loop-engine 兜底,
// 每 run 限 1 次)双保险共存,共用 `compactMessages`,无阈值/优先级冲突。
//
// plan compress-trigger-gate T1:新增 `evaluateCompactTrigger` 统一触发判据,
// 手动 /compact + loop-engine proactive 共用同一函数,token 阈值 + 窗口守门
// + full summary 降级三段分类返回;`shouldAutoCompact` 保留为兼容 wrapper
// (外部调用方未迁移前不破)。
import type { AnthropicNativeMessage } from "../model-adapter/types.js";
import { DEFAULT_KEEP_RECENT } from "./constant.js";
import { estimateMessagesTokens } from "./estimate.js";
import { preserveToolPairs } from "./window.js";

/** CompactReason — 触发判据分类标识,SSOT 见 plans/compress-trigger-gate.md */
type CompactReason =
  | "below_token_threshold" // token 未达阈值,不压缩
  | "messages_too_few" // token 已超但 splitForCompaction 无窗口
  | "windowed" // token 已超 + 有可丢前缀,走窗口压缩
  | "full_summary"; // token 已超 + 无窗口,走 full summary 路径

/** CompactTriggerDecision — 判据返回 discriminated union */
type CompactTriggerDecision =
  | { action: "noop"; reason: "below_token_threshold" }
  | { action: "compact_via_full_summary"; reason: "messages_too_few" }
  | { action: "compact_via_window"; reason: "windowed" };

/**
 * 统一触发判据。手动 /compact + loop-engine proactive 共用本函数。
 *
 * ADR-0013 D3:proactive/reactive 共用 compactMessages,本函数只决定"走哪条
 * 压缩路径",不引入新压缩实现。token 估算仅供判据决策(ADR-0008 D6)。
 */
export function evaluateCompactTrigger(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  ctx: {
    contextWindow: number;
    threshold: number;
    keepRecent?: number; // 默认 DEFAULT_KEEP_RECENT
  }
): CompactTriggerDecision {
  const estimated = estimateMessagesTokens(messages);
  if (estimated < ctx.threshold) {
    return { action: "noop", reason: "below_token_threshold" };
  }
  // token 已超阈值 — 看窗口是否可丢
  const { slicedFrom } = preserveToolPairs(
    messages,
    ctx.keepRecent ?? DEFAULT_KEEP_RECENT
  );
  if (slicedFrom === 0) {
    return { action: "compact_via_full_summary", reason: "messages_too_few" };
  }
  return { action: "compact_via_window", reason: "windowed" };
}

/**
 * 判断 messages 当前累计 token 是否到达 proactive auto-compact 阈值。
 * 纯函数。reactive 触发由 loop-engine 的 `PromptTooLongError` 分支持有
 * (ADR-0013,plan T3),同一模块的 `compactMessages` 是双保险共用的压缩函数
 * —— proactive 与 reactive 不分叉阈值与压缩逻辑,各自独立触发,共用输出。
 * 共存语义断言见 `tests/harness/compress/dual-insurance.test.ts`。
 *
 * @deprecated — 新 caller 请使用 `evaluateCompactTrigger`(plan
 * compress-trigger-gate T1)。本函数保留为兼容 wrapper,函数体不变以免破坏
 * 既有外部调用方;委托关系 = 仅 token 阈值判据,不含窗口守门 / full summary
 * 降级语义。
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
//
// #467 step 2:full-compact 五个函数(LLM 结构化摘要压缩)与旧纯截断路径
// `compactMessages` 并列暴露 —— loop-engine 与 hub 可自由选择摘要成功路径或
// placeholder 回退路径。注:不再导出 `COMPACT_TIMEOUT_SECONDS`(2026-08-19,
// 实测 27KB dropped ~17s + Claude Code 无 client-side 超时语义对齐)——
// runFullCompact 不设默认 client-side 超时,上限 = SDK 默认 HTTP timeout
// + 用户 signal 取消;`timeoutMs` 保留为注入缝供测试 / 显式 caller 使用。
export {
  COMPACTION_BOUNDARY_PLACEHOLDER,
  DEFAULT_KEEP_RECENT,
} from "./constant.js";
export { compactMessages } from "./window.js";
export { estimateMessagesTokens, estimateTokens } from "./estimate.js";
export { getAutoCompactThreshold, validateThreshold } from "./threshold.js";
export {
  buildCompactPrompt,
  extractCompactSummary,
  splitForCompaction,
  buildCompactedMessages,
  runFullCompact,
} from "./full-compact.js";
export type { FullCompactOutcome, CompactAdapter } from "./full-compact.js";
export type { CompactReason, CompactTriggerDecision };
