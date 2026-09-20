/**
 * Per-turn wire projection for thinking / tool calls + compact-boundary
 * recent-user-tasks excerpt.
 *
 * Pure functions, no I/O. Both projectors accept a `mask` function applied
 * to any text written to the wire before truncation (consistent with
 * `finalText` masking on `toTurnDto`).
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
import { isAgentStatusText } from "../harness/agent-status.js";
import { isGraphModeText } from "../harness/graph/notification.js";
import { isSubagentDrainText } from "../harness/subagent/host-drain.js";
import { isSkillIndexDeltaText } from "../harness/skill/index-delta.js";
import type { ActivityItem, ThinkingView, ToolCallView } from "./contract.js";

/**
 * Wire surface: sum `thinkingMs` (ms) over assistant messages in a slice.
 * Given a `messages` slice, a parallel `thinkingMs` array aligned to
 * messages, and a slice start `startIndex` (default 0), add up the
 * thinkingMs of in-range messages with `role === "assistant"`.
 *
 * Edge cases (pinned by schema validation):
 *  - `thinkingMs` undefined (no data anywhere / legacy sessions) → 0;
 *  - out-of-range index (thinkingMs[index] === undefined) → counted as 0;
 *  - `null` element (no thinkingMs at that position) → 0;
 *  - non-finite / `<= 0` (already filtered at appendEvents; defensive here) → 0;
 *  - non-integer / negative index → 0.
 *
 * Output: accumulated ms. Byte/second conversion is the caller's decision
 * (Math.ceil(ms / 1000)).
 *
 * No cross-module import: semantically mirrors src/tui/turn-activity.ts
 * sumThinkingMsInRange, but the hub-side web wire must not depend on the
 * TUI, so this is an independent copy.
 */
export function sumAssistantThinkingMsInRange(opts: {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly thinkingMs: ReadonlyArray<number | null> | undefined;
  readonly startIndex?: number;
}): number {
  const { messages, thinkingMs } = opts;
  const start = opts.startIndex ?? 0;
  if (thinkingMs === undefined) return 0;
  if (messages.length === 0) return 0;
  let total = 0;
  for (let offset = 0; offset < messages.length; offset++) {
    const msg = messages[offset];
    if (msg === undefined) continue;
    if (msg.role !== "assistant") continue;
    const index = start + offset;
    if (!Number.isInteger(index) || index < 0) continue;
    const value = thinkingMs[index];
    if (value === null || value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) continue;
    total += value;
  }
  return total;
}

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

/**
 * External signal (ADR-0024): greetings never become a compact-boundary
 * recent-tasks excerpt entry. This predicate moved here from
 * `store/schema.ts` — its only remaining consumer is
 * `extractRecentUserTasks` (the seed path that wrote `session.taskFocus` is
 * gone with the field's retirement). Keeping the predicate in the
 * turn-projection layer removes the historical cross-layer import (schema
 * → projection) without changing the algorithm.
 */
export function shouldSeedTaskFocus(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  return !TASK_FOCUS_GREETING_RE.test(t);
}

/** Greeting regex (companion to `shouldSeedTaskFocus`). SSOT lives with the
 *  predicate; export is internal (tests only — no public contract surface). */
const TASK_FOCUS_GREETING_RE =
  /^(你好|您好|嗨|哈喽|hello|hi|hey|thanks|thank you|谢谢您?)([!！.。?？\s]*)$/i;

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
  // Complexity anti-drift: the collect + build split keeps each pass
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

type ActivityDraft =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

type ToolResultView = { readonly text: string; readonly isError: boolean };

/**
 * Project assistant text and tool_use blocks in native block order.
 *
 * `tool_result` blocks are collected separately because they normally arrive
 * in a later user message. Runtime validation is intentionally defensive:
 * this is a display projection and malformed persisted data must not prevent
 * the rest of a session from being rendered.
 */
