/**
 * src/tui/tool-summary.ts
 *
 * Tool-call summary lines (pure formatting, unit-testable); migrated from
 * the archive Ink TUI with unchanged semantics:
 *  - a summary line = tool name + argument digest + status;
 *  - generate/edit tools are enriched: write_file/edit_file show *what was
 *    generated* (path + line count).
 *
 * `summarizePartialInput` (re-exported from shared) summarizes partial JSON
 * while streaming (parses → summarizeToolCall; incomplete JSON → raw clip).
 *
 * The **text layer** (summaries / status-line assembly / clip helpers /
 * subagent wording) lives in the neutral module `src/shared/tool-line.ts`
 * so the CLI shares one implementation (CLI importing src/tui would invert
 * the layering). This file re-exports those symbols so existing TUI callers
 * and tests/tui/* keep their import paths byte-for-byte; what stays here is
 * TUI-only: **result previews** (completedToolPreview / resultToolPreview /
 * toolPreviewRows) and the display registry carrying settledClass.
 *
 * Width discipline (narrow-terminal fix): a summary line renders in three
 * shapes — running progress line (`Running 1 shell command… · <command>` /
 * `name · detail`) and settled line `name · detail` (only failed rows get
 * the `[失败]` prefix) — and line-level window accounting always counts 1
 * line. When `cols` is passed, clip by visual width (reserving the widest
 * decoration) so no shape wraps (the running bash prefix is long; the full
 * line is backstopped by `formatToolStatusLine`).
 *
 * Content visibility: after write_file / edit_file completes,
 * `completedToolPreview` produces a truncated body or diff (UI SSOT); the
 * live box and history `ToolPreviewRows` share `CompletedToolPreviewView`
 * rendering. `toolPreviewRows` remains an unbounded DiffLine helper (tests
 * lock the whole-file green diff for create); production UI does not call
 * it directly.
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import {
  BASH_RUNNING_PREFIX,
  SUBAGENT_ROLE_FALLBACK,
  SUBAGENT_TOOL_LABEL,
  TOOL_SUMMARIES,
  clipOneLine,
  clipOneLineVisual,
  formatLiveToolEvent,
  formatThinkingLive,
  formatToolStatusLine,
  isSubagentTool,
  resolveSubagentRoleFromInput,
  subagentDisplayMark,
  summarizePartialInput,
  summarizeToolCall,
  visualWidth,
} from "../shared/tool-line.js";
import { computeDiff, type DiffLine } from "./diff-unified.js";
import { foldBashPreviewLines } from "./progress-tick.js";
import { TOOL_SETTLED_CLASS, type SettledClass } from "./tool-settled.js";

// Single source for the text layer = src/shared/tool-line.ts (shared with
// the CLI). The re-export keeps existing TUI callers' and tests/tui/*'
// import paths unchanged (zero byte drift).
export {
  BASH_RUNNING_PREFIX,
  SUBAGENT_ROLE_FALLBACK,
  SUBAGENT_TOOL_LABEL,
  clipOneLine,
  clipOneLineVisual,
  formatLiveToolEvent,
  formatThinkingLive,
  formatToolStatusLine,
  isSubagentTool,
  resolveSubagentRoleFromInput,
  subagentDisplayMark,
  summarizePartialInput,
  summarizeToolCall,
  visualWidth,
};

/** ANSI CSI / OSC escape sequences (mostly CSI SGR `\x1b[...m` / OSC `\x1b]...BEL/ST`).
 *  The strip also swallows the terminator (m / K / H / J / BEL / ST = ESC \) so an
 *  escape sequence is never cut in half (boundary contract: truncation must not
 *  split a sequence mid-way). */
const ANSI_ESCAPE_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Strip ANSI escape sequences (returns by character count; original invisible-char positions preserved). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, "");
}

export interface ToolSummaryLine {
  readonly toolName: string;
  readonly detail: string;
  /** ok | failed | unknown (tool_result never arrived, e.g. cancelled interrupt). */
  readonly status: "ok" | "failed" | "unknown";
}

