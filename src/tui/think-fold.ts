/**
 * Pure functions for thinking-fold line copy (SSOT). Human-display contract:
 * specs/tui-human-display.md + docs/CONTEXT.md `live tool line` / `unit fold`.
 *
 *  - `formatThinkingFold(seconds)` — finished fold line: finite and
 *    `seconds > 0` → English `Thought for <duration>` (the only finished
 *    wording; no extra label prefix, no Chinese fallback); missing / non-positive
 *    / non-finite → "" (never fabricate a zero-second line).
 *    `unit fold` keeps only the English duration form — the render layer
 *    welds the count onto the same line (turn-activity.ts); this function
 *    produces the duration segment only.
 *  - `thinkingPeekLines(text, limit)` — preview window while "thinking" is
 *    folded: while thinking is in flight, expose the **last** ≤3 body lines;
 *    after freeze / turn end the caller stops taking the window and folds
 *    back to the pure summary line.
 *  - `formatThinkingLive()` — streaming panel thinking fold line (in
 *    progress): always `Thinking…`. Live ticking seconds were removed —
 *    they visually duplicate and semantically clash with the mode line's
 *    `· Xs` (total turn runtime ≠ thinking time); "thinking duration" is
 *    carried only by the post-hoc frozen summary.
 *
 * Discipline: pure functions, no React, no IO — same as run-stats.ts,
 * driven directly by unit tests (tests/tui/think-fold.test.ts). Callers
 * (chat-view.tsx / message-blocks.tsx) must use this module only; no
 * template strings re-implemented in the render layer.
 */

/** Finished fold line: `Thought for <N>s`; no usable seconds → "". */
export function formatThinkingFold(seconds: number | undefined): string {
  const s = Math.floor(seconds ?? 0);
  if (!Number.isFinite(s) || s <= 0) return "";
  return `Thought for ${s}s`;
}

/** Streaming fold line copy (always `Thinking…`, no live seconds — see module comment).
 *  Implementation lives in `src/shared/tool-line.ts` — the CLI spinner (shared by
 *  CLI and TUI) and the TUI fold line must use identical copy, and CLI importing
 *  src/tui would invert layering. */
export { formatThinkingLive } from "../shared/tool-line.js";

/** Hard cap for the folded thinking preview line count (last 2–3 lines; take the upper bound 3). */
export const THINKING_PEEK_MAX_LINES = 3;

/**
 * Folded "thinking" body preview: take at most `limit` trailing lines of
 * `text` (default = the cap of 3).
 *
 * - Blank / whitespace-only lines do not consume the budget — streaming
 *   thinking is often separated by markdown blank lines, and letting them
 *   count would leave "only one body line" of preview;
 * - trailing whitespace and CR are stripped — the render layer lays out by
 *   visible characters;
 * - `limit` is hard-clamped to `[0, THINKING_PEEK_MAX_LINES]`: the preview
 *   is a bounded window — no caller size may exceed the 3-line height cap
 *   (folded height must be independent of full thinking text length).
 */
export function thinkingPeekLines(
  text: string,
  limit: number = THINKING_PEEK_MAX_LINES
): ReadonlyArray<string> {
  const take = Math.min(
    THINKING_PEEK_MAX_LINES,
    Math.max(0, Math.floor(limit))
  );
  if (take === 0 || text === "") return [];
  const lines: string[] = [];
  const all = text.split("\n");
  for (let i = all.length - 1; i >= 0 && lines.length < take; i--) {
    const line = (all[i] ?? "").replace(/\s+$/u, "");
    if (line.trim() === "") continue; // blank lines do not consume the preview budget
    lines.push(line);
  }
  return lines.reverse();
}
