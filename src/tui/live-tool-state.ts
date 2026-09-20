/**
 * src/tui/live-tool-state.ts
 *
 * Live state of tool calls — a pure reducer driving the two-phase timeline
 * `tool_call_start` → running → postToolUse completion → ok/failed summary
 * line. An unmatched `post_tool_use` is never appended (that contract was
 * inverted from the archived version): completion renders from the history
 * `tool_result`, so no ghost failure lines appear.
 *
 * `tool_input_delta` events: running entries accumulate partialJson into
 * `partialInput` (a display-layer intermediate, rendered only by the running
 * summary line); on `post_tool_use` the authoritative full input overwrites
 * and **clears** partialInput, so no partial text survives into completion.
 *
 * Completed entries are **never deleted by the reducer** — whether a
 * successful read-only probe stays is decided by consumers (retract →
 * unanchored activity-block count; keep → tail tool card); see the
 * post_tool_use branch in `liveToolReduce`.
 *
 * Design:
 *  - State keeps insert order (`ReadonlyArray`) so ChatView renders in order;
 *  - `toolUseId` is the pairing anchor — provided by the streaming
 *    `tool_call_start`, and completion events must carry it; on an unmatched
 *    id the reducer returns prev (no structured entry appended). String live
 *    lines remain the caller's liveToolLines channel's job;
 *  - multiple tools per conversationId pair FIFO (the first unfinished
 *    running entry is marked by the first completion event), matching the
 *    serial harness loop;
 *  - `tool_input_delta` pairs strictly by `id` (not FIFO): later deltas may
 *    belong to earlier entries; only status === "running" entries are hit;
 *    unmatched / non-running → ignored (defensive: display events must not
 *    corrupt authoritative state).
 *  - Pure functions + Object.freeze discipline, same source as session-state.ts.
 */
import { isLiveNoise } from "./tool-settled.js";
import { formatLiveToolEvent, formatToolStatusLine } from "./tool-summary.js";

export type LiveToolStatus = "running" | "ok" | "failed";

export interface LiveToolRun {
  readonly id: string;
  readonly name: string;
  readonly status: LiveToolStatus;
  readonly input: unknown;
  /** Identity marker: how many draft segments were already sealed this turn.
   *  Absent (0 / omitted) → render above the first draft segment; N ≥ 1 →
   *  render below segment N, above segment N+1. The caller stamps it in event
   *  order at append time (an identity marker, not a counting anchor). */
  readonly draftEpoch?: number;
  /** Partial JSON text accumulated from `tool_input_delta` while running
   *  (display-layer intermediate). Set when running and deltas arrive;
   *  overwritten by the full input and cleared at completion (post_tool_use). */
  readonly partialInput?: string;
  /** Completion event's detail (an intermediate of formatLiveToolEvent); absent while running. */
  readonly detail?: string;
  /** Completion event's message (failure reason); absent while running. */
  readonly message?: string;
  /** Observation side-channel — pre-write file content; absent while running. */
  readonly oldContent?: string;
  /** Observation side-channel — post-write file content; absent while running. */
  readonly newContent?: string;
  /** Bash stdout bypass (ToolResultMeta.stdout), the source for the result-preview tail window. */
  readonly stdout?: string;
  /** Bash stderr bypass (ToolResultMeta.stderr), the source for the result-preview tail window. */
  readonly stderr?: string;
}

export type LiveToolEvent =
  | {
      readonly kind: "tool_call_start";
      readonly id: string;
      readonly name: string;
      /** Draft segments already sealed when this tool started (the interleaving
       *  basis, see LiveToolRun.draftEpoch). Default = 0. */
      readonly draftEpoch?: number;
    }
  | {
      /** Incremental tool input (partial_json arriving in pieces, passed
       *  through by the adapter via `HarnessStreamEvent`). Display layer only —
       *  the authoritative input still arrives whole via `post_tool_use`. */
      readonly kind: "tool_input_delta";
      readonly id: string;
      readonly partialJson: string;
    }
  | {
      readonly kind: "post_tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
      readonly ok: boolean;
      readonly detail?: string;
      readonly message?: string;
      /** Observation side-channel — pre-write file content. */
      readonly oldContent?: string;
      /** Observation side-channel — post-write file content. */
      readonly newContent?: string;
      /** Bash stdout bypass carried by the completion event; feeds the result-preview tail window. */
      readonly stdout?: string;
      /** Bash stderr bypass carried by the completion event; feeds the result-preview tail window. */
      readonly stderr?: string;
    };

