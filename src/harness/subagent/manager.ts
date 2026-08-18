/**
 * #356 T2 — SubAgentManager:父代理侧子代理生命周期 / 状态机 / 浓缩 buffer /
 * shutdown 链。
 *
 * 与 mcp/manager.ts:266-306 蓝本同构(abort in-flight + SIGTERM + SIGKILL 兜底)。
 * DI 边界:manager 自身不 import child_process(运行时),spawn 工厂由调用方注入,
 * 避免与 worker.ts 共享子进程类型的运行时耦合;生产 spawn 实现 defaultSubAgentSpawn
 * 在 ./spawn.ts,T6 接线时由 build-engine 注入。
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import { parseParentEnvelope, truncateEnvelopeResult } from "./envelope.js";
import type { SubAgentEnvelope, WorkerEnvelope } from "./envelope.js";
import type { SubAgentDefinition } from "./role.js";
import { SubAgentSandboxRootError } from "../errors.js";
import type {
  TraceService,
  SubagentStopRecord,
  SubagentStateChangeRecord,
  SubagentState,
} from "../trace/index.js";
import { safeTrace } from "../trace/safe-trace.js";

// re-export: manager 的调用方(T4/T5 工具、host-drain)统一从 manager 侧拿
// SubAgentDefinition,不必各自 import role.js。
export type { SubAgentDefinition } from "./role.js";

export type QueryBufferResult =
  | { status: "not_found" }
  | { status: "running" }
  | SubAgentEnvelope // completed
  | {
      status: "failed";
      reason: "crashed" | "maxTurnsExceeded" | "timeout" | "protocolError";
      summary: string;
    };

/**
 * #358 T7: Session API 只读投影的最小状态面 (spec Code Style 137)。
 * 字段集与 trace SubagentSpawnRecord 对齐,但截断语义不同:
 * taskPreview 截断 ≤120 (权限行,不落 task 全文 —— spec 358 权限 row)。
 * Postel: endedAt/summary/reason 仅终态且有值时在场, running 态缺席。
 */
export interface SubagentInfo {
  readonly taskId: string;
  readonly state: "starting" | "running" | "completed" | "failed";
  readonly taskPreview: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly summary?: string;
  readonly reason?: string;
}

export interface SubAgentManager {
  /**
   * 同步入 map 立即返回 taskId(manager 内部 randomUUID() 唯一真值,SC3)。
   * #361 C1:running+starting 数 ≥ MAX_CONCURRENT_WORKERS 时立即抛
   * SubAgentCapacityError(handler 接住后抛 ToolExecutionError)。
   */
  readonly spawn: (def: SubAgentDefinition) => { readonly taskId: string };
  /** 同步非阻塞四态查询(SC5)。 */
  readonly queryBuffer: (taskId: string) => QueryBufferResult;
  /**
   * #361 C3: 第三参 `signal?: AbortSignal` —— caller abort → reject
   * SubAgentAbortError(与 SubAgentWaitTimeoutError 类型区分)。首查终态路径
   * 保留(立即 resolve,不经 interval)。timeoutMs 缺省走 #358 T2 三层链
   * (def.timeoutMs ?? opts.taskTimeoutMs ?? PER_TASK_TIMEOUT_MS)。
   */
  readonly waitFor: (
    taskId: string,
    timeoutMs?: number,
    signal?: AbortSignal
  ) => Promise<SubAgentEnvelope>;
  /** abort in-flight + SIGTERM 子孙 + ≥5s 兜底 SIGKILL(SC12)。 */
  readonly shutdown: () => Promise<void>;
  /** T7 host-drain 需要的最小只读枚举:返回当前 buffer 内 completed 任务列表。 */
  readonly drainCompleted: () => ReadonlyArray<{
    readonly taskId: string;
    readonly envelope: SubAgentEnvelope;
  }>;
  /**
   * #361 C2: host-drain 阻塞轮询所需的非终态任务 ID 列表(starting + running)。
   * completed / failed 不出现;host drain 据此判断"无任务→"" vs "仅 running→轮询"。
   */
  readonly listActive: () => ReadonlyArray<string>;
  /**
   * #361 T5: 主动 abort 单任务 → 传播 task.abortCtrl.abort + child.SIGTERM +
   * 5s SIGKILL 兜底(以本次 SIGTERM 为基准重排,review-fix S1)。对未找到 /
   * 已终态任务 no-op。
   */
  readonly abortTask: (taskId: string) => boolean;
  /**
   * #358 T7: 只读全量枚举(starting/running/completed/failed 合一) — Session
   * API GET /sessions/:id/subagents 端点消费。数据源 = 内存 map + 终态
   * envelope(与 queryBuffer/drainCompleted 同真值),不在端点侧做任务寿命
   * 语义决策。taskPreview 截断 ≤120 见 SubagentInfo 注释。
   */
  readonly listSubagents: () => ReadonlyArray<SubagentInfo>;
}

/** spawn DI 工厂签名:由调用方注入(fake 测试 / 生产 defaultSubAgentSpawn)。 */
export type SubAgentSpawn = (
  def: SubAgentDefinition,
  taskId: string,
  stdinPayload: WorkerEnvelope
) => ChildProcess;

