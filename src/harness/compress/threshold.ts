// Configurable via env, with hard validation threshold < window.
// The default gate is now a ratio (95%) of the **policy budget window**
// (ADR-0100). The old formula `window - MAX_OUTPUT_TOKENS_FOR_SUMMARY -
// AUTOCOMPACT_BUFFER_TOKENS` (≈ window−33k) was only a sensible margin when
// the denominator ≈ the provider's true cap; `contextWindow` is now the
// operator's policy budget (default 256000), and reusing the old formula
// would fire compaction at 87% of budget, so it was retired. The two
// constants themselves remain in constant.ts (pinned by constant.test.ts)
// but no longer participate in default-gate derivation.

/** Default auto-compact gate as a fraction of the policy budget window
 *  (ADR-0100). */
export const AUTO_COMPACT_STRATEGY_RATIO = 0.95;

/**
 * Derive the auto-compact threshold.
 * Explicit threshold > 0 -> validated to be < contextWindow, else throw;
 * unset / 0 / negative -> default `floor(AUTO_COMPACT_STRATEGY_RATIO × contextWindow)`.
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
  // Floor: the threshold is a whole token count, never fractional.
  return Math.floor(contextWindow * AUTO_COMPACT_STRATEGY_RATIO);
}

/** validateThreshold — pure check: returns true when valid, throws when invalid. */
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
