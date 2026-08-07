// Q6b-D1/D2 决议:env 可配,硬校验 threshold < window
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
} from "./constant.js";

/**
 * 推导 auto-compact 阈值。
 * 显式 threshold > 0 → 校验必须 < contextWindow,否则 throw;
 * 未设 / 0 / 负数 → 缺省推导 window - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS。
 */
export function getAutoCompactThreshold(
  contextWindow: number,
  explicitThreshold: number | undefined
): number {
  if (explicitThreshold !== undefined && explicitThreshold > 0) {
    if (explicitThreshold >= contextWindow) {
      throw new Error(
        `autoCompactThreshold (${explicitThreshold}) must be < contextWindow (${contextWindow})`
      );
    }
    return explicitThreshold;
  }
  const effective =
    contextWindow - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS;
  return effective;
}

/** validateThreshold — 纯校验:合法返回 true,非法 throw。 */
export function validateThreshold(
  contextWindow: number,
  threshold: number
): boolean {
  if (threshold >= contextWindow) {
    throw new Error(
      `autoCompactThreshold (${threshold}) must be < contextWindow (${contextWindow})`
    );
  }
  return true;
}
