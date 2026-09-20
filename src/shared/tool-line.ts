/**
 * src/shared/tool-line.ts
 *
 * Human-readable tool-line SSOT: CLI and TUI share the same summary functions.
 * Two copies of the templates would drift, so the text layer lives in this
 * neutral module:
 *
 *   - depends only on `string-width` (no React / @opentui / TUI internals), so
 *     `src/cli/*` can import it safely — CLI → TUI imports would invert the
 *     layering;
 *   - `src/tui/tool-summary.ts` re-exports this module, keeping existing TUI
 *     call sites and tests/tui/* import paths unchanged;
 *   - line-shaping helpers (visualWidth / clipOneLine / clipOneLineVisual):
 *     moved here together with the summaries so both faces use one budget
 *     formula.
 *
 * Display contract (docs/CONTEXT.md `live tool line`): while running, an
 * English "name + key point" line (search=query, fetch=url, read=path,
 * grep=pattern); bash commands stay visible behind the
 * `Running 1 shell command…` prefix; thinking shows `Thinking…`.
 * There are no `[运行中]` ("running") / `[完成]` ("done") status brackets.
 */
import stringWidth from "string-width";

/** Visual column width (CJK / full-width characters count as 2 columns). */
export function visualWidth(s: string): number {
  return stringWidth(s);
}

/** Clip to one line by character count: collapse whitespace, truncate to
 *  `max` and append `…` when longer. */
export function clipOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Clip one line by **visual width** (CJK takes 2 columns). Guarantees the
 * result has `visualWidth <= maxWidth`; the ellipsis reserves 1 column.
 * Returns an empty string when maxWidth <= 0.
 */
export function clipOneLineVisual(s: string, maxWidth: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (maxWidth <= 0) return "";
  if (visualWidth(oneLine) <= maxWidth) return oneLine;
  const budget = maxWidth - 1;
  let acc = "";
  let w = 0;
  for (const ch of oneLine) {
    const cw = visualWidth(ch);
    if (w + cw > budget) break;
    acc += ch;
    w += cw;
  }
  return `${acc}…`;
}

const MAX_DETAIL = 80;
/** Chrome reserve (shape see `formatToolStatusLine`): the longest prefix is
 *  `[失败] ` ("failed") + the tool name; historically fixed at 12 columns (the old
 *  `[运行中] ` ("running") 9 + ` · ` 3 accounting, kept as a conservative constant after
 *  status brackets were dropped — tool names fit in this budget).
 *  Once detail is clipped the line never wraps; the running-bash prefix is
 *  clipped as a full line at the assembly site. */
const CHROME_RESERVE = 12;

function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};
}

function countLines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  return s.split("\n").length;
}

/** Detail clipping: with `cols`, clip by visual width (the line never
 *  wraps); otherwise legacy 80 characters. */
function clipDetail(s: string, name: string, cols: number | undefined): string {
  if (cols === undefined) return clipOneLine(s, MAX_DETAIL);
  const budget = Math.max(4, cols - visualWidth(name) - CHROME_RESERVE);
  return clipOneLineVisual(s, Math.min(MAX_DETAIL, budget));
}

/** Field-extraction helper: string field (missing → fallback), so each case
 *  need not repeat the same defense. */
function pickString(
  rec: Record<string, unknown>,
  key: string,
  fallback = "?"
): string {
  const v = rec[key];
  return typeof v === "string" ? v : fallback;
}