/** waitFor 超时 / shutdown 收口的 typed 拒绝原因(status/reason 常量透传给调用方)。 */
export class SubAgentWaitTimeoutError extends Error {
  override readonly name = "SubAgentWaitTimeoutError";
  readonly status = "failed" as const;
  readonly reason = "timeout" as const;
}

/**
 * #361 C1: 父代理侧并发 worker 上限。spawn 入口 running+starting 数 ≥ 此值
 * 立即抛 SubAgentCapacityError(显式失败,模型可降并发重试;不 queue 不静默)。
 */
export const MAX_CONCURRENT_WORKERS = 4;

/**
 * #361 C1: spawn 并发超限 typed 拒绝。字段 `{ status:"failed", reason:"capacity",
 * active }` 透传。message 含 capacity + 4/4(handler 用作 ToolExecutionError 文案)。
 */
export class SubAgentCapacityError extends Error {
  override readonly name = "SubAgentCapacityError";
  readonly status = "failed" as const;
  readonly reason = "capacity" as const;
  readonly active: number;
  constructor(active: number) {
    super(
      `spawn_subagent: at capacity (${active}/${MAX_CONCURRENT_WORKERS} concurrent workers). Requeue after a worker completes or reduce parallelism.`
    );
    this.active = active;
  }
}

/**
 * #361 C3: waitFor 收到 AbortSignal abort → typed 拒绝(与 SubAgentWaitTimeoutError
 * 类型区分)。字段 `{ status:"failed", reason:"aborted", taskId }`。
 * handler 捕获后抛 ToolExecutionError,executor 因 `signal.aborted === true`
 * 归一 `execution_failed:cancelled`(归因 = 调用侧取消)。
 */
export class SubAgentAbortError extends Error {
  override readonly name = "SubAgentAbortError";
  readonly status = "failed" as const;
  readonly reason = "aborted" as const;
  readonly taskId: string;
  constructor(taskId: string) {
    super(`waitFor aborted for task ${taskId}`);
    this.taskId = taskId;
  }
}

/**
 * #361 T13 / #358 T2: per-task 缺省 wallclock 7200s(2h)——spec Assumptions 1:
 * operator 真实使用数据表明子代理任务常态超过 1 小时,对齐 deer-flow 1800s
 * 实测再留余量;300s 原值无实测依据。
 * wait:true handler 显式传给 waitFor;manager 内部 spawn 的 per-task
 * SIGTERM 计时器也用此链末端常量作缺省,worker 侧 wallclock 与前景 wait 对齐。
 * 唯一声明点 (spec "per-task 缺省值归 T2 manager 消费点, 避免两处声明")。
 */
export const PER_TASK_TIMEOUT_MS = 7_200_000;

/**
 * #358 T2: per-task wallclock 三层缺省链 (spec SC4 / Assumptions 1):
 * `def.timeoutMs ?? opts.taskTimeoutMs ?? PER_TASK_TIMEOUT_MS`。
 * 语义分离 (C9): 这是任务寿命 (父 manager SIGTERM), 与 worker 内 per-call
 * 竞速 (deps.timeoutMs) 无关; 单一常量声明点保证缺省值不漂移。
 */
export function effectiveTaskTimeoutMs(
  def: SubAgentDefinition,
  opts: { readonly taskTimeoutMs?: number }
): number {
  return def.timeoutMs ?? opts.taskTimeoutMs ?? PER_TASK_TIMEOUT_MS;
}

/**
 * #358 review-fix (Fix 3): taskPreview SSOT —— 长度 + 来源统一。
 * 只取 `def.task`（不回落 def.systemPrompt），截断 ≤120 字符（默认）。
 * 两个消费面共用同一真值:
 *   - `recordSubagentSpawn` 的 subagent_spawn 落盘 taskPreview
 *   - `listSubagents` 的 HTTP/API 投影 taskPreview
 * 120 是 spec 权限行定案的 "least-privilege" 边界（task 全文不落盘 / 不
 * 上行）；trace 侧没有理由写更多，且 systemPrompt 纳入会扩大脱敏面。max
 * 参数供显式覆盖（当前无调用方传 <120 以下的更小值，保留参数防未来漂移）。
 */
export function truncateTaskPreview(
  def: SubAgentDefinition,
  max?: number
): string {
  return def.task?.slice(0, max ?? 120) ?? "";
}

type TaskState = "starting" | "running" | "completed" | "failed";

