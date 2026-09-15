/**
 * Sandbox 命令执行 runner — bash 工具与 verify-loop 共用的
 * 「命令 → bwrap fence → spawn → 超时 → 输出捕获 → 截断」执行体（#128 T2 抽取）。
 *
 * 依赖方向：sandbox 是基础层，aci/tools（bash/grep/glob）与 verify/ 都消费它；
 * 本文件不 import 任何 aci/verify 模块。spawnWithStopSignal / truncateByCodePoint
 * 原在 aci/tools/helpers.ts，为保持依赖单向迁到此地；helpers.ts 仍 re-export
 * 二者以兼容 grep / glob / 既有测试。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { ToolExecutionError } from "../errors.js";
import type { BwrapFence } from "./bwrap.js";
import { createSandboxServer } from "./server/index.js";

/** runInSandbox 默认输出截断上限，对齐 bash.ts 既有 MAX_OUTPUT_CODE_POINTS。 */
export const DEFAULT_MAX_OUTPUT_CODE_POINTS = 12_000;

const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * SIGKILL 之后等进程组消失的额外窗口。组拆除是 best-effort：等不到就
 * 放手，否则一个不可杀的组会把调用方永久挂住。
 */
const GROUP_SETTLE_MS = 250;

/** 进程组消失轮询间隔。 */
const GROUP_POLL_MS = 20;

/** 信号→退出码映射：shell 约定 = 128 + signal number。 */
export const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> =
  Object.freeze({
    SIGHUP: 129,
    SIGINT: 130,
    SIGQUIT: 131,
    SIGILL: 132,
    SIGTRAP: 133,
    SIGABRT: 134,
    SIGBUS: 135,
    SIGFPE: 136,
    SIGKILL: 137,
    SIGUSR1: 138,
    SIGSEGV: 139,
    SIGUSR2: 140,
    SIGPIPE: 141,
    SIGALRM: 142,
    SIGTERM: 143,
    SIGSTKFLT: 144,
    SIGCHLD: 145,
    SIGCONT: 146,
    SIGSTOP: 147,
    SIGTSTP: 148,
    SIGTTIN: 149,
    SIGTTOU: 150,
    SIGURG: 151,
    SIGXCPU: 152,
    SIGXFSZ: 153,
    SIGVTALRM: 154,
    SIGPROF: 155,
    SIGWINCH: 156,
    SIGIO: 157,
    SIGPWR: 158,
    SIGSYS: 159,
  });

export interface SpawnWithStopSignalOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  /**
   * Explicit env forwarded to `spawn`. When omitted, child inherits the full
   * process env (used by tests that don't care about isolation). Production
   * callers must pass a pre-filtered env so a leaked host secret can't reach
   * the child via the parent — bwrap's --clearenv covers the in-sandbox half,
   * this covers the outside half (#225).
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam; production callers should use the two-second default. */
  readonly killGraceMs?: number;
}

export interface SpawnResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SpawnWithStopSignalResult {
  readonly child: ChildProcess;
  readonly done: Promise<SpawnResult>;
}

/** Truncate by Unicode code points rather than UTF-16 code units. */
export function truncateByCodePoint(text: string, max: number): string {
  if (!Number.isInteger(max) || max < 0) {
    throw new RangeError("max must be a non-negative integer");
  }
  return Array.from(text).slice(0, max).join("");
}

/**
 * 拆除序列：SIGTERM → 宽限 → SIGKILL → 等组清空。
 *
 * Why close 不再解除升级：`close` 只在直系 child 退出且它的 stdio 管道关闭
 * 时到达。后代可能既不持有管道（`> /dev/null` / stdio:"ignore"）又对 SIGTERM
 * 免疫（`trap '' TERM` / 自带 handler / 不可中断的系统调用）—— 这种形状下
 * close 到达时同组后代仍在跑。旧实现一 close 就 clearTimeout，把 SIGKILL
 * 兜底连同调用方的等待一起撤掉，后代于是继续走完整棵树（2026-09-14 事故：
 * `find /` 在工具调用返回 cancelled 后仍走了约 232s）。拆除既已请求，就必须
 * 等组真的空了再交付 cancelled。
 *
 * 快路径：可被 TERM 带走的树在宽限期内就清空，立即结算（不白等 2s）。
 */
