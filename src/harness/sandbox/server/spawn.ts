/**
 * Internal spawn sub-process helpers for the sandbox server.
 *
 // (ADR-0045)
 *
 * The spawn orchestrator in `server/index.ts` keeps only the "protocol shape";
 * concrete node creation, SIGTERM→SIGKILL escalation and queue/sentinel
 * machinery live in this file. Nothing here is exported beyond the package —
 * it exists solely for `server/index.ts`.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import {
  confirmedStopped,
  sendSignalToProcessGroup,
  unconfirmedCleanup,
  waitForProcessGroupGone,
  type CleanupEvidence,
} from "../cleanup-result.js";
import type {
  QueuedTaskEvent,
  SandboxServerError,
  SandboxTaskEvent,
  SandboxTaskHandle,
} from "./types.js";

/**
 * Bounded wait for process-group disappearance after the last signal, before
 * the teardown reports `unconfirmed`. Mirrors the runner's GROUP_SETTLE_MS: it
 * bounds the verdict wait, not the kill route.
 */
export const DEFAULT_GROUP_OBSERVE_MS = 250;

/** Node constant — default killGraceMs (same shape as the manager's background tasks). */
// (ADR-0021)
export const DEFAULT_KILL_GRACE_MS = 2_000;

/** Generates a `bg-` + 12-hex task_id (same shape as the manager's background tasks). */
// (ADR-0021)
export function newTaskId(): string {
  return `bg-${randomBytes(6).toString("hex")}`;
}

/** nodeSpawn detached child — the single spawn shape, centralising fenced cwd/env/detached. */
export function spawnDetached(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): ChildProcess {
  return nodeSpawn(argv[0] as string, argv.slice(1), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

/** Build the log path — lands in `cwd`, same form as manager.ts. */
export function logPathFor(cwd: string, taskId: string): string {
  return join(cwd, `.iknow-bg-${taskId}.log`);
}

/** Trigger the SIGKILL escalation — shared by the killTimer callback and the immediate graceMs=0 branch. */
export function escalateToSigkill(
  child: ChildProcess,
  pid: number | undefined,
  log: (msg: string) => void,
  onFailure: (detail: string) => void = (detail) =>
    log(`sandbox server: ${detail}`)
): void {
  if (pid === undefined) return;
  try {
    child.kill("SIGKILL");
  } catch {
    /* the group signal below is the authoritative route; a closed pipe says nothing about liveness */
  }
  sendSignalToProcessGroup(pid, "SIGKILL", onFailure);
}

/** Trigger the SIGTERM escalation — shared by all stop entry points. */
export function escalateToSigterm(
  child: ChildProcess,
  pid: number | undefined,
  log: (msg: string) => void,
  onFailure: (detail: string) => void = (detail) =>
    log(`sandbox server: ${detail}`)
): void {
  if (pid === undefined) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* the group signal below is the authoritative route; a closed pipe says nothing about liveness */
  }
  sendSignalToProcessGroup(pid, "SIGTERM", onFailure);
}

/** Append stdout/stderr chunks to the log file — a serial writeChain avoids races. */
export function makeLogWriter(
  logPath: string,
  taskId: string,
  log: (msg: string) => void
): { enqueue: (chunk: Buffer | string) => void } {
  let writeChain: Promise<void> = Promise.resolve();
  return {
    enqueue(chunk) {
      const chain = writeChain.then(() =>
        appendFile(logPath, chunk, "utf8").catch(() => {
          log(`sandbox server: log append failed for ${taskId}`);
        })
      );
      void chain;
    },
  };
}

/**
 * queue + pending-consumer container — one producer (the spawn node) + many
 * consumers (each `events()` call competes for events; see the
 * single-consumer contract in SandboxTaskHandle.events' JSDoc).
 *
 * Why a factory: `push` / `next` / `close` used to be inlined in the spawn
 * closure for 30+ lines; extracting them slims the spawn orchestrator down to
 * just the protocol lines (abort / handle construction).
 */
export interface EventChannel {
  push(ev: SandboxTaskEvent): void;
  next(): Promise<IteratorResult<QueuedTaskEvent>>;
  close(): void;
  readonly closed: boolean;
}

export function createEventChannel(): EventChannel {
  const queue: QueuedTaskEvent[] = [];
  const pending: Array<(ev: QueuedTaskEvent) => void> = [];
  let closed = false;

  const push = (ev: SandboxTaskEvent): void => {
    if (closed) return;
    const next = pending.shift();
    if (next) next(ev);
    else queue.push(ev);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    while (pending.length > 0) {
      const next = pending.shift()!;
      next({ kind: "close" });
    }
  };

  const next = (): Promise<IteratorResult<QueuedTaskEvent>> => {
    if (queue.length > 0) {
      return Promise.resolve({ value: queue.shift()!, done: false });
    }
    if (closed) {
      return Promise.resolve({ value: { kind: "close" }, done: true });
    }
    return new Promise((res) => {
      pending.push((ev: QueuedTaskEvent) => {
        if (ev.kind === "close") res({ value: { kind: "close" }, done: true });
        else res({ value: ev, done: false });
      });
    });
  };

  return {
    push,
    next,
    close,
    get closed() {
      return closed;
    },
  };
}

/** Turn the close sentinel into an AsyncIterable wrapper (the SandboxTaskEvent stream). */
export async function* toTaskEventStream(
  channel: EventChannel
): AsyncGenerator<SandboxTaskEvent, void, void> {
  while (true) {
    const r = await channel.next();
    if (r.done) return;
    if (r.value.kind === "close") return;
    yield r.value;
  }
}

/** Wire stdout/stderr data into the channel + log writer. */
export function wireChildStreamHandlers(
  child: ChildProcess,
  channel: EventChannel,
  writer: { enqueue: (chunk: Buffer | string) => void }
): void {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    channel.push({ kind: "stdout", chunk });
    writer.enqueue(chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    channel.push({ kind: "stderr", chunk });
    writer.enqueue(chunk);
  });
}

