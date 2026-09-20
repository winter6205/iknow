/**
 * src/tui/chrome-focus.ts
 *
 * chrome-focus reducer (pure function module).
 *
 * Sole responsibility: one abstraction owns the focus state
 * `input` | `subagent(row)` | `graph`, moving between the three rings with
 * Down/Up. The reducer only knows down/up (every other key is a no-op — it
 * never grabs Tab / Enter / Escape / plain characters; those stay with the
 * prompt-input / slash / graph-chrome reducers and components).
 *
 * Wiring is not in this file — hooking useKeyboard up to this reducer happens
 * in the app layer. What ships here is only the pure functions + unit tests
 * covering 5 classes (empty / negative / overflow / concurrent / exception).
 *
 * Complexity discipline: ≤4 nesting per branch, ≤60 lines per function,
 * cyclomatic ≤10.
 *
 * Invariants:
 *  - subagent row clamps to [0, subagentCount-1]; out of range → back to input;
 *  - missing snapshot (hasSnapshot=false) → the graph ring is unreachable / if
 *    it holds focus, back to input;
 *  - subagentCount=0 → the subagent ring is unreachable / if it holds focus,
 *    back to input.
 */
export type ChromeFocus =
  | { readonly kind: "input" }
  | { readonly kind: "subagent"; readonly row: number }
  | { readonly kind: "graph" };

export interface ReduceChromeFocusInput {
  readonly focus: ChromeFocus;
  readonly key: string;
  /** Currently visible subagent row count (from the projectSubagentLines projection). */
  readonly subagentCount: number;
  /** Whether a run_graph snapshot exists. */
  readonly hasSnapshot: boolean;
}

export interface ReduceChromeFocusResult {
  readonly focus: ChromeFocus;
}

/** Defense: negative / NaN → 0; semantics stay clear, pinned by unit tests. */
function safeCount(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function clampRow(row: number, count: number): number {
  if (count <= 0) return 0;
  if (row < 0) return 0;
  if (row >= count) return count - 1;
  return row;
}

/**
 * Pure-function reducer for the chrome-focus state machine.
 *
 * Design points:
 *  - only `down` / `up` move the cursor; other keys return the current focus
 *    verbatim (no key grabbing).
 *  - **no-op semantics**: branches that leave focus unchanged return the very
 *    `input.focus` reference (not a fresh object) —— callers detect change via
 *    the identity comparison `next.focus !== chromeFocus`; reference equality
 *    → no setState / no extra re-render. The onLeaveToChrome contract (no
 *    reachable ring → return false, PromptInput keeps its state) relies on this too.
 *  - the subagent ring's row count is projected by the caller (same source as
 *    projectSubagentLines); the reducer only sees the count, not which subagent
 *    a row is — the app.tsx side assembles it during wiring.
 *  - the graph ring is a single node (no row selection — one graph chrome row).
 *  - exceptions / boundaries: missing snapshot / empty panel / negative row
 *    → skip that ring; focus returns to the previous reachable ring
 *    (input is the floor).
 */
export function reduceChromeFocus(
  input: ReduceChromeFocusInput
): ReduceChromeFocusResult {
  const count = safeCount(input.subagentCount);
  const key = input.key;

  if (input.focus.kind === "input") {
    if (key === "down") {
      if (count > 0) return { focus: { kind: "subagent", row: 0 } };
      if (input.hasSnapshot) return { focus: { kind: "graph" } };
      return { focus: input.focus };
    }
    return { focus: input.focus };
  }

  if (input.focus.kind === "subagent") {
    // Exception / empty panel: the current subagent ring is unreachable → back to input.
    if (count === 0) return { focus: { kind: "input" } };
    const row = clampRow(input.focus.row, count);
    if (key === "down") {
      if (row + 1 < count) return { focus: { kind: "subagent", row: row + 1 } };
      if (input.hasSnapshot) return { focus: { kind: "graph" } };
      return { focus: input.focus };
    }
    if (key === "up") {
      if (row === 0) return { focus: { kind: "input" } };
      return { focus: { kind: "subagent", row: row - 1 } };
    }
    return { focus: input.focus };
  }

  // graph
  if (!input.hasSnapshot) return { focus: { kind: "input" } };
  if (key === "up") {
    if (count > 0) return { focus: { kind: "subagent", row: count - 1 } };
    return { focus: { kind: "input" } };
  }
  return { focus: input.focus };
}
