/**
 * Bounded cleanup for one TUI process. The operation list is assembled by the
 * host, so each owner can begin stopping without coupling its lifetime to the
 * currently selected conversation.
 */
export const DEFAULT_TUI_SHUTDOWN_TIMEOUT_MS = 8_000;
export const TUI_EXIT_WATCHDOG_DELAY_MS = 500;

export interface TuiShutdownOperation {
  readonly name: string;
  readonly stop: () => void | Promise<void>;
}

export interface TuiShutdownReport {
  readonly cleanupConfirmed: boolean;
  readonly timedOut: boolean;
  readonly pendingOperations: ReadonlyArray<string>;
  readonly failedOperations: ReadonlyArray<string>;
}

export interface TuiShutdownCoordinator {
  readonly begin: (
    operations: ReadonlyArray<TuiShutdownOperation>,
    inflightTurns?: ReadonlyArray<Promise<unknown>>
  ) => Promise<TuiShutdownReport>;
}

type OperationState = "pending" | "completed" | "failed";
const MAX_TUI_SHUTDOWN_TIMEOUT_MS = 60_000;

/** Create one idempotent, time-bounded cleanup run for this host process. */
export function createTuiShutdownCoordinator(
  timeoutMs = DEFAULT_TUI_SHUTDOWN_TIMEOUT_MS
): TuiShutdownCoordinator {
  validateTimeout(timeoutMs, "shutdown timeout");
  let shutdownPromise: Promise<TuiShutdownReport> | undefined;

  return {
    begin: (operations, inflightTurns = []) => {
      if (shutdownPromise !== undefined) return shutdownPromise;

      const allOperations: TuiShutdownOperation[] = [...operations];
      if (inflightTurns.length > 0) {
        allOperations.push({
          name: "in-flight turns",
          stop: async () => {
            await Promise.allSettled(inflightTurns);
          },
        });
      }
      let resolveShutdown!: (report: TuiShutdownReport) => void;
      let rejectShutdown!: (reason: unknown) => void;
      shutdownPromise = new Promise<TuiShutdownReport>((resolve, reject) => {
        resolveShutdown = resolve;
        rejectShutdown = reject;
      });
      void settleWithinDeadline(allOperations, timeoutMs).then(
        resolveShutdown,
        rejectShutdown
      );
      return shutdownPromise;
    },
  };
}

/** Arm an unreferenced process-exit backstop after the terminal is restored. */
export function scheduleTuiExitWatchdog(
  report: TuiShutdownReport,
  options: {
    readonly delayMs?: number;
    readonly forceExit?: (code: number) => void;
    readonly onProcessStillAlive?: (report: TuiShutdownReport) => void;
  } = {}
): ReturnType<typeof setTimeout> {
  const delayMs = options.delayMs ?? TUI_EXIT_WATCHDOG_DELAY_MS;
  validateTimeout(delayMs, "watchdog delay");
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  const watchdog = setTimeout(() => {
    try {
      options.onProcessStillAlive?.(report);
    } finally {
      forceExit(1);
    }
  }, delayMs);
  watchdog.unref();
  return watchdog;
}

async function settleWithinDeadline(
  operations: ReadonlyArray<TuiShutdownOperation>,
  timeoutMs: number
): Promise<TuiShutdownReport> {
  const states: OperationState[] = operations.map(() => "pending");
  const settlements = operations.map((operation, index) => {
    try {
      return Promise.resolve(operation.stop()).then(
        () => {
          states[index] = "completed";
        },
        () => {
          states[index] = "failed";
        }
      );
    } catch {
      states[index] = "failed";
      // EXIT: one owner can reject synchronously; keep starting every other
      // owner's cleanup and report this owner as unconfirmed below.
      return Promise.resolve();
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineWon = await Promise.race([
    Promise.all(settlements).then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), Math.max(1, timeoutMs));
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);

  const pendingOperations = operations
    .filter((_, index) => states[index] === "pending")
    .map((operation) => operation.name);
  const failedOperations = operations
    .filter((_, index) => states[index] === "failed")
    .map((operation) => operation.name);
  const timedOut = deadlineWon && pendingOperations.length > 0;
  return {
    cleanupConfirmed:
      pendingOperations.length === 0 && failedOperations.length === 0,
    timedOut,
    pendingOperations,
    failedOperations,
  };
}

function validateTimeout(value: number, label: string): void {
  if (
    !Number.isFinite(value) ||
    value < 1 ||
    value > MAX_TUI_SHUTDOWN_TIMEOUT_MS
  ) {
    throw new RangeError(
      `${label} must be finite and between 1 and ${MAX_TUI_SHUTDOWN_TIMEOUT_MS} milliseconds`
    );
  }
}