/**
 * close handler — settled short-circuit + exit event + the teardown verdict.
 *
 * The leader's `close` is not the task's end: a descendant that holds no pipe
 * and ignores SIGTERM is still running in the group when it arrives. So when a
 * teardown is in flight, the terminal verdict waits for the bounded
 * observation and is pushed by `StopHandle` (one terminal transition only);
 * a natural exit keeps the old shape — exit plus channel close, no stop claim.
 */
export function onChildClose(
  child: ChildProcess,
  channel: EventChannel,
  orphan: OrphanSettler,
  stopHandle: StopHandle
): void {
  child.once("close", (code, signal) => {
    if (orphan.settled) return;
    channel.push({ kind: "exit", exit_code: code, signal });
    if (!stopHandle.stopped) {
      // No teardown was requested: the task ended on its own. No stop may be
      // claimed, and there is no group to observe.
      channel.close();
      return;
    }
    void stopHandle.settleTeardown(signal);
  });
}

/** error handler — log + typed orphan fail-loud. */
export function onChildError(
  child: ChildProcess,
  orphan: OrphanSettler,
  task_id: string,
  log: (msg: string) => void
): void {
  child.once("error", (cause) => {
    log(`sandbox server: child error ${task_id}: ${String(cause)}`);
    orphan.settle(cause);
  });
}

/**
 * External AbortSignal wiring — for short-lived tasks it passes straight to
 * the spawn; for long-lived ones it goes through stop() escalation.
 */
export function wireAbortSignal(
  signal: AbortSignal | undefined,
  stopHandle: StopHandle,
  killGraceMs: number
): void {
  if (signal?.aborted) {
    void stopHandle.stop(killGraceMs);
    return;
  }
  signal?.addEventListener(
    "abort",
    () => {
      void stopHandle.stop(killGraceMs);
    },
    { once: true }
  );
}

/**
 * Assemble the handle — task_id + log_path + events stream + stop control plane.
 */
export function assembleHandle(
  task_id: string,
  log_path: string,
  channel: EventChannel,
  stopHandle: StopHandle
): SandboxTaskHandle {
  return {
    task_id,
    log_path,
    events(): AsyncIterable<SandboxTaskEvent> {
      return toTaskEventStream(channel);
    },
    stop: stopHandle.stop,
  };
}

/** Internal typed-error helper — typed errors are built uniformly in one factory. */
export function orphanGroupError(
  context: string,
  pgid: number | undefined
): SandboxServerError {
  return pgid === undefined
    ? { kind: "orphan_process_group", context }
    : { kind: "orphan_process_group", context, pgid };
}

/** Stop control plane — the closure owns child/pgid/log/stopped/killFallback. */
export interface StopHandle {
  stop(graceMs?: number): Promise<void>;
  /**
   * Complete a teardown that the caller initiated: observe the group within
   * the bounded window, then push exactly one terminal `stopped` verdict.
   * Called on the leader's `close`, and on its own when the escalation window
   * outlasts the leader (an interruptible descendant that never exits).
   */
  settleTeardown(signal: NodeJS.Signals | null): Promise<void>;
  readonly stopped: boolean;
}