function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};
}

function countLines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  return s.split("\n").length;
}

/** Tool display registry — declares "summary + result preview" in one place.
 *
 *  Co-locating each tool's status-line wording with its preview function
 *  means adding display for a new tool is one TOOL_DISPLAYS entry instead of
 *  three scattered edits (live + history + result preview). One row per
 *  tool: summary function + optional preview function (no preview need →
 *  field absent; tools that deliberately show no preview, e.g. read_file,
 *  are also field-absent).
 *
 *  Preview signature: `(rec, resultText?) => ResultPreview`.
 *  `rec` = projection of the tool_use input; `resultText` = tool_result text
 *  (absent on the live path, which reads the run.stdout / run.stderr
 *  side-channels instead; always provided on the history path — source =
 *  `toolResultTextMap(session.messages)`).
 */
interface ToolDisplay {
  /** Summary declaration: references the same function object as shared
   *  TOOL_SUMMARIES (not a copy of text) — the CLI and TUI detail wording
   *  stays single-source; the registry merely folds it into the one-row
   *  declaration. */
  readonly summary: (rec: Record<string, unknown>) => string;
  /** Optional running-state summary. Field absent = running and settled
   *  share one wording; a tool that declares it has a settled summary
   *  containing a quantity only trustworthy once the input is complete
   *  (write_file's line count) — while streaming the input is a half-
   *  finished product, so that quantity must be omitted, never shown as 0. */
  readonly runningSummary?: (rec: Record<string, unknown>) => string;
  /** Settled-state tri-class (a missing declaration is illegal — the field
   *  is required and tests reject gaps). */
  readonly settledClass: SettledClass;
  readonly preview?: (
    rec: Record<string, unknown>,
    resultText?: string,
    stdout?: string,
    stderr?: string
  ) => ResultPreview;
}

function bashPreview(
  _rec: Record<string, unknown>,
  resultText?: string,
  stdout?: string,
  stderr?: string
): ResultPreview {
  // Live path: the stdout/stderr side-channels take priority (they bypass
  // the model's tool_result encoding and don't depend on deserializing
  // historical tool_result JSON). Fallback = the resultText JSON envelope
  // (history path).
  let bashStdout = stdout;
  let bashStderr = stderr;
  if (
    bashStdout === undefined &&
    bashStderr === undefined &&
    resultText !== undefined
  ) {
    try {
      const parsed = JSON.parse(resultText) as Record<string, unknown>;
      if (typeof parsed.stdout === "string") bashStdout = parsed.stdout;
      if (typeof parsed.stderr === "string") bashStderr = parsed.stderr;
    } catch {
      // EXIT: not a JSON shape (bash should never produce one; kept as
      // defense) → treat the whole resultText as stdout so something still
      // shows. No throw, no other-shape attempts — the historical
      // tool_result text is the most faithful material the display layer
      // has, so degrade to full text rather than an empty preview.
      bashStdout = resultText;
    }
  }
  const streams: string[] = [];
  if (typeof bashStdout === "string" && bashStdout.length > 0)
    streams.push(bashStdout);
  if (typeof bashStderr === "string" && bashStderr.length > 0)
    streams.push(bashStderr);
  if (streams.length === 0) return EMPTY_RESULT_PREVIEW;
  const merged = streams.join("\n");
  if (!isRenderableOutput(merged)) return EMPTY_RESULT_PREVIEW;
  const lines = foldBashPreviewLines(merged);
  if (lines.length === 0) return EMPTY_RESULT_PREVIEW;
  const { visible, hiddenLineCount } = takeTailWindow(lines);
  if (visible.length === 0) return EMPTY_RESULT_PREVIEW;
  return { kind: "result", lines: visible, hiddenLineCount };
}

