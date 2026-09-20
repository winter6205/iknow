/**
 * web/src/components/result-tool-preview.ts
 *
 * Web-side result preview projection, mirroring the TUI's `resultToolPreview`
 * (src/tui/tool-summary.ts). The two ends implement it separately (web cannot
 * import src/); boundary behavior (overflow `… +N 行` ("… +N lines"), ANSI
 * passthrough, empty / all-whitespace / ANSI-only → no render) stays aligned.
 * **The visible window line count is a known divergence**: the TUI moved to
 * 3 lines; this file still keeps `RESULT_PREVIEW_WINDOW`, and syncing the two
 * ends is tracked as a separate consistency item.
 *
 * Web data source: wire `ToolCallView.outputPreview` (already masked and
 * truncated to `MAX_TOOL_OUTPUT_PREVIEW_CHARS` = 1500 chars). bash goes
 * through a JSON envelope → same parse-then-extract semantics as the TUI
 * (concatenating the `stdout` / `stderr` fields).
 *
 * Boundaries:
 *   - empty / all-whitespace / empty-after-ANSI-strip output → `{ kind: "empty" }`;
 *   - take the tail `RESULT_PREVIEW_WINDOW` lines + overflow count;
 *   - a single line renders as one line (no padding to fill the window);
 *   - ANSI sequences are counted by stripped width; truncation must not cut
 *     through the middle of an escape sequence (line-level cuts never split chars);
 *   - tools with no preview need (read_file / write_file / edit_file, etc.) → `empty`.
 *
 * Failure styling is applied by the render layer via error-color tokens
 * (ToolCallItem outer / OutputBlock inner); the preview text itself is unchanged
 * (spec: on failure show the content as-is but tint the whole block red).
 */
import type { ToolCallView } from "../api/types.ts";

/** Web-side visible preview window (TUI already moved to 3 lines; end sync is a separate ticket, see file header). */
export const RESULT_PREVIEW_WINDOW = 5;

/** Name mirrors the TUI's `resultToolPreview` — same semantics. */
export type ResultPreview =
  | { readonly kind: "empty" }
  | {
      readonly kind: "result";
      readonly lines: readonly string[];
      /** Truncated line count = totalLines - visibleLines (visibleLines always = min(RESULT_PREVIEW_WINDOW, totalLines)). */
      readonly hiddenLineCount: number;
    };

const ANSI_ESCAPE_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Strip ANSI escapes (visibility checks only; never mutates the original string). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, "");
}

/** Overflow label: `… +N 行` ("… +N lines") — wording pinned by the spec. */
export function resultPreviewOverflowLabel(hiddenLineCount: number): string {
  return `… +${hiddenLineCount} 行`;
}

/** Tools with a consumable preview. skill: one-line result; bash: JSON envelope embedding stdout/stderr.
 *  read_file / write_file / edit_file / grep / glob / web_* / lsp_* and other no-preview
 *  tools always yield empty output (spec boundary). */
const PREVIEWABLE_TOOLS: ReadonlySet<string> = new Set(["bash", "skill"]);

/** bash tool_result text → joined output (same semantics as TUI `bashPreview`).
 *  JSON.parse succeeds with `stdout` / `stderr` fields → join stdout + "\n" + stderr;
 *  parse succeeds but fields missing → return "" so the outer isRenderableOutput
 *  yields empty — matching TUI behavior (TUI returns empty preview when
 *  streams.length === 0). */
function extractBashOutput(resultText: string): string {
  try {
    const parsed = JSON.parse(resultText) as Record<string, unknown>;
    const streams: string[] = [];
    if (typeof parsed.stdout === "string" && parsed.stdout.length > 0) {
      streams.push(parsed.stdout);
    }
    if (typeof parsed.stderr === "string" && parsed.stderr.length > 0) {
      streams.push(parsed.stderr);
    }
    return streams.join("\n");
  } catch {
    // EXIT: parse failure (non-JSON shape, same fallback semantics as TUI
    // bashPreview) → treat the whole resultText as stdout. The fallback lives
    // inside the catch body, not mixed with the happy-path return: the display
    // layer degrades to full text rather than an empty preview.
    return resultText;
  }
}

/** Single source: decide whether to render a preview block from output that may contain ANSI.
 *  Empty / all-whitespace / empty-after-strip → treated as empty (never render an empty block). */
function isRenderableOutput(s: string): boolean {
  if (s.length === 0) return false;
  const stripped = stripAnsi(s);
  if (stripped.trim().length === 0) return false;
  if (stripped.length === 0) return false;
  return true;
}

/** Split by lines (ANSI preserved); drop a trailing empty line (bash output commonly ends with \n). */
function splitOutputLines(s: string): string[] {
  if (s.length === 0) return [];
  const lines = s.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

/** Take the tail N lines + overflow count. lines.length <= N → pass through in full. */
function takeTailWindow(lines: readonly string[]): {
  readonly visible: string[];
  readonly hiddenLineCount: number;
} {
  if (lines.length <= RESULT_PREVIEW_WINDOW) {
    return { visible: lines.slice(), hiddenLineCount: 0 };
  }
  const tail = lines.slice(lines.length - RESULT_PREVIEW_WINDOW);
  return {
    visible: tail,
    hiddenLineCount: lines.length - RESULT_PREVIEW_WINDOW,
  };
}

/**
 * Single source: build the result preview from tool name + wire `outputPreview`.
 *  No preview declaration / no outputPreview / empty output → `{ kind: "empty" }`.
 */
export function resultToolPreview(
  toolName: string,
  outputPreview: ToolCallView["outputPreview"]
): ResultPreview {
  if (outputPreview === undefined || outputPreview.length === 0) {
    return { kind: "empty" };
  }
  if (!PREVIEWABLE_TOOLS.has(toolName)) return { kind: "empty" };

  const raw =
    toolName === "bash" ? extractBashOutput(outputPreview) : outputPreview;
  if (!isRenderableOutput(raw)) return { kind: "empty" };

  const lines = splitOutputLines(raw);
  if (lines.length === 0) return { kind: "empty" };

  const { visible, hiddenLineCount } = takeTailWindow(lines);
  if (visible.length === 0) return { kind: "empty" };

  return { kind: "result", lines: visible, hiddenLineCount };
}