function createTreeTeardown(
  child: ChildProcess,
  graceMs: number,
  settle: (outcome: SpawnResult) => void,
  killedOutcome: () => SpawnResult
): {
  stop: () => void;
  close: (outcome: SpawnResult) => void;
  failed: () => void;
} {
  let killTimer: NodeJS.Timeout | undefined;
  let settled = false;
  /** 直系 child 的 close 回执；进程组清空前不据此结算（见 finish）。 */
  let closeOutcome: SpawnResult | undefined;
  /** 拆除请求已发出（abort → SIGTERM 已发）。 */
  let teardownRequested = false;
  /** 进程组已确认清空（或已判定不可再治理）—— 拆除链到此收口。 */
  let groupClear = false;

  /**
   * 单点结算（single-wins）：直系 child 已回执即兑现。调用方只在「拆除链
   * 已收口」时进入这里 —— 组是否清空的判断留在调用点，本函数不重复判定。
   */
  const finish = (): void => {
    // EXIT: 已结算，或直系 child 尚未回执（无 close 可兑现）。
    if (settled || closeOutcome === undefined) return;
    settled = true;
    if (killTimer !== undefined) clearTimeout(killTimer);
    settle(closeOutcome);
  };

  /**
   * close 到达时的收口：未请求拆除（自然退出）、拆除链已收口、或组当场
   * 已空 → 结算；否则把等待交给已 armed 的 SIGKILL 升级链。
   */
  const close = (outcome: SpawnResult): void => {
    closeOutcome = outcome;
    const pid = child.pid;
    // EXIT: 无拆除在飞 → 自然退出；拆除已收口 / 组当场已空 / pid 不可得
    // → 无升级链需要等待，直接结算。
    if (
      !teardownRequested ||
      groupClear ||
      pid === undefined ||
      !groupAlive(pid)
    ) {
      finish();
    }
  };

  const stop = (): void => {
    const pid = child.pid;
    // EXIT: 幂等 —— 已结算或拆除已在飞，或 pid 不可得（无处可杀）。
    if (settled || teardownRequested || pid === undefined) return;
    teardownRequested = true;
    killProcessGroupLocal(pid, "SIGTERM");
    killTimer = setTimeout(() => {
      killProcessGroupLocal(pid, "SIGKILL");
      // SIGKILL 免疫不了，但落到组上要一拍；窗口耗尽即无条件收口 —— 不可杀
      // 的组（D 态）不该把调用方挂死。
      void waitForGroupGone(pid, GROUP_SETTLE_MS).then(() => {
        groupClear = true;
        // close 尚未到达（不可中断的 child）→ 用 SIGKILL 结果兜底，否则
        // promise 永远悬着。
        closeOutcome ??= killedOutcome();
        finish();
      });
    }, graceMs);
    // 刻意不 unref：close 早于组清空时（正是事故形状），这根 timer 是唯一的
    // 结算路径 —— unref 掉会让调用方的 promise 永远悬着。
    void waitForGroupGone(pid, graceMs).then((gone) => {
      // EXIT: 宽限期内组未清空 → 升级链（killTimer）接手结算。
      if (!gone) return; // 升级链接手
      groupClear = true;
      finish();
    });
  };

  /** spawn 失败：撤掉在飞的 timer，让调用方走 reject 而不是被结算路径抢先。 */
  const failed = (): void => {
    settled = true;
    if (killTimer !== undefined) clearTimeout(killTimer);
  };

  return { stop, close, failed };
}

/**
 * Spawn in a detached process group so cancellation can stop the whole tree.
 * The returned promise centralizes output collection and the TERM-to-KILL
 * escalation shared by sandbox consumers.
 */
