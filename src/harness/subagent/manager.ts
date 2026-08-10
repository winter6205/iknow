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
  /** 同步入 map 立即返回 taskId(manager 内部 randomUUID() 唯一真值,SC3)。 */
  readonly spawn: (def: SubAgentDefinition) => { readonly taskId: string };
  /** 同步非阻塞四态查询(SC5)。 */
  readonly queryBuffer: (taskId: string) => QueryBufferResult;
  /** host 内部独占 waitFor(不暴露给 agent,spec Never);timeoutMs 默认 30s。 */
  readonly waitFor: (
    taskId: string,
    timeoutMs?: number
  ) => Promise<SubAgentEnvelope>;
  /** abort in-flight + SIGTERM 子孙 + ≥5s 兜底 SIGKILL(SC12)。 */
  readonly shutdown: () => Promise<void>;
  /** T7 host-drain 需要的最小只读枚举:返回当前 buffer 内 completed 任务列表。 */
  readonly drainCompleted: () => ReadonlyArray<{
    readonly taskId: string;
    readonly envelope: SubAgentEnvelope;
  }>;
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

type TaskState = "starting" | "running" | "completed" | "failed";

interface Task {
  readonly id: string;
  readonly def: SubAgentDefinition;
  state: TaskState;
  child?: ChildProcess;
  envelope?: SubAgentEnvelope;
  abortCtrl?: AbortController;
}

/** 本地 SubAgentDefinition 未含 task / sandboxRoot(WorkerEnvelope 必填),T6 接线时由调用方在 def 上补齐。 */
type SpawnableDefinition = SubAgentDefinition & {
  readonly task?: string;
  readonly sandboxRoot?: string;
};

const WAIT_POLL_MS = 25;
const SHUTDOWN_SIGKILL_GRACE_MS = 5000;

export function createSubAgentManager(opts: {
  readonly spawn: SubAgentSpawn;
}): SubAgentManager {
  const tasks = new Map<string, Task>();
  /** 所有未决 waitFor 的轮询句柄(非终态,shutdown 必须清,防进程悬挂)。 */
  const waitPollers = new Set<ReturnType<typeof setInterval>>();
  /** 未决 waitFor 的 reject 引用:shutdown 时主动拒绝,SC16 不悬挂。 */
  const waitRejecters = new Set<(reason: unknown) => void>();

  function spawn(def: SubAgentDefinition): { readonly taskId: string } {
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
      // SC16:非 0 退出码 / 被信号杀死 → crashed,覆盖先前 envelope(即使已 completed)。
      if (code !== 0 || signal !== null) {
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
    // task / sandboxRoot 是 WorkerEnvelope 必填;本地 SubAgentDefinition 未含。
    // T6 接线时调用方在 def 上补齐(如 spawn_subagent 工具的 task 输入)。此处缺省空串,
    // 保证 manager 自身永远是合法 WorkerEnvelope 形态(worker 侧 schema 可过)。
    const spawnable = def as SpawnableDefinition;
    return {
      task: spawnable.task ?? "",
      sandboxRoot: spawnable.sandboxRoot ?? "",
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
    timeoutMs = 30000
  ): Promise<SubAgentEnvelope> {
    return new Promise((resolve, reject) => {
      const task = tasks.get(taskId);
      if (!task) {
        reject(new SubAgentWaitTimeoutError());
        return;
      }
      const started = Date.now();
      let interval: ReturnType<typeof setInterval> | undefined;
      const cleanup = () => {
        if (interval) clearInterval(interval);
        waitPollers.delete(interval as ReturnType<typeof setInterval>);
        waitRejecters.delete(reject);
      };
      const check = () => {
        // completed / failed 都 resolve envelope(调用方按 status 区分);仅 timeout / shutdown reject。
        if (task.state === "completed" || task.state === "failed") {
          cleanup();
          if (task.envelope) resolve(task.envelope);
          else reject(new SubAgentWaitTimeoutError());
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          cleanup();
          reject(new SubAgentWaitTimeoutError());
        }
      };
      interval = setInterval(check, WAIT_POLL_MS);
      waitPollers.add(interval);
      waitRejecters.add(reject);
      check(); // 立即首查:已终态任务直接收敛,不等首个 tick
    });
  }

  async function shutdown(): Promise<void> {
    const runningChildren = [...tasks.values()]
      .filter((t) => t.state === "starting" || t.state === "running")
      .map((t) => t.child)
      .filter((c): c is ChildProcess => c !== undefined);

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

    // 未决 waitFor 主动拒绝 + 清轮询句柄(SC16 不悬挂)。
    for (const reject of waitRejecters) reject(new SubAgentWaitTimeoutError());
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
  });
}
