/**
 * Per-turn wire projection for thinking / tool calls (T1).
 *
 * Pure functions, no I/O. Both projectors accept a `mask` function applied
 * to any text written to the wire before truncation (SC20 boundary,
 * consistent with `finalText` masking on `toTurnDto`).
 *
 * Caller responsibility: pass the message slice for the turn only (not the
 * full session history). `toTurnDto` uses `result.messages.slice(priorCount)`
 * and `projectMessagesToTurns` builds each turn's slice from the next
 * non-tool_result user message.
 */
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../harness/index.js";
import type { ThinkingView, ToolCallView } from "./contract.js";

/** Max thinking text chars per entry (after mask, before truncation). */
export const MAX_THINKING_TEXT_CHARS = 2000;
/** Max tool input preview chars (JSON.stringify(input) → mask → truncate). */
export const MAX_TOOL_INPUT_PREVIEW_CHARS = 500;
/** Max tool output preview chars (concatenated text blocks → mask → truncate). */
export const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 1500;

export type TextMask = (s: string) => string;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Concatenate text blocks inside a tool_result content (unknown shape). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join(" ");
}

/**
 * Collect assistant `thinking` (non-empty text → entries) and count
 * `redacted_thinking` blocks. Returns `undefined` when there is no
 * thinking at all (entries empty AND redactedCount=0), so callers can
 * omit the wire field entirely.
 */
export function projectThinkingView(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  mask: TextMask
): ThinkingView | undefined {
  const entries: { readonly text: string }[] = [];
  let redactedCount = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "thinking") {
        if (block.thinking.length > 0) {
          entries.push({
            text: truncate(mask(block.thinking), MAX_THINKING_TEXT_CHARS),
          });
        }
      } else if (block.type === "redacted_thinking") {
        // `data` is intentionally never put on the wire; only count.
        redactedCount++;
      }
    }
  }
  if (entries.length === 0 && redactedCount === 0) return undefined;
  return { entries, redactedCount };
}

/**
 * Pair `tool_use` blocks with their `tool_result` (matched by `tool_use_id`),
 * in block order. Returns `undefined` when no tool_use blocks were seen.
 * Missing tool_result → `outputPreview=""`, `isError=false`, `truncated=false`.
 */
export function projectToolCalls(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  mask: TextMask
): readonly ToolCallView[] | undefined {
  const resultsById = new Map<string, { text: string; isError: boolean }>();
  for (const msg of messages) {
    for (const block of msg.content as ReadonlyArray<AnthropicContentBlock>) {
      if (block.type === "tool_result") {
        const text = toolResultText(block.content);
        const prev = resultsById.get(block.tool_use_id);
        const isError = (prev?.isError ?? false) || block.is_error === true;
        resultsById.set(block.tool_use_id, {
          text: prev ? prev.text + text : text,
          isError,
        });
      }
    }
  }

  let foundUse = false;
  const views: ToolCallView[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content as ReadonlyArray<AnthropicContentBlock>) {
      if (block.type !== "tool_use") continue;
      foundUse = true;
      const result = resultsById.get(block.id);
      const inputJson =
        block.input === undefined ? "" : JSON.stringify(block.input);
      const maskedInput = mask(inputJson);
      const inputPreview = truncate(maskedInput, MAX_TOOL_INPUT_PREVIEW_CHARS);
      const rawOutput = result ? mask(result.text) : "";
      const truncated = rawOutput.length > MAX_TOOL_OUTPUT_PREVIEW_CHARS;
      const outputPreview = truncate(rawOutput, MAX_TOOL_OUTPUT_PREVIEW_CHARS);
      views.push({
        id: block.id,
        name: block.name,
        inputPreview,
        outputPreview,
        isError: result?.isError ?? false,
        truncated,
      });
    }
  }
  return foundUse ? views : undefined;
}
