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
import type { ChildProcess } from "node:child_process";
import { parseParentEnvelope, truncateEnvelopeResult } from "./envelope.js";
import type { SubAgentEnvelope, WorkerEnvelope } from "./envelope.js";
import type { SubAgentDefinition } from "./role.js";

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
   * 保留(立即 resolve,不经 interval)。timeoutMs 默认 PER_TASK_TIMEOUT_MS。
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
 * #361 T13: per-task 缺省 wallclock 5min(修正 spawn-subagent-tool 注释
 * "default 5 min if absent" 与 manager waitFor 旧默认 30s 不一致)。
 * wait:true handler 显式传给 waitFor;manager 内部 spawn 的 per-task
 * SIGTERM 计时器也用此常量作缺省,worker 侧 wallclock 与前景 wait 对齐。
 */
export const PER_TASK_TIMEOUT_MS = 300_000;

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
}): SubAgentManager {
  const tasks = new Map<string, Task>();
  /** 所有未决 waitFor 的轮询句柄(非终态,shutdown 必须清,防进程悬挂)。 */
  const waitPollers = new Set<ReturnType<typeof setInterval>>();
  /** 未决 waitFor 的 settleReject 引用:shutdown 时主动拒绝,SC16 不悬挂。 */
  const waitRejecters = new Set<(reason: unknown) => void>();

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

    const id = randomUUID();
    const task: Task = { id, def, state: "starting" };
    tasks.set(id, task);

    let child: ChildProcess;
    try {
      child = opts.spawn(def, id, buildWorkerPayload(def));
    } catch (err) {
      task.state = "failed";
      task.envelope = {
        status: "failed",
        reason: "crashed",
        summary: `subagent spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        result: "",
      };
      return { taskId: id };
    }
    task.child = child;
    task.state = "running";
    task.abortCtrl = new AbortController();

    // #356 High #2 fix: per-task timeout (SC6 / assumption 14).
    // #361 T13: def.timeoutMs 缺省 = PER_TASK_TIMEOUT_MS(5min),与前景 wait
    // 对齐 — 避免"spawn 300s wallclock vs waitFor 300s wait"语义错位。
    // expiry -> mark failed reason:"timeout" + SIGTERM;5s fallback SIGKILL
    // against workers that ignore SIGTERM(review-fix S1:兜底改在 timeout
    // SIGTERM 之后 arm,基准对齐 SIGTERM 点;不再 spawn 时 arm —— 否则默认
    // 300s timeout 下 5s 就把 worker 强杀)。timer.unref so it does not
    // block process exit。
    const effectiveTimeoutMs = def.timeoutMs ?? PER_TASK_TIMEOUT_MS;
    if (effectiveTimeoutMs > 0) {
      task.timeoutTimer = setTimeout(() => {
        // Already terminated (child exit / stdout envelope) -> do not overwrite.
        if (task.state === "completed" || task.state === "failed") return;
        task.state = "failed";
        task.envelope = {
          status: "failed",
          reason: "timeout",
          summary: `timeout after ${effectiveTimeoutMs}ms`,
          result: "",
        };
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
    // 写完即 end(),否则 worker 永远等 stdin。
    if (child.stdin) {
      child.stdin.write(JSON.stringify(buildWorkerPayload(def)) + "\n");
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
          task.state = "completed";
        } catch (err) {
          // SC13:信封校验失败 = 协议错误。
          task.state = "failed";
          task.envelope = {
            status: "failed",
            reason: "protocolError",
            summary: `subagent envelope protocol error: ${err instanceof Error ? err.message : String(err)}`,
            result: "",
          };
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
        task.state = "failed";
        task.envelope = {
          status: "failed",
          reason: "crashed",
          summary: `worker exit code=${code} signal=${signal}`,
          result: "",
        };
      }
      // 干净退出(0, null)且有 envelope → 保持 completed;无 envelope → 维持 running,
      // 由 waitFor timeout / host drain 兜底。
    });

    child.on("error", (err) => {
      task.state = "failed";
      task.envelope = {
        status: "failed",
        reason: "crashed",
        summary: err.message,
        result: "",
      };
    });

    return { taskId: id };
  }

  function buildWorkerPayload(def: SubAgentDefinition): WorkerEnvelope {
    // #356 High #1 fix: task / sandboxRoot live on SubAgentDefinition (role.ts);
    // read directly. Empty-string fallback keeps manager output as a valid
    // WorkerEnvelope that satisfies worker-side schema.
    // #365 真实 LLM e2e 修复:spawn_subagent 工具不采集 sandboxRoot(role.ts:34
    // 注释约定"manager 装配期根据父 cwd 补齐"),此前 def.sandboxRoot ?? ""
    // 直接把空串写进 envelope → worker 的 fs 工具(bash bwrap fence)以空 cwd
    // 装配,`--bind "" ""` bwrap 即抛 "Can't find source path" → worker 内所有
    // fs 工具不可用。此处补齐:def 缺席时回退 process.cwd()(父代理进程 cwd,
    // 与 build-engine 缺省 sandboxRoot 同语义)。
    const sandboxRoot = def.sandboxRoot ?? process.cwd();
    return {
      task: def.task ?? "",
      sandboxRoot,
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
    timeoutMs = PER_TASK_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<SubAgentEnvelope> {
    return new Promise((resolve, reject) => {
      const task = tasks.get(taskId);
      if (!task) {
        reject(new SubAgentWaitTimeoutError());
        return;
      }
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
        if (Date.now() - started >= timeoutMs) {
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
  });
}