interface Task {
  readonly id: string;
  readonly def: SubAgentDefinition;
  state: TaskState;
  child?: ChildProcess;
  envelope?: SubAgentEnvelope;
  abortCtrl?: AbortController;
  /**
   * #356 High #2 fix: per-task timeout handle (def.timeoutMs expiry -> SIGTERM
   * + 5s fallback SIGKILL -> reason:"timeout"). shutdown / child exit /
   * terminal state must clear it to avoid leaks or stray SIGKILL.
   */
  timeoutTimer?: NodeJS.Timeout;
  /** #356 High #2 fix: SIGKILL 兜底 timer(exit / shutdown 需与 timeoutTimer 一并清)。 */
  timeoutKillFallback?: NodeJS.Timeout;
  /** #358 T4: startedAt ISO 戳 (subagent_spawn 落盘的 source)。
   *  Task 构造时即生成;后续 spawn/stop 都引用此 ISO。 */
  readonly startedAt: string;
  /** #358 T4: stoppedEmitted guard — subagent_stop 单点 single-emit
   * (exit handler 与 child.on("error")/timeout-fired 等多路径都可能触发终态);
   * flag 一旦置位不再覆写, 避免重复落盘。 */
  stoppedEmitted: boolean;
  /**
   * #358 T7: 终态 ISO 戳(仅簿记,不改状态机语义)。emitStop 内随
   * stoppedEmitted 锁存一次;listSubagents 读它当 endedAt。running/
   * starting 态缺席 → Postel 不上行。
   */
  endedAt?: string;
}

const WAIT_POLL_MS = 25;
const SHUTDOWN_SIGKILL_GRACE_MS = 5000;

/**
 * #361 T5: SIGKILL 兜底计时器(per-task timeout 与 abortTask 共用)。
 * `reset=true` 时先清已有兜底再以新基准重排(abortTask 场景:兜底基准从
 * 早前的 arm 点移到本次 SIGTERM 点 —— 避免旧兜底在 timeout SIGTERM 同点
 * 双发;review-fix S1)。child exit / shutdown / terminal state 清理见
 * exit handler / shutdown 循环。
 */
function armKillFallback(task: Task, reset = false): void {
  if (task.timeoutKillFallback !== undefined) {
    if (!reset) return;
    clearTimeout(task.timeoutKillFallback);
    task.timeoutKillFallback = undefined;
  }
  const killFallback = setTimeout(() => {
    if (task.child && task.child.exitCode === null) {
      try {
        task.child.kill("SIGKILL");
      } catch {
        /* ESRCH et al. ignore */
      }
    }
  }, SHUTDOWN_SIGKILL_GRACE_MS);
  killFallback.unref?.();
  task.timeoutKillFallback = killFallback;
}

