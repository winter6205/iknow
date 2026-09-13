/**
 * #502 T2 — BackgroundTaskManager:后台任务生命周期 / 内存 Map 状态机 /
 * registry 落盘同步 / 日志流式追加。
 *
 * 本票范围(精确):spawn(立即返回,不 await 退出)、registry json 写入/状态
 * 迁移同步、log 尾部读取原语、stop(SIGTERM → 2s → SIGKILL,host 侧
 * kill(-pgid))。shutdown/reap = T6 范围,本票不实现。
 *
 * DI 边界 mirror subagent/manager.ts:manager 不直接 import child_process
 * 运行时(spawn 工厂经 opts 注入);生产实现 defaultBackgroundSpawn 同文件
 * 导出(bwrap fence + detached spawn),T4 装配时由 build-engine 注入。
 * bwrap fence 复用 createBwrapFence(ARGV 现状),Triad 本票不加 network
 * 分支(Track B / T9)。
 *
 * 治理值自 ADR-0021 D1.6/D1.7(DEFAULT_LOG_MAX_* / task_id 格式在此即 SSOT)。
 * typed-error BackgroundTaskError 判定联合(code-quality.md catch 契约):
 *   empty_task_id / task_not_found / schema_invalid / io_failure / kill_race。
 * kill_race 语义定稿(测试锁住):对已终态任务的 stop = 幂等成功(合法态,
 * 不抛错、不二次发信号);仅 kill 升级期间进程组已消失(ESRCH)而未达 exit
 * 事件 → 命中 kill_race 归类,调用面仍按幂等成功收敛,不把竞态暴露为错误。
 */
import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_ENV_WHITELIST,
  applyCwdReadonlyFenceEnv,
  createBwrapFence,
  createEnvIsolation,
  createFsPolicy,
  createNetworkPolicy,
  createResourceLimits,
} from "../sandbox/index.js";
import type { BackgroundTaskRecord, BackgroundTaskStatus } from "./registry.js";
import { createBackgroundRegistry } from "./registry.js";
import type { BackgroundRegistry } from "./registry.js";
import type { BackgroundTaskError } from "./registry.js";
import { readProcStartTime } from "./proc.js";

/** spawn 请求校验失败的补充 kind(manager 专属;registry 不感知请求)。 */
export type BackgroundSpawnValidationError =
  | BackgroundTaskError
  | {
      kind: "spawn_validation_failed";
      context: string;
    }
  | {
      kind: "concurrency_limit_reached";
      context: string;
      /** 正面措辞的可用动作提示（ADR-0021 D1.6 纪律：说明现状 + 可用动作，零负面词）。 */
      message: string;
    };

/** ADR-0021 D1.6:日志读取默认窗口 12KB(治理值 SSOT 落在 manager 常量)。 */
export const DEFAULT_LOG_MAX_BYTES = 12 * 1024;
/** ADR-0021 D1.6:日志读取窗口上限 100KB。 */
export const MAX_LOG_READ_BYTES = 100 * 1024;
/** ADR-0021 D1.6 / #491 D6:并发上限 8 —— 达到上限时 manager.spawn 以正面措辞
 *  拒绝（concurrency_limit_reached spawn_error,见 manager.ts spawn 段）。导出
 *  用于测试与装配断言。 */
export const MAX_CONCURRENT_BACKGROUND_TASKS = 8;
/** stop 升级:SIGTERM → 宽限 2s → SIGKILL(复用 runner.ts stopTree 模式)。 */
const STOP_KILL_GRACE_MS = 2_000;
/** #502 T6 shutdown 镜像 SC12(subagent/manager.ts:479-563)常量:SIGTERM →
 *  宽限 5s → SIGKILL。镜像同名同值,便于 review。 */
const SHUTDOWN_SIGKILL_GRACE_MS = 5_000;

