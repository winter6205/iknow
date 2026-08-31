import type { SubagentManagerWakeView } from "./manager-registry.js";
import type { SubAgentTerminalNotice } from "./mailbox.js";
import { errorMessage } from "../errors.js";

function reportObserverDiagnostic(scope: string, error: unknown): void {
  try {
    process.stderr.write(`[subagent-wake] ${scope}: ${errorMessage(error)}\n`);
  } catch (diagnosticError) {
    // EXIT: diagnostics are best-effort; a broken stderr must not rethrow into
    // a mailbox callback or cleanup path.
    void diagnosticError;
  }
}

export type SubagentWakeFailureReason = "wakeFailed" | "watcherUnavailable";

/**
 * A host wake did not deliver a terminal handoff. This is deliberately an
 * error/status object rather than an envelope: a host must not turn a failed
 * silent run into a fabricated successful result.
 */
export class SubagentWakeError extends Error {
  override readonly name = "SubagentWakeError";
  readonly status = "undelivered" as const;
  readonly reason: SubagentWakeFailureReason;
  readonly taskIds: readonly string[];
  readonly queryable: boolean;
  readonly cause: unknown;

  constructor(opts: {
    readonly reason: SubagentWakeFailureReason;
    readonly taskIds?: readonly string[];
    readonly queryable?: boolean;
    readonly cause: unknown;
  }) {
    const taskIds = [...(opts.taskIds ?? [])];
    const taskText =
      taskIds.length > 0
        ? `task(s) ${taskIds.join(", ")} remain queryable via subagent_result`
        : "no terminal envelope was available; no completion was recorded";
    super(
      `subagent wake undelivered (${opts.reason}): ${taskText}: ${errorMessage(opts.cause)}`
    );
    this.reason = opts.reason;
    this.taskIds = Object.freeze(taskIds);
    this.queryable = opts.queryable ?? false;
    this.cause = opts.cause;
  }
}

export function toSubagentWakeError(
  error: unknown,
  opts: {
    readonly reason?: SubagentWakeFailureReason;
    readonly taskIds?: readonly string[];
    readonly queryable?: boolean;
  } = {}
): SubagentWakeError {
  if (error instanceof SubagentWakeError) return error;
  return new SubagentWakeError({
    reason: opts.reason ?? "wakeFailed",
    taskIds: opts.taskIds,
    queryable: opts.queryable,
    cause: error,
  });
}

/**
 * Read task ids without making a failed wake depend on the drain path. The
 * helper is defensive because failure reporting must never mask the original
 * wake failure.
 */
export function queryableSubagentTaskIds(
  manager: SubagentManagerWakeView | undefined,
  conversationId?: string
): readonly string[] {
  if (manager === undefined) return [];
  try {
    return manager.drainCompleted(conversationId).map(({ taskId }) => taskId);
  } catch (error) {
    reportObserverDiagnostic("queryable task lookup failed", error);
    // EXIT: diagnostic lookup is fail-safe; no task ids can be asserted when
    // the manager drain itself failed.
    return [];
  }
}

export interface SubagentWake {
  readonly request: () => void;
  readonly flush: () => void;
  readonly dispose: () => void;
}

export interface CreateSubagentWakeOptions {
  readonly manager: SubagentManagerWakeView | undefined;
  /**
   * Optional session scope for a host. A function keeps one subscription
   * usable while an interactive host switches sessions.
   */
  readonly conversationId?: string | (() => string | undefined);
  readonly subscribe?: SubagentManagerWakeView["subscribe"];
  readonly isIdle: () => boolean;
  readonly wake: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

/**
 * Turn terminal mailbox notifications into serialized host wake requests.
 *
 * A notice is only a request: an active parent turn keeps it pending and the
 * request is retried when the host becomes idle. Same-tick notices coalesce so
 * a batch of workers does not start a batch of parent turns. The wake callback
 * owns the entry-specific run boundary and is deliberately best-effort; a
 * failed wake is reported, never presented as a successful handoff.
 */
export function createSubagentWake(
  options: CreateSubagentWakeOptions
): SubagentWake {
  const pendingTaskIds = new Map<string, string | undefined>();
  let pendingAnonymous = false;
  let running = false;
  let scheduled = false;
  let disposed = false;
  const enabled =
    options.manager !== undefined || options.subscribe !== undefined;
  const scoped = options.conversationId !== undefined;
  const currentConversationId = (): string | undefined =>
    typeof options.conversationId === "function"
      ? options.conversationId()
      : options.conversationId;

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch (observerError) {
      reportObserverDiagnostic("onError observer failed", observerError);
    }
  };

