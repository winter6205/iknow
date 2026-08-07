/**
 * Host-side init script hook (W1).
 *
 * 为什么需要这个:用户的初始化脚本(读 ~/.iknow/、建目录、seed 配置)如果
 * 由 agent 用 bash 工具跑,会被 execute 分类 → ask → TTY y/N 拦截,体验
 * 上"启动脚本还要用户手动确认"违反直觉(用户的反馈)。参照
 * upstream-openharness 的 `initialize_workspace`(宿主侧直接 seed 模板,
 * 不走 agent 权限),这里提供宿主侧的 init 脚本执行钩子:由宿主进程
 * spawn 执行用户自写脚本,不经过 agent bash 工具 → 无权限确认、无
 * allowlist 限制、无 fs 软沙箱限制(写 ~/.iknow 是宿主自己的事)。
 *
 * 触发面:
 *   - `runHostInitScript()` 在 chat / ask / serve 进程启动时各调一次。
 *   - 脚本路径:`IKNOW_HOST_INIT_SCRIPT` env 指定,或默认 `~/.iknow/init.sh`。
 *   - 文件不存在 → skip(零行为变化);执行失败 → warn + 不阻塞装配
 *     (降级契约,同 `initIknowWorkspaceSafe`)。
 *
 * 安全约束:
 *   - 超时(默认 15s):超时 → kill 进程组 → 不阻塞装配。
 *   - 输出落 stderr(可见但不带 `execution_failed` 前缀 — 不是 agent 工具结果)。
 *   - 危险命令拦截:脚本由用户自写,宿主不对其做 hard-wall / allowlist
 *     校验(那本就不是它的语义)。用户写啥跑啥,责任自负。
 *
 * 与 `initIknowWorkspaceSafe()` 的关系:后者 seed iknow 自身的模板文件
 * (user.md / state.json),由代码常量驱动;前者是**用户自写**脚本,二者
 * 独立。先后顺序:先 initIknowWorkspaceSafe(代码常量),再 runHostInitScript
 * (用户脚本),这样用户脚本可以读到已 seed 的 user.md / state.json。
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULT_HOST_INIT_SCRIPT = path.join(os.homedir(), ".iknow", "init.sh");
const DEFAULT_TIMEOUT_MS = 15_000;

export interface HostInitScriptResult {
  /** Whether the script was found and executed (true) or skipped (false). */
  readonly ran: boolean;
  /** Resolved script path (whether ran or not — useful for diagnostics). */
  readonly scriptPath: string;
  /** Exit code; null when skipped or killed by timeout / signal. */
  readonly exitCode: number | null;
  /** Truncated stdout (≤ 4 KiB) for `[/iknow-host-init]` log line. */
  readonly stdout: string;
  /** Truncated stderr (≤ 4 KiB). */
  readonly stderr: string;
  /** Reason for skip / failure — non-empty triggers a stderr warn. */
  readonly warn?: string;
}