/** Reducer: append running / mark completed → a new frozen array. */
export function liveToolReduce(
  prev: ReadonlyArray<LiveToolRun>,
  event: LiveToolEvent
): ReadonlyArray<LiveToolRun> {
  if (event.kind === "tool_call_start") {
    // Never overwrite an existing entry — a repeated id is treated as idempotent (defensive).
    if (prev.some((r) => r.id === event.id)) return prev;
    return Object.freeze([
      ...prev,
      Object.freeze({
        id: event.id,
        name: event.name,
        status: "running" as const,
        input: undefined,
        draftEpoch:
          typeof event.draftEpoch === "number" && event.draftEpoch > 0
            ? event.draftEpoch
            : undefined,
      }),
    ]);
  }
  // tool_input_delta: find the running entry by id and accumulate partialInput
  // (order preserved). Unmatched / non-running → ignored (defensive: display
  // deltas must not corrupt authoritative state).
  if (event.kind === "tool_input_delta") {
    const target = prev.find(
      (r) => r.id === event.id && r.status === "running"
    );
    if (target === undefined) return prev;
    return Object.freeze(
      prev.map((r) =>
        r === target
          ? Object.freeze({
              ...r,
              partialInput: (r.partialInput ?? "") + event.partialJson,
            })
          : r
      )
    );
  }
  // post_tool_use — the paired entry transitions to ok/failed. An unmatched
  // id (no tool_call_start / race) is ignored like an unmatched
  // tool_input_delta: completion renders from the history tool_result, and
  // appending would produce ghost failure lines.
  //
  // Completions always happen in place; the reducer never deletes. The old
  // `COMPACT_READONLY_TOOLS` direct deletion stacked with chat-view's
  // history-id filtering into a double delete — once a tool_use id was in
  // history (MessageBlocks hides title and preview per slot for successful
  // retracts) and the live array wiped it too, no surface on the frame
  // carried it. Where it lands is decided by consumers (retract → the
  // unanchored activity block's `called` count; keep / failed → the tail
  // tool card); the reducer no longer predicts the render surface.
  if (event.kind === "post_tool_use") {
    const target = prev.find((r) => r.id === event.id);
    if (target === undefined) return prev;
    return Object.freeze(
      prev.map((r) =>
        r === target
          ? Object.freeze({
              id: r.id,
              name: r.name,
              status: (event.ok ? "ok" : "failed") as LiveToolStatus,
              // draftEpoch was stamped at append time; the completion rebuild must keep it.
              draftEpoch: r.draftEpoch,
              input: event.input,
              // Completion overwrites with the authoritative full input and clears any partialInput residue.
              partialInput: undefined,
              detail: event.detail,
              message: event.message,
              oldContent: event.oldContent,
              newContent: event.newContent,
              stdout: event.stdout,
              stderr: event.stderr,
            })
          : r
      )
    );
  }
  return prev;
}

export type LiveTailSlot =
  | { readonly kind: "tools"; readonly runs: ReadonlyArray<LiveToolRun> }
  | { readonly kind: "draft"; readonly text: string };

/** Interleave tool groups with draft segments by draftEpoch. Empty drafts are
 *  skipped; tools whose epoch exceeds the segment count hang at the tail.
 *
 * Retract-class tools (read_file / grep / …) are **all** folded into the
 * unanchored activity block (block title + preview slot) and no longer get a
 * tail tool card — otherwise the block's preview slot would double-draw them.
 * keep / accent / failed runs still render as tail progress lines
 * (live-tool-preview), interleaved with drafts by draftEpoch.
 */
