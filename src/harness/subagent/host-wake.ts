import type { SubAgentManager } from "./manager.js";
import type { SubAgentTerminalNotice } from "./mailbox.js";
import { errorMessage } from "../errors.js";

function reportObserverDiagnostic(scope: string, error: unknown): void {
  try {
    process.stderr.write(
      `[subagent-wake] ${scope}: ${errorMessage(error)}\n`
    );
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
  manager: SubAgentManager | undefined,
  conversationId?: string
): readonly string[] {
  if (manager === undefined) return [];
  try {
    return manager
      .drainCompleted(conversationId)
      .map(({ taskId }) => taskId);
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
  readonly manager: SubAgentManager | undefined;
  /**
   * Optional session scope for a host. Notices for other conversations are
   * retained by the mailbox and can be replayed when that session is active.
   */
  readonly conversationId?: string;
  readonly subscribe?: SubAgentManager["subscribe"];
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
  let pending = false;
  const pendingTaskIds = new Set<string>();
  let running = false;
  let scheduled = false;
  let disposed = false;
  const enabled =
    options.manager !== undefined || options.subscribe !== undefined;

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch (observerError) {
      reportObserverDiagnostic("onError observer failed", observerError);
    }
  };

  const reportFailure = (
    reason: SubagentWakeFailureReason,
    error: unknown
  ): void => {
    const taskIds = [...pendingTaskIds];
    pending = false;
    pendingTaskIds.clear();
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
    if (disposed || running || !pending) return;
    let idle: boolean;
    try {
      idle = options.isIdle();
    } catch (error) {
      reportFailure("watcherUnavailable", error);
      return;
    }
    if (!idle) return;
    pending = false;
    running = true;
    let wakeResult: Promise<void>;
    try {
      wakeResult = options.wake();
    } catch (error) {
      running = false;
      reportFailure("wakeFailed", error);
      return;
    }
    void Promise.resolve(wakeResult)
      .catch((error: unknown) => {
        reportFailure("wakeFailed", error);
      })
      .finally(() => {
        running = false;
        if (!pending) pendingTaskIds.clear();
        if (pending && !disposed) queueMicrotask(flush);
      });
  };

  const request = (notice?: SubAgentTerminalNotice): void => {
    if (disposed || !enabled) return;
    if (notice !== undefined) pendingTaskIds.add(notice.taskId);
    pending = true;
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
            options.conversationId === undefined ||
            notice.conversationId === options.conversationId
          ) {
            request(notice);
          }
        }) ?? (() => {});
    } catch (error) {
      reportFailure("watcherUnavailable", error);
    }
  }

  return Object.freeze({
    request,
    flush,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      pending = false;
      pendingTaskIds.clear();
      try {
        unsubscribe();
      } catch (unsubscribeError) {
        reportObserverDiagnostic("unsubscribe failed", unsubscribeError);
      }
    },
  });
}
