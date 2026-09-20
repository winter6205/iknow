/**
 * Human- and model-readable notifications for graph-mode toggles (SSOT).
 *
 * Toggle notices land at the tail of messages — after the system-segment
 * injection was removed, this "switch hint" is the only channel through which
 * the model can learn the graph state. Two static texts (pinned by template):
 *
 *  - Graph-on notice = the old orchestration-guidance text (merged in) plus
 *    an explicit "graph mode is now on" opening. Reading it, the model can
 *    start using run_graph, but the run() assembly snapshot of the same round
 *    is still the old one — existing ADR-0030 behaviour, not broken here.
 *
 *  - Graph-off notice = one "graph mode is now off" line plus a static
 *    pointer to spawn_subagent (the tool surface still lists run_graph and
 *    the handler rejects, so spawn_subagent is the working path).
 *
 *  Same single-line static shape as ADR-0028's `<agent_status>` (wrapped in
 *  `<graph_mode>...</graph_mode>` tags for model grep and human read-side
 *  filtering). Text is byte-constant within a session (no per-turn
 *  interpolation) → the backend's passive prefix cache only accepts
 *  tail-appends, as intended.
 *
 *  Whether a toggle fired is judged by loop-engine holding the "previous
 *  graph snapshot": appendMessage only when this round's assembly snapshot
 *  differs; equal → zero appends. build-engine takes no part (it only wires
 *  the seam, never imposes logic); loop-engine closes the loop.
 */

export type GraphModeChange = "on" | "off";

/** Official frame open/close tag literals (ADR-0112: the outbound-projection
 *  TAG-escape roster is assembled from these constants; the three notification
 *  constants start with OPEN_TAG and end with CLOSE_TAG — pinned by a lock test). */
export const GRAPH_MODE_OPEN_TAG = "<graph_mode>";
export const GRAPH_MODE_CLOSE_TAG = "</graph_mode>";

/**
 * Human-side filter predicate: all three graph-presence notifications are
 * host-injected machine-readable envelopes, not operator-typed input — the
 * TUI must never render them as ❯ bubbles. Same discipline and shape as
 * `isAgentStatusText` (`src/harness/agent-status.ts`): the producer declares
 * the predicate at home, consumers (TUI / CLI) share it, so no consumer
 * re-implements the prefix check.
 *
 * Shape = the whole user message starts with `<graph_mode>` (all three
 * constants are bounded by it; the model greps the same form). Leading
 * whitespace is tolerated (consistent with agent_status).
 */
export function isGraphModeText(text: string): boolean {
  return text.trimStart().startsWith(GRAPH_MODE_OPEN_TAG);
}

/** Graph-on notification (SSOT; loop-engine's single source). */
export const IKNOW_GRAPH_MODE_ON_NOTIFICATION =
  "<graph_mode>Graph mode is now on. run_graph is available alongside spawn_subagent — call it when the work splits into pieces that depend on each other. Declare the whole shape in one call: every node gets an `id`, a self-contained `task`, and the `deps` it waits for. Nodes whose deps are all satisfied run in parallel; a node starts only once every node it depends on has finished, and its task arrives with those results appended. If a node fails, the nodes downstream of it come back skipped while unrelated branches keep running, and the call still returns one report covering every node. Read that report and decide what to do next. Keep using spawn_subagent for a single task, or for several tasks with no ordering between them — a graph with no edges buys nothing over parallel spawns.</graph_mode>";

/** Graph-off notification (SSOT). */
export const IKNOW_GRAPH_MODE_OFF_NOTIFICATION =
  "<graph_mode>Graph mode is now off. run_graph is still listed but will reject calls — use spawn_subagent instead (single task, or several tasks in parallel via multiple spawn_subagent calls in one turn).</graph_mode>";

/**
 * Map one toggle decision to a single-line user message text (SSOT; content
 * comes from the two constants above).
 *
 *  `change === "on"` → graph-on notice (includes orchestration guidance);
 *  `change === "off"` → graph-off notice.
 *
 *  Text format follows ADR-0028's status-bar `<agent_status>...</agent_status>`
 *  single-line static shape: the whole thing is one user message; the model
 *  read surface = the static read side.
 */
export function renderGraphModeChangeNotification(
  change: GraphModeChange
): string {
  return change === "on"
    ? IKNOW_GRAPH_MODE_ON_NOTIFICATION
    : IKNOW_GRAPH_MODE_OFF_NOTIFICATION;
}

/**
 * ADR-0081 — short "graph still on" presence line for the current round
 * (SSOT). Once per `run()`, not once per model call.
 *
 *  Purpose: while the holder is still on, this `run()` appends this line to
 *  the messages tail once — so within the round the model can read a short
 *  presence line in addition to the tool description (resident, never
 *  toggled with mode). The short line never replaces the long ON/OFF toggle
 *  notices (those still fire only on the flip beat), and never enters system
 *  / run_graph receipts / <agent_status>.
 *
 *  Differences from the long ON notice:
 *   - No full orchestration manual; it only names the semantic difference
 *     between the two tools (dependent splits → run_graph, a live graph that
 *     may carry marked failure edges; single tasks → spawn_subagent), so the
 *     model knows the graph is still on and which tool to pick this round.
 *   - Clearly shorter than the long ON text, keeping session bytes constant
 *     (KV-cache tail-append compatible + model-grep friendly), no per-turn
 *     interpolation.
 *   - Cadence = once per `run()`; long ON/OFF = once per flip beat (on
 *     includes orchestration guidance, off the shutdown hint).
 *
 *  Implementation: loop-engine's `appendGraphModePresence` seam decides
 *  before each model call via `assembly.enabled()`: seam absent /
 *  enabled() === false / the long ON was just posted on this beat / this run
 *  already settled → zero appends; otherwise the append seam records it into
 *  pendingInjected.
 */
export const IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION =
  "<graph_mode>Graph mode is still on. Prefer run_graph when the work splits into pieces with dependencies between them (declare the whole shape in one call — it's a live graph, not a single spawn, and may include marked failure edges); use spawn_subagent for a single task or for several independent tasks.</graph_mode>";
