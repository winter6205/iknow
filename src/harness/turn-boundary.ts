/**
 * src/harness/turn-boundary.ts
 *
 * Turn-boundary rule (one query message + the last-query scan) as a flat pure
 * harness module. It sits in the harness layer because harness-side consumers
 * slice the message list by this rule, and `src/harness/**` must never import
 * `src/session-api/**` (frozen contract, see verify/evidence-checker.ts header).
 * `session-api/turn-projection.ts` and `tui/turn-activity.ts` re-export these
 * symbols so every existing consumer keeps one definition of the boundary.
 */
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "./model-adapter/types.js";
import { isAgentStatusText } from "./agent-status.js";
import { isGraphModeText } from "./graph/notification.js";
import { isSubagentDrainText } from "./subagent/host-drain.js";
import { isSkillIndexDeltaText } from "./skill/index-delta.js";

/**
 * Joined text of a message's text blocks (" "-separated; "" when none).
 * Single shared implementation — previously duplicated verbatim as hub.ts
 * `textOf` and store/checkpoint.ts `joinedText`; keep every consumer on this
 * one helper (fixes here apply to both sides; do not copy again).
 */
export function messageText(msg: AnthropicNativeMessage): string {
  return msg.content
    .filter(
      (b): b is Extract<AnthropicContentBlock, { type: "text" }> =>
        b.type === "text"
    )
    .map((b) => b.text)
    .join(" ");
}

/**
 * Turn-boundary rule SSOT (shared by hub.ts projectMessagesToTurns and
 * store/checkpoint.ts splitTurns; the former hub `isQueryMessage` /
 * checkpoint `isQuery` conditions converge here): a turn starts at a user
 * message that carries NO tool_result block and is NOT a subagent drain
 * summary, an agent_status bar injection, a graph_mode notification (ON/OFF
 * toggle + ADR-0081 one short presence note per run()), nor a skill-index
 * delta listing (ADR-0098 `<available_skills>` increment); user messages
 * with only tool_result blocks are continuation, not queries. Drain /
 * agent_status / graph_mode / skill-index-delta messages are host-injected —
 * they neither surface as a turn nor bound the preceding turn's slice.
 *
 * The five injected-envelope kinds share one list with TUI
 * `isTuiHiddenUserMessage` (the "hidden injection" consumers must not drift
 * apart); predicates always come from each producer's own module
 * (`isSubagentDrainText` / `isAgentStatusText` / `isGraphModeText` /
 * `isSkillIndexDeltaText`).
 */
export function isTurnQuery(msg: AnthropicNativeMessage): boolean {
  const text = messageText(msg);
  return (
    msg.role === "user" &&
    !msg.content.some((b) => b.type === "tool_result") &&
    !isSubagentDrainText(text) &&
    !isAgentStatusText(text) &&
    !isGraphModeText(text) &&
    !isSkillIndexDeltaText(text)
  );
}

/** Index of the last turn query; no query → -1. */
export function lastTurnQueryIndex(
  messages: ReadonlyArray<AnthropicNativeMessage>
): number {
  let idx = -1;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message !== undefined && isTurnQuery(message)) idx = i;
  }
  return idx;
}

/** Slice from `start` (inclusive) to the end; start < 0 or out of range → empty array (a missing query must not mean the whole history). */
export function sliceTurnFrom(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  start: number
): ReadonlyArray<AnthropicNativeMessage> {
  if (start < 0 || start >= messages.length) return [];
  return messages.slice(start);
}
