/**
 * CLI projection layer: renders harness `RunResult` + `LoopTrace` into two
 * forms.
 *
 * Forked from the legacy `formatAnswerHuman` / `formatAnswerJson` (still
 * consumed by the Session API) and switched to the harness foundation
 * `RunResult` + `LoopTrace` shapes; the CLI path uses this projection.
 *
 * Design points:
 * - `formatRunHuman` always renders the status line (even when finalText is
 *   null) so script consumers see stopReason / turns / tool chain / total
 *   duration on stderr, never an empty string.
 * - `formatRunJson` deliberately omits `result.messages`: Anthropic-native
 *   messages are too large for the oneshot ask path; finalText + trace
 *   suffice for scripts.
 * - Tool-name flattening: `Set` enumerates in insertion order, so
 *   `Array.from(new Set(...))` gives dedupe plus first-occurrence order.
 * - Thinking display switch for `formatRunHuman` (`opts.showThinking`,
 *   default false). Off: output contains no thinking text; on: a prefixed
 *   block is shown. Display channel only; `finalText` / `result.messages` /
 *   `LoopTrace` fields are untouched. Implemented as env flag
 *   `IKNOW_CHAT_SHOW_THINKING` (via `src/config/env.ts` SSOT, default off).
 * - `lastUsage` display (ADR-0008 display path): `formatRunJson` adds a
 *   `lastUsage` key when non-null (camelCase four fields, `TokenUsage`
 *   shape); null = no successful model call in the run -> key absent (same
 *   style as the `messages` omission). `formatRunHuman` appends
 *   ` · tokens in/out: <in>/<out>` to the status line (input/output only;
 *   cache fields stay off the human surface for minimal clarity).
 */
import type {
  AnthropicNativeMessage,
  LoopTrace,
  RunResult,
  TokenUsage,
} from "../harness/index.js";
import {
  createOutputMask,
  currentSecretValues,
} from "../harness/sandbox/index.js";

/** Tool-name list separator in status line (CLI script consumers parse this). */
const TOOL_LIST_SEP = ",";
/** Tool-list placeholder when no tool has been called. */
const NO_TOOLS = "-";
/** Thinking-block prefix shown when the display switch is on. */
export const THINKING_PREFIX = "思考:";
/** Placeholder line for redacted_thinking (encrypted blob) when the switch is on. */
export const REDACTED_PLACEHOLDER = "[已加密思考]";

export interface FormatRunOpts {
  readonly result: RunResult;
  readonly trace: LoopTrace;
}

/**
 * Thinking display switch; default false.
 *
 * Chosen as an env flag (`IKNOW_CHAT_SHOW_THINKING`) over a REPL slash
 * command because:
 *   - consistent with the `IKNOW_LLM_*` family / `src/config/env.ts` SSOT;
 *   - readable uniformly across chat / serve / ask;
 *   - implementation is a pure render function, easy to TDD; adds no
 *     mutable session state;
 *   - a REPL toggle's advantage is per-session switching, but this is a
 *     display preference — env suffices.
 * If in-session switching is ever needed, a `/show-thinking` subcommand can
 * be added as a reversible increment.
 */
export interface FormatRunHumanOpts extends FormatRunOpts {
  /** Thinking display switch; default false. */
  readonly showThinking?: boolean;
  /** Ctrl+C interrupt feedback text. Only when cancelled, computed by the
   *  caller (chat-session) and passed in (saved / not-checkpointed note);
   *  absent -> no status-line prefix, byte-stable. */
  readonly interruptNote?: string;
}

/**
 * Find the last assistant message in reverse order; undefined when none.
 *
 * The `m &&` guard stays: element type is
 * `AnthropicNativeMessage | undefined`; without the guard TS would narrow
 * `m` back to undefined inside the branch and reject property access.
 */
function findLastAssistantMessage(
  messages: ReadonlyArray<AnthropicNativeMessage>
): AnthropicNativeMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") return m;
  }
  return undefined;
}