  const reportFailure = (
    reason: SubagentWakeFailureReason,
    error: unknown,
    taskIds: readonly string[],
    clearAnonymous = false
  ): void => {
    for (const taskId of taskIds) pendingTaskIds.delete(taskId);
    if (clearAnonymous) pendingAnonymous = false;
    reportError(
      toSubagentWakeError(error, {
        reason,
        taskIds,
        queryable: taskIds.length > 0 && options.manager !== undefined,
      })
    );
  };

  const flush = (): void => {
    scheduled = false;
    if (disposed || running || (pendingTaskIds.size === 0 && !pendingAnonymous))
      return;
    let conversationId: string | undefined;
    try {
      conversationId = currentConversationId();
    } catch (error) {
      reportFailure(
        "watcherUnavailable",
        error,
        [...pendingTaskIds.keys()],
        true
      );
      return;
    }
    const taskIds = [...pendingTaskIds].reduce<string[]>(
      (matched, [taskId, noticeConversationId]) => {
        if (
          !scoped ||
          (conversationId !== undefined &&
            noticeConversationId === conversationId)
        ) {
          matched.push(taskId);
        }
        return matched;
      },
      []
    );
    const anonymousMatches =
      pendingAnonymous && (!scoped || conversationId !== undefined);
    if (taskIds.length === 0 && !anonymousMatches) return;
    let idle: boolean;
    try {
      idle = options.isIdle();
    } catch (error) {
      reportFailure("watcherUnavailable", error, taskIds, anonymousMatches);
      return;
    }
    if (!idle) return;
    for (const taskId of taskIds) pendingTaskIds.delete(taskId);
    if (anonymousMatches) pendingAnonymous = false;
    running = true;
    let wakeResult: Promise<void>;
    try {
      wakeResult = options.wake();
    } catch (error) {
      running = false;
      reportFailure("wakeFailed", error, taskIds, anonymousMatches);
      return;
    }
    void Promise.resolve(wakeResult)
      .catch((error: unknown) => {
        reportError(
          toSubagentWakeError(error, {
            reason: "wakeFailed",
            taskIds,
            queryable: taskIds.length > 0 && options.manager !== undefined,
          })
        );
      })
      .finally(() => {
        running = false;
        if (pendingTaskIds.size > 0 && !disposed) queueMicrotask(flush);
      });
  };

  const request = (notice?: SubAgentTerminalNotice): void => {
    if (disposed || !enabled) return;
    if (notice !== undefined) {
      pendingTaskIds.set(notice.taskId, notice.conversationId);
    } else {
      pendingAnonymous = true;
    }
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };

  const subscribe = options.subscribe ?? options.manager?.subscribe;
  let unsubscribe: () => void = () => {};
  if (subscribe !== undefined) {
    try {
      unsubscribe =
        subscribe((notice) => {
          if (
            typeof options.conversationId === "function" ||
            options.conversationId === undefined ||
            notice.conversationId === options.conversationId
          ) {
            request(notice);
          }
        }) ?? (() => {});
    } catch (error) {
      reportFailure("watcherUnavailable", error, [], true);
    }
  }

  return Object.freeze({
    request,
    flush,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      pendingAnonymous = false;
      pendingTaskIds.clear();
      try {
        unsubscribe();
      } catch (unsubscribeError) {
        reportObserverDiagnostic("unsubscribe failed", unsubscribeError);
      }
    },
  });
}
