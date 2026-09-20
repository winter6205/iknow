/** @jsxImportSource @opentui/react */
/**
 * src/tui/live-tool-preview.tsx
 *
 * Live tool tail rendering + single row-account SSOT (migrated from
 * archive/tui-ink/src/live-tool-preview.tsx, ink → OpenTUI):
 * `liveToolPreviewTextLines` is shared by the renderer (liveToolPreviewBox)
 * and the row account (liveToolPreviewRows), so the two never drift (parity).
 *
 * Exception = the subagent-card path (specs/tui-subagent-transcript-live.md):
 * on a card hit, rendering and text lines both move to `SubagentCardView` /
 * card-level projection; this module only dispatches (`cardIfLive`) —— that
 * branch is always 2 rows, both sides stay same-source.
 *
 * Running state with `partialInput` (accumulated tool_input_delta) renders an
 * English progress line `name · <partial summary>` (bash:
 * `Running 1 shell command… · <command>`; on successful parse it goes through
 * summarizeToolCall, incomplete JSON is truncated verbatim); no delta → the
 * base progress line (bash keeps only the shell prefix). Summaries come from
 * `summarizePartialInput` (tool-summary.ts); the row account stays 1 row.
 * Running lines deliberately carry no localized status bracket.
 *
 * write_file / edit_file render no `content` body while running (including
 * incomplete JSON); after completion `completedToolPreview` truncates the
 * code or diff.
 *
 * Row-account basis: box render = 1 status row + N preview rows (diff lines
 * folded by width, visible rows only). `liveToolPreviewRows` returns the
 * box's actual physical row count.
 */
import type { ReactNode } from "react";
import type { SubagentCardLines } from "./subagent-message-lines.js";
import { SubagentCardView } from "./subagent-card-view.js";
import type { LiveToolRun } from "./live-tool-state.js";
import {
  formatCompletedToolLine,
  formatRunningToolLine,
} from "./live-tool-state.js";
import {
  completedToolPreview,
  formatToolStatusLine,
  resultToolPreview,
  summarizePartialInput,
  summarizeToolCall,
  clipOneLineVisual,
  clipErrorLine,
  visualWidth,
} from "./tool-summary.js";
import { deriveSlot, settledColorToFg } from "./tool-settled.js";
import {
  CompletedToolPreviewView,
  completedToolPreviewTextLines,
  resultPreviewTextLines,
} from "./completed-tool-preview-view.js";
import { tuiPalette } from "./theme.js";

function isWriteEditTool(name: string): boolean {
  return name === "write_file" || name === "edit_file";
}

function writeEditRunningLine(run: LiveToolRun, cols: number): string {
  const partial = run.partialInput;
  if (partial === undefined || partial.length === 0) {
    return formatRunningToolLine(run);
  }
  try {
    const parsed: unknown = JSON.parse(partial);
    if (typeof parsed !== "object" || parsed === null) {
      return formatRunningToolLine(run);
    }
    const rec = parsed as Record<string, unknown>;
    const path =
      typeof rec.path === "string" && rec.path.length > 0 ? rec.path : "?";
    // Running write/edit: `Wrote <path> (N lines)` / `Edited <path>` —— the
    // line count appears only once the streamed content is a non-empty string
    // (missing in a half-streamed object ≠ 0 lines). Never stream old/new/
    // content bodies into the status line.
    const summary =
      run.name === "write_file"
        ? summarizeToolCall("write_file", parsed, cols, { running: true })
            .detail
        : clipOneLineVisual(
            `Edited ${path}`,
            Math.min(80, Math.max(4, cols - visualWidth(run.name) - 12))
          );
    return summary.length === 0
      ? formatRunningToolLine(run)
      : formatToolStatusLine({
          toolName: run.name,
          input: parsed,
          status: "running",
          detail: summary,
          cols,
        });
  } catch {
    // EXIT: incomplete write/edit JSON → keep the running summary line;
    // do not stream content or dump raw partial JSON.
    return formatRunningToolLine(run);
  }
}

/**
 * Running status line: with partialInput deltas → English progress line
 * `name · <partial summary>` (bash prefix `Running 1 shell command…`);
 * empty / no delta → base progress line (formatRunningToolLine). Summary
 * single source = summarizePartialInput; the row account stays 1 row.
 * write/edit never stream content into this line. Assembling the
 * partial-bearing shape is delegated to formatToolStatusLine (tool-summary
 * SSOT), same source as the historical ToolSummaryRow —— byte-identical,
 * no duplicated template.
 */