/**
 * Partition one assistant message's content blocks into three groups:
 * - `thinkingLines`: thinking text (in order, no trim / skip-empty);
 * - `textLines`: non-empty text (trim length > 0);
 * - `hasRedacted`: whether any redacted_thinking block exists.
 *
 * tool_use / tool_result / other blocks fall through explicitly (no default
 * arm, so TS keeps exhaustiveness checks when block types grow).
 */
function partitionAnswerBlocks(content: AnthropicNativeMessage["content"]): {
  thinkingLines: string[];
  textLines: string[];
  hasRedacted: boolean;
} {
  const thinkingLines: string[] = [];
  const textLines: string[] = [];
  let hasRedacted = false;
  for (const block of content) {
    if (block.type === "thinking") {
      thinkingLines.push(block.thinking);
    } else if (block.type === "redacted_thinking") {
      hasRedacted = true;
    } else if (block.type === "text") {
      if (block.text.trim().length > 0) textLines.push(block.text);
    }
    // tool_use / tool_result / other blocks: not rendered.
  }
  return { thinkingLines, textLines, hasRedacted };
}

/**
 * Assembly when `showThinking=true`: thinking prefix + thinking texts +
 * redacted placeholder (emitted when either exists), blank-line separated
 * from the joined text blocks.
 */
function assembleVisibleAnswer(
  thinkingLines: string[],
  textLines: string[],
  hasRedacted: boolean
): string {
  const visible: string[] = [];
  if (thinkingLines.length > 0 || hasRedacted) {
    const pieces: string[] = [];
    if (thinkingLines.length > 0) pieces.push(...thinkingLines);
    if (hasRedacted) pieces.push(REDACTED_PLACEHOLDER);
    visible.push(`${THINKING_PREFIX}${pieces.join("\n")}`);
  }
  if (textLines.length > 0) {
    visible.push(textLines.join("\n"));
  }
  return visible.join("\n\n");
}

/**
 * Pure function — extract the visible display text from the last successful
 * assistant turn.
 *
 * - `showThinking=false` (default): text blocks only (thinking stays out of
 *   `finalText` — the projection-layer landing point of that decision).
 * - `showThinking=true`: assembly order is
 *   `<THINKING_PREFIX><thinking texts …>\n\n<text blocks …>`;
 *   one redacted_thinking placeholder line (encrypted blob has no visible
 *   content);
 *   tool_use / tool_result never enter the display channel.
 *
 * Input run results are authoritative history + trace; messages, trace and
 * finalText are not modified.
 */
export function renderAssistantAnswer(opts: {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly showThinking: boolean;
}): string {
  const lastAssistant = findLastAssistantMessage(opts.messages);
  if (!lastAssistant) return "";
  const { thinkingLines, textLines, hasRedacted } = partitionAnswerBlocks(
    lastAssistant.content
  );
  if (!opts.showThinking) {
    // thinking / redacted_thinking are not emitted while the switch is off.
    return textLines.join("\n");
  }
  return assembleVisibleAnswer(thinkingLines, textLines, hasRedacted);
}

/**
 * Human status line (no answer text) for `RunResult` + `LoopTrace`.
 *
 * Layout: `stop=<stopReason> · turns=<turnCount> · tools=<a,b,c> ·
 * <totalDurationMs>ms [ · tokens in/out: <in>/<out>]`
 *
 * Extracted from `formatRunHuman` so the streaming chat host can emit JUST
 * this line as the trailing status, without re-printing the answer text
 * (which has already been streamed to stdout as the final output).
 * `formatRunHuman` delegates here to preserve DRY — both the non-streamed
 * and streamed paths build the same status string.
 *
 * `result.finalText === null` is irrelevant (the status line never reads
 * finalText). When `trace.turns` holds no tool calls, `tools=` shows `-`.
 *
 * `lastUsage` non-null appends the `tokens in/out` reading; null = no
 * successful model call in the run, hidden.
 */
