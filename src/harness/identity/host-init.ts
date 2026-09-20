/**
 * Host-side init script hook.
 *
 * Why: if a user's initialization script (read ~/.iknow/, create dirs, seed
 * config) were run by the agent through the bash tool, it would be
 * classified as execute → ask → TTY y/N interception — "a startup script that
 * still needs manual confirmation" is counterintuitive (user feedback). This
 * is a host-side hook instead: the host process spawns the user's own script,
 * bypassing the agent bash tool → no permission prompt, no allowlist, no fs
 * soft-sandbox limits (writing ~/.iknow is the host's own business).
 *
 * Trigger surface:
 *   - `runHostInitScript()` is called once at chat / ask / serve process startup.
 *   - Script path: `IKNOW_HOST_INIT_SCRIPT` env, or default `~/.iknow/init.sh`.
 *   - File absent → skip (zero behavior change); execution failure → warn +
 *     never block assembly (degradation contract, same as
 *     `initIknowWorkspaceSafe`).
 *
 * Safety constraints:
 *   - Timeout (default 15s): on timeout → kill the process group → assembly
 *     is not blocked.
 *   - Output lands on stderr (visible but without the `execution_failed`
 *     prefix — it is not an agent tool result).
 *   - No dangerous-command interception: the script is user-authored, and the
 *     host applies no hard-wall / allowlist validation to it (that was never
 *     its semantics). The user runs what they wrote, at their own risk.
 *
 * Relation to `initIknowWorkspaceSafe()`: the latter seeds iknow's own
 * template files (user.md / state.json) driven by code constants; the former
 * runs a **user-authored** script — the two are independent. Ordering:
 * initIknowWorkspaceSafe first (code constants), then runHostInitScript
 * (user script), so the user script can read the already-seeded
 * user.md / state.json.
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
    return skipResult(scriptPath);
  }
  const { cwd, timeoutMs, env } = resolveSpawnOpts(opts);
  return runScript(scriptPath, { cwd, timeoutMs, env });
}

/** Result factory for the "script absent" path. */
function skipResult(scriptPath: string): HostInitScriptResult {
  return {
    ran: false,
    scriptPath,
    exitCode: null,
    stdout: "",
    stderr: "",
  };
}

/** Normalize spawn options from the public API. */
function resolveSpawnOpts(opts: RunHostInitScriptOpts): {
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
} {
  return {
    cwd: opts.cwd ?? process.cwd(),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: opts.env ?? process.env,
  };
}

/** Spawn the script and return a single settled result via the lifecycle helpers. */
function runScript(
  scriptPath: string,
  spawnOpts: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }
): Promise<HostInitScriptResult> {
  const { cwd, timeoutMs, env } = spawnOpts;
  const child = spawn("/bin/bash", [scriptPath], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const buf = createOutputBuffer();
  collectOutput(child, buf);
  return new Promise<HostInitScriptResult>((resolve) => {
    const ctx: LifecycleCtx = { child, scriptPath, buf, resolve };
    armTimeout(ctx, timeoutMs);
    wireErrorHandler(ctx);
    wireCloseHandler(ctx);
  });
}

/** Mutable buffer that caps collected stdout / stderr at OUTPUT_TRUNCATE bytes.
 *  Internal mutable state via closure — the returned object exposes append and
 *  snapshot but no live strings (avoids getter reactivity footguns). */
interface OutputBuffer {
  readonly append: (stream: "stdout" | "stderr", chunk: string) => void;
  readonly snapshot: () => { stdout: string; stderr: string };
}

function createOutputBuffer(): OutputBuffer {
  let stdout = "";
  let stderr = "";
  return {
    append: (stream, chunk) => {
      if (stream === "stdout" && stdout.length < OUTPUT_TRUNCATE) {
        stdout += chunk;
      } else if (stream === "stderr" && stderr.length < OUTPUT_TRUNCATE) {
        stderr += chunk;
      }
    },
    snapshot: () => ({
      stdout: stdout.slice(0, OUTPUT_TRUNCATE),
      stderr: stderr.slice(0, OUTPUT_TRUNCATE),
    }),
  };
}

function collectOutput(
  child: ReturnType<typeof spawn>,
  buf: OutputBuffer
): void {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => buf.append("stdout", chunk));
  child.stderr?.on("data", (chunk: string) => buf.append("stderr", chunk));
}

/** Lifecycle state passed through spawn event handlers — single object so each
 *  handler stays short. */
interface LifecycleCtx {
  readonly child: ReturnType<typeof spawn>;
  readonly scriptPath: string;
  readonly buf: ReturnType<typeof createOutputBuffer>;
  readonly resolve: (r: HostInitScriptResult) => void;
  // Mutable bookkeeping — settled prevents double-resolve; timer is the
  // pending timeout handle that armTimeout may install. Both fields start
  // undefined on the freshly constructed object and are populated by the
  // first call to settle / armTimeout.
  settled?: boolean;
  timer?: NodeJS.Timeout;
}

function settle(ctx: LifecycleCtx, result: HostInitScriptResult): void {
  if (ctx.settled) return;
  ctx.settled = true;
  if (ctx.timer !== undefined) clearTimeout(ctx.timer);
  ctx.resolve(result);
}

function armTimeout(ctx: LifecycleCtx, timeoutMs: number): void {
  if (timeoutMs <= 0) return;
  ctx.timer = setTimeout(() => {
    const pid = ctx.child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* ESRCH etc. — ignore */
      }
    }
    const snap = ctx.buf.snapshot();
    settle(ctx, {
      ran: true,
      scriptPath: ctx.scriptPath,
      exitCode: null,
      stdout: snap.stdout,
      stderr: snap.stderr,
      warn: `host init: timed out after ${timeoutMs}ms; killed`,
    });
  }, timeoutMs);
  if (ctx.timer.unref) ctx.timer.unref();
}

function wireErrorHandler(ctx: LifecycleCtx): void {
  ctx.child.once("error", (err) => {
    settle(ctx, {
      ran: true,
      scriptPath: ctx.scriptPath,
      exitCode: null,
      stdout: "",
      stderr: "",
      warn: `host init: spawn failed: ${err.message}`,
    });
  });
}

function wireCloseHandler(ctx: LifecycleCtx): void {
  ctx.child.once("close", (code, signal) => {
    const snap = ctx.buf.snapshot();
    settle(ctx, {
      ran: true,
      scriptPath: ctx.scriptPath,
      exitCode: signal === null ? code : null,
      stdout: snap.stdout,
      stderr: snap.stderr,
      ...closeReason(signal, code),
    });
  });
}

/** Map child-process close outcome to the warn / silent piece of the result. */
function closeReason(
  signal: NodeJS.Signals | null,
  code: number | null
): { warn?: string } {
  if (signal !== null) {
    return { warn: `host init: terminated by signal ${signal}` };
  }
  if (code !== 0) {
    return { warn: `host init: exit code ${code}` };
  }
  return {};
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
