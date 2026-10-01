/**
 * src/harness/sandbox/turn-work-registry.ts
 *
 * Per-turn ownership of work that outlives a single tool call (ADR-0135,
 * spec #1170 Success Criterion 11).
 *
 * Why this exists: a security interruption cancels "this turn's owned
 * workers and finite background jobs" — and nothing else. There was no
 * per-turn ownership surface before, so the only available granularity was
 * the whole conversation (a manager-wide shutdown), which would also kill a
 * persistent service the user started two turns ago.
 *
 * The unit of ownership is a *user turn*, so a registry instance is created
 * per turn and discarded with it. Work launched by an earlier turn is owned
 * by that turn's (now unreachable) registry and therefore survives an
 * interruption of a later turn — isolation falls out of the lifetime rather
 * than out of a filter that could be forgotten.
 *
 * Cleanup evidence is deliberately per item and deliberately honest. The
 * background plane reports its own bounded `CleanupEvidence` verbatim; the
 * subagent plane can only report that a stop was requested, because
 * `abortTask` signals a child and returns before disappearance is observed.
 * Neither plane may report a confirmed stop it did not observe.
 */

import type { CleanupEvidence } from "./cleanup-result.js";

/** What kind of turn-owned work an entry names. */
export type TurnWorkKind = "subagent" | "background_task";

/** One turn-owned work item, as registered at launch. */
export interface TurnOwnedWork {
  readonly kind: TurnWorkKind;
  readonly id: string;
}

/**
 * Cleanup verdict for one owned item.
 *
 * - `stop_requested`: a teardown signal was delivered (or the plane's own
 *   request returned without an observation yet). Not a claim of exit.
 * - `confirmed_stopped` / `unconfirmed`: the bounded observation's verdict,
 *   mirrored at the top level so a consumer need not branch on the plane.
 *   `cleanup` always carries the plane's own evidence verbatim.
 */
export type TurnOwnedWorkCleanup = {
  readonly kind: TurnWorkKind;
  readonly id: string;
  readonly state: "stop_requested" | "confirmed_stopped" | "unconfirmed";
  /** Typed cause when `state === "unconfirmed"`; absent otherwise. */
  readonly reason?: string;
  /** The plane's own bounded cleanup result, verbatim. */
  readonly cleanup: CleanupEvidence;
};

/** Cancellation routes a host injects. Both optional: a route the host
 *  cannot supply reports its items as unconfirmed instead of vanishing. */
export interface TurnWorkCancelRoutes {
  /** Stop one worker. `true` = an in-flight child was signalled. */
  readonly cancelSubagent?: (taskId: string) => boolean;
  /** Request teardown of one finite background job. */
  readonly cancelBackgroundTask?: (taskId: string) => Promise<CleanupEvidence>;
}

export interface TurnWorkRegistry extends TurnWorkCancelRoutes {
  /** Register a worker this turn launched. */
  readonly registerSubagent: (taskId: string) => void;
  /** Register a finite background job this turn launched. */
  readonly registerBackgroundTask: (taskId: string) => void;
  /** Everything still registered, in launch order. */
  readonly owned: () => ReadonlyArray<TurnOwnedWork>;
  readonly isEmpty: () => boolean;
  /**
   * Cancel every registered item once and report bounded per-item evidence.
   * Idempotent: a second call reports nothing, because the registry is
   * emptied by the first.
   */
  readonly cancelOwned: () => Promise<ReadonlyArray<TurnOwnedWorkCleanup>>;
}