export function createStopHandle(
  child: ChildProcess,
  pgid: number | undefined,
  task_id: string,
  defaultGraceMs: number,
  log: (msg: string) => void,
  channel: EventChannel,
  observeMs: number = DEFAULT_GROUP_OBSERVE_MS
): StopHandle {
  let stopped = false;
  let killFallback: NodeJS.Timeout | undefined;
  let terminal = false;
  /** The leader's `close` arrived — no second close will come to settle the verdict. */
  let closeObserved = false;
  /** The SIGKILL escalation has fired; settlement is no longer gated on the leader's close. */
  let escalated = false;
  /** First non-ESRCH signal failure of this teardown; keeps the verdict off `confirmed_stopped`. */
  let teardownFailure: string | undefined;
  /** The signal the group actually died from, carried into the stopped event. */
  let terminalSignal: NodeJS.Signals | null = null;

  const recordFailure = (detail: string): void => {
    teardownFailure ??= detail;
    log(`sandbox server: ${task_id}: ${detail}`);
  };

  const pushTerminal = (evidence: CleanupEvidence): void => {
    // EXIT: already terminal — competing stop / close / escalation events yield one transition.
    if (terminal) return;
    terminal = true;
    if (killFallback !== undefined) {
      clearTimeout(killFallback);
      killFallback = undefined;
    }
    channel.push({
      kind: "stopped",
      signal: terminalSignal,
      cleanup: evidence,
    });
    channel.close();
  };

  /**
   * Exit condition of the bounded teardown: the group was observed gone, or
   * the observation expired / a signal failed — which is `unconfirmed`, never
   * a stop. The window is bounded, so this always returns.
   *
   * The escalation is the ceiling: once it has fired, settlement no longer
   * waits for a leader that may never emit `close` (a signal that never landed
   * must not leave the task's consumers waiting forever). Before that point
   * the leader's `close` is the single settlement point, because a descendant
   * that is still draining must not be reported as a stop.
   */
  const observeAndSettle = async (): Promise<void> => {
    if (!closeObserved && !escalated) return;
    if (pgid === undefined) {
      pushTerminal(
        unconfirmedCleanup(
          0,
          "teardown_failed",
          "no process group to observe",
          task_id
        )
      );
      return;
    }
    const gone = await waitForProcessGroupGone(pgid, observeMs);
    if (gone) {
      pushTerminal(confirmedStopped(pgid, task_id));
      return;
    }
    pushTerminal(
      unconfirmedCleanup(
        pgid,
        teardownFailure !== undefined
          ? "teardown_failed"
          : "observation_expired",
        teardownFailure ??
          "process group still alive when the bounded observation ended",
        task_id
      )
    );
  };

  const stop = (graceMs?: number): Promise<void> => {
    const g = graceMs ?? defaultGraceMs;
    if (!Number.isInteger(g) || g < 0) {
      return Promise.reject({
        kind: "negative_argument",
        context: `stop: graceMs=${String(graceMs)} must be a non-negative integer`,
        cause: new RangeError("graceMs must be a non-negative integer"),
      } satisfies SandboxServerError);
    }
    if (stopped) return Promise.resolve();
    stopped = true;
    escalateToSigterm(child, pgid, log, recordFailure);
    if (g > 0) {
      killFallback = setTimeout(() => {
        killFallback = undefined;
        escalated = true;
        escalateToSigkill(child, pgid, log, recordFailure);
        // A leader that ignores SIGTERM never emits `close`, so the escalation
        // itself settles the verdict once the group drains (bounded).
        void observeAndSettle();
      }, g);
      // Deliberately not unref'd: when the leader has already closed, this
      // timer is the only path that reaps the surviving descendants.
      void observeAndSettle();
    } else {
      // graceMs=0 → SIGKILL immediately, skipping the setTimeout queue.
      escalated = true;
      escalateToSigkill(child, pgid, log, recordFailure);
      void observeAndSettle();
    }
    return Promise.resolve();
  };

  const settleTeardown = async (
    signal: NodeJS.Signals | null
  ): Promise<void> => {
    if (terminal) return;
    terminalSignal ??= signal;
    closeObserved = true;
    await observeAndSettle();
  };

  return {
    stop,
    settleTeardown,
    get stopped() {
      return stopped;
    },
  };
}

/**
 * OrphanSettler factory — the closure owns child/pgid/log/channel/rejectHandle/settled.
 * Why a factory: the inlined version inside runSpawnNode mixed 4 mutable
 * states + side effects in one orchestrator function, blowing past the 60-line
 * hard cap of the complexity gate.
 */
export interface OrphanSettler {
  settle(cause: unknown): void;
  get settled(): boolean;
}

export function createOrphanSettler(
  child: ChildProcess,
  pgid: number | undefined,
  task_id: string,
  channel: EventChannel,
  rejectHandle: (err: SandboxServerError) => void,
  log: (msg: string) => void
): OrphanSettler {
  let settled = false;
  const settle = (cause: unknown): void => {
    if (settled) return;
    settled = true;
    try {
      escalateToSigkill(child, pgid, log);
    } finally {
      channel.close();
      rejectHandle(
        orphanGroupError(
          `spawn ${task_id}: accept 后子进程异常退出未回执: ${String(cause)}`,
          pgid
        )
      );
    }
  };
  return {
    settle,
    get settled() {
      return settled;
    },
  };
}
