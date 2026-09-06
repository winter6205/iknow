/**
 * ADR-0045 — sandbox 执行面同进程 router。
 *
 * 形态:可挂载工厂(createTraceRouter 同款,traceserver/serve.ts:61)。
 * 无 socket / 无 fork / 无 daemon —— 三个消费方(bash 前台 / verify /
 * 后台)全在同一 Node 进程内,harness 装配期持一份 router 引用。
 *
 * 两型协议(消息合同见 ./types.ts):
 *   - exec(req): 短生命周期 request/response,等子进程退出取一次性结果。
 *   - spawn(req): 长生命周期 task-handle,同步 resolve task_id,返回
 *     handle 暴露 stdout/stderr/exit/stopped AsyncIterable + stop
 *     control message(SIGTERM → graceMs → SIGKILL 升级)。
 *
 * 5 类故障路径(ADR-0045 §4):empty / negative / overflow / concurrent /
 * exception —— typed error 抛在 ./types.ts SandboxServerError 判别联合
 * 上,client 按 kind 分支。fail-loud 纪律(§5):server 不可达 typed
 * fail-loud 不静默降级;ctx.signal abort 不只丢 promise —— spawn 协议
 * 经 stop control message 取消,exec 协议经 AbortSignal 透传到
 * spawnWithStopSignal(runner.ts:131-132)。
 *
 * 降级:runInSandbox(runner.ts:184)与 defaultBackgroundSpawn
 * (manager.ts:239)在迁移期内降级为 router handler 的薄包装,不删
 * (兼容既有 30+ fixture)。本文件不重新实现 spawn 逻辑 —— 仍走
 * runner.ts spawnWithStopSignal 与 manager.ts nodeSpawn 既有路径。
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { spawnWithStopSignal } from "../runner.js";
import {
  DEFAULT_MAX_OUTPUT_CODE_POINTS,
  signalExitCode,
  truncateByCodePoint,
} from "../runner.js";
import type { SandboxServerError } from "./types.js";
import type {
  ExecRequest,
  ExecResponse,
  SandboxTaskEvent,
  SandboxTaskHandle,
  SpawnRequest,
} from "./types.js";

/** 同进程 router 形态:无可观察状态、无 server、无 socket、无 fork。 */
export interface SandboxServer {
  readonly exec: (req: ExecRequest) => Promise<ExecResponse>;
  readonly spawn: (req: SpawnRequest) => Promise<SandboxTaskHandle>;
}

/** router 工厂选项 —— 当前为占位(ADR-0045 §3 留 client 侧的
 *  violation-handling 不进 server;后续若有 process-level 治理需要
 * 在此添加,工厂仍无 server 形态)。 */
export interface CreateSandboxServerOptions {
  /** server 内 spawn 失败时日志;缺省静默。 */
  readonly log?: (msg: string) => void;
}

/**
 * factory —— 无 server、无共享 mutable state;调用方在装配期持一份
 * router 引用;三处消费方(bash 前台 / verify / background)共用。
 * (mirror `createTraceRouter` 形态,traceserver/serve.ts:61。)
 */
