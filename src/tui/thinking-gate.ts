/**
 * Thinking override gate, pure functions (no React dependency, unit-testable
 * standalone). Extracted from TuiApp.runTurnOnce, where the override pass-through
 * decision (stateChanged / override computation) was inlined in a component
 * closure and hard to test.
 *
 * Semantics: pass a per-turn override only when the user actually changed the
 * thinking state relative to the env defaultThinking baseline; otherwise
 * return undefined -> use cached deps (behavior unchanged).
 */

import type {
  ThinkingEffortWire,
  WireThinkingOverride,
} from "../session-api/contract.js";

/** Shape of env `thinking` + `thinkingEffort` (minimal projection of TuiAppProps.defaultThinking). */
export interface DefaultThinkingShape {
  readonly mode: "off" | "adaptive";
  readonly effort: ThinkingEffortWire;
}

/** Gate pure function: current thinking state vs env default -> wire
 *  override (undefined = use cached deps). When enabled=false the effort
 *  dimension is already covered by enabled, so effort need not be compared
 *  (defaultEffort may be ""). */
export function computeThinkingOverride(
  defaultThinking: DefaultThinkingShape | undefined,
  enabled: boolean,
  effort: ThinkingEffortWire
): WireThinkingOverride | undefined {
  const defaultMode = defaultThinking?.mode ?? "off";
  const defaultEffort = defaultThinking?.effort ?? "";
  const stateChanged =
    enabled !== (defaultMode === "adaptive") ||
    (enabled && effort !== defaultEffort);
  if (!stateChanged) return undefined;
  return enabled ? { mode: "adaptive", effort } : { mode: "off" };
}

/** Thinking level display label: "" (not explicitly set) -> "auto", others
 *  as-is. Single source for the former `effort || "auto"` duplication
 *  (/effort invalid-level hint + infoLines). */
export function formatEffortLabel(effort: ThinkingEffortWire): string {
  return effort === "" ? "auto" : effort;
}