const TOOL_DISPLAYS: Readonly<Record<string, ToolDisplay>> = {
  // settledClass values come from tool-settled.ts's classification table and
  // summary from shared TOOL_SUMMARIES (both single sources; the registry
  // reuses, never copies — summary + preview? + settledClass co-located in
  // one row).
  write_file: {
    summary: TOOL_SUMMARIES.write_file!.summary,
    runningSummary: TOOL_SUMMARIES.write_file!.runningSummary,
    settledClass: TOOL_SETTLED_CLASS.write_file!,
  },
  edit_file: {
    summary: TOOL_SUMMARIES.edit_file!.summary,
    settledClass: TOOL_SETTLED_CLASS.edit_file!,
  },
  bash: {
    summary: TOOL_SUMMARIES.bash!.summary,
    preview: bashPreview,
    settledClass: TOOL_SETTLED_CLASS.bash!,
  },
  read_file: {
    summary: TOOL_SUMMARIES.read_file!.summary,
    settledClass: TOOL_SETTLED_CLASS.read_file!,
  },
  grep: {
    summary: TOOL_SUMMARIES.grep!.summary,
    settledClass: TOOL_SETTLED_CLASS.grep!,
  },
  glob: {
    summary: TOOL_SUMMARIES.glob!.summary,
    settledClass: TOOL_SETTLED_CLASS.glob!,
  },
  web_search: {
    summary: TOOL_SUMMARIES.web_search!.summary,
    settledClass: TOOL_SETTLED_CLASS.web_search!,
  },
  web_fetch: {
    summary: TOOL_SUMMARIES.web_fetch!.summary,
    settledClass: TOOL_SETTLED_CLASS.web_fetch!,
  },
  memory_recall: {
    summary: TOOL_SUMMARIES.memory_recall!.summary,
    settledClass: TOOL_SETTLED_CLASS.memory_recall!,
  },
  memory_save: {
    summary: TOOL_SUMMARIES.memory_save!.summary,
    settledClass: TOOL_SETTLED_CLASS.memory_save!,
  },
  tool_search: {
    summary: TOOL_SUMMARIES.tool_search!.summary,
    settledClass: TOOL_SETTLED_CLASS.tool_search!,
  },
  // skill is an accent-class tool — only the name is colored
  // (`skill <name>`); the skill body is not spread into a pale result
  // preview. No preview field is declared (resultToolPreview returns empty).
  skill: {
    summary: TOOL_SUMMARIES.skill!.summary,
    settledClass: TOOL_SETTLED_CLASS.skill!,
  },
  // skill_search was removed (ADR-0046); historical tool_results may still
  // carry the name → the default placeholder handles it (it is no longer in
  // TOOL_SUMMARIES), same behavior as any unregistered tool (no display
  // declaration = retract fallback).
  // The two subagent tools: settledClass takes the core's explicitly
  // declared "subagent" — no `!` fallback, so a missing/misreported
  // declaration fails at compile time or at the cross-module gate.
  spawn_subagent: {
    summary: TOOL_SUMMARIES.spawn_subagent!.summary,
    runningSummary: TOOL_SUMMARIES.spawn_subagent!.runningSummary,
    settledClass: TOOL_SETTLED_CLASS.spawn_subagent,
  },
  subagent_result: {
    summary: TOOL_SUMMARIES.subagent_result!.summary,
    settledClass: TOOL_SETTLED_CLASS.subagent_result,
  },
  lsp_definition: {
    summary: TOOL_SUMMARIES.lsp_definition!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_definition!,
  },
  lsp_references: {
    summary: TOOL_SUMMARIES.lsp_references!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_references!,
  },
  lsp_hover: {
    summary: TOOL_SUMMARIES.lsp_hover!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_hover!,
  },
  lsp_go_to_implementation: {
    summary: TOOL_SUMMARIES.lsp_go_to_implementation!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_go_to_implementation!,
  },
  lsp_prepare_call_hierarchy: {
    summary: TOOL_SUMMARIES.lsp_prepare_call_hierarchy!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_prepare_call_hierarchy!,
  },
  lsp_incoming_calls: {
    summary: TOOL_SUMMARIES.lsp_incoming_calls!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_incoming_calls!,
  },
  lsp_outgoing_calls: {
    summary: TOOL_SUMMARIES.lsp_outgoing_calls!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_outgoing_calls!,
  },
  lsp_diagnostics: {
    summary: TOOL_SUMMARIES.lsp_diagnostics!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_diagnostics!,
  },
  lsp_document_symbol: {
    summary: TOOL_SUMMARIES.lsp_document_symbol!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_document_symbol!,
  },
  lsp_workspace_symbol: {
    summary: TOOL_SUMMARIES.lsp_workspace_symbol!.summary,
    settledClass: TOOL_SETTLED_CLASS.lsp_workspace_symbol!,
  },
  // Host tools / nothing previewable — summary declaration only, no preview
  // (CLI and TUI render identically; model visibility matches current state).
  bash_output: {
    summary: TOOL_SUMMARIES.bash_output!.summary,
    settledClass: TOOL_SETTLED_CLASS.bash_output!,
  },
  bash_stop: {
    summary: TOOL_SUMMARIES.bash_stop!.summary,
    settledClass: TOOL_SETTLED_CLASS.bash_stop!,
  },
  todo_write: {
    summary: TOOL_SUMMARIES.todo_write!.summary,
    settledClass: TOOL_SETTLED_CLASS.todo_write!,
  },
  list_mcp_resources: {
    summary: TOOL_SUMMARIES.list_mcp_resources!.summary,
    settledClass: TOOL_SETTLED_CLASS.list_mcp_resources!,
  },
  read_mcp_resource: {
    summary: TOOL_SUMMARIES.read_mcp_resource!.summary,
    settledClass: TOOL_SETTLED_CLASS.read_mcp_resource!,
  },
  query_trace: {
    summary: TOOL_SUMMARIES.query_trace!.summary,
    settledClass: TOOL_SETTLED_CLASS.query_trace!,
  },
  // The five task-worktree lifecycle tools: enter/exit/create/remove are
  // accent-class (name colored), list is query-class (retract). Their
  // human-readable wording lives in shared TOOL_SUMMARIES — the CLI side
  // has no registry lookup, so only a single source avoids drift.
  // These five are conditionally assembled at the TUI surface (stripped
  // from the deps-tools expectation set), but their display declarations
  // stay resident — registry completeness is decoupled from assembly
  // conditions.
  "create-worktree": {
    summary: TOOL_SUMMARIES["create-worktree"]!.summary,
    settledClass: TOOL_SETTLED_CLASS["create-worktree"]!,
  },
  "enter-worktree": {
    summary: TOOL_SUMMARIES["enter-worktree"]!.summary,
    settledClass: TOOL_SETTLED_CLASS["enter-worktree"]!,
  },
  "exit-worktree": {
    summary: TOOL_SUMMARIES["exit-worktree"]!.summary,
    settledClass: TOOL_SETTLED_CLASS["exit-worktree"]!,
  },
  "remove-worktree": {
    summary: TOOL_SUMMARIES["remove-worktree"]!.summary,
    settledClass: TOOL_SETTLED_CLASS["remove-worktree"]!,
  },
  "list-worktrees": {
    summary: TOOL_SUMMARIES["list-worktrees"]!.summary,
    settledClass: TOOL_SETTLED_CLASS["list-worktrees"]!,
  },
};