export function createSandboxServer(
  opts: CreateSandboxServerOptions = {}
): SandboxServer {
  const log = opts.log ?? (() => undefined);

  // ─── short-lived exec ────────────────────────────────────────────────
  async function exec(req: ExecRequest): Promise<ExecResponse> {
    // empty fence:缺 fence / fence.argv 缺失 → typed fail-loud,不 spawn。
    if (
      !req.fence ||
      !Array.isArray(req.fence.argv) ||
      req.fence.argv.length === 0
    ) {
      throw {
        kind: "empty_request",
        context: "exec: fence missing or has empty argv",
      } satisfies SandboxServerError;
    }
    if (typeof req.cwd !== "string" || req.cwd.length === 0) {
      throw {
        kind: "empty_request",
        context: "exec: cwd required",
      } satisfies SandboxServerError;
    }
    // negative:maxOutputCodePoints / killGraceMs 越界 —— 沿 runner.ts:84-86
    // truncateByCodePoint 契约抛 RangeError(typed error 捕获处仍 typed)。
    const maxOutputCodePoints =
      req.maxOutputCodePoints ?? DEFAULT_MAX_OUTPUT_CODE_POINTS;
    if (
      req.maxOutputCodePoints !== undefined &&
      (!Number.isInteger(req.maxOutputCodePoints) ||
        req.maxOutputCodePoints < 0)
    ) {
      throw {
        kind: "negative_argument",
        context: `exec: maxOutputCodePoints=${req.maxOutputCodePoints} must be a non-negative integer`,
        cause: new RangeError(
          "maxOutputCodePoints must be a non-negative integer"
        ),
      } satisfies SandboxServerError;
    }
    if (
      req.killGraceMs !== undefined &&
      (!Number.isInteger(req.killGraceMs) || req.killGraceMs < 0)
    ) {
      throw {
        kind: "negative_argument",
        context: `exec: killGraceMs=${req.killGraceMs} must be a non-negative integer`,
        cause: new RangeError("killGraceMs must be a non-negative integer"),
      } satisfies SandboxServerError;
    }
    // signal.aborted 初始态也走 exec:handler 立即把 signal 透传到 spawnWithStopSignal
    // (runner.ts:131-132)。此处只验 frame 完整,fence 自身已封冻 argv。
    const { done } = spawnWithStopSignal(
      req.fence.argv[0] as string,
      req.fence.argv.slice(1),
      {
        cwd: req.cwd,
        signal: req.signal,
        env: req.env,
        killGraceMs: req.killGraceMs,
      }
    );
    let result: {
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    };
    try {
      result = await done;
    } catch (cause) {
      // exception:子进程退出未回执 / spawn 失败 —— typed fail-loud,
      // 不静默降级。orphan 进程组 reap 纪律交给 spawnWithStopSignal(其
      // 已对 abort / kill 升级托管);此处只把 spawn failure 转 typed error。
      throw {
        kind: "server_unreachable",
        context: `exec: spawn failed for fence argv[0]=${String(req.fence.argv[0])}`,
        cause,
      } satisfies SandboxServerError;
    }
    // overflow:server 端截断后下发,不把未截断字节送回 client。
    return {
      exitCode: result.code ?? signalExitCode(result.signal),
      stdout: truncateByCodePoint(result.stdout, maxOutputCodePoints),
      stderr: truncateByCodePoint(result.stderr, maxOutputCodePoints),
    };
  }

  // ─── long-lived spawn ────────────────────────────────────────────────
  function spawn(req: SpawnRequest): Promise<SandboxTaskHandle> {
    return new Promise((resolveHandle) => {
      // empty fence 校验 —— 短生命周期 exec 同款。
      if (
        !req.fence ||
        !Array.isArray(req.fence.argv) ||
        req.fence.argv.length === 0
      ) {
        // typed fail-loud 不 spawn。async Promise 也走 sync throw 让
        // handler catch(typed-error catch 契约不依赖 throw 时机)。
        throw {
          kind: "empty_request",
          context: "spawn: fence missing or has empty argv",
        } satisfies SandboxServerError;
      }
      if (typeof req.cwd !== "string" || req.cwd.length === 0) {
        throw {
          kind: "empty_request",
          context: "spawn: cwd required",
        } satisfies SandboxServerError;
      }
      if (
        req.killGraceMs !== undefined &&
        (!Number.isInteger(req.killGraceMs) || req.killGraceMs < 0)
      ) {
        throw {
          kind: "negative_argument",
          context: `spawn: killGraceMs=${req.killGraceMs} must be a non-negative integer`,
          cause: new RangeError("killGraceMs must be a non-negative integer"),
        } satisfies SandboxServerError;
      }

      const killGraceMs = req.killGraceMs ?? 2_000;
      const task_id = `bg-${randomBytes(6).toString("hex")}`;
      const log_path = join(req.cwd, `.iknow-bg-${task_id}.log`);

      const child: ChildProcess = nodeSpawn(
        req.fence.argv[0] as string,
        req.fence.argv.slice(1),
        {
          cwd: req.cwd,
          env: req.env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        }
      );

      // process-group leader:child.pid = pgid(detached:true;manager.ts:288)。
      const pid = child.pid;
      const pgid = pid; // detached 进程组 leader pgid == pid

      // event queue + signal —— long-lived protocol;queue 长度无界(stdout
      // 不截断,manager.log appendFile 是外部约束),但 unref 防止 back-pressure
      // 滞留测试进程。
      const queue: SandboxTaskEvent[] = [];
      const pending: Array<(ev: SandboxTaskEvent) => void> = [];
      let closed = false;
      let killFallback: NodeJS.Timeout | undefined;
      let stopped = false;

      const push = (ev: SandboxTaskEvent): void => {
        if (closed) return;
        const next = pending.shift();
        if (next) {
          next(ev);
        } else {
          queue.push(ev);
        }
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        if (killFallback !== undefined) {
          clearTimeout(killFallback);
          killFallback = undefined;
        }
        // drain pending consumers with done sentinel.
        while (pending.length > 0) {
          const next = pending.shift()!;
          next(undefined as unknown as SandboxTaskEvent);
        }
      };

      const killProcessGroup = (signal: NodeJS.Signals): void => {
        if (pid === undefined) return;
        try {
          process.kill(-pid, signal);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ESRCH") {
            log(
              `sandbox server: kill -${pid} ${signal} failed: ${String(err)}`
            );
          }
        }
      };

      const stop = (graceMs?: number): Promise<void> => {
        const g = graceMs ?? killGraceMs;
        if (!Number.isInteger(g) || g < 0) {
          return Promise.reject({
            kind: "negative_argument",
            context: `stop: graceMs=${String(graceMs)} must be a non-negative integer`,
            cause: new RangeError("graceMs must be a non-negative integer"),
          } satisfies SandboxServerError);
        }
        if (stopped) return Promise.resolve();
        stopped = true;
        // SIGTERM 先到;g ms 后仍未 exit(SIGTERM→SIGKILL 升级沿
        // manager.ts:587-624 纪律)。
        try {
          if (pid !== undefined) {
            try {
              child.kill("SIGTERM");
            } catch {
              /* ESRCH / EPIPE 吞 */
            }
            killProcessGroup("SIGTERM");
          }
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
            if (pid === undefined) return;
            try {
              child.kill("SIGKILL");
            } catch {
              /* swallow */
            }
            killProcessGroup("SIGKILL");
          }, g);
          killFallback.unref?.();
        } else {
          // graceMs=0 → 立刻 SIGKILL。
          if (pid !== undefined) {
            try {
              child.kill("SIGKILL");
            } catch {
              /* swallow */
            }
            killProcessGroup("SIGKILL");
          }
        }
        return Promise.resolve();
      };

      // event streams — log file append 镜像 manager.ts:466-471 的
      // writeChain 串行(避免 stdout/stderr 与 file append 竞态)。
      const writeChain: Promise<void> = Promise.resolve();
      const enqueue = (chunk: Buffer | string): void => {
        const chain = writeChain.then(() =>
          appendFile(log_path, chunk, "utf8").catch(() => {
            log(`sandbox server: log append failed for ${task_id}`);
          })
        );
        // 异步尾追到 chain,不阻塞 emit 路径。
        void chain;
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        push({ kind: "stdout", chunk });
        enqueue(chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        push({ kind: "stderr", chunk });
        enqueue(chunk);
      });

      child.once("error", (cause) => {
        log(`sandbox server: child error ${task_id}: ${String(cause)}`);
        push({
          kind: "exit",
          exit_code: null,
          signal: null,
        });
        // exception:orphan 进程组 reap —— starttime 不一致 / pgid 已被回收
        // 时只标死、不 kill(镜像 stale-reap.ts:184);一致则 SIGKILL。
        if (pgid !== undefined) {
          try {
            process.kill(-pgid, "SIGKILL");
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ESRCH") {
              log(
                `sandbox server: orphan reap kill -${pgid} failed: ${String(err)}`
              );
            }
          }
        }
        close();
      });

      child.once("close", (code, signal) => {
        push({
          kind: "exit",
          exit_code: code,
          signal,
        });
        if (stopped && signal !== null) {
          push({ kind: "stopped", signal });
        }
        close();
      });

      // external abort(短生命周期透传到 spawn,长生命周期经 stop() 升级)—
      // — client 端 ctx.signal abort 必须把信号传到 fence 子进程,不只丢
      // client promise。
      if (req.signal?.aborted) {
        void stop(killGraceMs);
      } else {
        req.signal?.addEventListener(
          "abort",
          () => {
            void stop(killGraceMs);
          },
          { once: true }
        );
      }

      const handle: SandboxTaskHandle = {
        task_id,
        log_path,
        events(): AsyncIterable<SandboxTaskEvent> {
          if (closed) {
            return (async function* () {
              /* empty */
            })();
          }
          const iterable = {
            [Symbol.asyncIterator]() {
              return {
                next(): Promise<IteratorResult<SandboxTaskEvent>> {
                  if (queue.length > 0) {
                    return Promise.resolve({
                      value: queue.shift() as SandboxTaskEvent,
                      done: false,
                    });
                  }
                  if (closed) {
                    return Promise.resolve({
                      value: undefined as unknown as SandboxTaskEvent,
                      done: true,
                    });
                  }
                  return new Promise<IteratorResult<SandboxTaskEvent>>(
                    (res) => {
                      pending.push((ev: SandboxTaskEvent) => {
                        if (ev === undefined) {
                          res({
                            value: undefined as unknown as SandboxTaskEvent,
                            done: true,
                          });
                        } else {
                          res({ value: ev, done: false });
                        }
                      });
                    }
                  );
                },
              };
            },
          };
          return iterable;
        },
        stop,
      };
      resolveHandle(handle);
    });
  }

  return { exec, spawn };
}

