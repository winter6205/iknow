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
import { isSubagentDrainText } from "../harness/subagent/host-drain.js";
import type { ThinkingView, ToolCallView } from "./contract.js";

/**
 * Joined text of a message's text blocks (" "-separated; "" when none).
 * Single shared implementation — previously duplicated verbatim as hub.ts
 * `textOf` and store/checkpoint.ts `joinedText`; keep every consumer on this
 * one helper (修改此处即双侧生效，禁止再复制第二份).
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
 * Turn-boundary rule SSOT (hub.ts projectMessagesToTurns 与
 * store/checkpoint.ts splitTurns 共用；原 hub `isQueryMessage` / checkpoint
 * `isQuery` 三条件收敛于此): a turn starts at a user message that carries NO
 * tool_result block and is NOT a subagent drain summary; user messages with
 * only tool_result blocks are continuation, not queries. Drain messages are
 * host-injected result summaries — they neither surface as a turn nor bound
 * the preceding turn's slice.
 */
export function isTurnQuery(msg: AnthropicNativeMessage): boolean {
  return (
    msg.role === "user" &&
    !msg.content.some((b) => b.type === "tool_result") &&
    !isSubagentDrainText(messageText(msg))
  );
}

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
  // M2 / ACR complexity anti-drift: collect + build split keeps each pass
  // single-purpose and both below the 30-line / ≤10-branch threshold.
  const resultsById = collectToolResults(messages);
  return buildToolCallViews(messages, resultsById, mask);
}

/**
 * Pass 1: collect `tool_result` blocks by `tool_use_id`. Multiple results
 * for the same id concatenate their text; `is_error` latches true.
 */
function collectToolResults(
  messages: ReadonlyArray<AnthropicNativeMessage>
): Map<string, { text: string; isError: boolean }> {
  const resultsById = new Map<string, { text: string; isError: boolean }>();
  for (const msg of messages) {
    for (const block of msg.content as ReadonlyArray<AnthropicContentBlock>) {
      if (block.type !== "tool_result") continue;
      const text = toolResultText(block.content);
      const prev = resultsById.get(block.tool_use_id);
      const isError = (prev?.isError ?? false) || block.is_error === true;
      resultsById.set(block.tool_use_id, {
        text: prev ? prev.text + text : text,
        isError,
      });
    }
  }
  return resultsById;
}

/**
 * Pass 2: walk assistant `tool_use` blocks in order, pairing each with its
 * collected result and producing the wire view (mask → truncate).
 */
function buildToolCallViews(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  resultsById: Map<string, { text: string; isError: boolean }>,
  mask: TextMask
): readonly ToolCallView[] | undefined {
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
