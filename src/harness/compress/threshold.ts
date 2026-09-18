// Q6b-D1/D2 决议:env 可配,硬校验 threshold < window
// ADR-0100:缺省闸改为 **策略预算窗口** 的比例（95%）。旧的
// `window - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS`（≈ window−33k）
// 只在分母≈供应商真上限时才是合理余量；`contextWindow` 现在是操作员的策略预算
// （缺省 256000），沿用它会让压缩在预算的 87% 就开火，故退出这条公式。
// 两个常量本身仍留在 constant.ts（Q6b-D4 的常量照搬集，由 constant.test.ts 钉值），
// 只是不再参与缺省闸推导。

/** auto-compact 缺省闸占策略预算窗口的比例（ADR-0100）。 */
export const AUTO_COMPACT_STRATEGY_RATIO = 0.95;

/**
 * 推导 auto-compact 阈值。
 * 显式 threshold > 0 → 校验必须 < contextWindow,否则 throw;
 * 未设 / 0 / 负数 → 缺省推导 `floor(AUTO_COMPACT_STRATEGY_RATIO × contextWindow)`。
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
  // 向下取整:阈值是整数 token 数,不产分数。
  return Math.floor(contextWindow * AUTO_COMPACT_STRATEGY_RATIO);
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