export function spawnWithStopSignal(
  command: string,
  args: readonly string[],
  options: SpawnWithStopSignalOptions
): SpawnWithStopSignalResult {
  const child = spawn(command, args, {
    cwd: options.cwd,
    ...(options.env !== undefined ? { env: options.env } : {}),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let resolveDone: (r: SpawnResult) => void = () => undefined;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // 拆除序列收在一处：**仅本前台 exec 路径**（abort / tier timeout / 自然退出）
  // 共用，两边不会各自漂移。后台 bash_stop 走另一条实现
  // （background/manager.ts + sandbox/server/spawn.ts 的 createStopHandle），
  // 不在本函数覆盖范围内。
  const teardown = createTreeTeardown(
    child,
    options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    (outcome) => {
      options.signal?.removeEventListener("abort", teardown.stop);
      resolveDone(outcome);
    },
    () => ({ code: null, signal: "SIGKILL", stdout, stderr })
  );

  const done = new Promise<SpawnResult>((resolve, reject) => {
    resolveDone = resolve;
    child.once("error", (error) => {
      teardown.failed();
      options.signal?.removeEventListener("abort", teardown.stop);
      reject(error);
    });
    child.once("close", (code, signal) => {
      teardown.close({ code, signal, stdout, stderr });
    });
  });

  if (options.signal?.aborted) teardown.stop();
  else options.signal?.addEventListener("abort", teardown.stop, { once: true });

  return { child, done };
}

/** 进程组探活：任一组员在场即 true（EPERM 无法判定 → 保守视为在场）。 */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EXIT: ESRCH = 组已不存在 → false；其余 errno（EPERM 等）无法判定 →
    // 保守视为在场，让升级链继续持有结算权。
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * 有界轮询到进程组消失：窗口内清空 → true；窗口耗尽 → 以最后一次探活为准。
 * 组拆除是 best-effort，永远有界，不把调用方挂死在一个不可杀的组上。
 */
async function waitForGroupGone(pgid: number, capMs: number): Promise<boolean> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true;
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
  }
  return !groupAlive(pgid);
}

export function signalExitCode(signal: NodeJS.Signals | null): number {
  return signal === null ? 1 : (SIGNAL_EXIT_CODES[signal] ?? 1);
}

export function requireBwrap(): void {
  const probe = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
  if (probe.status !== 0)
    throw new ToolExecutionError(
      "runInSandbox: bwrap is required; install bwrap (≥ 0.11.1) via apt install bubblewrap or your distro equivalent"
    );
}

export interface SandboxRunResult {
  /** 退出码；被信号终止时 = 128 + signal number（见 SIGNAL_EXIT_CODES）。 */
  readonly exitCode: number;
  /** 已按 maxOutputCodePoints 截断。 */
  readonly stdout: string;
  /** 已按 maxOutputCodePoints 截断。 */
  readonly stderr: string;
}

export interface SandboxRunOptions {
  readonly fence: BwrapFence;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly env: NodeJS.ProcessEnv;
  /** 输出截断上限，默认 DEFAULT_MAX_OUTPUT_CODE_POINTS（12_000）。 */
  readonly maxOutputCodePoints?: number;
  /** 透传 spawnWithStopSignal 的 SIGTERM→SIGKILL 宽限期；默认 2s。 */
  readonly killGraceMs?: number;
}

export async function runInSandbox(
  opts: SandboxRunOptions
): Promise<SandboxRunResult> {
  // ADR-0045 T8(a): in-process 直调路径降级为 server handler 薄包装 —— 保留
  // 此函数签名(SandboxRunResult)以兼容既有 30+ fixture,内部走 server.exec
  // 短生命周期协议。同进程 router 形态下 = 函数调用,无 IPC 成本。
  const server = createSandboxServer();
  return server.exec({
    kind: "exec",
    fence: opts.fence,
    cwd: opts.cwd,
    env: opts.env,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.maxOutputCodePoints !== undefined
      ? { maxOutputCodePoints: opts.maxOutputCodePoints }
      : {}),
    ...(opts.killGraceMs !== undefined
      ? { killGraceMs: opts.killGraceMs }
      : {}),
  });
}

function killProcessGroupLocal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * 给 server 复用:发送信号到 detached 进程组,ESRCH(组已消失)吞掉,
 * 其他错误经 `log` 上报(不抛 — kill 升级是 best-effort,失败 = reap
 * 不彻底,不阻断主流程)。
 *
 * Why a shared helper:server/index.ts 内联版本与 runner 本地版本吞错
 * 行为不一致(runner 抛,server log);server 形态要求 never-throw(若
 * kill 抛错会触发 typed `server_unreachable`,而 reap 本属内部清理,
 * 不该升级为可观察故障面)。统一对外只暴露 `killProcessGroup` 这条
 * best-effort 路径,runner 内部用本地严格版本。
 */
export function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  log?: (msg: string) => void
): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    log?.(`killProcessGroup: kill -${pid} ${signal} failed: ${String(error)}`);
  }
}