/**
 * 工厂的无 task_id task 工厂 —— 测试 seam:把 task_id 外部注入,便于
 * 测试「empty_task_id」一类 typed error 路径(工厂内部生成无法覆盖)。
 * 生产路径仍走默认 createSandboxServer(opts) → randomBytes。
 */
export interface TestSandboxServerHandle {
  readonly server: SandboxServer;
  readonly resolveHandle: (h: SandboxTaskHandle) => void;
}

export function createTestSandboxServer(
  opts: CreateSandboxServerOptions = {}
): TestSandboxServerHandle {
  let resolveHandleExternal: (h: SandboxTaskHandle) => void = () => undefined;
  const realServer = createSandboxServer(opts);
  const server: SandboxServer = {
    exec: realServer.exec,
    spawn: (_req) =>
      new Promise<SandboxTaskHandle>((resolve) => {
        resolveHandleExternal = resolve;
      }),
  };
  return { server, resolveHandle: (h) => resolveHandleExternal(h) };
}

/** 不暴露内部;消费方拿到 handle 后 stop() / events()。 */
export type {
  ExecRequest,
  ExecResponse,
  SpawnRequest,
  SandboxTaskEvent,
  SandboxTaskHandle,
  SandboxServerError,
} from "./types.js";
export { renderSandboxServerError } from "./types.js";