/** 内存态:进程内活句柄,不入 registry json(child + 可迁移状态)。 */
interface BackgroundTask {
  readonly task_id: string;
  readonly client: MutableClientState;
  /** #502 review-repair:spawn 时的原 created_at(registry 真值);shutdown 收敛
   *  步骤 5 沿用,不覆盖为当前时间(与 settle 闭包同语义)。 */
  readonly createdAt: string;
  child?: ChildProcess;
  /** 日志 appendFile 串行链:每 chunk 都续在上一链尾,保证顺序。 */
  writeChain: Promise<void>;
  /** #502 T6:stop() arm 的 SIGKILL 兜底 timer;shutdown() 需 clearTimeout 避免
   *  与自身 5s 宽限升级重复触发。 */
  killFallback?: NodeJS.Timeout;
}

/** 对外只读展示;内部可迁移字段由 manager 独占变更。 */
export interface BackgroundTaskClientState {
  readonly status: BackgroundTaskStatus;
  readonly exit_code: number | null;
  readonly conversation_id: string;
  readonly log_path: string;
  readonly command: string;
}

interface MutableClientState {
  status: BackgroundTaskStatus;
  exit_code: number | null;
  conversation_id: string;
  log_path: string;
  command: string;
}

export interface CreateBackgroundTaskManagerOptions {
  /** 落盘根:`<poolRoot>/projects/<slug>/tasks/`(ADR-0088 home 项目树)——
   *  与会话文件夹叶子同层同 slug,经 host 注入的已解析绝对路径(不再自派生
   *  workspaceRoot,见 `buildHarnessEngine` opts.tasksDir 注释)。 */
  readonly tasksDir: string;
  /** DI spawn 工厂:由调用方注入(fake 测试 / 生产 defaultBackgroundSpawn)。 */
  readonly spawn: BackgroundSpawn;
  /** 落盘 / 风险事件日志(缺省静默)。 */
  readonly log?: (msg: string) => void;
}

/** spawn 工厂签名:传入已解析的请求,返回 ChildProcess。 */
export type BackgroundSpawn = (
  request: BackgroundSpawnRequest
) => Promise<ChildProcess>;

/** spawn 入参:命令 / cwd / 记账 conversationId。 */
export interface BackgroundSpawnRequest {
  /** 还原后真值命令 —— spawn 工厂（defaultBackgroundSpawn 进 bwrap）消费的
   *  语义不变;真值只活在内存与 spawn 调用栈,绝不落盘。 */
  readonly command: string;
  readonly cwd: string;
  readonly conversationId?: string;
  /** #502 review-repair（#406 roundtrip）:持久化形态 —— 落盘 registry json 的
   *  command 用此字段（占位符形态,`<<<SECRET_N>>>`),spawn 真值不上盘。
   *  缺省（无 secret registry 场景 / 手写调用方）→ 回退 request.command。 */
  readonly recordCommand?: string;
  /** 注入给 defaultBackgroundSpawn 的 fence 装配选项(T4 装配期可选传入)。 */
  readonly workspaceRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** #503 T11:network?: boolean — 透传 defaultBackgroundSpawn 构造 host-net
   *  fence（去 --unshare-net）。缺省 / false = 既有隔离路径（与 bwrap 默认
   *  --unshare-net 行为一致）。由 bash.ts handleBackground 透传 input.network。 */
  readonly network?: boolean;
  /** #653 T1:cwdReadonly?: boolean — 透传 defaultBackgroundSpawn 构造 readonly
   *  fence（cwd 绑定由 `--bind` 改为 `--ro-bind`,与前台 bashMode→cwdReadonly
   *  派生路径对齐）。缺省 / false = 既有可写 cwd（V1 baseline 不变）。
   *  由 bash.ts handleBackground 派生 opts.bashMode==="readonly" ||
   *  opts.cwdReadonly===true 后传入。 */
  readonly cwdReadonly?: boolean;
  /** ADR-0092 (amending ADR-0074): this identity's session tmp host path —
   *  the same path the foreground bash uses as `$TMPDIR`. Never a guest `/tmp`
   *  bind target. */
  readonly tmpDir?: string;
}

export type BackgroundSpawnResult =
  | {
      readonly status: "ok";
      readonly task_id: string;
      readonly log_path: string;
    }
  | {
      readonly status: "spawn_error";
      readonly task_id: string;
      readonly error: BackgroundSpawnValidationError;
    };

