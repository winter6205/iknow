import type { AnthropicNativeMessage } from "./model-adapter/types.js";

/**
 * Shared backward scan for the last assistant with non-empty text.
 * `deriveFinalText` and verify `claimIndex` must use this one scan.
 */
export function lastNonEmptyAssistant(
  messages: ReadonlyArray<AnthropicNativeMessage>
): { readonly index: number; readonly text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") {
      const texts = m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .filter((t) => t.trim().length > 0);
      if (texts.length > 0) return { index: i, text: texts.join("\n") };
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
