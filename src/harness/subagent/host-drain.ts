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
 *   - per-task condensation format:
 *       ## Sub-agent <taskId> result: <summary>
 *
 *       [result]
 *     multiple tasks separated by blank lines.
 *
 * Two entrypoints (ADR-0150): `peekPendingSubagents` is the read-only view
 * (diagnostics, no claim), and `claimPendingSubagents` atomically takes the
 * undelivered terminal generations, returning a handle the host acknowledges
 * only on the write that carries the digest (or releases). A view without the
 * optional claim seam falls back to the read-only path, and its claims handle
 * is a no-op.
 *
 * Implementation constraint: the drain/claim path consumes results only
 * through the manager's drain/claim views and never calls listActive() /
 * waitFor(); the pre-rebind closeout helper below is the one caller that
 * reads the roster.
 *
 * The ask entrypoint has no manager → this function is not called → no
 * behavior change.
 */
import type { ClaimedDelivery } from "./delivery-ledger.js";
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
 * Read-only gate: condense terminal results that are still undelivered into a
 * single user-message string. Never claims, so an emptiness check cannot take
 * a result away from the delivery path.
 *
 * Returns "" when:
 *   - manager is undefined (ask-entry shape);
 *   - manager has no tasks or no undelivered terminal tasks;
 *   - the manager's read-only drain / condensation fails (never throws).
 */
export async function peekPendingSubagents(
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

/** Opaque claims a host settles after the write that carries their digest. */
export interface DeliveryClaims {
  /** Mark the claimed generations delivered (idempotent). */
  acknowledge(): void;
  /** Return the claimed generations to the claimable state (idempotent). */
  release(): void;
}

export interface ClaimedSubagentDrain {
  /** Full formatted segment: freshly claimed text plus any pending closeout text. */
  readonly text: string;
  /** What this round claimed; the substring `writeCarriesDigest` searches for. */
  readonly digestText: string;
  /**
   * `null` = no claim was taken (no manager / failure). A no-op handle means
   * there is nothing to settle: nothing was claimed, or the view has no claim
   * seam — the read-only fallback is a successful read, not a failed claim.
   */
  readonly claims: DeliveryClaims | null;
}

const NO_CLAIMS: DeliveryClaims = {
  acknowledge: () => {},
  release: () => {},
};

/** Hand a claim taken before a failure back to the claimable state. */
function releaseTakenClaim(
  manager: SubagentManagerDrainView,
  claimed: ReadonlyArray<ClaimedDelivery<SubAgentEnvelope>> | undefined
): void {
  if (claimed === undefined || claimed.length === 0) return;
  try {
    manager.releaseDeliveries?.(claimed);
  } catch (releaseError) {
    // EXIT: the drain is non-throwing for its callers (the hub claims outside
    // any try). A release seam that throws must not turn "deliver nothing
    // this round" into an escaped error.
    void releaseError;
  }
}

function claimsOf(
  claims: ReadonlyArray<ClaimedDelivery<unknown>>,
  view: SubagentManagerDrainView | undefined
): DeliveryClaims {
  if (claims.length === 0 || view?.acknowledgeDeliveries === undefined) {
    return NO_CLAIMS;
  }
  return {
    acknowledge: () => view.acknowledgeDeliveries?.(claims),
    release: () => view.releaseDeliveries?.(claims),
  };
}

/**
 * Delivery take: claim every undelivered terminal generation and format the
 * text that will carry it. A view without the optional claim seam (structural
 * fakes / ask surface) falls back to the read-only path with a no-op claim.
 *
 * The caller must settle the claims: `acknowledge()` after the write that
 * actually carries `digestText`, `release()` on any earlier failure
 * (ADR-0150).
 */
export async function claimPendingSubagents(
  manager: SubagentManagerDrainView | undefined,
  opts?: DrainPendingSubagentsOpts
): Promise<ClaimedSubagentDrain> {
  if (manager === undefined) {
    return { text: "", digestText: "", claims: null };
  }
  // Hoisted so the failure path can hand back a claim it already took.
  let claimed: ReadonlyArray<ClaimedDelivery<SubAgentEnvelope>> | undefined;
  try {
    claimed = manager.claimCompleted?.(opts?.conversationId) ?? [];
    if (claimed.length === 0) {
      // No claim seam, or genuinely nothing undelivered: stay readable so a
      // seam-less view keeps today's behavior.
      const text = formatDrainedResults(
        manager.drainCompleted(opts?.conversationId)
      );
      return { text, digestText: text, claims: claimsOf([], manager) };
    }
    const text = formatDrainedResults(
      claimed.map((claim) => ({
        taskId: claim.taskId,
        envelope: claim.envelope,
      }))
    );
    return { text, digestText: text, claims: claimsOf(claimed, manager) };
  } catch (error) {
    // EXIT: host drain is intentionally non-throwing; an unreadable manager
    // delivers nothing this round. A claim taken before the failure goes back
    // to undelivered instead of being stranded in `claimed` forever.
    releaseTakenClaim(manager, claimed);
    void error;
    return { text: "", digestText: "", claims: null };
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