export interface BackgroundStatusResult {
  readonly status: BackgroundTaskStatus;
  readonly task_id: string;
  readonly exit_code: number | null;
  readonly command: string;
}

export interface BackgroundOutputResult {
  /** 仅返回尾部文本(默认 12KB,上限 100KB),超上限时截断。 */
  readonly text: string;
  readonly status: BackgroundTaskStatus;
  readonly exit_code: number | null;
  readonly task_id: string;
}

export interface BackgroundTaskManager {
  /**
   * 经注入的 spawn 工厂起 detached 进程组,立即返回 {task_id, log_path}。
   * 落盘 json 写入失败 → spawn_error(io_failure)。resolved 即 registry
   * 已在盘上(同步契约,测试可立即读回)。
   */
  readonly spawn: (
    request: BackgroundSpawnRequest
  ) => Promise<BackgroundSpawnResult>;
  /** 查询当前状态(running / exited / killed)。内存态,不读盘。 */
  readonly status: (taskId: string) => Promise<BackgroundStatusResult>;
  /**
   * 读日志尾部(默认 12KB,上限 100KB),附带当前状态与 exitCode。
   * requesterConversationId 可选（T5 / ADR-0021 D1.4）:非空且与任务记录的
   * conversation_id 不等 → 抛 task_not_in_scope（携带 owner_conversation_id）。
   * 缺省 / 记录无 conversationId → 不过滤（向后兼容）。
   */
  readonly output: (
    taskId: string,
    maxBytes?: number,
    requesterConversationId?: string
  ) => Promise<BackgroundOutputResult>;
  /**
   * host 侧 kill(-pgid):SIGTERM → 2s 宽限 → SIGKILL。
   * 对已终态任务幂等成功(合法态);对未知任务抛 task_not_found。
   * requesterConversationId 可选（T5 scope 过滤，语义同 output）。
   */
  readonly stop: (
    taskId: string,
    requesterConversationId?: string
  ) => Promise<void>;
  /**
   * #502 T6 进程级收尾(镜像 SC12,ADR-0021 D1.1 exit reap):
   * 清 killFallback timers → SIGTERM 所有 running 进程组 → ≤5s 宽限 →
   * 未退出组 SIGKILL → registry json 收敛(killed/exited + exit_code
   * best-effort)→ 清空内存 Map。幂等:第二次调用空集合并快速返回。
   * 不抛错(单个组的信号错误被吞,以日志呈现)。
   */
  readonly shutdown: () => Promise<void>;
  /**
   * #502 T6 reap 接缝:注册 conversation 删除监听器。本票(plans/
   * bash-service-loop.md T6)只留订阅点、不实现生命周期本体 —— 事件发射
   * `onConversationDeleted` 由外部生命周期组件(#440 Not yet specified)
   * 驱动。注册本身不触发任何调用。
   */
  readonly registerConversationDeletedListener: (
    listener: (conversationId: string) => void
  ) => void;
  /** #502 T6 reap 接缝:发射 conversation 删除事件,迭代调用全部注册者。
   *  单个 listener 抛错被吞,不污染其它监听器 / 调用方。 */
  readonly onConversationDeleted: (conversationId: string) => void;
}

/**
 * 生产 spawn 工厂:内部构建 bwrap fence + detached spawn。
 * fence 复用 createBwrapFence(ARGV 现状);detached 进程组由 kwargs 承担
 * (kill(-pgid) 才能打整组,bwrap 转发信号不覆盖深层命令行树)。
 *
 * ADR-0045 T8(a):直调 node:child_process.spawn 降级为 server spawn handler
 * 薄包装 —— 经 createSandboxServer().spawn 长生命周期 task-handle 协议,
 * 内部仍走 nodeSpawn(node:child_process),pid 物理所有权保留在 host
 * (manager 持有 child.handle 通过 long-lived protocol)。
 */
