// Proactive estimation trigger + reactive PromptTooLongError trigger
// (ADR-0013): the proactive path (shouldAutoCompact) and the reactive
// fallback in loop-engine (at most once per run) coexist as double
// insurance, sharing `compactMessages` with no threshold/priority conflict.
//
// `evaluateCompactTrigger` is the unified trigger decision: manual /compact
// and loop-engine proactive share one function, classifying the result into
// token threshold + window gating + full-summary fallback;
// `shouldAutoCompact` is kept as a compatibility wrapper.
import type { AnthropicNativeMessage } from "../model-adapter/types.js";
import { DEFAULT_KEEP_RECENT } from "./constant.js";
import { estimateMessagesTokens } from "./estimate.js";
import { preserveToolPairs } from "./window.js";

/** CompactReason — trigger-decision classification tag. */
type CompactReason =
  | "below_token_threshold" // token estimate below threshold; no compaction
  | "messages_too_few" // threshold exceeded but splitForCompaction finds no window
  | "windowed" // threshold exceeded + droppable prefix; windowed compaction
  | "full_summary"; // threshold exceeded + no window; full-summary path

/** CompactTriggerDecision — trigger-decision result (discriminated union). */
type CompactTriggerDecision =
  | { action: "noop"; reason: "below_token_threshold" }
  | { action: "compact_via_full_summary"; reason: "messages_too_few" }
  | { action: "compact_via_window"; reason: "windowed" };

/**
 * Unified trigger decision, shared by manual /compact and loop-engine
 * proactive. Proactive and reactive share `compactMessages` (ADR-0013);
 * this function only decides which compaction path to take and introduces
 * no new compaction implementation. The token estimate is used only for
 * the decision (ADR-0008).
 */
export function evaluateCompactTrigger(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  ctx: {
    contextWindow: number;
    threshold: number;
    keepRecent?: number; // defaults to DEFAULT_KEEP_RECENT
  }
): CompactTriggerDecision {
  const estimated = estimateMessagesTokens(messages);
  if (estimated < ctx.threshold) {
    return { action: "noop", reason: "below_token_threshold" };
  }
  // Token threshold exceeded — check whether the window can be dropped
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
 * Whether the current accumulated token estimate of messages reaches the
 * proactive auto-compact threshold. Pure function. The reactive trigger is
 * owned by loop-engine's `PromptTooLongError` branch (ADR-0013);
 * `compactMessages` in this module is the compaction function shared by
 * both insurance paths — proactive and reactive do not fork the threshold
 * or the compaction logic; they trigger independently and share the
 * output.
 *
 * @deprecated — new callers should use `evaluateCompactTrigger`. This
 * function is kept as a compatibility wrapper with an unchanged body to
 * avoid breaking existing external callers; the delegation covers only the
 * token-threshold decision, without window gating / full-summary fallback.
 */
export function shouldAutoCompact(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  ctx: { contextWindow: number; threshold: number }
): boolean {
  return estimateMessagesTokens(messages) >= ctx.threshold;
}

// Re-export the public API so `import { ... } from "src/harness/compress/"`
// works as a single entry. Note: under strict noUnusedLocals, re-export-only
// symbols must not be imported first; use direct `export ... from`.
//
// The five full-compact functions (LLM structured-summary compaction) are
// exposed alongside the legacy pure-truncation path `compactMessages` —
// loop-engine and hub can freely choose the summary-success path or the
// placeholder fallback. Note: `COMPACT_TIMEOUT_SECONDS` is no longer
// exported: runFullCompact installs no default client-side timeout (ceiling
// = SDK default HTTP timeout + user-signal cancellation); `timeoutMs` stays
// as an injection seam for tests / explicit callers.
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