export function projectActivity(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  mask: TextMask
): readonly ActivityItem[] {
  // EXIT: malformed/non-array or empty input has no activity to project.
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const { drafts, resultsById } = scanActivityMessages(messages);
  return mapActivityDrafts(drafts, resultsById, mask);
}

type ActivityScan = {
  readonly drafts: readonly ActivityDraft[];
  readonly resultsById: ReadonlyMap<string, ToolResultView>;
};

function scanActivityMessages(messages: ReadonlyArray<unknown>): ActivityScan {
  const drafts: ActivityDraft[] = [];
  const resultsById = new Map<string, ToolResultView>();
  for (const rawMessage of messages) {
    scanActivityMessage(rawMessage, drafts, resultsById);
  }
  return { drafts, resultsById };
}

function scanActivityMessage(
  rawMessage: unknown,
  drafts: ActivityDraft[],
  resultsById: Map<string, ToolResultView>
): void {
  try {
    if (!isRecord(rawMessage) || !Array.isArray(rawMessage.content)) return;
    scanActivityBlocks(
      rawMessage.content,
      rawMessage.role === "assistant",
      drafts,
      resultsById
    );
  } catch {
    // EXIT: skip a malformed message while preserving other activity.
  }
}

function scanActivityBlocks(
  blocks: readonly unknown[],
  isAssistant: boolean,
  drafts: ActivityDraft[],
  resultsById: Map<string, ToolResultView>
): void {
  for (const rawBlock of blocks) {
    if (!isRecord(rawBlock)) continue;
    const block = rawBlock;
    if (block.type === "tool_result") {
      collectActivityToolResult(block, resultsById);
      continue;
    }
    if (!isAssistant) continue;
    const draft = toActivityDraft(block);
    if (draft !== undefined) drafts.push(draft);
  }
}

function toActivityDraft(
  block: Record<string, unknown>
): ActivityDraft | undefined {
  if (block.type === "text") {
    if (typeof block.text !== "string" || block.text.length === 0) {
      // EXIT: skip empty or malformed text block.
      return undefined;
    }
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use") {
    if (!isValidActivityToolUse(block)) {
      // EXIT: skip malformed tool_use.
      return undefined;
    }
    return {
      type: "tool",
      id: block.id,
      name: block.name,
      input: block.input,
    };
  }
  // EXIT: skip unknown block.
  return undefined;
}

