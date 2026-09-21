// usage→context-occupancy pure derivation (ADR-0118).
// pre_call shape (both cache fields null/absent): the countTokens total is
// already `inputTokens`, so adding cache fields there would double-count.
// post_call shape (>=1 cache field non-null): Anthropic splits the input into
// three disjoint categories, so occupancy sums all three (null counts as 0).
// outputTokens never participates — occupancy measures the input side only.
import type { TokenUsage } from "../model-adapter/types.js";

export function occupancyFromUsage(usage: TokenUsage): number {
  const cacheRead = usage.cacheReadInputTokens;
  const cacheCreation = usage.cacheCreationInputTokens;
  if (cacheRead == null && cacheCreation == null) {
    return usage.inputTokens;
  }
  return usage.inputTokens + (cacheRead ?? 0) + (cacheCreation ?? 0);
}