function runningLine(run: LiveToolRun, cols: number): string {
  if (isWriteEditTool(run.name)) return writeEditRunningLine(run, cols);
  const partial = run.partialInput;
  if (partial === undefined || partial.length === 0) {
    return formatRunningToolLine(run);
  }
  const summary = summarizePartialInput(run.name, partial, cols);
  if (summary.length === 0) return formatRunningToolLine(run);
  return formatToolStatusLine({
    toolName: run.name,
    input: run.input,
    status: "running",
    detail: summary,
    cols,
  });
}

function completedPreviewOf(run: LiveToolRun) {
  return completedToolPreview(run.name, run.input, {
    oldContent: run.oldContent,
    newContent: run.newContent,
  });
}

/** Live path: completed tool result preview (bash). Uses the run.stdout /
 *  run.stderr bypass (no dependence on historical tool_result
 *  deserialization). Missing preview declaration / field → empty. Failed
 *  runs keep the preview off —— no long stderr piled under a dim ⎿
 *  (failures render one short error line only). */
function resultPreviewOf(run: LiveToolRun) {
  if (run.status === "running") {
    return { kind: "empty" as const };
  }
  if (run.status === "failed") {
    return { kind: "empty" as const };
  }
  return resultToolPreview(run.name, run.input, {
    stdout: run.stdout,
    stderr: run.stderr,
  });
}

/** Failure cross-cut: a failed run never takes the card projection (it goes
 *  through the existing failure overlay); otherwise a non-empty card is this
 *  run's card-level two rows.
 *
 *  One function instead of two `&&` chains: both the render side
 *  (`liveToolPreviewBox`) and the text side (`liveToolPreviewTextLines`) need
 *  this predicate; written twice, any drift would reintroduce inconsistencies
 *  like "the row account says 2 rows, the render draws 3". */
function cardIfLive(
  run: LiveToolRun,
  card: SubagentCardLines | null | undefined
): SubagentCardLines | null {
  if (run.status === "failed") return null;
  return card ?? null;
}

/**
 * Once the session has any spawn join card, the live tail stops drawing
 * un-joined `spawn_subagent` running rows (CONTEXT **subagent card live**: a
 * `running...` card and the fallback `general-purpose running` row must never
 * sit side by side). No join card → keep as-is, the first running row stays
 * visible.
 */
export function filterLiveToolRunsAgainstSpawnCards(
  runs: ReadonlyArray<LiveToolRun>,
  cards: ReadonlyMap<string, SubagentCardLines> | undefined
): ReadonlyArray<LiveToolRun> {
  if (cards === undefined || cards.size === 0) return runs;
  return runs.filter((run) => {
    if (run.name !== "spawn_subagent" || run.status !== "running") return true;
    return cards.has(run.id);
  });
}

/**
 * Plain text lines of the live tool box ([status row, ...preview rows]),
 * shared by the row account + flat projection. The completed preview is
 * same-source with `completedToolPreview` (code or truncated diff); the
 * result preview goes through `resultToolPreview` (bash stdout/stderr tail).
 */
export function liveToolPreviewTextLines(
  run: LiveToolRun,
  cols: number,
  /** specs/tui-subagent-transcript-live.md: when this run is a spawn card that
   *  joined a subagent, the card's text lines come from the card-level
   *  projection (row 1 `{role} running...`, row 2 the dim preview; a green
   *  `✓ Done` is appended under the completed overview). Absent → byte-for-byte
   *  as before (non-spawn tools, polled cards, un-joined spawn cards all take
   *  the existing path). */
  card?: SubagentCardLines | null
): ReadonlyArray<string> {
  const live = cardIfLive(run, card);
  if (live !== null) {
    return live.doneLine === undefined
      ? [live.roleLine, live.detailLine]
      : [live.roleLine, live.detailLine, live.doneLine];
  }
  if (run.status === "running") {
    return [runningLine(run, cols)];
  }
  const out: string[] = [formatCompletedToolLine(run, cols)];
  if (run.status === "failed") {
    // Failed: one short truncated error line, no dim preview. Data source =
    // run.message ?? run.detail (live bypass fields) —— intentionally forked
    // from the historical message-blocks.failureTextOf JSON-envelope parsing:
    // live events have not gone through tool_result encoding, there is no
    // envelope to parse; the historical side only has persisted text, no bypass
    // fields. Byte-equal error text is not promised across the two sides
    // (shared truncation discipline = clipErrorLine).
    const err = clipErrorLine(run.message ?? run.detail ?? "", cols);
    if (err.length > 0) out.push(err);
    return out;
  }
  for (const l of completedToolPreviewTextLines(
    completedPreviewOf(run),
    cols
  )) {
    out.push(l);
  }
  for (const l of resultPreviewTextLines(resultPreviewOf(run))) {
    out.push(l);
  }
  return out;
}

