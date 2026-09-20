/**
 * src/tui/subagent-kill.ts
 *
 * Ctrl+X force-kills the subagent on the focused chrome-focus row; with no
 * subagent focus it is a no-op (specs/agent-control-surface.md).
 *
 * Why a separate module: app.tsx is huge and under complexity pressure — key
 * handling keeps exactly one call site there, and this pure function is
 * unit-tested without rendering a TUI.
 *
 * The only row → taskId mapping: reuse the panel's live row order —
 * `projectSubagentLines`' live prefix (`src/tui/subagent-panel.tsx`) only
 * increments its index for starting/running rows, and failed/completed lines
 * can only append after the live ones. So `liveSubagents(subagents)[row]`
 * and the panel's `focusedRow` address the same row; focus and kill never
 * compute separate orders. The predicate itself is the shared single source
 * `isLiveSubagent` (`src/tui/subagent-message-lines.ts`) — panel, projection
 * and kill no longer each restate
 * `state === "starting" || state === "running"` literals.
 *
 * Boundaries (empty + stale rows):
 *   - focus is not subagent (input / graph) → no-op;
 *   - row is not a non-negative integer (NaN / negative / fraction / undefined) → no-op;
 *   - row ≥ live count (stale focus: the subagent just reached a terminal
 *     state before the next clamp tick) → no-op;
 *   - no live subagents → no-op.
 *   All of the above return `{ kind: "none" }` — never throw, never fabricate a taskId.
 *
 * Where the parent turn's cancellation comes from: `abortTask` first settles
 * the task's in-flight `waitFor` with `SubAgentAbortError` (the manager's
 * per-task rejection set), then aborts the worker subprocess (SIGTERM with a
 * 5s SIGKILL backstop). The parent foreground
 * `waitFor(taskId, …, ctx.signal)` converges without needing its own abort
 * signal: the handler converts the typed abort into a `ToolExecutionError`
 * (operator-kill text) and the executor passes it through because the
 * caller's signal was not aborted — the model-visible attribution is "killed
 * by the operator", clearly distinct from the wall-clock-timeout message and
 * the strict `"cancelled"` of Ctrl+C / `/quit`. Ordering contract: rejection
 * precedes SIGTERM — otherwise the worker's SIGTERM cleanup would write back
 * a `reason:"timeout"` envelope and mislabel an operator kill as a wall-clock
 * expiry. This module only maps "focused row → the right taskId"; the chain
 * itself belongs to the manager.
 */
import type { SubagentInfo } from "../harness/subagent/manager.js";
import type { ChromeFocus } from "./chrome-focus.js";
import { isLiveSubagent } from "./subagent-message-lines.js";

/** Same source as projectSubagentLines' live prefix: starting / running only. */
export function liveSubagents(
  subagents: ReadonlyArray<SubagentInfo>
): ReadonlyArray<SubagentInfo> {
  return subagents.filter(isLiveSubagent);
}

export type KillSubagentDispatch =
  | { readonly kind: "none" }
  | { readonly kind: "kill"; readonly taskId: string; readonly role?: string };

/**
 * Pure Ctrl+X dispatch: focused row → that live subagent's taskId; else no-op.
 * Does not call abort — it only decides "who to kill" (the caller hands the
 * taskId to bridge.abortSubagentTask).
 */
export function dispatchKillFocusedSubagent(
  focus: ChromeFocus,
  subagents: ReadonlyArray<SubagentInfo>
): KillSubagentDispatch {
  if (focus.kind !== "subagent") return { kind: "none" };
  const row = focus.row;
  if (!Number.isInteger(row) || row < 0) return { kind: "none" };
  const target = liveSubagents(subagents)[row];
  if (target === undefined) return { kind: "none" };
  return target.role !== undefined
    ? { kind: "kill", taskId: target.taskId, role: target.role }
    : { kind: "kill", taskId: target.taskId };
}
