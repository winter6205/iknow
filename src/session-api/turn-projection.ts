/**
 * Per-turn wire projection for thinking / tool calls (T1) +
 * compact-boundary recent-user-tasks excerpt (#604 T1).
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
import { isAgentStatusText } from "../harness/agent-status.js";
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
 * tool_result block and is NOT a subagent drain summary nor an agent_status
 * bar injection; user messages with only tool_result blocks are continuation,
 * not queries. Drain / agent_status messages are host-injected — they neither
 * surface as a turn nor bound the preceding turn's slice.
 */
export function isTurnQuery(msg: AnthropicNativeMessage): boolean {
  const text = messageText(msg);
  return (
    msg.role === "user" &&
    !msg.content.some((b) => b.type === "tool_result") &&
    !isSubagentDrainText(text) &&
    !isAgentStatusText(text)
  );
}

/**
 * External signal (ADR-0024): greetings never become a compact-boundary
 * recent-tasks excerpt entry. #605 T2 moved this predicate from
 * `store/schema.ts` to here — its only remaining consumer is
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

// -- #604 T1: 任务摘录（compact 边界现抽现贴） -------------------------------
//
// 把会话里**最近几句合格用户任务原话**纯函数式抽出，供 hub 注入到 compact
// 边界 placeholder 之后。取代旧 `renderTaskFocusBoundary` 的 240+history+cap720
// 焦点渲染（taskFocus 字段仍由 conditionalSave seed，T2 才删 — 本轮只换边界
// 渲染源）。
//
// 契约:
//   - 倒序遍历 messages，按时间倒序取至多 limit(=3)条合格 user-turn 原文(trim)。
//   - 合格谓词：role === "user" ∧ 非纯 tool_result（isTurnQuery）∧ 寒暄过滤
//     (shouldSeedTaskFocus,同 SSOT) ∧ 非 self-reference (TASK_EXCERPT_PREFIX
//     前缀 — 上一轮摘录段本身不得被下一轮抽到,concurrent 隔离)。
//   - 0 句 → []。assistant / 寒暄 / drain / whitespace 一律不取。
//   - 返回 chronological 顺序（最早→最新），latest 在末尾。
//   - 不截断、不调 LLM：纯函数 over messages。

/** SSOT:compact 边界附件任务摘录的前缀。自身不会被下一轮抽取视为合格用户
 *  任务(concurrent 隔离)，见 `isTaskExcerptText`。 */
export const TASK_EXCERPT_PREFIX = "[Recent user tasks]";

/** 单轮默认抽取上限。spec 写明 ≤3。 */
export const MAX_RECENT_USER_TASKS = 3;

/**
 * Pred:文本是否是上一轮 compact 注入的「任务摘录」段本身。
 *
 * 谓词必须 trimStart 比对(plan: 摘录段可能被前置空白包裹,但前缀哨兵仍识别);
 * 反向:用户真发的用户任务原文若意外以 `[Recent user tasks]` 字面开头,
 * 也会被排除 — 这是 spec 接受的代价(摘录哨兵与用户文本语义上不重叠)。
 */
export function isTaskExcerptText(text: string): boolean {
  return text.trimStart().startsWith(TASK_EXCERPT_PREFIX);
}

/**
 * 抽取会话里最近几句合格用户任务原文 — compact 边界摘录段的数据源。
 *
 * 遍历方向:倒序取够 limit 条即停。返回结果再 reverse 为 chronological
 * 顺序(最早→最新)，与 renderRecentUserTasksBoundary 的 `1. 2. 3.` 列表
 * 一致(最新交代在末尾)。
 *
 * 调用方对 messages 内容负全责:hub.postMessage 已在 messages 内追加了本轮
 * query,本函数读取 session.messages 即可拿到「含本轮的视图」;若调用方需要
 * 「取摘录前一刻」的视图,请传入 priorMessages(= conditionalSave 内
 * `session.messages`)。
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
    // shouldSeedTaskFocus 已包含寒暄过滤(plan §"抽取")。
    if (!shouldSeedTaskFocus(text)) continue;
    out.push(text);
  }
  return out.reverse();
}