/** Physical row count of the live tool box (status 1 row + visible preview rows).
 *  card hit → live 2 rows (identity + overview), completed 3 rows (`✓ Done`
 *  appended under the overview); the row account is same-source with
 *  `liveToolPreviewTextLines` (the 2-row path comes from it too, parity holds). */
export function liveToolPreviewRows(
  run: LiveToolRun,
  cols: number,
  card?: SubagentCardLines | null
): number {
  return liveToolPreviewTextLines(run, cols, card).length;
}

/** Live tool runs container: one blank line between adjacent cards.
 *
 *  The keep-class title cards share the historical MessageBlocks
 *  `withBlockSpacing` rhythm (1 line between adjacent blocks) —— the
 *  historical side handles spacing via message-blocks' block wrapper.
 *  Spacing is inserted only between cards; the first card gets no top blank
 *  line (matching the historical first block getting no top margin).
 *  Process-group summary rows are not keep cards and do not take this
 *  spacing (this container only receives runs; summary rows are drawn by
 *  the caller).
 *
 *  `memo` does not apply: the call convention passes a fresh runs array each
 *  frame, and the container itself is stateless.
 *
 *  `cards` (specs/tui-subagent-transcript-live.md): toolUseId → card-level
 *  two-row projection (produced by `subagentCardLinesMap`). Looked up exactly
 *  by `run.id` —— missing map / missing entry → that card keeps its existing
 *  shape, never borrowing another worker's preview. */
export function liveToolRunsBox(
  runs: ReadonlyArray<LiveToolRun>,
  cols: number,
  cards?: ReadonlyMap<string, SubagentCardLines>
): ReactNode {
  const visible = filterLiveToolRunsAgainstSpawnCards(runs, cards);
  return (
    <box flexDirection="column" width={cols}>
      {visible.map((run, i) => (
        <box
          key={`${run.id}-card`}
          flexDirection="column"
          marginTop={i === 0 ? 0 : 1}
        >
          {liveToolPreviewBox(run, cols, cards?.get(run.id))}
        </box>
      ))}
    </box>
  );
}

/** Live tool tail box: status line + truncated completed-state preview.
 *  Running shows the status line only (with partialInput deltas it includes
 *  `· <partial summary>`); write/edit draw no content while running. Colors
 *  consume deriveSlot's color tokens —— failure is error, accent-class
 *  successes are accent; dim no longer tints every completed row.
 *
 *  `card` (specs/tui-subagent-transcript-live.md): on a hit this spawn card
 *  draws `SubagentCardView`'s two rows (row 1 `{role} running...`, row 2 the
 *  dim preview / green `✓ Done`); the whole card no longer goes through the
 *  existing title + preview combination; a failed card never takes the card
 *  (the failure cross-cut holds at the box layer too). */
export function liveToolPreviewBox(
  run: LiveToolRun,
  cols: number,
  card?: SubagentCardLines | null
): ReactNode {
  const live = cardIfLive(run, card);
  if (live !== null) {
    return (
      <box key={run.id} flexDirection="column">
        <SubagentCardView card={live} />
      </box>
    );
  }
  const running = run.status === "running";
  const status = running
    ? runningLine(run, cols)
    : formatCompletedToolLine(run, cols);
  const preview = running ? null : completedPreviewOf(run);
  const resultPreview = running ? undefined : resultPreviewOf(run);
  const slot = deriveSlot(run.name, {
    running,
    failed: run.status === "failed",
  });
  const fg = settledColorToFg(slot.color, {
    default: tuiPalette.text,
    accent: tuiPalette.accent,
    error: tuiPalette.error,
  });
  // Accent-class titles (skill / worktree lifecycle) get bold —— same source
  // as message-blocks.ToolSummaryRow (byte-identical across live + history).
  const isAccentTitle = slot.color === "accent";
  return (
    <box key={run.id} flexDirection="column">
      {isAccentTitle ? (
        <text fg={fg} wrapMode="none">
          <b>{status}</b>
        </text>
      ) : (
        <text fg={fg} wrapMode="none">
          {status}
        </text>
      )}
      {preview !== null && (
        <CompletedToolPreviewView
          preview={preview}
          cols={cols}
          resultPreview={resultPreview}
        />
      )}
    </box>
  );
}