export function formatStatusLine(opts: FormatRunHumanOpts): string {
  const { result, trace, interruptNote } = opts;
  const toolNames = flattenToolNames(trace);
  const tools = toolNames.length > 0 ? toolNames.join(TOOL_LIST_SEP) : NO_TOOLS;
  const status =
    `stop=${result.stopReason} · ` +
    `turns=${result.turnCount} · ` +
    `tools=${tools} · ` +
    `${trace.totals.totalDurationMs}ms` +
    tokenSegment(result.lastUsage);
  // Interrupt feedback rides as a status-line prefix — streaming hosts emit
  // only the status line, so the note must sit on it or be lost;
  // formatRunHuman delegates here, so both paths carry it. Non-cancelled ->
  // interruptNote undefined -> no prefix, byte-stable.
  return interruptNote ? `⏹ 已打断，${interruptNote}\n${status}` : status;
}

/**
 * Human projection of `RunResult` + `LoopTrace`.
 *
 * Layout:
 *   `<rendered text>
 *
 *   stop=<stopReason> · turns=<turnCount> · tools=<a,b,c> · <totalDurationMs>ms
 *   [ · tokens in/out: <inputTokens>/<outputTokens>]`
 *
 * When `result.finalText === null` or has no content, the text part is an
 * empty string and the status line still prints.
 *
 * The status segment delegates to `formatStatusLine` (DRY with the
 * streaming chat host path which emits only the status line + separator).
 *
 * The thinking surface follows `opts.showThinking` (default false). Off:
 * identical to the original behaviour (derived from `finalText`, no
 * thinking in the answer). On: `renderThinkingVisible` = collapsed summary
 * line + answer body (joined text blocks), matching the TUI final-draft
 * default collapsed state (chat TTY has no collapse interaction; the
 * summary line *is* the collapsed state).
 *
 * Secret masking: the final text passes through
 * `createOutputMask(currentSecretValues())` — known secret values are
 * replaced with `***` at the consumer-side output boundary.
 *
 * Collapsed-state assembly: `renderThinkingSummary` / `renderThinkingVisible`.
 */
function renderThinkingVisible(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  const summary = renderThinkingSummary(messages);
  const text = renderAssistantAnswer({ messages, showThinking: false });
  if (summary === "") return text;
  return text === "" ? summary : `${summary}\n\n${text}`;
}

export function formatRunHuman(opts: FormatRunHumanOpts): string {
  const { result, showThinking = false } = opts;
  const rawText = showThinking
    ? renderThinkingVisible(result.messages)
    : (result.finalText ?? "");
  const text = buildOutputMask().mask(rawText);
  const status = formatStatusLine(opts);
  return `${text}\n\n${status}`;
}

/**
 * Chat assembly gate: never print the passed green-check line.
 * Failure triad still uses formatVerifyReport. abort / disabled stay silent.
 */
export function formatChatVerifyReport(
  outcome: string,
  rounds: number
): string | undefined {
  if (
    outcome === "failed" ||
    outcome === "unstable" ||
    outcome === "escalated"
  ) {
    return formatVerifyReport(outcome, rounds);
  }
  return undefined;
}

/** CLI human verify line. Chat uses formatChatVerifyReport. */
export function formatVerifyReport(
  outcome: "failed" | "unstable" | "escalated" | "passed",
  rounds: number
): string {
  const label =
    outcome === "failed"
      ? "验证未通过"
      : outcome === "unstable"
        ? "验证不稳定（套件干扰）"
        : outcome === "escalated"
          ? "验证耗尽（升级后仍未通过）"
          : "验证通过";
  // passed is a legal terminal state and carries no "completion not judged" warning suffix; the other three states keep the existing text.
  if (outcome === "passed") {
    return `[验证] ${label}（${rounds} 轮）`;
  }
  return `[验证] ${label}（${rounds} 轮）—— 未判完成，结果以验证为准。`;
}

/**
 * Token reading segment for the human status line.
 *
 * `lastUsage` is a required `RunResult` field; null = no successful model
 * call in the run -> empty string (status line keeps its shape). The human
 * surface shows input/output only — the two cache fields stay off it
 * (minimal clarity; the JSON projection still carries them in full, see
 * formatRunJson).
 */
function tokenSegment(lastUsage: TokenUsage | null): string {
  if (lastUsage === null) return "";
  return ` · tokens in/out: ${lastUsage.inputTokens}/${lastUsage.outputTokens}`;
}