export function createSubAgentManager(opts: {
  readonly spawn: SubAgentSpawn;
  /**
   * #357 T1: 父 sandboxRoot —— 父代理的"工作域"。`buildWorkerPayload` 单点校验
   * `def.sandboxRoot` 必须 prefix-of-parent(防任意路径提权)。缺省 = process.cwd()
   * (manager 直造场景,如既有的 manager.test.ts makeHarness);生产装配由 build-engine
   * 注入主代理的 sandboxRoot(SC8)。manager 自身不解析 opts.sandboxRoot —— 在
   * buildWorkerPayload 内 realpath 一次后冻结,worker fs 工具沿用同一 resolved 值。
   */
  readonly sandboxRoot?: string;
  /**
   * #358 T4: 可选 TraceService — 子代理生命周期三类事件 (subagent_spawn /
   * subagent_state_change / subagent_stop) 落盘。注入则通过 safeTrace 包裹
   * 发埋点;不注入则零副作用 (与既有行为 byte-stable)。
   */
  readonly trace?: TraceService;
  /**
   * #358 T2: per-task 缺省 wallclock (毫秒) — 消费链中段:
   * `def.timeoutMs ?? opts.taskTimeoutMs ?? PER_TASK_TIMEOUT_MS`。
   * 装配由 build-engine 从 env.subagent.taskTimeoutMs (settings/env 合并)
   * 透传;env 层无第三层默认 (常量唯一声明点在本文件)。
   */
  readonly taskTimeoutMs?: number;
}): SubAgentManager {
  const tasks = new Map<string, Task>();
  /** 所有未决 waitFor 的轮询句柄(非终态,shutdown 必须清,防进程悬挂)。 */
  const waitPollers = new Set<ReturnType<typeof setInterval>>();
  /** 未决 waitFor 的 settleReject 引用:shutdown 时主动拒绝,SC16 不悬挂。 */
  const waitRejecters = new Set<(reason: unknown) => void>();
  /** #358 T4: trace 句柄 closure 捕获, spawn/state_change/stop 三处共用。 */
  const trace = opts.trace;

  /**
   * #358 T4: emitStateChange — 任何 task.state 迁移点必经此处。
   * Postel: reason 仅 toState === "failed" 时填 (spec Code Style 121)。
   * 该函数: (1) 写入 task.state (2) 同步发 subagent_state_change 埋点 (3) 不 throw。
   * safeTrace 包裹: trace 写盘失败不阻塞 manager 业务。
   */
  function emitStateChange(
    task: Task,
    toState: SubagentState,
    opts2?: { readonly reason?: SubagentStateChangeRecord["reason"] }
  ): void {
    const fromState = task.state;
    // review-fix (Fix 2): 同态迁移 self-loop guard —— 状态机 "same state"
    // 迁移是 no-op。典型场景: SC6 优雅收尾时 timer fire 先 emitStateChange
    // (running → failed), 随后 worker 的 timeout envelope 在 stdout handler
    // 再次 emitStateChange (failed → failed) —— 前者已落盘, 后者若再写会
    // 产生 from_state === to_state === "failed" 的 spurious 记录。跳过 state
    // 赋值与 trace 两者 (既有 emitStop 的 stoppedEmitted 单点守门不覆盖这里:
    // state_change 没有等价 flag, 靠 prev === toState 判定)。
    if (fromState === toState) return;
    task.state = toState;
    if (!trace) return;
    void safeTrace(() =>
      trace.recordSubagentStateChange({
        id: task.id,
        taskId: task.id,
        origin: "parent",
        startedAt: task.startedAt,
        status: toState === "failed" ? "error" : "ok",
        ts: new Date().toISOString(),
        fromState,
        toState,
        ...(opts2?.reason !== undefined ? { reason: opts2.reason } : {}),
      })
    );
  }

  /**
   * #358 T4: emitStop — 任务终态时落 subagent_stop; stoppedEmitted flag 守门
   * 保证 single-emit (exit handler + timeout-fire + child.on("error") 多路径
   * 都可能触发终态); 已发则 no-op。
   * Postel: 缺省 reason = envelope.reason; summary = envelope.summary (failed 态必有)。
   */
  function emitStop(
    task: Task,
    finalState: "completed" | "failed",
    extras: {
      readonly exitCode?: number;
      readonly signal?: NodeJS.Signals | string;
      readonly reason?: SubagentStopRecord["reason"];
      readonly summary?: string;
    } = {}
  ): void {
    if (task.stoppedEmitted) return;
    task.stoppedEmitted = true;
    const endedAt = new Date().toISOString();
    // #358 T7: 终态 ISO 随 single-emit 锁存一次 (listSubagents 读它当 endedAt)。
    task.endedAt = endedAt;
    const durationMs = Math.max(
      0,
      Date.parse(endedAt) - Date.parse(task.startedAt)
    );
    if (!trace) return;
    void safeTrace(() =>
      trace.recordSubagentStop({
        id: task.id,
        taskId: task.id,
        origin: "parent",
        startedAt: task.startedAt,
        endedAt,
        durationMs,
        finalState,
        status: finalState === "failed" ? "error" : "ok",
        ts: endedAt,
        ...(extras.exitCode !== undefined ? { exitCode: extras.exitCode } : {}),
        ...(extras.signal !== undefined ? { signal: extras.signal } : {}),
        ...(extras.reason !== undefined ? { reason: extras.reason } : {}),
        ...(extras.summary !== undefined ? { summary: extras.summary } : {}),
      })
    );
  }

  function spawn(def: SubAgentDefinition): { readonly taskId: string } {
    // #361 C1: running+starting ≥ MAX_CONCURRENT_WORKERS 立即抛 SubAgentCapacityError。
    // 显式失败 > 静默排队(handler 接住后抛 ToolExecutionError,模型降并发重试)。
    let activeCount = 0;
    for (const t of tasks.values()) {
      if (t.state === "starting" || t.state === "running") activeCount++;
    }
    if (activeCount >= MAX_CONCURRENT_WORKERS) {
      throw new SubAgentCapacityError(activeCount);
    }

    // #357 T1: 校验必须在 opts.spawn 之前(否则 line 205 既有 try/catch 会把
    // 拒绝吞成 task failed)。也不在 tasks.set 之后 —— 提前抛出保证 map 无残留。
    // buildWorkerPayload 单点校验所有 spawn 路径(模型工具 + 判官 + 将来角色),
    // 校验失败同步抛 SubAgentSandboxRootError(handler 转 ToolExecutionError)。
    const payload = buildWorkerPayload(def);

    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const task: Task = {
      id,
      def,
      state: "starting",
      startedAt,
      stoppedEmitted: false,
    };
    tasks.set(id, task);

    let child: ChildProcess;
    try {
      child = opts.spawn(def, id, payload);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      task.envelope = {
        status: "failed",
        reason: "crashed",
        summary: `subagent spawn failed: ${errMsg}`,
        result: "",
      };
      // #358 T4: spawn 仍落 subagent_spawn (失败路径也记录尝试);
      // 紧接 emitStateChange(failed) + emitStop (single-emit lifecycle)。
      if (trace) {
        void safeTrace(() =>
          trace.recordSubagentSpawn({
            id: task.id,
            taskId: task.id,
            origin: "parent",
            startedAt: task.startedAt,
            status: "error",
            ts: new Date().toISOString(),
          })
        );
      }
      emitStateChange(task, "failed", { reason: "crashed" });
      emitStop(task, "failed", {
        reason: "crashed",
        summary: `subagent spawn failed: ${errMsg}`,
      });
      return { taskId: id };
    }
    task.child = child;
    task.abortCtrl = new AbortController();

    // #358 T4: subagent_spawn 在 child 成功 launch 后 emit (task.state 此时还是
    // "starting",下方 emitStateChange("running") 联动跑 starting→running 迁移)。
    if (trace) {
      const taskPreviewSource = truncateTaskPreview(def, 120);
      void safeTrace(() =>
        trace.recordSubagentSpawn({
          id: task.id,
          taskId: task.id,
          origin: "parent",
          startedAt: task.startedAt,
          status: "ok",
          ts: new Date().toISOString(),
          ...(taskPreviewSource.length > 0
            ? { taskPreview: taskPreviewSource }
            : {}),
          ...(def.model !== undefined ? { model: def.model } : {}),
          ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
          ...(def.timeoutMs !== undefined ? { timeoutMs: def.timeoutMs } : {}),
        })
      );
    }
    // 状态迁移: starting → running (emitStateChange 内置 task.state 写入 + 埋点)
    emitStateChange(task, "running");

    // #356 High #2 fix: per-task timeout (SC6 / assumption 14).
    // #358 T2: def.timeoutMs 缺省走三层链 (def ?? taskTimeoutMs ?? 7200s),
    // 与前景 wait 对齐 — 避免"spawn wallclock vs waitFor wait"语义错位。
    // expiry -> mark failed reason:"timeout" + SIGTERM;5s fallback SIGKILL
    // against workers that ignore SIGTERM(review-fix S1:兜底改在 timeout
    // SIGTERM 之后 arm,基准对齐 SIGTERM 点;不再 spawn 时 arm —— 否则默认
    // 7200s timeout 下 5s 就把 worker 强杀)。timer.unref so it does not
    // block process exit。
    const effectiveTimeoutMs = effectiveTaskTimeoutMs(def, opts);
    if (effectiveTimeoutMs > 0) {
      task.timeoutTimer = setTimeout(() => {
        // Already terminated (child exit / stdout envelope) -> do not overwrite.
        if (task.state === "completed" || task.state === "failed") return;
        // #358 T3 优雅窗口:此处先写 generic fallback 信封并立即 SIGTERM,
        // 但 SIGKILL 兜底(5s 后)到达之前,stdout handler 的
        // `task.envelope = env` 会用**子进程写回的更丰富信封**无条件替换
        // fallback —— worker 在 SIGTERM 上自跑收尾摘要轮后 emits 的
        // {reason:"timeout", summary:<真实进度>} 因此成为父侧最终真值,
        // 不被 generic "timeout after <n>ms" 覆盖 (emitStateChange/emitStop
        // 已先发不可逆;timedOut 由 exit handler 的 guard 保 reason=timeout)。
        // SIGKILL 兜底只对忽略 SIGTERM 的 worker 生效 (armKillFallback)。
        task.envelope = {
          status: "failed",
          reason: "timeout",
          summary: `timeout after ${effectiveTimeoutMs}ms`,
          result: "",
        };
        emitStateChange(task, "failed", { reason: "timeout" });
        emitStop(task, "failed", {
          reason: "timeout",
          summary: `timeout after ${effectiveTimeoutMs}ms`,
        });
        if (task.child) {
          try {
            task.child.kill("SIGTERM");
          } catch {
            /* ESRCH et al. ignore */
          }
        }
        // #361 T5 (S1):SIGKILL 兜底以 SIGTERM 为基准 arm 5s,worker 忽略
        // SIGTERM 时 5s 后强杀;abortTask 已先到时此处 reset=false 直接
        // 复用(避免 SIGKILL 时刻双发)。exit handler 清。
        armKillFallback(task);
      }, effectiveTimeoutMs);
      task.timeoutTimer.unref?.();
    }

    // 写 payload(stdin JSON-line)。worker 侧 for-await stdin 读到 EOF 才开始跑;
    // 写完即 end(),否则 worker 永远等 stdin。#357 T1:复用单点校验过的 payload,
    // 避免二次 buildWorkerPayload 调用带来的再次校验副作用风险(虽然当前为纯函数,
    // 但显式复用更清晰,且与 opts.spawn 第三参对齐)。
    if (child.stdin) {
      child.stdin.write(JSON.stringify(payload) + "\n");
      child.stdin.end();
    }

    // stdout newline-JSON → parse → truncate → completed。多条 envelope 取最后一条。
    let stdoutBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.trim().length === 0) continue;
        try {
          const env = truncateEnvelopeResult(parseParentEnvelope(line));
          task.envelope = env;
          // #358 T4: state migration + stop event (single-emit 在 emitStop 内由
          // stoppedEmitted flag 守门,后续 exit/error 路径重复触发 no-op)。
          if (env.status === "ok") {
            emitStateChange(task, "completed");
            emitStop(task, "completed", { summary: env.summary });
          } else {
            emitStateChange(task, "failed", {
              reason: (env.reason ?? "protocolError") as
                | "crashed"
                | "maxTurnsExceeded"
                | "timeout"
                | "protocolError"
                | "cancelled",
            });
            emitStop(task, "failed", {
              reason: (env.reason ?? "protocolError") as
                | "crashed"
                | "maxTurnsExceeded"
                | "timeout"
                | "protocolError"
                | "cancelled",
              summary: env.summary,
            });
          }
        } catch (err) {
          // SC13:信封校验失败 = 协议错误。
          const errMsg = err instanceof Error ? err.message : String(err);
          task.envelope = {
            status: "failed",
            reason: "protocolError",
            summary: `subagent envelope protocol error: ${errMsg}`,
            result: "",
          };
          emitStateChange(task, "failed", { reason: "protocolError" });
          emitStop(task, "failed", {
            reason: "protocolError",
            summary: `subagent envelope protocol error: ${errMsg}`,
          });
        }
      }
    });

    child.on("exit", (code, signal) => {
      // #356 High #2 fix: child exited -> clear timeoutTimer + killFallback to
      // avoid stray SIGKILL on already-dead children.
      if (task.timeoutTimer) {
        clearTimeout(task.timeoutTimer);
        task.timeoutTimer = undefined;
      }
      if (task.timeoutKillFallback) {
        clearTimeout(task.timeoutKillFallback);
        task.timeoutKillFallback = undefined;
      }
      // SC16:非 0 退出码 / 被信号杀死 → crashed,覆盖先前 envelope(即使已 completed)。
      // #356 High #2 fix: 主动 timeout 后我们 SIGTERM child,child 以信号退出
      // 会走到这里 —— 保留 reason:"timeout",不被 crashed 覆盖(否则 waitFor /
      // queryBuffer 的 timeout 语义丢失)。
      const timedOut =
        task.state === "failed" && task.envelope?.reason === "timeout";
      if (!timedOut && (code !== 0 || signal !== null)) {
        const reason: "crashed" | "timeout" =
          task.state === "failed" && task.envelope?.reason === "timeout"
            ? "timeout"
            : "crashed";
        // 在 timeout-fire 之后 child 走 SIGTERM 退出:task.state 已经 failed,
        // 直接 emitStop(reason=timeout, signal=SIGTERM 等) — 不再次 emitStateChange。
        if (reason === "crashed") {
          task.envelope = {
            status: "failed",
            reason: "crashed",
            summary: `worker exit code=${code} signal=${signal}`,
            result: "",
          };
          emitStateChange(task, "failed", { reason: "crashed" });
          emitStop(task, "failed", {
            reason: "crashed",
            summary: `worker exit code=${code} signal=${signal}`,
            ...(code !== null ? { exitCode: code } : {}),
            ...(signal !== null ? { signal } : {}),
          });
        } else {
          // timeout envelope 已经写入 → 仅补 emitStop (terminal 信号)
          emitStop(task, "failed", {
            reason: "timeout",
            summary: task.envelope?.summary ?? `timeout after effective`,
            ...(code !== null ? { exitCode: code } : {}),
            ...(signal !== null ? { signal } : {}),
          });
        }
      }
      // SC16: 干净退出 (0, null) 且无 envelope → 不改 state,维持 running。
      // 由 waitFor timeout / host drain 兜底(SC16 由兜底机制接住)。
      // 干净退出(0, null)且有 envelope → 保持 completed (已在 stdout 段 emitStop)。
    });

    child.on("error", (err) => {
      const errMsg = err.message;
      task.envelope = {
        status: "failed",
        reason: "crashed",
        summary: errMsg,
        result: "",
      };
      emitStateChange(task, "failed", { reason: "crashed" });
      emitStop(task, "failed", {
        reason: "crashed",
        summary: errMsg,
      });
    });

    return { taskId: id };
  }

  function buildWorkerPayload(def: SubAgentDefinition): WorkerEnvelope {
    // #357 T1: 所有 spawn 路径必经此单点校验。语义:
    //   1. parentSandboxRoot = realpathSync(opts.sandboxRoot ?? process.cwd())
    //      —— 父代理的工作域真值(resolve 父目录层可能含 symlink,例如 /var → /private/var
    //      on macOS),worker fs 工具沿用同一 resolved 值。
    //   2. def.sandboxRoot 缺席 → 写入 parentSandboxRoot(SC8:继承父根,不是 process.cwd())。
    //      父根 ≠ process.cwd() 的场景(主代理的 sandboxRoot ≠ 启动 cwd)下,这一变更
    //      防止子代理工作域意外扩大到主进程 cwd 之外。
    //   3. def.sandboxRoot 在场 → resolved = realpathSync(resolve(def.sandboxRoot)),
    //      rel = relative(parentSandboxRoot, resolved)。rel === "" 合法(相等);
    //      rel.startsWith("..") || isAbsolute(rel) → typed 拒绝。realpath 抛 ENOENT
    //      → fail-closed 同样 typed 拒绝(避免给模型"声明未创建路径就能逃逸"的暗示);
    //      其他 errno 原样 rethrow(让 unexpected I/O 故障暴露给上游)。
    //   4. `rel.startsWith("..")` 对合法目录名 `..foo` 也拒绝(spec Code Style 是
    //      合同,fail-closed 优先,不试图区分 `..foo` vs `..` / `../`)。
    let parentSandboxRoot: string;
    try {
      parentSandboxRoot = realpathSync(opts.sandboxRoot ?? process.cwd());
    } catch (err) {
      // opts.sandboxRoot 本身存在但不可 realpath(罕见;主代理装配通常与 cwd 同) →
      // 不可推断父根,直接 typed 拒绝。
      if (
        (err as NodeJS.ErrnoException).code === "ENOENT" ||
        (err as NodeJS.ErrnoException).code === "ENOTDIR"
      ) {
        throw new SubAgentSandboxRootError({
          parentSandboxRoot: opts.sandboxRoot ?? process.cwd(),
          requested: def.sandboxRoot ?? "(inherited from parent)",
        });
      }
      throw err;
    }

    let resolved: string;
    if (def.sandboxRoot === undefined) {
      resolved = parentSandboxRoot;
    } else {
      try {
        resolved = realpathSync(resolve(def.sandboxRoot));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // fail-closed: 模型声明的 sandboxRoot 不存在 → typed 拒绝,
          // 防止"声明一个未来创建的路径 = 隐式扩大父根"语义漏洞。
          throw new SubAgentSandboxRootError({
            parentSandboxRoot,
            requested: def.sandboxRoot,
          });
        }
        throw err;
      }
      const rel = relative(parentSandboxRoot, resolved);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new SubAgentSandboxRootError({
          parentSandboxRoot,
          requested: def.sandboxRoot,
        });
      }
    }

    return {
      task: def.task ?? "",
      sandboxRoot: resolved,
      ...(def.systemPrompt !== undefined && { systemPrompt: def.systemPrompt }),
      ...(def.disallowedTools !== undefined && {
        disallowedTools: [...def.disallowedTools],
      }),
      ...(def.model !== undefined && { model: def.model }),
      ...(def.maxTurns !== undefined && { maxTurns: def.maxTurns }),
      ...(def.timeoutMs !== undefined && { timeoutMs: def.timeoutMs }),
    };
  }

  function queryBuffer(taskId: string): QueryBufferResult {
    const task = tasks.get(taskId);
    if (!task) return { status: "not_found" };
    if (task.state === "starting" || task.state === "running")
      return { status: "running" };
    if (task.state === "completed" && task.envelope) return task.envelope;
    // failed 态必有 envelope(handlers 一律带 result);防御兜底。
    if (task.envelope) {
      return {
        status: "failed",
        reason: task.envelope.reason ?? "crashed",
        summary: task.envelope.summary,
      };
    }
    return {
      status: "failed",
      reason: "crashed",
      summary: "subagent failed without envelope",
    };
  }

  function waitFor(
    taskId: string,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<SubAgentEnvelope> {
    return new Promise((resolve, reject) => {
      const task = tasks.get(taskId);
      if (!task) {
        reject(new SubAgentWaitTimeoutError());
        return;
      }
      // #358 T2: 缺省 timeoutMs 走三层链 (def ?? taskTimeoutMs ?? 7200s),
      // 与 spawn 的 SIGTERM 计时同源 — 防止缺省值两处声明漂移。
      const effectiveTimeout =
        timeoutMs ?? effectiveTaskTimeoutMs(task.def, opts);
      // #361 C3: 预 abort → 立即 SubAgentAbortError,不建轮询状态。
      if (signal?.aborted) {
        reject(new SubAgentAbortError(taskId));
        return;
      }

      let settled = false;
      let interval: ReturnType<typeof setInterval> | undefined;
      // #361 C3: abort listener 在 resolve/reject 后 cleanup,防泄漏。
      const onAbort = (): void => {
        if (!signal?.aborted) return;
        cleanup();
        settleReject(new SubAgentAbortError(taskId));
      };
      const cleanup = () => {
        if (interval) clearInterval(interval);
        waitPollers.delete(interval as ReturnType<typeof setInterval>);
        waitRejecters.delete(settleReject);
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      const settleReject = (reason: unknown): void => {
        if (settled) return;
        settled = true;
        reject(reason);
      };
      const resolveEnvelope = (env: SubAgentEnvelope): void => {
        cleanup();
        if (settled) return;
        settled = true;
        resolve(env);
      };

      const started = Date.now();
      const check = () => {
        // completed / failed 都 resolve envelope(调用方按 status 区分);
        // 仅 timeout / abort / shutdown reject。
        if (task.state === "completed" || task.state === "failed") {
          if (task.envelope) resolveEnvelope(task.envelope);
          else settleReject(new SubAgentWaitTimeoutError());
          return;
        }
        if (signal?.aborted) {
          cleanup();
          settleReject(new SubAgentAbortError(taskId));
          return;
        }
        if (Date.now() - started >= effectiveTimeout) {
          cleanup();
          settleReject(new SubAgentWaitTimeoutError());
        }
      };
      interval = setInterval(check, WAIT_POLL_MS);
      waitPollers.add(interval);
      waitRejecters.add(settleReject);
      signal?.addEventListener("abort", onAbort);
      check(); // 立即首查:已终态任务直接收敛,不等首个 tick
    });
  }

  /**
   * #361 T5: 主动 abort 单任务。传播 abortCtrl.abort() → child SIGTERM →
   * SIGKILL 兜底 5s。review-fix S1:先进去清旧兜底计时器,再以本次 SIGTERM
   * 为基准重排 5s —— 否则 spawn 早期(per-task timeout 前)arm 的旧兜底仍
   * 在旧基准 fire,与 timeout SIGTERM 同点双发。未找到 / 已终态任务 no-op
   * 返回 false;实际对 in-flight child 发起中止返回 true。
   */
  function abortTask(taskId: string): boolean {
    const task = tasks.get(taskId);
    if (!task) return false;
    if (task.state !== "starting" && task.state !== "running") return false;
    task.abortCtrl?.abort();
    if (task.child) {
      try {
        task.child.kill("SIGTERM");
      } catch {
        /* ESRCH et al. ignore */
      }
      // 清 + 重排:兜底基准 = 本次 SIGTERM 时刻(reset=true)。
      armKillFallback(task, true);
    }
    return true;
  }

  /** #361 C2: host-drain 阻塞轮询所需的非终态任务 ID 列表(starting + running)。 */
  function listActive(): ReadonlyArray<string> {
    const out: string[] = [];
    for (const [id, task] of tasks) {
      if (task.state === "starting" || task.state === "running") out.push(id);
    }
    return out;
  }

  /**
   * #358 T7: 全量只读投影。summary/reason 取终态 envelope(与 queryBuffer
   * 同真值);taskPreview 截断 ≤120,不落 task 全文(spec 权限 row)。
   * Postel: endedAt 仅在终态存续;summary/reason 仅 envelope 有值时上行。
   */
  function listSubagents(): ReadonlyArray<SubagentInfo> {
    const out: SubagentInfo[] = [];
    for (const task of tasks.values()) {
      const envelope = task.envelope;
      const item: SubagentInfo = {
        taskId: task.id,
        state: task.state,
        // Fix 3: 与 recordSubagentSpawn 同源 (truncateTaskPreview 默认 120)。
        taskPreview: truncateTaskPreview(task.def),
        startedAt: task.startedAt,
        ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
        ...(envelope?.summary !== undefined
          ? { summary: envelope.summary }
          : {}),
        ...(envelope !== undefined &&
        envelope.status === "failed" &&
        envelope.reason !== undefined
          ? { reason: envelope.reason }
          : {}),
      };
      out.push(item);
    }
    return out;
  }

  async function shutdown(): Promise<void> {
    const runningTasks = [...tasks.values()].filter(
      (t) => t.state === "starting" || t.state === "running"
    );
    const runningChildren = runningTasks
      .map((t) => t.child)
      .filter((c): c is ChildProcess => c !== undefined);

    // #356 High #2 fix: shutdown clears all timeoutTimers so the manager
    // process does not hold dangling timers nor fire SIGKILL on already-
    // SIGTERM'd children.
    for (const t of runningTasks) {
      if (t.timeoutTimer) {
        clearTimeout(t.timeoutTimer);
        t.timeoutTimer = undefined;
      }
      if (t.timeoutKillFallback) {
        clearTimeout(t.timeoutKillFallback);
        t.timeoutKillFallback = undefined;
      }
    }

    // 1. abort in-flight(预留:当前 spec 未把 abortCtrl 接到具体调用)。
    for (const t of tasks.values()) t.abortCtrl?.abort();

    // 2. SIGTERM 所有运行中子进程。
    for (const child of runningChildren) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ESRCH 等忽略 */
      }
    }

    // 3. 等退出 ≤5s,未退出 → SIGKILL 兜底。
    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const closed = new Set<ChildProcess>();
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolvePromise();
      };
      const timer = setTimeout(() => {
        for (const child of runningChildren) {
          if (!closed.has(child)) {
            try {
              child.kill("SIGKILL");
            } catch {
              /* ESRCH 等忽略 */
            }
          }
        }
        finish();
      }, SHUTDOWN_SIGKILL_GRACE_MS);
      if (runningChildren.length === 0) {
        finish();
        return;
      }
      for (const child of runningChildren) {
        // 已在 spawn 后退出(exitCode 为 number)的视为已关闭;否则监听 exit。
        if (typeof child.exitCode === "number") {
          closed.add(child);
          if (closed.size === runningChildren.length) finish();
          continue;
        }
        child.once("exit", () => {
          closed.add(child);
          if (closed.size === runningChildren.length) finish();
        });
      }
    });

    // 未决 waitFor 主动拒绝 + 清轮询句柄(SC16 不悬挂)。snapshot 防止
    // settleReject 在自身 cleanup 中 mutate waitRejecters 跳过迭代。
    for (const reject of [...waitRejecters])
      reject(new SubAgentWaitTimeoutError());
    waitRejecters.clear();
    for (const poller of waitPollers) clearInterval(poller);
    waitPollers.clear();

    // 4. 清空 tasks map。
    tasks.clear();
  }

  function drainCompleted(): ReadonlyArray<{
    readonly taskId: string;
    readonly envelope: SubAgentEnvelope;
  }> {
    const out: { taskId: string; envelope: SubAgentEnvelope }[] = [];
    for (const [id, task] of tasks) {
      if (task.state === "completed" && task.envelope) {
        out.push({ taskId: id, envelope: task.envelope });
      }
    }
    return out;
  }

  return Object.freeze({
    spawn,
    queryBuffer,
    waitFor,
    shutdown,
    drainCompleted,
    listActive,
    abortTask,
    listSubagents,
  });
}