export interface RunHostInitScriptOpts {
  /** Override script path. Falls back to env IKNOW_HOST_INIT_SCRIPT, then
   *  ~/.iknow/init.sh. `null` forces skip. */
  readonly scriptPath?: string | null;
  /** Working directory for the script. Default `process.cwd()`. */
  readonly cwd?: string;
  /** Timeout in ms. Default 15_000. Set ≤ 0 to disable. */
  readonly timeoutMs?: number;
  /** Env passed to the script. Default `process.env` (full inherit). */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the effective script path from opts → env → default.
 * Returns `null` if the caller passed `scriptPath: null` (explicit skip).
 */
function resolveScriptPath(opts: RunHostInitScriptOpts): string | null {
  if (opts.scriptPath === null) return null;
  if (typeof opts.scriptPath === "string" && opts.scriptPath.length > 0) {
    return opts.scriptPath;
  }
  const fromEnv = process.env.IKNOW_HOST_INIT_SCRIPT;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return DEFAULT_HOST_INIT_SCRIPT;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const OUTPUT_TRUNCATE = 4_096;

/**
 * Run the host-side init script if it exists. Returns a result descriptor;
 * never throws. Callers should inspect `warn` to surface stderr diagnostics.
 */
export function runHostInitScript(
  opts: RunHostInitScriptOpts = {}
): Promise<HostInitScriptResult> {
  const scriptPath = resolveScriptPath(opts);
  if (scriptPath === null) {
    return Promise.resolve({
      ran: false,
      scriptPath: "",
      exitCode: null,
      stdout: "",
      stderr: "",
      warn: "host init: skipped (explicit null)",
    });
  }
  return executeScript(scriptPath, opts);
}

async function executeScript(
  scriptPath: string,
  opts: RunHostInitScriptOpts
): Promise<HostInitScriptResult> {
  if (!(await fileExists(scriptPath))) {
    return {
      ran: false,
      scriptPath,
      exitCode: null,
      stdout: "",
      stderr: "",
    };
  }
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = opts.env ?? process.env;

  return new Promise<HostInitScriptResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn("/bin/bash", [scriptPath], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (result: HostInitScriptResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < OUTPUT_TRUNCATE) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < OUTPUT_TRUNCATE) stderr += chunk;
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const pid = child.pid;
        if (pid !== undefined) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* ESRCH 等忽略 */
          }
        }
        finish({
          ran: true,
          scriptPath,
          exitCode: null,
          stdout: stdout.slice(0, OUTPUT_TRUNCATE),
          stderr: stderr.slice(0, OUTPUT_TRUNCATE),
          warn: `host init: timed out after ${timeoutMs}ms; killed`,
        });
      }, timeoutMs);
      if (timer.unref) timer.unref();
    }

    child.once("error", (err) => {
      finish({
        ran: true,
        scriptPath,
        exitCode: null,
        stdout: "",
        stderr: "",
        warn: `host init: spawn failed: ${err.message}`,
      });
    });

    child.once("close", (code, signal) => {
      const truncatedStdout = stdout.slice(0, OUTPUT_TRUNCATE);
      const truncatedStderr = stderr.slice(0, OUTPUT_TRUNCATE);
      if (signal !== null) {
        finish({
          ran: true,
          scriptPath,
          exitCode: null,
          stdout: truncatedStdout,
          stderr: truncatedStderr,
          warn: `host init: terminated by signal ${signal}`,
        });
        return;
      }
      if (code !== 0) {
        finish({
          ran: true,
          scriptPath,
          exitCode: code,
          stdout: truncatedStdout,
          stderr: truncatedStderr,
          warn: `host init: exit code ${code}`,
        });
        return;
      }
      finish({
        ran: true,
        scriptPath,
        exitCode: code,
        stdout: truncatedStdout,
        stderr: truncatedStderr,
      });
    });
  });
}

/**
 * Convenience wrapper: run the host init script and emit a single stderr
 * line if anything is worth reporting. Silent on success (ran=true, no warn).
 *
 * Use this in product entry points (chat / ask / serve startup).
 */
export async function runHostInitScriptSafe(
  opts?: RunHostInitScriptOpts
): Promise<HostInitScriptResult> {
  const result = await runHostInitScript(opts);
  if (result.warn) {
    const tag = "[iknow-host-init]";
    if (result.stderr.length > 0) {
      process.stderr.write(`${tag} ${result.warn}\n${result.stderr}\n`);
    } else {
      process.stderr.write(`${tag} ${result.warn}\n`);
    }
  } else if (result.ran && process.env.IKNOW_HOST_INIT_VERBOSE === "1") {
    // Verbose mode: surface success too (handy for the user's own debugging).
    process.stderr.write(
      `[iknow-host-init] ok: ${result.scriptPath} (exit ${result.exitCode})\n`
    );
  }
  return result;
}