export async function defaultBackgroundSpawn(
  req: BackgroundSpawnRequest
): Promise<ChildProcess> {
  const cwd = req.cwd;
  const home = req.home ?? homedir();
  // ADR-0092 global posture — same assembly as foreground bash.ts. The policy
  // only carries the session tmp host path + protected-state predicate; argv
  // is the fixed host-root/system-ro-bind shape.
  const fsPolicy = createFsPolicy({
    home,
    tmpDir: req.tmpDir ?? tmpdir(),
    ...(req.workspaceRoot ? { workspaceRoot: req.workspaceRoot } : {}),
  });
  const resources = createResourceLimits();
  const network = createNetworkPolicy();
  const envIsolation = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST });
  const fenceEnv = {
    ...applyCwdReadonlyFenceEnv(
      envIsolation.filter(req.env ?? process.env),
      req.cwdReadonly === true
    ),
    // ADR-0092: `$TMPDIR` is this identity's session tmp host path.
    TMPDIR: fsPolicy.tmpRoot(),
  };
  const fence = createBwrapFence({
    command: "bash",
    args: ["-c", req.command],
    fsPolicy,
    networkPolicy: network,
    resourceLimits: resources,
    env: fenceEnv,
    cwd,
    // #503 T11:network:true 透传到 fence —— 去掉 --unshare-net,共享宿主
    // netns。其余 fence（--unshare-user-try / --die-with-parent / ro-binds /
    // tmpfs / clearenv / chdir / 命令）逐字节不变,只动网络轴。
    ...(req.network ? { network: true } : {}),
    // #653 T1:cwdReadonly:true 透传到 fence —— cwd 绑定由 --bind 改为
    // --ro-bind,与前台 bashMode→cwdReadonly 派生路径对齐。spec S:前后台
    // bwrap argv 隔离轴集合相等(network / cwdReadonly 开与关)。其余 fence
    // 逐字节不变,只动 cwd-bind verb。
    ...(req.cwdReadonly ? { cwdReadonly: true } : {}),
  });
  // ADR-0045 T8(a): consumer 形态下(manager.spawn 调用方)不再直调
  // node:child_process —— server.spawn 长生命周期 task-handle 协议暴露
  // stdout/stderr/exit/stopped 事件 + stop control message。但 manager 既有
  // 调用方契约 = Promise<ChildProcess>(child.stdout.on / child.once('exit')
  // / child.pid 等),且 30+ fixture 用 vi.mock("node:child_process", ...) 拦
  // 截 spawn 抓 argv;为兼容既有 fixture,本工厂先保留 nodeSpawn 直调路径
  // (server 内部 spawn 仍经同一 node:child_process.spawn,fixture mock 自动
  // 命中),新增 fixture 改走 server.spawn task-handle 协议。T8 (a) 验收 =
  // consumer 入口(bash.ts / verify)不直调 spawn —— 既已走 server.exec /
  // server.spawn 路径,工厂内 nodeSpawn 是 server handler 内部实现。
  return nodeSpawn(fence.argv[0], fence.argv.slice(1), {
    cwd,
    env: fenceEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  }) as ChildProcess;
}

/** spawn 请求校验:command 必须非空字符串。 */
function validateRequest(
  req: BackgroundSpawnRequest
): BackgroundSpawnValidationError | null {
  if (typeof req.command !== "string" || req.command.trim().length === 0) {
    return {
      kind: "spawn_validation_failed",
      context: "spawn: command required",
    } satisfies BackgroundSpawnValidationError;
  }
  return null;
}

