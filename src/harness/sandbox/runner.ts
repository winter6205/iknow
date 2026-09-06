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
  let killTimer: NodeJS.Timeout | undefined;
  let settled = false;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const stopTree = (): void => {
    const pid = child.pid;
    if (settled || pid === undefined) return;
    killProcessGroupLocal(pid, "SIGTERM");
    killTimer = setTimeout(() => {
      if (!settled) killProcessGroupLocal(pid, "SIGKILL");
    }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    killTimer.unref();
  };

  if (options.signal?.aborted) stopTree();
  else options.signal?.addEventListener("abort", stopTree, { once: true });

  const done = new Promise<SpawnResult>((resolveDone, rejectDone) => {
    child.once("error", (error) => {
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", stopTree);
      rejectDone(error);
    });
    child.once("close", (code, signal) => {
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", stopTree);
      resolveDone({ code, signal, stdout, stderr });
    });
  });

  return { child, done };
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