/** Field-extraction helper: number field (missing / non-finite → null). */
function pickNumber(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** LSP tools: shared "file[:line]" template (definition/references/hover/...). */
function lspAt(rec: Record<string, unknown>, name: string): string {
  const file = pickString(rec, "file");
  const line = pickNumber(rec, "line");
  return `LSP ${name.replace("lsp_", "")} ${file}${line !== null ? `:${line}` : ""}`;
}

/** Dedicated display label for subagent tools, set apart from ordinary tool
 *  lines (common agent convention: subagent invocations get their own visual,
 *  not the plain `name · detail` tool-line shape). Geometric glyph, no emoji. */
export const SUBAGENT_TOOL_LABEL = "子代理";

/** Subagent tool predicate: spawn_subagent (dispatch) + subagent_result (poll). */
export function isSubagentTool(name: string): boolean {
  return name === "spawn_subagent" || name === "subagent_result";
}

/** Subagent tool status glyph: running → ▣, ok → ✓, failed → ✗. */
export function subagentDisplayMark(kind: "running" | "ok" | "failed"): string {
  if (kind === "ok") return "✓";
  if (kind === "failed") return "✗";
  return "▣";
}

/** Catalog-role projection of the spawn tool input (same fallback as the
 *  card's two-line projection). */
export const SUBAGENT_ROLE_FALLBACK = "general-purpose";

/** Resolve the catalog id from a spawn_subagent tool_use input (`subagent_type` → `role` → fallback). */
export function resolveSubagentRoleFromInput(
  rec: Record<string, unknown>
): string {
  const fromType = pickString(rec, "subagent_type", "").trim();
  if (fromType.length > 0 && fromType !== "?") return fromType;
  const fromRole = pickString(rec, "role", "").trim();
  if (fromRole.length > 0 && fromRole !== "?") return fromRole;
  return SUBAGENT_ROLE_FALLBACK;
}

function spawnSubagentSettledSummary(rec: Record<string, unknown>): string {
  return resolveSubagentRoleFromInput(rec);
}

function spawnSubagentRunningSummary(rec: Record<string, unknown>): string {
  return `${resolveSubagentRoleFromInput(rec)} running`;
}

/** write_file summary: `Wrote <path> (N lines)`. N = line count of `content`
 *  (empty string → a real 0 lines, distinct from "unknown" while running). */
function wroteLinesSummary(rec: Record<string, unknown>): string {
  return `Wrote ${pickString(rec, "path")} (${countLines(rec.content)} lines)`;
}

/** edit_file summary: `Edited <path> (N → M lines)`. Line counts come from
 *  old_str / new_str themselves (the size of this change fragment, not the
 *  whole file) — the change content is carried by the edit diff preview, so
 *  the title line no longer squeezes in an old→new snippet. */
function editedFileSummary(rec: Record<string, unknown>): string {
  const all = rec.replace_all === true;
  const oldLines = countLines(rec.old_str);
  const newLines = countLines(rec.new_str);
  return `Edited ${pickString(rec, "path")}${all ? " (all)" : ""} (${oldLines} → ${newLines} lines)`;
}

/** Running write_file summary: path and line count appear only when **known**.
 *  While running the input is a streaming half-product — missing / non-string
 *  / empty `content` all mean "not arrived yet", not "the file has 0 lines",
 *  so only the path is drawn; if even `path` has not arrived → empty string
 *  (the caller falls back to the bare `write_file` line, no `Wrote ?`).
 *  Only an empty content in the settled state (summary) is a genuinely empty
 *  file, which still shows `(0 lines)`.
 *
 *  Running wording = the squeezed shape `Wrote <path> (<N> lines)`: coexists
 *  with the default preview — the preview draws the body, the line count
 *  stays on the title line; when subagents/many writes squeeze the view, the
 *  preview yields but the title line remains. */
function writeFileRunningSummary(r: Record<string, unknown>): string {
  const path = r.path;
  if (typeof path !== "string" || path.length === 0) return "";
  const content = r.content;
  if (typeof content !== "string" || content.length === 0)
    return `Wrote ${path}`;
  return `Wrote ${path} (${countLines(content)} lines)`;
}

/** Text display for one tool: summary + optional running summary. */
interface ToolSummaryDisplay {
  readonly summary: (rec: Record<string, unknown>) => string;
  /** Running summary (optional). Absent field = running and settled share the
   *  same text; tools that declare it have a settled summary containing a
   *  quantity that is only trustworthy once the input is complete (write_file
   *  line count) — while running the input is a streaming half-product, so
   *  that quantity must be omitted rather than shown as 0. */
  readonly runningSummary?: (rec: Record<string, unknown>) => string;
}

/** Tool → text summary lookup table (SSOT). Each entry returns un-clipped
 *  detail text.
 *
 *  Includes tools whose CLI side no longer has a "display registry" to query
 *  (session actions, MCP, and the five worktree-lifecycle tools) — summary
 *  text is single-sourced, so CLI/TUI cannot each keep a fallback.
 *  Display contract (docs/CONTEXT.md `live tool line`): detail is an English
 *  "tool name + key point of this call" (search=query, fetch=url, read=path,
 *  grep=pattern).
 *
 *  The five task-worktree lifecycle tools use their registered names in the
 *  human-readable line — the semantics are still task worktrees; the wording
 *  names only the action and the target id, no policy. */
export const TOOL_SUMMARIES: Readonly<Record<string, ToolSummaryDisplay>> = {
  write_file: {
    summary: wroteLinesSummary,
    runningSummary: writeFileRunningSummary,
  },
  bash: { summary: (r) => pickString(r, "command", "") },
  edit_file: { summary: editedFileSummary },
  read_file: { summary: (r) => `Read ${pickString(r, "path")}` },
  grep: { summary: (r) => `Search ${pickString(r, "pattern")}` },
  glob: { summary: (r) => `Glob ${pickString(r, "pattern")}` },
  // web / memory / search tools: focus the first key field, keep raw JSON out.
  web_search: { summary: (r) => `Search ${pickString(r, "query")}` },
  web_fetch: { summary: (r) => `Fetch ${pickString(r, "url")}` },
  memory_recall: { summary: (r) => `Recall ${pickString(r, "query")}` },
  memory_save: { summary: (r) => `Remember ${pickString(r, "title")}` },
  tool_search: {
    summary: (r) => {
      const query = pickString(r, "query", "");
      if (query.length > 0) return `Tool search ${query}`;
      if (Array.isArray(r.names) && r.names.length > 0) {
        const firstName = r.names[0];
        return `Tool search ${typeof firstName === "string" ? firstName : r.names.length}`;
      }
      return "Tool search ?";
    },
  },
  skill: { summary: (r) => `skill ${pickString(r, "name")}` },
  spawn_subagent: {
    summary: spawnSubagentSettledSummary,
    runningSummary: spawnSubagentRunningSummary,
  },
  subagent_result: { summary: (r) => `Poll ${pickString(r, "task_id")}` },
  // LSP tool set: 10 tools. 8 share the file[:line] template; documentSymbol / workspaceSymbol have their own shapes.
  lsp_definition: { summary: (r) => lspAt(r, "lsp_definition") },
  lsp_references: { summary: (r) => lspAt(r, "lsp_references") },
  lsp_hover: { summary: (r) => lspAt(r, "lsp_hover") },
  lsp_go_to_implementation: {
    summary: (r) => lspAt(r, "lsp_go_to_implementation"),
  },
  lsp_prepare_call_hierarchy: {
    summary: (r) => lspAt(r, "lsp_prepare_call_hierarchy"),
  },
  lsp_incoming_calls: { summary: (r) => lspAt(r, "lsp_incoming_calls") },
  lsp_outgoing_calls: { summary: (r) => lspAt(r, "lsp_outgoing_calls") },
  lsp_diagnostics: { summary: (r) => lspAt(r, "lsp_diagnostics") },
  lsp_document_symbol: {
    summary: (r) => `LSP documentSymbol ${pickString(r, "file")}`,
  },
  lsp_workspace_symbol: {
    summary: (r) => `LSP workspaceSymbol ${pickString(r, "query")}`,
  },
  // bash_output / bash_stop / todo_write / list_mcp_resources /
  // read_mcp_resource / query_trace: nothing previewable — summary only, model view unchanged.
  bash_output: {
    summary: (r) => `Bash output ${pickString(r, "task_id", "?")}`,
  },
  bash_stop: { summary: (r) => `Stopped ${pickString(r, "task_id", "?")}` },
  todo_write: { summary: (r) => `Todo ${pickString(r, "id", "?")}` },
  list_mcp_resources: { summary: () => "MCP resources" },
  read_mcp_resource: {
    summary: (r) => `MCP resource ${pickString(r, "uri", "?")}`,
  },
  query_trace: { summary: () => "Trace query" },
  // The five task-worktree lifecycle tools: registered names in the human line, action + target id.
  "create-worktree": { summary: () => "Created worktree" },
  "enter-worktree": {
    summary: (r) => `Entered worktree ${pickString(r, "conversationId", "?")}`,
  },
  "exit-worktree": { summary: () => "Exited worktree" },
  "remove-worktree": {
    summary: (r) => `Removed worktree ${pickString(r, "conversationId", "?")}`,
  },
  "list-worktrees": { summary: () => "Listed worktrees" },
};

/**
 * Argument summary for one tool call. `cols` = terminal width: when given,
 * detail is clipped by visual width so "chrome + tool name + detail" fits one
 * line (narrow terminals never wrap, line accounting does not drift).
 *
 * `opts.running` = this call's input is still a streaming half-product: tools
 * that declare a `runningSummary` use it, omitting quantities that are only
 * trustworthy once the input is complete (write_file line count).
 * Undeclared → same text as settled, behavior unchanged.
 *
 * Lookup table (TOOL_SUMMARIES) dispatch: one summarizer per tool, bodies
 * kept ≤10 lines / cyclomatic complexity ≤10; unknown tools fall to a
 * `(name)` placeholder (2026-08-13 user feedback: tool folds must not expose
 * the full input JSON).
 */
export function summarizeToolCall(
  name: string,
  input: unknown,
  cols?: number,
  opts?: { readonly running?: boolean }
): { detail: string } {
  const rec = inputRecord(input);
  const clip = (s: string): string => clipDetail(s, name, cols);
  const declared = TOOL_SUMMARIES[name];
  if (declared !== undefined) {
    const summarize =
      opts?.running === true && declared.runningSummary !== undefined
        ? declared.runningSummary
        : declared.summary;
    return { detail: clip(summarize(rec)) };
  }
  // Genuinely unknown tool: show only the name placeholder, never dump the
  // full input JSON (2026-08-13 user feedback: tool folds must not stringify
  // all input args).
  return { detail: clip(`(${name})`) };
}

/**
 * Summary for the partial JSON text of a running call. Best-effort
 * `JSON.parse` on the accumulating `partialJson`:
 *  - parse succeeds → `summarizeToolCall` in running semantics: registry
 *    entries declaring a `runningSummary` omit not-yet-trustworthy
 *    quantities — `content` inside a partial may simply have "not arrived",
 *    so it must not render as `(0 lines)`;
 *  - parse fails (incomplete JSON, e.g. `{"command":"l`) or primitive shape
 *    (null / number / boolean) → show the raw text clipped via `clipDetail`
 *    (single source, visual-width discipline);
 *  - empty string → empty string.
 *
 * Masking note: a partial may contain secret-shaped text, but this increment
 * only serves a display-layer intermediate state — only the authoritative
 * complete input after finishing reaches the model; this is visual clipping
 * only, no output mask wired in (low risk, keeps the single-line clip simple).
 *
 * Consumers: TUI live line + CLI stream preview sink (CLI has no
 * input-complete event and must derive detail from the accumulated
 * partialJson — the same function guarantees byte-identical text on both).
 */
export function summarizePartialInput(
  name: string,
  partialJson: string,
  cols?: number
): string {
  if (partialJson.length === 0) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(partialJson);
  } catch {
    parsed = undefined;
  }
  // Incomplete JSON (parse failed) or primitive shape (null / number /
  // boolean — tool arguments are semantically object/array only) → show the
  // raw text clipped. Clipping goes through clipDetail as single source (same
  // visual-width discipline as the settled summary, no budget-formula drift).
  if (
    parsed === undefined ||
    (typeof parsed !== "object" && typeof parsed !== "boolean")
  ) {
    return clipDetail(partialJson, name, cols);
  }
  return summarizeToolCall(name, parsed, cols, { running: true }).detail;
}

