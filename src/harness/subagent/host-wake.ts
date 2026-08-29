import type { SubAgentManager } from "./manager.js";

export interface SubagentWake {
  readonly request: () => void;
  readonly flush: () => void;
  readonly dispose: () => void;
}

export interface CreateSubagentWakeOptions {
  readonly manager: SubAgentManager | undefined;
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
  let running = false;
  let scheduled = false;
  let disposed = false;
  const enabled =
    options.manager !== undefined || options.subscribe !== undefined;

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Error reporting is an observer and must not become an unhandled
      // rejection from the mailbox callback.
    }
  };

  const flush = (): void => {
    scheduled = false;
    if (disposed || running || !pending || !options.isIdle()) return;
    pending = false;
    running = true;
    let wakeResult: Promise<void>;
    try {
      wakeResult = options.wake();
    } catch (error) {
      running = false;
      reportError(error);
      if (pending) queueMicrotask(flush);
      return;
    }
    void Promise.resolve(wakeResult)
      .catch((error: unknown) => {
        reportError(error);
      })
      .finally(() => {
        running = false;
        if (pending && !disposed) queueMicrotask(flush);
      });
  };

  const request = (): void => {
    if (disposed || !enabled) return;
    pending = true;
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };

  const subscribe = options.subscribe ?? options.manager?.subscribe;
  const unsubscribe =
    subscribe?.(() => {
      request();
    }) ?? (() => {});

  return Object.freeze({
    request,
    flush,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      pending = false;
      unsubscribe();
    },
  });
}
