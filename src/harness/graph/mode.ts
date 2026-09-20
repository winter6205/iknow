/**
 * Graph mode overlay — the single point for the session-level orchestration
 * toggle (ADR-0030).
 *
 * Graph mode is **not** a `PermissionMode`: authorization (ask / auto / plan)
 * and orchestration (in-graph or not) are two axes; entangling them pollutes
 * policy and makes the coordinator split harder later. `PERMISSION_MODES` is
 * untouched — Graph exists only as a boolean overlay in this module.
 *
 * Four responsibilities, all shared by the three entry points (chat / TUI /
 * serve) — one copy per entry point would drift:
 *
 * - **Value domain**: `parseGraphFlag` — `/graph` and settings share one set
 *   of boolean literals.
 * - **Initial-value chain**: `resolveGraphMode` — settings > default off.
 *   Graph is an optional overlay; by default tasks still use one-shot
 *   `spawn_subagent` without entering a graph, so the default must be off.
 *   Deliberately **no env branch**: product SSOT = Shift+Tab + `/graph` +
 *   settings; an env gate was already rejected once (ADR-0014).
 * - **Mutable holder**: `GraphModeContext` mirrors `PermissionModeContext` —
 *   REPL / TUI / serve flip it in place without rebuilding the engine.
 * - **Tri-state wheel + command semantics**: `nextShiftTabAgentMode` /
 *   `applyGraphCommand` — `Default → Auto → Graph → Default`; `/graph on|off`
 *   is the non-TTY equivalent.
 *
 * Boundary: takes only the `PermissionMode` value domain and the shared
 * key-guard from `harness/permission/modes.js` (graph → permission is
 * one-way; permission never learns about graph, Graph never enters
 * `PERMISSION_MODES`). Does not import config/ — the settings segment is
 * received as the structural projection `GraphModeDefaults` to avoid a
 * reverse harness → config dependency.
 */

import {
  DEFAULT_PERMISSION_MODE,
  isShiftTabKey,
  modeLabel,
  nextShiftTabMode,
  type PermissionMode,
  type PermissionModeContext,
  type ShiftTabKeyShape,
} from "../permission/modes.js";

/** Session-level graph toggle snapshot. */
export interface GraphModeState {
  /** Whether the graph orchestration overlay is on. Off = tasks use one-shot `spawn_subagent` as usual. */
  readonly enabled: boolean;
}

/** Default off — the product default for the optional graph overlay. */
export const GRAPH_MODE_DEFAULT_STATE: GraphModeState = Object.freeze({
  enabled: false,
});

/**
 * Structural projection of the `settings.graph` segment (assignable from the
 * `IknowSettingsGraph` shape). Structural instead of an import — see
 * "Boundary" in the file header.
 */
export interface GraphModeDefaults {
  readonly enabled?: boolean;
}

const TRUE_LITERALS: ReadonlySet<string> = new Set(["on", "true", "1", "yes"]);
const FALSE_LITERALS: ReadonlySet<string> = new Set([
  "off",
  "false",
  "0",
  "no",
]);

/**
 * Boolean value domain for `/graph` arguments and settings:
 * `on|true|1|yes` / `off|false|0|no`, trimmed and case-insensitive; booleans
 * pass through unchanged (the settings segment is already boolean).
 *
 * Invalid values return `undefined` instead of throwing — consistent with
 * the settings discipline "invalid value falls back, never throws"; the
 * caller uses it to fall back one level (invalid settings → default off).
 */
export function parseGraphFlag(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if (TRUE_LITERALS.has(v)) return true;
  if (FALSE_LITERALS.has(v)) return false;
  return undefined;
}

/** Initial value at assembly time: settings > default off. */
export function resolveGraphMode(opts?: {
  readonly settings?: GraphModeDefaults;
}): GraphModeState {
  return Object.freeze({
    enabled: opts?.settings?.enabled ?? GRAPH_MODE_DEFAULT_STATE.enabled,
  });
}

/**
 * Mutable holder — `/graph` and Shift+Tab flip the same toggle in place
 * within a running session without rebuilding the engine. Shape mirrors
 * `PermissionModeContext`.
 */
export interface GraphModeContext {
  /** Current snapshot (frozen; replacing the snapshot never mutates the holder). */
  readonly get: () => GraphModeState;
  readonly setEnabled: (enabled: boolean) => void;
}

export function createGraphModeContext(
  initial: GraphModeState = GRAPH_MODE_DEFAULT_STATE
): GraphModeContext {
  let current: GraphModeState = Object.freeze({ ...initial });
  return Object.freeze({
    get: () => current,
    setEnabled: (enabled: boolean) => {
      current = Object.freeze({ ...current, enabled });
    },
  });
}

// ── Shift+Tab tri-state wheel (ADR-0030) ───────────────────────────────────

/** Joint snapshot of the two axes: authorization + orchestration overlay. */
export interface AgentModeSnapshot {
  readonly permission: PermissionMode;
  readonly graph: boolean;
}

/** Human-readable label (TUI / REPL status line). Graph overrides the permission label. */
export type AgentModeLabel = "Default" | "Plan Mode" | "Auto" | "Graph";