/** Human prefix for the running bash line: `Running 1 shell command…`. When
 *  the command is visible it is appended as ` · <command>` (the separator only
 *  appears with a detail — no dangling ` ·` when input has not arrived or the
 *  command is empty).
 *  Progress streams like `1%`→`100%` update **in place on the same line**
 *  (progress tick), not appended line by line into the bubble — this function
 *  produces one line, history keeps no percentages. */
export const BASH_RUNNING_PREFIX = "Running 1 shell command…";

/** Tool status line text SSOT.
 *
 *  Both history and live tool status lines are assembled through this function
 *  (CLI stream preview shares it):
 *  - ordinary tool, success: `name · detail` (no status bracket; state is
 *    expressed by color/glyph);
 *  - ordinary tool, running: **live tool line** — an English process line,
 *    `name · detail` (detail is the English key point from TOOL_SUMMARIES);
 *    running shell semantics only appear in the `Running N shell command(s)…`
 *    segment before the bash command, which itself stays visible;
 *  - failure: `[失败] name · detail` ("failed"; the failure overlay is out of scope here).
 *  - subagent tools (spawn_subagent / subagent_result) have their own shape:
 *    detail only (glyph / identity line are carried by the spawn card's
 *    two-line projection + SubagentPanel).
 *
 *  `[运行中]` / `[完成]` ("running"/"done") prefixes are retired overall — running is expressed
 *  by the English process line, settled by color/glyph. cols is passed through
 *  (same discipline as `summarizeToolCall(cols)`): when given, detail is
 *  clipped by visual width to fit one line; absent → legacy 80-char truncation
 *  (byte-compatible with existing callers). `detail` is an optional override:
 *  when the assembly layer's complete event carries a precomputed detail
 *  (liveToolReducer landing), the explicit detail skips the `summarizeToolCall`
 *  recompute, keeping it byte-identical to reducer state.detail. */