/** Single source: build a result preview from tool name + input + resultText
 *  (tail row window + ANSI passthrough). No preview declaration / no
 *  resultText / empty output → `{ kind: "empty" }`. */
export function resultToolPreview(
  name: string,
  input: unknown,
  opts?: {
    readonly resultText?: string;
    readonly stdout?: string;
    readonly stderr?: string;
  }
): ResultPreview {
  const display = TOOL_DISPLAYS[name];
  if (display === undefined || display.preview === undefined) {
    return EMPTY_RESULT_PREVIEW;
  }
  const rec = inputRecord(input);
  return display.preview(rec, opts?.resultText, opts?.stdout, opts?.stderr);
}

/** Registry coverage: list all tool names currently registered in TOOL_DISPLAYS (for tests). */
export function registeredToolDisplayNames(): ReadonlyArray<string> {
  return Object.keys(TOOL_DISPLAYS);
}

/** settledClass lookup on the display registry (for the test gate): an
 *  unregistered name defaults to retract, matching the TOOL_SETTLED_CLASS
 *  fallback. */
export function settledClassOfDisplay(name: string): SettledClass {
  return TOOL_DISPLAYS[name]?.settledClass ?? "retract";
}

/**
 * One short error line for a failed tool.
 * Single-source truncation: collapse whitespace → `clipOneLineVisual` clips
 * to visual width (no wrap on narrow terminals) with an `…` ellipsis — long
 * receipts (e.g. `[worktree_isolation]`) are never spread over multiple
 * lines. Empty text → empty string (the renderer draws no error row).
 */