export function liveTailSlots(
  runs: ReadonlyArray<LiveToolRun>,
  segments: ReadonlyArray<string>
): ReadonlyArray<LiveTailSlot> {
  // Strip live noise first — the unanchored block carries it. web_search /
  // web_fetch are live signals, not noise, so they **stay** in the tail (they
  // render as real cards; while running live-tool-preview draws their title
  // line). Failed runs never enter the block (failure cuts across), they keep
  // going through tail `liveToolRunsBox`'s `[失败]` line. The test comes from
  // the single source `isLiveNoise` (no second classification table; same
  // SSOT as `appendLiveBlocks`).
  const tailRuns = runs.filter(
    (r) => r.status === "failed" || !isLiveNoise(r.name)
  );
  const maxEpoch = Math.max(
    0,
    ...tailRuns.map((r) => r.draftEpoch ?? 0),
    Math.max(0, segments.length - 1)
  );
  const slots: LiveTailSlot[] = [];
  for (let i = 0; i <= maxEpoch; i++) {
    const group = tailRuns.filter((r) => (r.draftEpoch ?? 0) === i);
    if (group.length > 0) slots.push({ kind: "tools", runs: group });
    const text = segments[i];
    if (typeof text === "string" && text.length > 0) {
      slots.push({ kind: "draft", text });
    }
  }
  return slots;
}

/** Active tool name: the name of the last status=running entry; none running →
 *  undefined. Pure derivation (no new state); under the serial harness loop
 *  the tail running entry is the current tool. Used by app.tsx's status bar
 *  (ContextBar suffix).
 *
 *  MCP names get special treatment: `mcp__<server>__<tool>` adds little in
 *  the bottom bar (the server is already visible in the MCP panel and the
 *  name carries a redundant prefix), so derivation shortens it to
 *  `<server>/<tool>` — the single render surface (ContextBar) reads it via
 *  activeToolNameOf, so upstream never needs to know the MCP protocol shape. */
export function activeToolNameOf(
  runs: ReadonlyArray<LiveToolRun>
): string | undefined {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (run !== undefined && run.status === "running") {
      return shortenMcpToolName(run.name);
    }
  }
  return undefined;
}

/**
 * Shorten `mcp__<server>__<tool>` to `<server>/<tool>`; non-MCP names pass
 * through unchanged. Kept a pure function (slice/indexOf, O(n)) so unit
 * tests drive it directly.
 */
export function shortenMcpToolName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const body = name.slice("mcp__".length);
  const sep = body.indexOf("__");
  if (sep === -1) return name;
  const server = body.slice(0, sep);
  const tool = body.slice(sep + "__".length);
  return `${server}/${tool}`;
}

/** Format a running entry — delegates to `formatToolStatusLine` (the
 *  tool-summary.ts SSOT). Normal tools → an English progress line with the
 *  `name` (e.g. `read_file`, with input highlights when present) or bash's
 *  `Running 1 shell command…`; subagent tools (spawn_subagent /
 *  subagent_result) no longer appear as a `▣ 子代理` line — subagent state is
 *  expressed by the two-line projection on the spawn card plus SubagentPanel,
 *  so formatToolStatusLine returns only `detail` (e.g. `explore running` /
 *  `general-purpose`) to avoid a dual render. */
export function formatRunningToolLine(run: LiveToolRun): string {
  return formatToolStatusLine({
    toolName: run.name,
    input: run.input,
    status: "running",
  });
}

/** Format a completed entry — delegates to `formatLiveToolEvent` →
 *  `formatToolStatusLine` (the single tool-summary.ts SSOT). Must use the
 *  LiveToolRun's precomputed detail (run.detail ?? ""), never recompute from
 *  run.input — a recomputation can differ byte-wise from the detail
 *  postToolUse stored in the reducer. `cols` passes through to
 *  formatLiveToolEvent; detail was already trimmed by the reducer at the same
 *  cols (otherwise cols goes unconsumed unless detail is empty and the
 *  internal summarizeToolCall runs). */
export function formatCompletedToolLine(
  run: LiveToolRun,
  cols?: number
): string {
  return formatLiveToolEvent({
    toolName: run.name,
    input: run.input,
    kind: run.status === "ok" ? "ok" : "failed",
    detail: run.detail ?? "",
    cols,
  });
}
