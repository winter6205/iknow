/**
 * Host drain: between the run() boundaries of the chat / tui / serve
 * entrypoints, condense terminal-state tasks buffered in SubAgentManager
 * into user-message strings, appended to the next run()'s priorMessages.
 *
 * Key discipline:
 *   - empty manager (undefined) / no tasks → return "" immediately;
 *   - any terminal task → return the concatenated result immediately, never
 *     waiting for other running ones;
 *   - only running → return "" immediately, no polling at the run() boundary;
 *   - **drain never throws**: manager buffer or condensation failures
 *     silently return "";
 *   - does not modify manager buffer state (buffer is cached permanently
 *     until shutdown);
 *   - per-task condensation format:
 *       ## Sub-agent <taskId> result: <summary>
 *
 *       [result]
 *     multiple tasks separated by blank lines.
 *
 * Implementation constraint: consume results only via drainCompleted();
 * never call listActive() / waitFor(); never mutate the manager buffer.
 *
 * The ask entrypoint has no manager → this function is not called → no
 * behavior change.
 */
import type { SubagentManagerDrainView } from "./manager-registry.js";
import {
  projectParentVisibleEnvelope,
  type SubAgentEnvelope,
} from "./envelope.js";

/**
 * Drain message text prefix (SSOT). The per-task condensation format is
 * `${SUBAGENT_DRAIN_PREFIX}${taskId} result: ${summary}\n\n${result}`;
 * display projection layers (session-api turn projection / rewind boundary
 * projection) use `isSubagentDrainText` to recognize and skip drain
 * messages, so format and predicate stay same-sourced.
 */
export const SUBAGENT_DRAIN_PREFIX = "## Sub-agent ";

/** Trimmed text starting with the drain prefix is a drain message — drain messages do not form a turn and are not slice boundaries. */
export function isSubagentDrainText(text: string): boolean {
  return text.trim().startsWith(SUBAGENT_DRAIN_PREFIX);
}

export interface DrainPendingSubagentsOpts {
  /** Restrict the drain to workers owned by one interactive session. */
  readonly conversationId?: string;
  /** Deprecated, kept for caller compatibility; host drain does not poll. */
  readonly pollMs?: number;
  /** Deprecated, kept for caller compatibility; host drain does not wait. */
  readonly timeoutMs?: number;
}

export interface SubagentManagerCloseoutView extends SubagentManagerDrainView {
  readonly listActive: () => ReadonlyArray<string>;
  readonly waitFor: (
    taskId: string,
    timeoutMs?: number,
    signal?: AbortSignal
  ) => Promise<SubAgentEnvelope>;
}

export interface DrainPendingSubagentsBeforeShutdownResult {
  /** Terminal handoffs that can be delivered to the next parent-model run. */
  readonly text: string;
  /** Active tasks that never produced a deliverable terminal envelope. */
  readonly undeliveredTaskIds: readonly string[];
}

export interface DrainPendingSubagentsBeforeShutdownOpts {
  /** Receives wait/drain failures; the helper itself remains non-throwing. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Terminal entries → parent-visible condensed text. Exported only so the
 * terminal-channel mutual-exclusion test can construct the **persisted
 * state** (a subscriber registering before publish gets mailbox history
 * replayed immediately; see the late-subscriber usage in
 * tests/subagent/foreground-drain-exclusion.test.ts).
 */
export function formatDrainedResults(
  entries: ReadonlyArray<{
    readonly taskId: string;
    readonly envelope: SubAgentEnvelope;
  }>
): string {
  return entries
    .map(({ taskId, envelope }) => {
      const visible = projectParentVisibleEnvelope(envelope);
      const locator =
        visible.tmp_root !== undefined && visible.tmp_root.length > 0
          ? `\n\ntask_id: ${visible.task_id ?? taskId}\ntmp_root: ${visible.tmp_root}`
          : "";
      const roster =
        visible.product_roster !== undefined &&
        visible.product_roster.length > 0
          ? `\n\nproduct_roster: ${visible.product_roster.join(", ")}`
          : "";
      return `${SUBAGENT_DRAIN_PREFIX}${taskId} result: ${visible.summary}\n\n${visible.result}${locator}${roster}`;
    })
    .join("\n\n");
}

/**
 * Condense terminal subagent results into a single user-message string.
 *
 * Background host drain only consumes already-completed buffer entries.
 * Returns "" when:
 *   - manager is undefined (ask-entry shape);
 *   - manager has no tasks or no terminal tasks;
 *   - the manager's read-only drain / condensation fails (never throws).
 *
 * `_opts` is kept only for existing-caller compatibility; running workers
 * never trigger a wait.
 */
export async function drainPendingSubagents(
  manager: SubagentManagerDrainView | undefined,
  opts?: DrainPendingSubagentsOpts
): Promise<string> {
  if (manager === undefined) return "";

  try {
    return formatDrainedResults(manager.drainCompleted(opts?.conversationId));
  } catch (error) {
    // EXIT: host drain is intentionally non-throwing; "" is the documented
    // no-result/degraded channel, while terminal wake failures are reported
    // separately by host-wake.
    void error;
    return "";
  }
}

/**
 * Close out a manager before a CLI session rebinds to a replacement engine.
 *
 * Running wait:false workers are waited on before shutdown so their terminal
 * envelopes remain deliverable. A failed wait is still followed by shutdown,
 * but its task id is returned for an explicit host warning; no failure is
 * silently represented as a successful handoff.
 */
export async function drainPendingSubagentsBeforeShutdown(
  manager: SubagentManagerCloseoutView | undefined,
  opts: DrainPendingSubagentsBeforeShutdownOpts = {}
): Promise<DrainPendingSubagentsBeforeShutdownResult> {
  if (manager === undefined) {
    return { text: "", undeliveredTaskIds: [] };
  }

  const reportError = (error: unknown): void => {
    try {
      opts.onError?.(error);
    } catch (reportingError) {
      // EXIT: closeout diagnostics must not prevent the old manager from
      // reaching its normal shutdown path.
      void reportingError;
    }
  };

  let activeTaskIds: readonly string[] = [];
  try {
    activeTaskIds = [...new Set(manager.listActive())];
  } catch (error) {
    reportError(error);
  }

  for (const taskId of activeTaskIds) {
    try {
      await manager.waitFor(taskId);
    } catch (error) {
      reportError(error);
    }
  }

  let entries: ReadonlyArray<{
    readonly taskId: string;
    readonly envelope: SubAgentEnvelope;
  }> = [];
  try {
    entries = manager.drainCompleted();
  } catch (error) {
    reportError(error);
  }

  let text = "";
  let deliveredTaskIds = new Set<string>();
  try {
    text = formatDrainedResults(entries);
    deliveredTaskIds = new Set(entries.map(({ taskId }) => taskId));
  } catch (error) {
    reportError(error);
  }
  return {
    text,
    undeliveredTaskIds: activeTaskIds.filter(
      (taskId) => !deliveredTaskIds.has(taskId)
    ),
  };
}