export function formatToolStatusLine(opts: {
  readonly toolName: string;
  readonly input: unknown;
  readonly status: "running" | "ok" | "failed";
  readonly detail?: string;
  readonly cols?: number;
}): string {
  const detail =
    opts.detail ??
    summarizeToolCall(opts.toolName, opts.input, opts.cols, {
      running: opts.status === "running",
    }).detail;
  // Subagent tools (spawn_subagent / subagent_result) no longer render as a
  // `▣ 子代理 · detail` ("subagent") live/history card — subagent state is expressed by the
  // spawn card's two-line projection (`{role} running...` + preview / done)
  // plus SubagentPanel (task list under the input box), avoiding dual render.
  // The tool card keeps only `detail` (spawn → `{role} running` / `{role}`;
  // task body lives only in SubagentPanel; subagent_result → `Poll <task_id>`).
  if (isSubagentTool(opts.toolName)) {
    return detail;
  }
  if (opts.status === "failed") {
    if (detail.length === 0) return `[失败] ${opts.toolName}`;
    return `[失败] ${opts.toolName} · ${detail}`;
  }
  if (opts.status === "running" && opts.toolName === "bash") {
    // Running bash: `Running 1 shell command… · <command>` — the prefix gives
    // the shell semantics, the command stays visible ("keep running commands
    // visible"). Empty detail (input not arrived) → prefix only (the process
    // line still stands; it does not degrade to the bare tool name), no `· ?`
    // and no dangling separator (single-line visual-width clipping is
    // backstopped below too).
    if (detail.length === 0) return BASH_RUNNING_PREFIX;
    const joined = `${BASH_RUNNING_PREFIX} · ${detail}`;
    return opts.cols !== undefined
      ? clipOneLineVisual(joined, Math.max(1, opts.cols))
      : joined;
  }
  if (detail.length === 0) return opts.toolName;
  return `${opts.toolName} · ${detail}`;
}