export function clipErrorLine(text: string, cols: number): string {
  if (text.length === 0) return "";
  return clipOneLineVisual(text, Math.max(1, cols - 2));
}

/** Visible window for a new file (write create preview): first 10 body
 *  lines. **Not** a cap for edit diffs — diffs of edits/overwrites are never
 *  truncated. */
export const WRITE_CREATE_PREVIEW_WINDOW = 10;

/** Compatibility alias: existing callers/tests referencing `TOOL_PREVIEW_WINDOW` now equal the create window 10.
 *  Edit diffs no longer share this cap (diffs are fully visible). */
export const TOOL_PREVIEW_WINDOW = WRITE_CREATE_PREVIEW_WINDOW;

/** Result preview (bash / skill) visible window: tail rows, overflow is
 *  folded away. Line-count SSOT = docs/CONTEXT.md **result preview** ("take
 *  up to 3 tail lines of bash"): operator-ruled 3 lines; the write/edit
 *  window is independent of this constant. */
export const RESULT_PREVIEW_WINDOW = 3;

/** Write-create preview overflow label: `+N more lines` (N = hidden line
 *  count). The human-readable contract pins the English form (see
 *  docs/CONTEXT.md write create preview / fence display cap); the fence
 *  32-line cap and the create 10-line cap share this label so the two
 *  render paths (markdown fence / html) and the completed-state preview no
 *  longer each keep their own wording. */
export function previewOverflowLabel(hiddenLineCount: number): string {
  return `+${hiddenLineCount} more lines`;
}

/** Semantic alias for the write-create overflow label. Kept as a
 *  distinct name so completed-preview call sites read the intent; bytes are
 *  identical to `previewOverflowLabel` (same SSOT function). */
export const writePreviewOverflowLabel = previewOverflowLabel;

/** Result-preview overflow label: `… +N 行` (N = hidden line count) —
 *  aligned in intent with the write/edit overflow (hides the tail line
 *  count), but the pinned UI form is `… +N 行` with the marker on the first
 *  line, surfacing to the reader that test summaries / git results usually
 *  land at the end. */
export function resultPreviewOverflowLabel(hiddenLineCount: number): string {
  return `… +${hiddenLineCount} 行`;
}

/** Tool-result preview (bash / skill, i.e. subprocess output). The live path
 *  reads the `run.stdout / run.stderr` side-channels; the history path
 *  projects through `toolResultTextMap` onto the bash JSON envelope's
 *  `output` field. ANSI passthrough: escape sequences are kept; they are
 *  stripped only for the emptiness check and the overflow line count, while
 *  row content passes through unchanged.
 *
 *  Boundaries (pinned contract):
 *   - empty / all-whitespace / empty-after-ANSI-strip → `{ kind: "empty" }`;
 *   - keep the last RESULT_PREVIEW_WINDOW lines (cap 3), with a leading
 *     `+N` marker for overflow;
 *   - a single line shows as one line (no forced 3-line format);
 *   - ANSI sequences count by stripped width (`string-width` handles ANSI
 *     natively), and truncation must never split a sequence mid-way — this
 *     holds naturally because lines are never re-clipped in-row (row
 *     truncation counts lines, not visual width);
 *   - failure coloring is applied by the render layer wrapping ToolSummaryRow
 *     in an error-color token; the preview text itself is unchanged ("on
 *     failure the content still shows, tinted red as a whole"). */