const NO_ROUTE_SUBAGENT = "no_subagent_cancel_route";
const NO_ROUTE_BACKGROUND = "no_background_cancel_route";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createTurnWorkRegistry(
  routes: TurnWorkCancelRoutes = {}
): TurnWorkRegistry {
  // One entry per identity, insertion-ordered: a duplicate launch of the same
  // id must not be signalled twice.
  const owned = new Map<string, TurnOwnedWork>();

  const register = (kind: TurnWorkKind, taskId: string): void => {
    const id = taskId.trim();
    if (id === "") return;
    owned.set(id, { kind, id });
  };

  const cancelSubagent = async (
    item: TurnOwnedWork
  ): Promise<TurnOwnedWorkCleanup> => {
    if (routes.cancelSubagent === undefined) {
      return {
        kind: item.kind,
        id: item.id,
        state: "unconfirmed",
        reason: NO_ROUTE_SUBAGENT,
        cleanup: { state: "not_started" },
      };
    }
    try {
      const signalled = routes.cancelSubagent(item.id);
      return {
        kind: item.kind,
        id: item.id,
        // The worker plane returns "a signal went out", never "the process is
        // gone" — reporting confirmed_stopped here would be a fabricated stop.
        state: signalled ? "stop_requested" : "unconfirmed",
        ...(signalled ? {} : { reason: "no in-flight child to signal" }),
        cleanup: { state: "not_started" },
      };
    } catch (err) {
      return {
        kind: item.kind,
        id: item.id,
        state: "unconfirmed",
        reason: errorText(err),
        cleanup: { state: "not_started" },
      };
    }
  };

  const cancelBackgroundTask = async (
    item: TurnOwnedWork
  ): Promise<TurnOwnedWorkCleanup> => {
    if (routes.cancelBackgroundTask === undefined) {
      return {
        kind: item.kind,
        id: item.id,
        state: "unconfirmed",
        reason: NO_ROUTE_BACKGROUND,
        cleanup: { state: "not_started" },
      };
    }
    try {
      const evidence = await routes.cancelBackgroundTask(item.id);
      if (evidence.state === "confirmed_stopped") {
        return {
          kind: item.kind,
          id: item.id,
          state: "confirmed_stopped",
          cleanup: evidence,
        };
      }
      if (evidence.state === "unconfirmed") {
        return {
          kind: item.kind,
          id: item.id,
          state: "unconfirmed",
          reason: evidence.reason,
          cleanup: evidence,
        };
      }
      // `not_started`: the plane accepted the request but has not observed the
      // group yet. That is a delivered stop request, not a confirmed stop.
      return {
        kind: item.kind,
        id: item.id,
        state: "stop_requested",
        cleanup: evidence,
      };
    } catch (err) {
      return {
        kind: item.kind,
        id: item.id,
        state: "unconfirmed",
        reason: errorText(err),
        cleanup: { state: "not_started" },
      };
    }
  };

  const cancelOwned = async (): Promise<
    ReadonlyArray<TurnOwnedWorkCleanup>
  > => {
    const items = [...owned.values()];
    owned.clear();
    const reports = await Promise.all(
      items.map((item) =>
        item.kind === "subagent"
          ? cancelSubagent(item)
          : cancelBackgroundTask(item)
      )
    );
    return reports;
  };

  return Object.freeze({
    ...(routes.cancelSubagent !== undefined
      ? { cancelSubagent: routes.cancelSubagent }
      : {}),
    ...(routes.cancelBackgroundTask !== undefined
      ? { cancelBackgroundTask: routes.cancelBackgroundTask }
      : {}),
    registerSubagent: (taskId: string) => register("subagent", taskId),
    registerBackgroundTask: (taskId: string) =>
      register("background_task", taskId),
    owned: () => [...owned.values()],
    isEmpty: () => owned.size === 0,
    cancelOwned,
  });
}

/**
 * Read a task identity out of an `ok` tool result payload.
 *
 * Both producers of turn-owned work answer with `{ task_id }`: the
 * `spawn_subagent` async arm and the bash `background: true` arm. The payload
 * reaches this layer either as the handler's JSON-compatible object or as the
 * executor's rendered content blocks, so both shapes are read here rather than
 * in each caller.
 */
export function extractOwnedTaskId(
  payload: unknown
): string | undefined {
  const fromText = (text: string): string | undefined => {
    try {
      const parsed: unknown = JSON.parse(text);
      return taskIdOf(parsed);
    } catch {
      return undefined;
    }
  };
  if (Array.isArray(payload)) {
    for (const block of payload) {
      const text = (block as { text?: unknown } | null)?.text;
      if (typeof text !== "string") continue;
      const id = fromText(text);
      if (id !== undefined) return id;
    }
    return undefined;
  }
  return taskIdOf(payload);
}

function taskIdOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const taskId = (value as { task_id?: unknown }).task_id;
  return typeof taskId === "string" && taskId.trim() !== ""
    ? taskId.trim()
    : undefined;
}
