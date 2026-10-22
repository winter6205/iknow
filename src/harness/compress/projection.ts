// Occupancy projection (Plan A T2): the numerator for the next request.
//
// Two paths, one source tag:
//   - anchored: a confirmed API `usage` plus the frozen assistant message it
//     describes, still present in `messages` by reference. The base is
//     `occupancyFromUsage(usage) + usage.outputTokens` (the previous input plus
//     the output that enters the next prompt); only messages appended after
//     that assistant message are estimated. System and tools are already
//     inside `usage`, so they are never added again.
//   - unanchored: the whole history plus system / tools is estimated. This is
//     the post-compaction degradation and the vendor-without-countTokens path.
//
// Reference identity is the contract: `freezeMessage` clones every appended
// message, so a structurally equal object is not the anchor. When the stored
// assistant message is no longer in the array (compaction replaced the
// history) the anchored path must NOT slice from index -1 / 0 — that would add
// the entire history on top of the measured base. It falls back to the full
// estimate instead.
//
// Pure: no persistence, no clock, no second ledger.
import type {
  AnthropicNativeMessage,
  TokenUsage,
} from "../model-adapter/types.js";
import { estimateMessagesTokens, estimateTokens } from "./estimate.js";
import { occupancyFromUsage } from "./occupancy.js";

/** One occupancy reading. `measured` is an exact API count; `projected` is a
 *  client-side estimate and must never enter `lastUsage`, the trace, or any
 *  billing path. */
export interface OccupancyReading {
  readonly tokens: number;
  readonly source: "measured" | "projected";
}

/** Run-scoped anchor: the confirmed usage of one successful call and the exact
 *  assistant message frozen into the authoritative history for it. */
export interface OccupancyAnchor {
  readonly usage: TokenUsage;
  readonly assistantMessage: AnthropicNativeMessage;
}

export interface RequestEstimateInput {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly systemText?: string;
  readonly toolsText?: string;
}

/** Full re-estimate of one request: history (thinking included, because the
 *  provider replays signed thinking) + system + serialized tools. */
export function estimateRequestTokens(input: RequestEstimateInput): number {
  return (
    estimateMessagesTokens(input.messages, { countThinking: true }) +
    estimateTokens(input.systemText ?? "") +
    estimateTokens(input.toolsText ?? "")
  );
}

export function projectOccupancy(
  input: RequestEstimateInput & { readonly anchor: OccupancyAnchor | null }
): OccupancyReading {
  const anchor = input.anchor;
  if (anchor !== null) {
    const index = input.messages.indexOf(anchor.assistantMessage);
    if (index !== -1) {
      const base = occupancyFromUsage(anchor.usage) + anchor.usage.outputTokens;
      const appended = estimateMessagesTokens(input.messages.slice(index + 1));
      return { tokens: base + appended, source: "projected" };
    }
  }
  return { tokens: estimateRequestTokens(input), source: "projected" };
}