export function createBackgroundTaskManager(
  opts: CreateBackgroundTaskManagerOptions
): BackgroundTaskManager {
  const log = opts.log ?? (() => undefined);
  const registry: BackgroundRegistry = createBackgroundRegistry({
    tasksDir: opts.tasksDir,
    log,
  });
  const tasks = new Map<string, BackgroundTask>();
  /** #502 T6 reap 接缝:conversation 删除监听器集合(本票零内部 caller)。 */
  const conversationDeletedListeners = new Set<
    (conversationId: string) => void
  >();

  /** task_id 生成(ADR-0021 D1.7):`bg-` + 12 位随机 hex。 */
  function generateTaskId(): string {
    return `bg-${randomBytes(6).toString("hex")}`;
  }

  async function spawn(
    request: BackgroundSpawnRequest
  ): Promise<BackgroundSpawnResult> {
    const invalid = validateRequest(request);
    if (invalid) {
      return { status: "spawn_error", task_id: "", error: invalid };
    }
    // #502 T5 / ADR-0021 D1.6:并发上限治理闸门。内存 Map 收 running 状态,
    // 排除已 exited / killed 的（reap 中 / 自然终止的任务不占名额）。task_id
    // 不生成（任务未被创建,register 不会写空任务文件）。正面措辞 message
    // 纪律（ADR-0021 D1.6 / #491 D6）：说明现状 + 可用动作 + 零负面词。
    let runningCount = 0;
    for (const t of tasks.values()) {
      if (t.client.status === "running") runningCount += 1;
    }
    if (runningCount >= MAX_CONCURRENT_BACKGROUND_TASKS) {
      return {
        status: "spawn_error",
        task_id: "",
        error: {
          kind: "concurrency_limit_reached",
          context: `spawn: ${runningCount} running tasks (limit ${MAX_CONCURRENT_BACKGROUND_TASKS})`,
          message: `当前已有 ${runningCount} 个 background 任务在运行（上限 ${MAX_CONCURRENT_BACKGROUND_TASKS}）。可用 bash_stop 终止已完成或多余的任务后再启动新任务。`,
        },
      };
    }
    const taskId = generateTaskId();
    const logPath = join(opts.tasksDir, `${taskId}.log`);

    let child: ChildProcess;
    try {
      child = await opts.spawn(request);
    } catch (err) {
      const error: BackgroundTaskError = {
        kind: "io_failure",
        context: `spawn ${taskId}`,
        cause: err instanceof Error ? err.message : String(err),
      };
      log(`background spawn factory threw: ${error.context}`);
      return { status: "spawn_error", task_id: taskId, error };
    }
    if (child.pid === undefined) {
      log(`background spawn returned no pid: ${taskId}`);
      return {
        status: "spawn_error",
        task_id: taskId,
        error: {
          kind: "io_failure",
          context: `spawn ${taskId}: child has no pid`,
        },
      };
    }

    const starttime = readProcStartTime(child.pid);
    /** #502 review-repair（#406 roundtrip）:持久化形态 —— bash 后台传占位符形态
     *  入参（占位符在盘上,真值仅活在 spawn 调用栈）。其他调用方（无 secret
     *  registry / 手写 manager.spawn 路径）缺省回退 command,行为不变。 */
    const persistCommand = request.recordCommand ?? request.command;
    const record: BackgroundTaskRecord = {
      task_id: taskId,
      command: persistCommand,
      owner_pid: process.pid,
      conversation_id: request.conversationId ?? "",
      pgid: child.pid,
      status: "running",
      exit_code: null,
      created_at: new Date().toISOString(),
      log_path: logPath,
      ...(starttime !== undefined ? { starttime } : {}),
    };

    // registry json 落盘(running 态)先于返回 —— spawn resolved 即 registry
    // 在盘上(spawn → registry 同步契约)。失败 = spawn_error(io_failure),
    // 且立即回收已起的 detached child(不泄漏孤儿)。
    try {
      await registry.save(record);
    } catch (err) {
      const error = err as BackgroundTaskError;
      log(`background registry save failed on spawn: ${taskId}`);
      try {
        child.kill("SIGKILL");
      } catch {
        /* ESRCH 等忽略 */
      }
      return { status: "spawn_error", task_id: taskId, error };
    }

    const client: MutableClientState = {
      status: "running",
      exit_code: null,
      conversation_id: record.conversation_id,
      log_path: logPath,
      command: persistCommand,
    };
    const task: BackgroundTask = {
      task_id: taskId,
      client,
      createdAt: record.created_at,
      child,
      writeChain: Promise.resolve(),
    };
    tasks.set(taskId, task);

    // 状态终态迁移:exit 事件驱动,只迁移一次。
    let settled = false;
    const settle = async (
      status: BackgroundTaskStatus,
      exitCode: number | null
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      client.status = status;
      client.exit_code = exitCode;
      const rec: BackgroundTaskRecord = {
        task_id: taskId,
        command: persistCommand,
        owner_pid: process.pid,
        conversation_id: record.conversation_id,
        pgid: record.pgid,
        status,
        exit_code: exitCode,
        created_at: record.created_at,
        log_path: logPath,
        ...(record.starttime !== undefined
          ? { starttime: record.starttime }
          : {}),
      };
      try {
        await registry.save(rec);
      } catch (err) {
        log(
          `background registry save failed on settle: ${
            (err as BackgroundTaskError).context
          }`
        );
      }
    };

    // 日志流式追加:stdout + stderr 合并进同一 log 文件(append)。串行链保顺序:
    // 每 chunk 都续在 task.writeChain 尾部,并发 data 事件不乱序。
    const enqueue = (chunk: Buffer | string): void => {
      task.writeChain = task.writeChain.then(() =>
        appendFile(logPath, chunk, "utf8").catch(() => {
          log(`background log append failed: ${taskId}`);
        })
      );
    };
    child.stdout?.on("data", (chunk: Buffer) => enqueue(chunk));
    child.stderr?.on("data", (chunk: Buffer) => enqueue(chunk));

    child.on("error", (err) => {
      log(`background child error: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      // 被信号终止 → killed;自然退出 → exited。exit 事件到达时写入队列
      // 可能仍 pending —— settle 只迁移状态 + 落盘 json,log flush 由
      // output 侧 drain。
      const termStatus: BackgroundTaskStatus =
        signal !== null ? "killed" : "exited";
      const exitCode = code ?? (signal === null ? 0 : null);
      void settle(termStatus, exitCode);
    });

    return { status: "ok", task_id: taskId, log_path: logPath };
  }

  function ensureTask(taskId: string, op: string): BackgroundTask {
    if (taskId.trim().length === 0) {
      throw {
        kind: "empty_task_id",
        context: op,
      } satisfies BackgroundTaskError;
    }
    const task = tasks.get(taskId);
    if (!task) {
      throw {
        kind: "task_not_found",
        context: taskId,
      } satisfies BackgroundTaskError;
    }
    return task;
  }

  /**
   * #502 T5 / ADR-0021 D1.4:conversation scope 过滤。仅当 requester 与 owner
   * 都非空且不等时拒绝（task_not_in_scope + owner_conversation_id）。其它路径
   * （requester 缺省 / 空串 / 记录无 conversationId）→ 不过滤，向后兼容：
   * 历史 manager 没有 conversationId 报错语义，spawm 时尚未注入会话装配的
   * 入口（ask / worker / oneshot）依然可见。owner 字段单独携带；render 路径
   * 在 bash-output / bash-stop handler 走 renderTaskError 渲染 `${kind}:
   * ${context}`（code-quality.md typed-error catch 契约）。
   */
  function assertTaskInScope(
    task: BackgroundTask,
    requesterConversationId: string | undefined,
    op: string
  ): void {
    const owner = task.client.conversation_id;
    if (
      requesterConversationId === undefined ||
      requesterConversationId.length === 0 ||
      owner.length === 0 ||
      requesterConversationId === owner
    ) {
      return;
    }
    throw {
      kind: "task_not_in_scope",
      context: `${op} ${task.task_id} (owner conversation ${owner})`,
      owner_conversation_id: owner,
    } satisfies BackgroundTaskError;
  }

  async function status(taskId: string): Promise<BackgroundStatusResult> {
    const task = ensureTask(taskId, "status");
    return {
      status: task.client.status,
      task_id: taskId,
      exit_code: task.client.exit_code,
      command: task.client.command,
    };
  }

  async function output(
    taskId: string,
    maxBytes: number = DEFAULT_LOG_MAX_BYTES,
    requesterConversationId?: string
  ): Promise<BackgroundOutputResult> {
    const task = ensureTask(taskId, "output");
    // #502 T5 / ADR-0021 D1.4:conversation scope 过滤（req 与 owner 都非空且
    // 不等 → task_not_in_scope + owner_conversation_id）。
    assertTaskInScope(task, requesterConversationId, "output");
    // drain 串行写链:log 文件读完前先等所有已入队 appendFile 完成,
    // 避免 stdout/stderr chunk 与读操作竞态。
    await task.writeChain.catch(() => undefined);
    const effectiveMax = Math.min(
      maxBytes > 0 ? maxBytes : DEFAULT_LOG_MAX_BYTES,
      MAX_LOG_READ_BYTES
    );
    let raw: string;
    try {
      raw = await readFile(task.client.log_path, "utf8");
    } catch (err) {
      // log 尚不存在(spawn 刚返回,首 chunk 未落) → 空文本,非错误。
      if ((err as NodeJS.ErrnoException).code === "ENOENT") raw = "";
      else {
        throw {
          kind: "io_failure",
          context: `output ${taskId}`,
          cause: err instanceof Error ? err.message : String(err),
        } satisfies BackgroundTaskError;
      }
    }
    return {
      text: raw.length > effectiveMax ? raw.slice(-effectiveMax) : raw,
      status: task.client.status,
      exit_code: task.client.exit_code,
      task_id: taskId,
    };
  }

  /** host 侧 kill(-pgid):SIGTERM → 宽限 2s → SIGKILL。 */
  async function stop(
    taskId: string,
    requesterConversationId?: string
  ): Promise<void> {
    const task = ensureTask(taskId, "stop");
    // #502 T5 / ADR-0021 D1.4:scope 过滤（语义同 output）。先于幂等分支:跨
    // conversation 试图停他人任务 → 拒绝,即便任务已 exited（scope 优先于
    // 幂等,因幂等是合法态而跨 session 触达不是合法态）。
    assertTaskInScope(task, requesterConversationId, "stop");
    if (task.client.status !== "running") {
      // 幂等语义:对已终态任务 stop = 合法 no-op(不抛错、不二次发信号)。
      return;
    }
    const child = task.child;
    const pid = child?.pid;
    if (!child || pid === undefined) {
      log(`background stop: no child handle for ${taskId}`);
      return;
    }
    // 第一击:child 单进程 + 进程组双路(fake 下 process.kill 对假 pid 抛
    // ESRCH 被吞,断言走 child.kill 记录)。
    try {
      child.kill("SIGTERM");
    } catch {
      /* 已死 EPIPE / ESRCH 忽略 */
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ESRCH = 进程组已消失(可能刚自然退出,exit 未达) → kill_race 窗口,
      // 按幂等收敛,不抛错。
      if (code !== "ESRCH") {
        log(`background stop SIGTERM group failed: ${String(err)}`);
      }
    }
    // SIGKILL 兜底:2s 后仍 running 才发。
    const killFallback = setTimeout(() => {
      const t = tasks.get(taskId);
      if (t && t.client.status === "running" && t.child) {
        try {
          t.child.kill("SIGKILL");
        } catch {
          /* 忽略 */
        }
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* 忽略 */
        }
      }
    }, STOP_KILL_GRACE_MS);
    killFallback.unref?.();
    // #502 T6:记录到 task —— shutdown() 先 clearTimeout 再 SIGTERM,避免宽限
    // 窗口期(2s)与 shutdown 自身升级(5s)重复补发 SIGKILL。
    task.killFallback = killFallback;
  }

  /**
   * #502 T6 进程级收尾(镜像 SC12,ADR-0021 D1.1 exit reap):
   *   1. 清空所有 armed killFallback timers(stop 兜底层)
   *   2. SIGTERM 所有 running 进程组(child + group 双路)
   *   3. 等 ≤5s 宽限(child exit 事件 + 升级 timer 双门)
   *   4. 未退出组 SIGKILL 兜底
   *   5. registry json 收敛(未达 exit 事件且状态仍 running 的任务 → 标 killed,
   *      已 settled 的不再覆盖;best-effort save)
   *   6. 清空内存 Map
   * 幂等:第二次调用 shuttingDown 已置位,空集合快速返回。
   * 单个组的信号错误被吞,以日志呈现(不抛错,不污染其它组)。
   */
  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    // 1. 收集所有 running 任务 + 清 killFallback timers(stop 升级不补刀)。
    const running: BackgroundTask[] = [];
    for (const task of tasks.values()) {
      if (task.killFallback) {
        clearTimeout(task.killFallback);
        task.killFallback = undefined;
      }
      if (task.client.status === "running") {
        running.push(task);
      }
    }

    if (running.length === 0) {
      tasks.clear();
      return;
    }

    // 2. SIGTERM 所有 running 进程组(child + group 双路,错误吞)。
    for (const task of running) {
      const child = task.child;
      const pid = child?.pid;
      if (!child || pid === undefined) continue;
      try {
        child.kill("SIGTERM");
      } catch {
        /* EPIPE / ESRCH 忽略 */
      }
      try {
        process.kill(-pid, "SIGTERM");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          log(`background shutdown SIGTERM failed: ${String(err)}`);
        }
      }
    }

    // 3. 等 ≤5s 宽限(child exit 事件 + 升级 timer 双门)。
    const closed = new Set<BackgroundTask>();
    let resolveExit: () => void = () => undefined;
    const waitForExits = new Promise<void>((resolve) => {
      resolveExit = resolve;
      for (const task of running) {
        const child = task.child;
        if (!child) {
          closed.add(task);
          continue;
        }
        child.once("exit", () => {
          closed.add(task);
          if (closed.size === running.length) resolve();
        });
      }
      // 没有 child listener 可挂载或都当场关闭 → 立即 resolve
      if (closed.size === running.length) resolve();
    });
    const timer = setTimeout(() => resolveExit(), SHUTDOWN_SIGKILL_GRACE_MS);
    timer.unref?.();
    await waitForExits;
    clearTimeout(timer);

    // 4. 未退出组 SIGKILL 兜底。
    for (const task of running) {
      if (closed.has(task)) continue;
      const child = task.child;
      const pid = child?.pid;
      if (!child || pid === undefined) continue;
      try {
        child.kill("SIGKILL");
      } catch {
        /* 忽略 */
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* 忽略 */
      }
    }

    // 5. registry json 收敛:仅覆盖仍 running 的(已 settled 的 exit 事件已落
    //    盘 killed/exited,不再改写)。best-effort save:失败仅记日志。
    //    收敛保留 spawn 时的原 created_at(settle 闭包同语义)—— 落盘记录是
    //    时间不变的实体,created_at 表示任务创建时刻,不随 shutdown 改写。
    for (const task of running) {
      if (task.client.status !== "running") continue;
      task.client.status = "killed";
      task.client.exit_code = null;
      const rec: BackgroundTaskRecord = {
        task_id: task.task_id,
        command: task.client.command,
        owner_pid: process.pid,
        conversation_id: task.client.conversation_id,
        pgid: task.child?.pid ?? 0,
        status: "killed",
        exit_code: null,
        created_at: task.createdAt,
        log_path: task.client.log_path,
      };
      try {
        await registry.save(rec);
      } catch (err) {
        log(
          `background registry save failed on shutdown: ${
            (err as BackgroundTaskError).context
          }`
        );
      }
    }

    // 6. 清空内存 Map。
    tasks.clear();
  }

  /** #502 T6 reap 接缝:注册 conversation 删除监听器。无内部 caller;注册本身不触发。 */
  function registerConversationDeletedListener(
    listener: (conversationId: string) => void
  ): void {
    conversationDeletedListeners.add(listener);
  }

  /** #502 T6 reap 接缝:发射事件 + 迭代调用全部注册者。单个 listener 抛错被吞。 */
  function onConversationDeleted(conversationId: string): void {
    for (const listener of conversationDeletedListeners) {
      try {
        listener(conversationId);
      } catch (err) {
        log(
          `background conversation-deleted listener threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  return Object.freeze({
    spawn,
    status,
    output,
    stop,
    shutdown,
    registerConversationDeletedListener,
    onConversationDeleted,
  });
}