/** Summary line for the runtime postToolUse event (appears one by one while a
 *  turn is in progress). Delegates to `formatToolStatusLine` — the live
 *  complete line / history complete line / running line share one text
 *  contract, no copy-pasted templates.
 *
 *  Byte rules:
 *   - ordinary tool, success: detail non-empty → `name · detail`; empty →
 *     `name`. The completion prefix is gone (state shown by color/glyph), so
 *     no stray leading space remains.
 *   - ordinary tool, failure: `[失败] name · detail` / `[失败] name` ("failed"; the
 *     explicit prefix is kept).
 *   - subagent tools (spawn_subagent / subagent_result) own shape:
 *     `✓|✗ 子代理 · detail` / `✓|✗ 子代理` ("subagent"; the glyph already shows state, no [xxx] prefix).
 *
 *  The kind parameter stays compatible with history call sites: only `"ok"`
 *  is recognized (→ ok); any other value is treated as failed.
 *
 *  `detail` is an optional override: when the assembly layer's complete event
 *  carries a precomputed detail (liveToolReducer landing), the explicit detail
 *  skips the summarizeToolCall recompute, keeping the complete-event render
 *  byte-identical to reducer state.detail.
 *
 *  `cols` pass-through: when given, detail is clipped by visual width (same
 *  discipline as summarizeToolCall); absent → legacy 80-char truncation
 *  (byte-compatible with existing callers). */
export function formatLiveToolEvent(opts: {
  readonly toolName: string;
  readonly input: unknown;
  readonly kind: string;
  /** Explicit detail override; when provided, skips the summarizeToolCall recompute. */
  readonly detail?: string;
  /** Terminal width (optional): when given, detail is clipped by visual width; absent → legacy 80-char truncation. */
  readonly cols?: number;
}): string {
  const status: "ok" | "failed" = opts.kind === "ok" ? "ok" : "failed";
  return formatToolStatusLine({
    toolName: opts.toolName,
    input: opts.input,
    status,
    detail: opts.detail,
    cols: opts.cols,
  });
}

/** Streaming fold line text (always `Thinking…`, no live seconds — see the
 *  think-fold.ts module comment). It lives here because the CLI's "thinking"
 *  spinner and the TUI fold line must share one text; importing src/tui from
 *  the CLI would invert the layering. */
export function formatThinkingLive(): string {
  return "Thinking…";
}