export type ResultPreview =
  | { readonly kind: "empty" }
  | {
      readonly kind: "result";
      readonly lines: readonly string[];
      readonly hiddenLineCount: number;
    };

const EMPTY_RESULT_PREVIEW: ResultPreview = { kind: "empty" };

/** Take the tail N rows + overflow count. lines.length <= N → pass through in full. */
function takeTailWindow(lines: readonly string[]): {
  readonly visible: readonly string[];
  readonly hiddenLineCount: number;
} {
  if (lines.length <= RESULT_PREVIEW_WINDOW) {
    return { visible: lines, hiddenLineCount: 0 };
  }
  const tail = lines.slice(lines.length - RESULT_PREVIEW_WINDOW);
  return {
    visible: tail,
    hiddenLineCount: lines.length - RESULT_PREVIEW_WINDOW,
  };
}

/** Single source: decide whether output that may contain ANSI deserves a
 *  preview block. Empty / all-whitespace / empty-after-strip → treated as
 *  empty (no blank block rendered). */
function isRenderableOutput(s: string): boolean {
  if (s.length === 0) return false;
  // Whole input blank: visible chars are only whitespace / newlines / ANSI sequences.
  const stripped = stripAnsi(s);
  if (stripped.trim().length === 0) return false;
  // Empty after ANSI strip (theoretically covered above; kept in case ANSI sequences alone fill the input).
  if (stripped.length === 0) return false;
  return true;
}

export type CompletedToolPreview =
  | { readonly kind: "empty" }
  | {
      /** write create preview: first 10 body lines + `+N more lines`. */
      readonly kind: "code";
      readonly lines: readonly string[];
      readonly hiddenLineCount: number;
    }
  | {
      /** edit diff preview: this change's diff, **untruncated**. */
      readonly kind: "diff";
      readonly rows: readonly DiffLine[];
      readonly hiddenLineCount: number;
    }
  | {
      /** Squeeze mode: when the view is crowded by multiple writes /
       *  subagents, write/edit keep only the title line
       *  `Wrote N lines to <path>` and the body preview yields entirely
       *  (not truncated — removed). */
      readonly kind: "squeeze";
      readonly line: string;
    };

const EMPTY_COMPLETED_PREVIEW: CompletedToolPreview = { kind: "empty" };

function splitContentLines(content: string): readonly string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

/** Visible-window truncation (used **only for write create preview**; edit diffs are never truncated). */
function truncateWindow<T>(items: readonly T[]): {
  readonly visible: readonly T[];
  readonly hiddenLineCount: number;
} {
  if (items.length <= WRITE_CREATE_PREVIEW_WINDOW) {
    return { visible: items, hiddenLineCount: 0 };
  }
  return {
    visible: items.slice(0, WRITE_CREATE_PREVIEW_WINDOW),
    hiddenLineCount: items.length - WRITE_CREATE_PREVIEW_WINDOW,
  };
}

function resolveWriteEditPair(
  name: string,
  rec: Record<string, unknown>,
  opts?: {
    readonly oldContent?: string;
    readonly newContent?: string;
  }
): { readonly oldContent: string; readonly newContent: string } | null {
  let oldContent = opts?.oldContent;
  let newContent = opts?.newContent;
  if (oldContent === undefined || newContent === undefined) {
    if (name === "edit_file") {
      const o = rec.old_str;
      const n = rec.new_str;
      if (typeof o !== "string" || typeof n !== "string") return null;
      oldContent = o;
      newContent = n;
    } else if (name === "write_file") {
      const c = rec.content;
      if (typeof c !== "string") return null;
      // No side-channel old content → treat as new file (pure adds). The
      // history path has no pre-write disk content (meta is dropped at the
      // model boundary); this assumption is only overturned when the caller
      // explicitly passes oldContent.
      if (oldContent === undefined) oldContent = "";
      newContent = c;
    } else {
      return null;
    }
  }
  return { oldContent, newContent };
}

