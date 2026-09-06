/**
 * ADR-0045 — sandbox server 内部 helper:spawn 子流程抽取。
 *
 * `server/index.ts` 的 spawn orchestrator 仅持有"协议形状";具体
 * 节点创建、SIGTERM→SIGKILL 升级、queue/sentinel 都落在此文件。本文件
 * 不对外导出,仅供 `server/index.ts` 内部使用。
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

/** 节点常量 —— 默认 killGraceMs(沿 ADR-0021 D1.7 形态)。 */
export const DEFAULT_KILL_GRACE_MS = 2_000;

/** 生成 `bg-` + 12 hex task_id(沿 ADR-0021 D1.7)。 */
export function newTaskId(): string {
  return `bg-${randomBytes(6).toString("hex")}`;
}

/** nodeSpawn detached child —— 唯一 spawn 形态,集中 fenced cwd/env/detached。 */
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

/** 拼 log 路径 —— `cwd` 落地,与 manager.ts:466 同形。 */
export function logPathFor(cwd: string, taskId: string): string {
  return join(cwd, `.iknow-bg-${taskId}.log`);
}

/** 触发 SIGKILL 升级 —— killTimer 回调与 graceMs=0 即时分支共用。 */
export function escalateToSigkill(
  child: ChildProcess,
  pid: number | undefined,
  log: (msg: string) => void
): void {
  if (pid === undefined) return;
  try {
    child.kill("SIGKILL");
  } catch {
    /* ESRCH / EPIPE 吞 */
  }
  killProcessGroup(pid, "SIGKILL", log);
}

/** 触发 SIGTERM 升级 —— stop 入口共用。 */
export function escalateToSigterm(
  child: ChildProcess,
  pid: number | undefined,
  log: (msg: string) => void
): void {
  if (pid === undefined) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* ESRCH / EPIPE 吞 */
  }
  killProcessGroup(pid, "SIGTERM", log);
}

/** 把 stdout/stderr chunk append 到 log 文件 —— 串行 writeChain 避免竞态。 */
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
 * queue + pending consumers 容器 —— 单 producer(spawn 节点)+ 多
 * consumer(`events()` 多次调用 = 抢事件,见 SandboxTaskHandle.events
 * JSDoc 的 single-consumer 契约)。
 *
 * Why a class-like factory:`push` / `next` / `close` 三操作原内嵌在
 * spawn 闭包里 30+ 行,抽离后 spawn orchestrator 瘦身到只持有协议线
 * (abort / handle 构造)。
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

/** 把 close sentinel 转成 AsyncIterable 包装(SandboxTaskEvent 流)。 */
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

/** 把 stdout/stderr data 接到 channel + log writer。 */
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
 * close handler —— settled 短路 + cancelKillTimer + exit/stopped 事件 +
 * close channel。
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

/** error handler —— log + typed orphan fail-loud。 */
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
 * external AbortSignal 接线 —— 短生命周期透传到 spawn,长生命周期经 stop() 升级。
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
 * 拼 handle —— task_id + log_path + events stream + stop 控制面。
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

/** 内部 typed error helper —— factory 内统一构造 typed-error。 */
export function orphanGroupError(
  context: string,
  pgid: number | undefined
): SandboxServerError {
  return pgid === undefined
    ? { kind: "orphan_process_group", context }
    : { kind: "orphan_process_group", context, pgid };
}

/** stop 控制面 —— 闭包持有 child/pgid/log/stopped/killFallback。 */
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
      // graceMs=0 → 立刻 SIGKILL,不进 setTimeout 排队。
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
 * settleWithOrphan 工厂 —— 闭包持有 child/pgid/log/channel/rejectHandle/settled。
 * Why a factory:runSpawnNode 内联版本把 4 个可变状态 + 副作用都揉在
 * orchestrator 函数里,135 行超硬门 60 行(S5 complexity-anti-drift)。
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
