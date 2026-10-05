import type { AnthropicNativeMessage } from "./model-adapter/types.js";

/**
 * Position of one content block inside the messages array — the two
 * coordinates a windowed scan needs when message granularity is too coarse
 * (a single assistant message can carry the claim text and a tool_use alike).
 */
export interface ContentBlockPosition {
  readonly messageIndex: number;
  readonly contentBlockIndex: number;
}

/**
 * Content-block index of the last non-blank text block of one message's
 * content; -1 when there is none, including malformed / absent content
 * (fail-closed — callers keep their no-signal handling).
 */
export function lastNonEmptyTextBlockIndex(
  content: AnthropicNativeMessage["content"] | null | undefined
): number {
  if (!Array.isArray(content)) return -1;
  for (let j = content.length - 1; j >= 0; j--) {
    const block = content[j];
    if (
      block &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim().length > 0
    ) {
      return j;
    }
  }
  return -1;
}

/**
 * Shared backward scan for the last assistant with non-empty text.
 * `deriveFinalText` and verify `claimIndex` must use this one scan.
 * `contentBlockIndex` is the position of the last non-blank text block inside
 * the ORIGINAL content array: `text` is a join, so it cannot be traced back to
 * where the claim actually sat.
 */
export function lastNonEmptyAssistant(
  messages: ReadonlyArray<AnthropicNativeMessage>
): {
  readonly index: number;
  readonly text: string;
  readonly contentBlockIndex: number;
} | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") {
      const texts = m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .filter((t) => t.trim().length > 0);
      if (texts.length > 0)
        return {
          index: i,
          text: texts.join("\n"),
          contentBlockIndex: lastNonEmptyTextBlockIndex(m.content),
        };
    }
  }
  return null;
}

/** Messages index of the claim assistant; -1 when none (checker fail-closed). */
export function deriveClaimIndex(
  messages: ReadonlyArray<AnthropicNativeMessage>
): number {
  return lastNonEmptyAssistant(messages)?.index ?? -1;
}
