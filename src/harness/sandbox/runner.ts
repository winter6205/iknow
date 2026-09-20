/**
 * Sandbox command runner — the shared "command → bwrap fence → spawn →
 * timeout → output capture → truncation" executor used by the bash tool and
 * the verify loop.
 *
 * Dependency direction: sandbox is a base layer consumed by aci/tools
 * (bash/grep/glob) and verify/; this file imports nothing from aci/verify.
 * spawnWithStopSignal / truncateByCodePoint originally lived in
 * aci/tools/helpers.ts and moved here to keep the dependency one-way;
 * helpers.ts still re-exports both for grep / glob / existing tests.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { ToolExecutionError } from "../errors.js";
import type { BwrapFence } from "./bwrap.js";
import { createSandboxServer } from "./server/index.js";

/** Default output truncation cap for runInSandbox, aligned with bash.ts's existing MAX_OUTPUT_CODE_POINTS. */
export const DEFAULT_MAX_OUTPUT_CODE_POINTS = 12_000;

const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * Extra window to wait for the process group to vanish after SIGKILL. Group
 * teardown is best-effort: give up when the window ends, otherwise one
 * unkillable group would hang the caller forever.
 */
const GROUP_SETTLE_MS = 250;

/** Poll interval while waiting for the process group to disappear. */
const GROUP_POLL_MS = 20;

/** signal→exit-code mapping: shell convention = 128 + signal number. */
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
 * Teardown sequence: SIGTERM → grace → SIGKILL → wait for the group to empty.
 *
 * Why close no longer disarms the escalation: `close` arrives only when the
 * direct child exits and its stdio pipes are closed. Descendants may hold no
 * pipe (`> /dev/null` / stdio:"ignore") and be immune to SIGTERM
 * (`trap '' TERM` / own handler / uninterruptible syscall) — in that shape
 * same-group descendants are still running when close arrives. The old
 * implementation cleared the timeout on close, taking the SIGKILL backstop and
 * the caller's wait down with it, so descendants kept walking the whole tree
 * (2026-09-14 incident: `find /` ran ~232s after the tool call returned
 * cancelled). Once teardown is requested, delivery of cancelled must wait for
 * the group to actually drain.
 *
 * Fast path: a tree that TERM can take drains within the grace window and
 * settles immediately (no wasted 2s wait).
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
  /** Close acknowledgement from the direct child; not settled on it until the process group drains (see finish). */
  let closeOutcome: SpawnResult | undefined;
  /** A teardown request has been issued (abort → SIGTERM sent). */
  let teardownRequested = false;
  /** Process group confirmed empty (or judged no longer governable) — the teardown chain is closed out here. */
  let groupClear = false;

  /**
   * Single settle point (single-wins): honoured once the direct child has
   * acknowledged. Callers only reach this when "the teardown chain is closed
   * out" — the group-emptiness decision stays at the call sites, this function
   * does not re-judge it.
   */
  const finish = (): void => {
    // EXIT: already settled, or the direct child has not acknowledged yet (nothing to honour).
    if (settled || closeOutcome === undefined) return;
    settled = true;
    if (killTimer !== undefined) clearTimeout(killTimer);
    settle(closeOutcome);
  };

  /**
   * Close-out when `close` arrives: no teardown requested (natural exit), the
   * teardown chain already closed out, or the group is empty on the spot →
   * settle; otherwise hand the wait to the already-armed SIGKILL escalation.
   */
  const close = (outcome: SpawnResult): void => {
    closeOutcome = outcome;
    const pid = child.pid;
    // EXIT: no teardown in flight → natural exit; teardown closed out / group
    // empty on the spot / pid unavailable → nothing left to wait for, settle.
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
    // EXIT: idempotent — already settled or teardown already in flight, or pid unavailable (nothing to kill).
    if (settled || teardownRequested || pid === undefined) return;
    teardownRequested = true;
    killProcessGroupLocal(pid, "SIGTERM");
    killTimer = setTimeout(() => {
      killProcessGroupLocal(pid, "SIGKILL");
      // SIGKILL cannot be ignored either, but landing on the group takes a
      // tick; once the window is spent the chain closes unconditionally — an
      // unkillable group (D state) must not hang the caller.
      void waitForGroupGone(pid, GROUP_SETTLE_MS).then(() => {
        groupClear = true;
        // close has not arrived yet (uninterruptible child) → fall back to the
        // SIGKILL outcome, otherwise the promise hangs forever.
        closeOutcome ??= killedOutcome();
        finish();
      });
    }, graceMs);
    // Deliberately not unref'd: when close arrives before the group drains
    // (exactly the incident shape), this timer is the only settlement path —
    // unref'ing it would leave the caller's promise hanging forever.
    void waitForGroupGone(pid, graceMs).then((gone) => {
      // EXIT: group not empty within the grace window → the escalation chain (killTimer) takes over settlement.
      if (!gone) return; // the escalation takes over
      groupClear = true;
      finish();
    });
  };

  /** Spawn failure: disarm any in-flight timers so the caller rejects instead of being beaten to settlement. */
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

  // The teardown sequence is consolidated in one place: shared **only by this
  // foreground exec path** (abort / tier timeout / natural exit), so the two
  // sides cannot drift apart. Background bash_stop goes through a different
  // implementation (background/manager.ts + createStopHandle in
  // sandbox/server/spawn.ts), outside this function's coverage.
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

/** Process-group liveness probe: true if any member is present (EPERM is undecidable → conservatively treated as present). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EXIT: ESRCH = group no longer exists → false; other errnos (EPERM etc.)
    // are undecidable → conservatively treated as present, keeping the
    // escalation chain in charge of settlement.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Bounded poll until the process group disappears: emptied within the window →
 * true; window spent → decided by the last liveness probe. Group teardown is
 * best-effort and always bounded, never hanging the caller on an unkillable group.
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
  /** Exit code; on signal termination = 128 + signal number (see SIGNAL_EXIT_CODES). */
  readonly exitCode: number;
  /** Already truncated to maxOutputCodePoints. */
  readonly stdout: string;
  /** Already truncated to maxOutputCodePoints. */
  readonly stderr: string;
}

export interface SandboxRunOptions {
  readonly fence: BwrapFence;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly env: NodeJS.ProcessEnv;
  /** Output truncation cap, default DEFAULT_MAX_OUTPUT_CODE_POINTS (12_000). */
  readonly maxOutputCodePoints?: number;
  /** SIGTERM→SIGKILL grace period passed through to spawnWithStopSignal; default 2s. */
  readonly killGraceMs?: number;
}

export async function runInSandbox(
  opts: SandboxRunOptions
): Promise<SandboxRunResult> {
  // The in-process direct-call path is degraded to a thin wrapper around the
  // server handler (ADR-0045) — this function's signature (SandboxRunResult) is kept for
  // 30+ existing fixtures, internally going through the server.exec
  // short-lived protocol. With the same-process router shape this is just a
  // function call, no IPC cost.
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
 * Reused by the server: send a signal to the detached process group, swallow
 * ESRCH (group already gone), report other errors via `log` (never throw —
 * kill escalation is best-effort; failure = incomplete reap, which must not
 * block the main flow).
 *
 * Why a shared helper: the inlined version in server/index.ts and the runner's
 * local version disagreed on error behaviour (runner throws, server logs); the
 * server shape requires never-throw (a throwing kill would surface as typed
 * `server_unreachable`, while reaping is internal cleanup that must not be
 * escalated into an observable fault surface). Externally only the
 * best-effort `killProcessGroup` path is exposed; the runner keeps its local
 * strict version internally.
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
