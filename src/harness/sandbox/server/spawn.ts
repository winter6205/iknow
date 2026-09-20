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

import { killProcessGroup } from "../runner.js";
import type {
  QueuedTaskEvent,
  SandboxServerError,
  SandboxTaskEvent,
  SandboxTaskHandle,
} from "./types.js";

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
  log: (msg: string) => void
): void {
  if (pid === undefined) return;
  try {
    child.kill("SIGKILL");
  } catch {
    /* swallow ESRCH / EPIPE */
  }
  killProcessGroup(pid, "SIGKILL", log);
}

/** Trigger the SIGTERM escalation — shared by all stop entry points. */
export function escalateToSigterm(
  child: ChildProcess,
  pid: number | undefined,
  log: (msg: string) => void
): void {
  if (pid === undefined) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* swallow ESRCH / EPIPE */
  }
  killProcessGroup(pid, "SIGTERM", log);
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
 * close handler — settled short-circuit + cancelKillTimer + exit/stopped
 * events + channel close.
 */
export function onChildClose(
  child: ChildProcess,
  channel: EventChannel,
  orphan: OrphanSettler,
  stopHandle: StopHandle
): void {
  child.once("close", (code, signal) => {
    if (orphan.settled) return;
    stopHandle.cancelKillTimer();
    channel.push({ kind: "exit", exit_code: code, signal });
    if (stopHandle.stopped && signal !== null) {
      channel.push({ kind: "stopped", signal });
    }
    channel.close();
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
  cancelKillTimer(): void;
  readonly stopped: boolean;
}

export function createStopHandle(
  child: ChildProcess,
  pgid: number | undefined,
  task_id: string,
  defaultGraceMs: number,
  log: (msg: string) => void
): StopHandle {
  let stopped = false;
  let killFallback: NodeJS.Timeout | undefined;

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
    try {
      escalateToSigterm(child, pgid, log);
    } catch (cause) {
      return Promise.reject({
        kind: "server_unreachable",
        context: `stop ${task_id}: kill escalation failed`,
        cause,
      } satisfies SandboxServerError);
    }
    if (g > 0) {
      killFallback = setTimeout(() => {
        killFallback = undefined;
        escalateToSigkill(child, pgid, log);
      }, g);
      killFallback.unref?.();
    } else {
      // graceMs=0 → SIGKILL immediately, skipping the setTimeout queue.
      escalateToSigkill(child, pgid, log);
    }
    return Promise.resolve();
  };

  const cancelKillTimer = (): void => {
    if (killFallback !== undefined) {
      clearTimeout(killFallback);
      killFallback = undefined;
    }
  };

  return {
    stop,
    cancelKillTimer,
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