function hasPreviewPath(rec: Record<string, unknown>): boolean {
  return typeof rec.path === "string" && rec.path.length > 0;
}

/**
 * Completed-state write/edit preview classification:
 *  - **new file** (write_file with empty old content) → `kind: "code"`,
 *    first 10 body lines + `+N more lines` (`WRITE_CREATE_PREVIEW_WINDOW`);
 *  - **overwrite / edit_file** → `kind: "diff"`, this change's diff is
 *    **untruncated** (hiddenLineCount always 0; the create 10-line cap never
 *    applies to diffs);
 *  - **squeeze** (caller explicitly declares the view is crowded, e.g. side-
 *    by-side subagents) → `kind: "squeeze"`, the body preview yields and only
 *    the title line `Wrote N lines to <path>` remains (assembled by the
 *    caller).
 *
 *  Non write/edit, missing path, empty body (no diff rows and no new-file
 *  content) → `{ kind: "empty" }`. Never reads the workspace; authoritative
 *  data = input + side-channel old/newContent.
 */
export function completedToolPreview(
  name: string,
  input: unknown,
  opts?: {
    /** Old content before writing to disk (write_file overwrite detection → diff baseline). */
    readonly oldContent?: string;
    readonly newContent?: string;
    /** Squeeze: the view is crowded by multiple writes / subagents → the
     *  body preview yields entirely. **Not wired yet**: squeeze is a
     *  permission, not a hard requirement — the main session defaults to the
     *  code/diff branches; with no caller passing this value the branch is
     *  unreachable until crowding signals (multi-write in one turn /
     *  subagents crowding the view) reach the render layer. */
    readonly squeezed?: boolean;
  }
): CompletedToolPreview {
  if (name !== "write_file" && name !== "edit_file") {
    return EMPTY_COMPLETED_PREVIEW;
  }
  const rec = inputRecord(input);
  if (!hasPreviewPath(rec)) return EMPTY_COMPLETED_PREVIEW;
  if (opts?.squeezed === true) {
    return {
      kind: "squeeze",
      line: squeezeWriteSummary(input, opts.newContent),
    };
  }
  const pair = resolveWriteEditPair(name, rec, opts);
  if (pair === null) return EMPTY_COMPLETED_PREVIEW;
  if (name === "write_file" && pair.oldContent === "") {
    const { visible, hiddenLineCount } = truncateWindow(
      splitContentLines(pair.newContent)
    );
    if (visible.length === 0) return EMPTY_COMPLETED_PREVIEW;
    return { kind: "code", lines: visible, hiddenLineCount };
  }
  // Edits/overwrites draw this change's diff, untruncated (hiddenLineCount always 0).
  const rows = toolPreviewRows(name, rec, 0, {
    oldContent: pair.oldContent,
    newContent: pair.newContent,
  });
  if (rows.length === 0) return EMPTY_COMPLETED_PREVIEW;
  return { kind: "diff", rows, hiddenLineCount: 0 };
}

/**
 * Unbounded DiffLine helper (not the production UI SSOT): edit_file /
 * write_file call `computeDiff` to produce the full `DiffLine[]`. Other
 * tools / no content → empty array. Production completed-state previews go
 * through `completedToolPreview` (create keeps code lines; diff is truncated
 * from this function's result); tests still use this to lock the whole-file
 * green diff for write_file create.
 *
 * `opts.oldContent / opts.newContent` (side-channel): live run-completion
 * events carry full pre/post-write file content (strictly separated from the
 * model's tool_result) → exact diff. Absent (persisted history, meta dropped
 * at the model boundary) falls back to intent-diff:
 *  - edit_file: fragment diff of input.old_str / input.new_str;
 *  - write_file: old treated as empty string → pure adds;
 *  - all other tools: empty array.
 */
export function toolPreviewRows(
  name: string,
  input: unknown,
  _cols: number,
  opts?: {
    readonly oldContent?: string;
    readonly newContent?: string;
  }
): readonly DiffLine[] {
  if (name !== "edit_file" && name !== "write_file") return [];
  const pair = resolveWriteEditPair(name, inputRecord(input), opts);
  if (pair === null) return [];
  return computeDiff(name, pair.oldContent, pair.newContent);
}