/**
 * Machine projection: pretty-printed JSON, deliberately omits `result.messages`.
 *
 * Deliberately excludes `result.messages` (Anthropic-native wire format) because
 * ask / chat oneshot scripts only need `finalText` + `stopReason` + `turnCount` +
 * `trace` for downstream parsing. Native messages stay available via `RunResult`
 * for in-process consumers; not for shell consumers.
 *
 * When `lastUsage` is non-null, a `lastUsage` key is added (camelCase four
 * fields, matching the domain type `TokenUsage` shape); null = no successful
 * model call -> key absent (same style as the `messages` omission;
 * `JSON.stringify` drops `undefined` values). `TokenUsage` field names are
 * already camelCase, so no mapping rewrite in the projection layer.
 *
 * The thinking display switch does **not** affect the JSON projection
 * (machine readers can extract thinking from `result.messages` themselves).
 *
 * Secret masking: `finalText` passes through
 * `createOutputMask(currentSecretValues())` — known secret values are
 * replaced with `***` at the consumer-side output boundary.
 */
export function formatRunJson(opts: FormatRunOpts): string {
  const { result, trace } = opts;
  const maskedFinalText =
    result.finalText === null ? null : buildOutputMask().mask(result.finalText);
  // null -> undefined -> dropped by JSON.stringify (same as messages omission).
  const lastUsage = result.lastUsage === null ? undefined : result.lastUsage;
  return JSON.stringify(
    {
      finalText: maskedFinalText,
      stopReason: result.stopReason,
      turnCount: result.turnCount,
      lastUsage,
      trace,
    },
    null,
    2
  );
}

/**
 * SC20: Build a fresh output mask from the currently-known secret values.
 *
 * Constructed per call (cheap enough — regex compilation on a few short
 * strings). Module-level memoization would also work but adds a test seam:
 * a per-call build means each call sees the env snapshot at call time,
 * which is what CLI invocations want (start-of-run snapshot is fine — env
 * does not mutate mid-run for CLI products).
 */
function buildOutputMask() {
  return createOutputMask(currentSecretValues());
}

/**
 * Flatten tool names across all turns, dedupe by first-occurrence order.
 * Returns an empty array when trace has no turns or no tool calls.
 *
 * Set iteration order in JS engines is insertion order; using `Array.from(new Set(...))`
 * preserves first-occurrence semantics without an extra index scan.
 */
function flattenToolNames(trace: LoopTrace): string[] {
  return Array.from(
    new Set(trace.turns.flatMap((t) => t.toolCalls.map((c) => c.toolName)))
  );
}

/**
 * Collapsed thinking summary line for the final draft (chat-side display
 * when `showThinking=true`).
 *
 * Returns the localized collapsed summary line (N thinking segments, plus
 * an encrypted-segment count when redacted blocks exist); empty string when
 * there is no thinking or redacted block. The TTY has no collapse
 * interaction, so the summary line *is* the collapsed state — consistent
 * with the TUI default-collapse semantics (both entry points share one
 * default thinking collapsed state). redacted_thinking counts toward the
 * encrypted tally (encrypted blobs have no visible content; presence only).
 */
export function renderThinkingSummary(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  const lastAssistant = findLastAssistantMessage(messages);
  if (!lastAssistant) return "";
  return summarizeThinkingContent(lastAssistant.content);
}

/**
 * Per-message collapsed thinking summary (SSOT, reused by chat-view from
 * the same source).
 *
 * Returns the localized collapsed summary line (N thinking segments, plus
 * an encrypted-segment count when redacted blocks exist); empty string when
 * none. Shared by the chat-side `showThinking=true` collapsed display and
 * the TUI collapse panel — both entry points keep identical default
 * collapsed state and summary text.
 */
export function summarizeThinkingContent(
  content: ReadonlyArray<AnthropicNativeMessage["content"][number]>
): string {
  let thinkingCount = 0;
  let redactedCount = 0;
  for (const block of content) {
    if (block.type === "thinking") thinkingCount += 1;
    else if (block.type === "redacted_thinking") redactedCount += 1;
  }
  if (thinkingCount === 0 && redactedCount === 0) return "";
  const redacted = redactedCount > 0 ? ` · 已加密 ×${redactedCount}` : "";
  return `思考（${thinkingCount} 段${redacted}）`;
}