function isValidActivityToolUse(
  block: Record<string, unknown>
): block is Record<string, unknown> & {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
} {
  return (
    typeof block.id === "string" &&
    block.id.length > 0 &&
    typeof block.name === "string" &&
    block.name.length > 0 &&
    Object.prototype.hasOwnProperty.call(block, "input") &&
    block.input !== undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function mapActivityDrafts(
  drafts: readonly ActivityDraft[],
  resultsById: ReadonlyMap<string, ToolResultView>,
  mask: TextMask
): readonly ActivityItem[] {
  return drafts.map((draft): ActivityItem => {
    if (draft.type === "text") {
      return { type: "text", text: mask(draft.text) };
    }
    const result = resultsById.get(draft.id);
    // EXIT: tool without result is still emitted with an empty output preview.
    return {
      type: "tool",
      tool: buildActivityToolView(draft, result, mask),
    };
  });
}

function collectActivityToolResult(
  block: Record<string, unknown>,
  resultsById: Map<string, ToolResultView>
): void {
  try {
    if (
      typeof block.tool_use_id !== "string" ||
      block.tool_use_id.length === 0
    ) {
      // EXIT: unpaired tool_result ignored.
      return;
    }
    if (resultsById.has(block.tool_use_id)) {
      // EXIT: duplicate tool_result ignored.
      return;
    }
    resultsById.set(block.tool_use_id, {
      text: toolResultText(block.content),
      isError: block.is_error === true,
    });
  } catch {
    // EXIT: malformed tool_result ignored.
  }
}

function buildActivityToolView(
  draft: Extract<ActivityDraft, { type: "tool" }>,
  result: ToolResultView | undefined,
  mask: TextMask
): ToolCallView {
  const inputJson = serializeToolInput(draft.input);
  const inputPreview = truncate(mask(inputJson), MAX_TOOL_INPUT_PREVIEW_CHARS);
  const rawOutput = result === undefined ? "" : mask(result.text);
  return {
    id: draft.id,
    name: draft.name,
    inputPreview,
    outputPreview: truncate(rawOutput, MAX_TOOL_OUTPUT_PREVIEW_CHARS),
    isError: result?.isError ?? false,
    truncated: rawOutput.length > MAX_TOOL_OUTPUT_PREVIEW_CHARS,
  };
}

const TOOL_INPUT_PREVIEW_EXIT = "// EXIT: tool input preview unavailable";

function serializeToolInput(input: unknown): string {
  try {
    return JSON.stringify(input) ?? TOOL_INPUT_PREVIEW_EXIT;
  } catch {
    // EXIT: unserializable tool input gets an explicit safe preview marker.
    return TOOL_INPUT_PREVIEW_EXIT;
  }
}

// -- Recent user tasks (extracted fresh at the compact boundary) -----------
//
// Pure-function extraction of the most recent qualifying user task texts,
// which the hub injects after the compact-boundary placeholder. Replaces the
// old `renderTaskFocusBoundary` focus rendering (240+history+cap720).
//
// Contract:
//   - Walk messages backwards, taking at most limit(=3) qualifying user-turn
//     originals (trimmed), newest first.
//   - Qualifying predicate: role === "user" ∧ not a pure tool_result
//     (isTurnQuery) ∧ not a greeting (shouldSeedTaskFocus, same SSOT) ∧ not a
//     self-reference (TASK_EXCERPT_PREFIX — a previous excerpt must not be
//     picked up by the next round).
//   - 0 matches → []. assistant / greeting / drain / whitespace never taken.
//   - Returned in chronological order (oldest → newest), latest last.
//   - No truncation, no LLM: pure function over messages.

/** SSOT: prefix of the compact-boundary task excerpt. Text carrying it is
 *  never treated as a qualifying user task by the next extraction round,
 *  see `isTaskExcerptText`. */
export const TASK_EXCERPT_PREFIX = "[Recent user tasks]";

/** Default per-round extraction limit. */
export const MAX_RECENT_USER_TASKS = 3;

/**
 * Pred: is this text the task-excerpt section injected by the previous
 * compact pass?
 *
 * Comparison trims leading start (the excerpt may be wrapped in leading
 * whitespace but the prefix sentinel still identifies it). Side effect: a
 * genuine user task that happens to start with the `[Recent user tasks]`
 * literal is also excluded — an accepted cost (the excerpt sentinel and
 * user text do not overlap semantically).
 */
export function isTaskExcerptText(text: string): boolean {
  return text.trimStart().startsWith(TASK_EXCERPT_PREFIX);
}

/**
 * Extract the most recent qualifying user task originals — the data source
 * for the compact-boundary excerpt.
 *
 * Direction: walk backwards, stop once limit entries are collected, then
 * reverse to chronological order (oldest → newest), consistent with the
 * `1. 2. 3.` list of renderRecentUserTasksBoundary (latest last).
 *
 * Callers own the messages content: hub.postMessage has already appended
 * the current query, so reading session.messages yields a "current turn
 * included" view; pass the pre-turn view (e.g. the conditionalSave-time
 * `session.messages`) if that is what you need.
 */
export function extractRecentUserTasks(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  options?: { readonly limit?: number }
): readonly string[] {
  const limit = options?.limit ?? MAX_RECENT_USER_TASKS;
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const msg = messages[i]!;
    if (!isTurnQuery(msg)) continue;
    const text = messageText(msg).trim();
    if (text.length === 0) continue;
    if (isTaskExcerptText(text)) continue;
    // shouldSeedTaskFocus already applies the greeting filter.
    if (!shouldSeedTaskFocus(text)) continue;
    out.push(text);
  }
  return out.reverse();
}