/** Squeeze title line: `Wrote N lines to <path>`. N = visible line count of
 *  this write's body; when `newContent` is absent (history without side-
 *  channel) N is omitted and only the path remains. */
export function squeezeWriteSummary(
  input: unknown,
  newContent?: string
): string {
  const rec = inputRecord(input);
  const path =
    typeof rec.path === "string" && rec.path.length > 0 ? rec.path : "?";
  if (typeof newContent !== "string" || newContent.length === 0) {
    return `Wrote to ${path}`;
  }
  return `Wrote ${countLines(newContent)} lines to ${path}`;
}

/** tool_use_id → is_error status map (exact tool_result pairing, SSOT). */
export function toolResultStatusMap(
  messages: ReadonlyArray<AnthropicNativeMessage>
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        map.set(block.tool_use_id, block.is_error === true);
      }
    }
  }
  return map;
}

/** One content block's joinable text: a `{type:"text", text:string}` block
 *  with non-empty text; anything else (null entries, other block types,
 *  malformed shapes) contributes nothing. */
function textOfContentPart(part: unknown): string | null {
  if (
    part !== null &&
    typeof part === "object" &&
    "type" in part &&
    (part as { type?: unknown }).type === "text" &&
    "text" in part &&
    typeof (part as { text?: unknown }).text === "string"
  ) {
    const t = (part as { text: string }).text;
    return t.length > 0 ? t : null;
  }
  return null;
}

/** tool_result text extraction (single implementation — the incremental
 *  index in tool-result-index.ts calls this same function, so the
 *  byte-equivalence contract is structural, not duplicated logic):
 *  - string content → passed through as-is unless empty (the common shape:
 *    bash JSON envelope / skill body);
 *  - AnthropicContentBlock[] → concatenate all text blocks in appearance
 *    order, skipping empty ones. The block shape appears on the ACI path:
 *    complex handler returns (e.g. structured objects) are encoded as
 *    AnthropicContentBlock[] via blocks; bash / skill use strings, so the
 *    string branch is what actually hits in practice.
 *  - neither string nor array (or nothing joinable) → null (consumers fall
 *    back to the empty preview).
 */
export function toolResultTextOf(content: unknown): string | null {
  if (typeof content === "string") {
    return content.length > 0 ? content : null;
  }
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    const t = textOfContentPart(part);
    if (t !== null) parts.push(t);
  }
  const joined = parts.join("");
  return joined.length > 0 ? joined : null;
}

/** tool_use_id → tool_result text map (full-build derivation oracle for
 *  historical result previews — production renders consume the incremental
 *  `syncToolIndex` result, which must stay byte-equivalent to this map). */
export function toolResultTextMap(
  messages: ReadonlyArray<AnthropicNativeMessage>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      const text = toolResultTextOf(block.content);
      if (text !== null) map.set(block.tool_use_id, text);
    }
  }
  return map;
}

/**
 * Project tool summary lines from the authoritative messages (resume
 * rendering / unit tests): assistant.tool_use produces rows, tool_result
 * backfills status by tool_use_id.
 */
export function projectToolLines(
  messages: ReadonlyArray<AnthropicNativeMessage>
): ReadonlyArray<ToolSummaryLine> {
  const statusMap = toolResultStatusMap(messages);
  const lines: ToolSummaryLine[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      const { detail } = summarizeToolCall(block.name, block.input);
      const hasResult = statusMap.has(block.id);
      const failed = statusMap.get(block.id) === true;
      lines.push({
        toolName: block.name,
        detail,
        status: !hasResult ? "unknown" : failed ? "failed" : "ok",
      });
    }
  }
  return lines;
}

// The running-bash prefix (BASH_RUNNING_PREFIX) and status-line assembly
// (formatToolStatusLine / formatLiveToolEvent) are implemented in
// src/shared/tool-line.ts (shared with the CLI), re-exported at the top.