export function agentModeLabel(snapshot: AgentModeSnapshot): AgentModeLabel {
  return snapshot.graph ? "Graph" : modeLabel(snapshot.permission);
}

/**
 * Shift+Tab tri-state wheel `Default → Auto → Graph → Default` (ADR-0030).
 *
 * - Press in Graph → back to Default (orchestration off + authorization
 *   reset to default); the wheel closes.
 * - Press in Auto → enter Graph, **permission frozen at full_auto** —
 *   entering a graph never changes ask/auto semantics.
 * - Otherwise (default / plan) → Auto. `plan` reuses the existing ruling of
 *   `nextShiftTabMode`: not a station on the wheel, one Shift+Tab goes
 *   straight to full_auto without opening graph (a plan session should not
 *   be nudged two stations forward by mistake).
 */
export function nextShiftTabAgentMode(
  current: AgentModeSnapshot
): AgentModeSnapshot {
  if (current.graph) {
    return { permission: DEFAULT_PERMISSION_MODE, graph: false };
  }
  if (current.permission === "full_auto") {
    return { permission: "full_auto", graph: true };
  }
  return { permission: nextShiftTabMode(current.permission), graph: false };
}

/**
 * Apply one Shift+Tab keystroke across the two holders (permission + graph).
 *
 * Shares the `isShiftTabKey` guard with the single-axis version
 * (permission/modes.ts is the SSOT), so TUI (opentui Key) and REPL
 * (node:readline Key) stay same-sourced.
 *
 * Missing `permission` → short-circuit no-op (early ask/serve paths).
 * Missing `graph` → degrade to the existing single-axis permission wheel
 * (entry points without the overlay see zero behaviour change).
 */
export function applyShiftTabAgentModeFlip(opts: {
  readonly key: ShiftTabKeyShape | undefined;
  readonly permission: PermissionModeContext | undefined;
  readonly graph: GraphModeContext | undefined;
  readonly onFlip: (next: AgentModeSnapshot) => void;
}): boolean {
  if (!isShiftTabKey(opts.key)) return false;
  const permission = opts.permission;
  if (!permission) return false;
  const graph = opts.graph;
  const current: AgentModeSnapshot = {
    permission: permission.get(),
    graph: graph?.get().enabled ?? false,
  };
  const next = graph
    ? nextShiftTabAgentMode(current)
    : { permission: nextShiftTabMode(current.permission), graph: false };
  permission.set(next.permission);
  graph?.setEnabled(next.graph);
  opts.onFlip(next);
  return true;
}

// ── `/graph` command (non-TTY equivalent) ──────────────────────────────────

/** Three-state `/graph` command (shared by the three entry points). */
export type GraphCommand =
  | { readonly kind: "status" }
  | { readonly kind: "set"; readonly enabled: boolean }
  | { readonly kind: "usage" };

export const GRAPH_MODE_USAGE_TEXT = "Usage: /graph [on|off|status]";

/**
 * Parse `/graph` args. Empty / `status` → query; `on|off` → flip; anything
 * else (including extra args) → usage.
 *
 * Extra args are not silently ignored: in `/graph on extra` the user thinks
 * `extra` means something; executing as plain `on` would be guessing for
 * them.
 */
export function parseGraphCommand(args: ReadonlyArray<string>): GraphCommand {
  const head = (args[0] ?? "").trim().toLowerCase();
  if (head === "" && args.length <= 1) return { kind: "status" };
  if (head === "status" && args.length === 1) return { kind: "status" };
  if (args.length === 1) {
    const enabled = parseGraphFlag(head);
    if (enabled !== undefined) return { kind: "set", enabled };
  }
  return { kind: "usage" };
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

/** Status echo (one identical line for all three entry points). */
export function formatGraphStatus(state: GraphModeState): string {
  return `图模式: ${onOff(state.enabled)}（下一次 run() 装配生效）`;
}

/** Execution result: `ok=false` means nothing changed; `text` is the user-visible line. */
export interface GraphCommandResult {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * Execute one `/graph` command against the holder and produce the
 * user-visible text.
 *
 * All three entry points call this: chat prints to stdout/stderr, TUI shows
 * a notice, serve puts `text` in the response body for the web to render —
 * different carriers, same semantics and wording.
 */
export function applyGraphCommand(
  ctx: GraphModeContext,
  args: ReadonlyArray<string>
): GraphCommandResult {
  const cmd = parseGraphCommand(args);
  switch (cmd.kind) {
    case "status":
      return { ok: true, text: formatGraphStatus(ctx.get()) };
    case "set":
      ctx.setEnabled(cmd.enabled);
      return {
        ok: true,
        text: `图模式已切换: ${onOff(cmd.enabled)}（下一次 run() 装配生效）`,
      };
    case "usage":
      return { ok: false, text: GRAPH_MODE_USAGE_TEXT };
  }
}

/**
 * Tokenize free-text args (the remainder segment of `/graph on` from " on ").
 * serve's wire sends an already-split array; TUI / web use this to extract
 * the remainder from a raw line.
 */
export function splitGraphArgs(raw: string): string[] {
  const trimmed = raw.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}
