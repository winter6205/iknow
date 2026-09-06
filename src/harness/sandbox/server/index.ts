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
 * 4 类故障路径(ADR-0045 §4):empty / negative / concurrent / exception
 * —— typed error 抛在 ./types.ts SandboxServerError 判别联合上,client
 * 按 kind 分支。overflow 已合并进 truncateByCodePoint 契约(§2.1 语义
 * 已如此),不抛 typed error。fail-loud 纪律(§5):server 不可达 typed
 * fail-loud 不静默降级;ctx.signal abort 不只丢 promise —— spawn 协议
 * 经 stop control message 取消,exec 协议经 AbortSignal 透传到
 * spawnWithStopSignal(runner.ts:131-132)。
 *
 * 降级:runInSandbox(runner.ts:184)与 defaultBackgroundSpawn
 * (manager.ts:239)在迁移期内降级为 router handler 的薄包装,不删
 * (兼容既有 30+ fixture)。本文件不重新实现 spawn 逻辑 —— 仍走
 * runner.ts spawnWithStopSignal 与 manager.ts nodeSpawn 既有路径。
 */

import {
  DEFAULT_MAX_OUTPUT_CODE_POINTS,
  signalExitCode,
  truncateByCodePoint,
} from "../runner.js";
import { spawnWithStopSignal } from "../runner.js";
import type { SandboxServerError } from "./types.js";
import type {
  ExecRequest,
  ExecResponse,
  SandboxTaskHandle,
  SpawnRequest,
} from "./types.js";
import {
  assembleHandle,
  createEventChannel,
  createOrphanSettler,
  createStopHandle,
  DEFAULT_KILL_GRACE_MS,
  logPathFor,
  makeLogWriter,
  newTaskId,
  onChildClose,
  onChildError,
  spawnDetached,
  wireAbortSignal,
  wireChildStreamHandlers,
} from "./spawn.js";

/** 同进程 router 形态:无可观察状态、无 server、无 socket、无 fork。 */
export interface SandboxServer {
  readonly exec: (req: ExecRequest) => Promise<ExecResponse>;
  readonly spawn: (req: SpawnRequest) => Promise<SandboxTaskHandle>;
}

/** router 工厂选项 —— 当前为占位(ADR-0045 §3 留 client 侧的
 *  violation-handling 不进 server;后续若有 process-level 治理需要
 *  在此添加,工厂仍无 server 形态)。 */
export interface CreateSandboxServerOptions {
  /** server 内 spawn 失败时日志;缺省静默。 */
  readonly log?: (msg: string) => void;
}

/**
 * fence + cwd 校验 —— exec 与 spawn 共享。空帧 typed fail-loud,
 * 不 spawn(ADR-0045 §4 empty 路径)。
 */
function validateFenceAndCwd(
  req: ExecRequest | SpawnRequest,
  op: "exec" | "spawn"
): void {
  if (
    !req.fence ||
    !Array.isArray(req.fence.argv) ||
    req.fence.argv.length === 0
  ) {
    throw {
      kind: "empty_request",
      context: `${op}: fence missing or has empty argv`,
    } satisfies SandboxServerError;
  }
  if (typeof req.cwd !== "string" || req.cwd.length === 0) {
    throw {
      kind: "empty_request",
      context: `${op}: cwd required`,
    } satisfies SandboxServerError;
  }
}

/** 负数 / 非整数参数校验 —— 透传 RangeError 给 client catch。 */
function validateNumericArgs(
  req: ExecRequest | SpawnRequest,
  op: "exec" | "spawn"
): void {
  if (
    "maxOutputCodePoints" in req &&
    req.maxOutputCodePoints !== undefined &&
    (!Number.isInteger(req.maxOutputCodePoints) || req.maxOutputCodePoints < 0)
  ) {
    throw {
      kind: "negative_argument",
      context: `${op}: maxOutputCodePoints=${req.maxOutputCodePoints} must be a non-negative integer`,
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
      context: `${op}: killGraceMs=${req.killGraceMs} must be a non-negative integer`,
      cause: new RangeError("killGraceMs must be a non-negative integer"),
    } satisfies SandboxServerError;
  }
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
    validateFenceAndCwd(req, "exec");
    validateNumericArgs(req, "exec");
    // signal.aborted 初始态也走 exec:handler 立即把 signal 透传到 spawnWithStopSignal
    // (runner.ts:131-132)。此处只验 frame 完整,fence 自身已封冻 argv。
    const maxOutputCodePoints =
      req.maxOutputCodePoints ?? DEFAULT_MAX_OUTPUT_CODE_POINTS;
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
    try {
      const result = await done;
      return {
        exitCode: result.code ?? signalExitCode(result.signal),
        stdout: truncateByCodePoint(result.stdout, maxOutputCodePoints),
        stderr: truncateByCodePoint(result.stderr, maxOutputCodePoints),
      };
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
  }

  // ─── long-lived spawn ────────────────────────────────────────────────
  function spawn(req: SpawnRequest): Promise<SandboxTaskHandle> {
    validateFenceAndCwd(req, "spawn");
    validateNumericArgs(req, "spawn");
    const killGraceMs = req.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const task_id = newTaskId();
    const log_path = logPathFor(req.cwd, task_id);
    return runSpawnNode(req, task_id, log_path, killGraceMs, log);
  }

  return { exec, spawn };
}

/** spawn 节点 —— 持有进程 + 事件通道 + stop 升级。失败统一 typed error。 */
function runSpawnNode(
  req: SpawnRequest,
  task_id: string,
  log_path: string,
  killGraceMs: number,
  log: (msg: string) => void
): Promise<SandboxTaskHandle> {
  return new Promise<SandboxTaskHandle>((resolveHandle, rejectHandle) => {
    const child = spawnDetached(req.fence.argv, req.cwd, req.env);
    const pgid = child.pid;
    const channel = createEventChannel();
    const writer = makeLogWriter(log_path, task_id, log);
    const orphan = createOrphanSettler(
      child,
      pgid,
      task_id,
      channel,
      rejectHandle,
      log
    );
    const stopHandle = createStopHandle(child, pgid, task_id, killGraceMs, log);
    wireChildStreamHandlers(child, channel, writer);
    onChildError(child, orphan, task_id, log);
    onChildClose(child, channel, orphan, stopHandle);
    wireAbortSignal(req.signal, stopHandle, killGraceMs);
    const handle = assembleHandle(task_id, log_path, channel, stopHandle);
    // Defer resolveHandle 一拍(setImmediate),让 spawn 失败的 child.once("error")
    // 事件先到达 orphan.settle → rejectHandle;否则 resolve 先发,reject
    // 被吞,typed orphan_process_group 不可观察(fail-loud 破裂)。
    setImmediate(() => {
      if (!orphan.settled) resolveHandle(handle);
    });
  });
}

/** 不暴露内部;消费方拿到 handle 后 stop() / events()。 */
export type {
  ExecRequest,
  ExecResponse,
  SpawnRequest,
  SandboxTaskEvent,
  SandboxTaskHandle,
  SandboxServerError,
  QueuedTaskEvent,
} from "./types.js";
export { renderSandboxServerError } from "./types.js";
