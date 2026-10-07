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
import {
  NOT_STARTED_CLEANUP,
  confirmedStopped,
  isProcessGroupGone,
  sendSignalToProcessGroup,
  unconfirmedCleanup,
  waitForProcessGroupGone,
  type CleanupEvidence,
} from "./cleanup-result.js";

/** Default output truncation cap for runInSandbox, aligned with bash.ts's existing MAX_OUTPUT_CODE_POINTS. */
export const DEFAULT_MAX_OUTPUT_CODE_POINTS = 12_000;

const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * Extra window to wait for the process group to vanish after SIGKILL. Group
 * teardown is best-effort: give up when the window ends, otherwise one
 * unkillable group would hang the caller forever.
 */
const GROUP_SETTLE_MS = 250;

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
  /**
   * ADR-0134: this run's own runtime deadline. The timer lives here, beside
   * the process, so expiry runs the same TERM/grace/KILL teardown an abort
   * does and the resulting SpawnResult carries the same CleanupEvidence —
   * a deadline is a real stop, not a frontend wait that gives up early.
   *
   * The caller owns the value; this layer only enforces it. It is NOT nested
   * inside any other clock: the highest enforced deadline for a foreground
   * Bash call is the one the model supplied.
   */
  readonly deadlineMs?: number;
  /**
   * How long the escalation waits for the process group to disappear after the
   * last signal before declaring the cleanup unconfirmed. Defaults to
   * GROUP_SETTLE_MS; lowering it only shortens the wait for the *verdict*,
   * never the kill route itself.
   */
  readonly groupObserveMs?: number;
}

export interface SpawnResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * What the bounded cleanup actually observed for the process group. Absent
   * only when the child never ran (spawn failed, so there is no group to
   * report on); `not_started` means no teardown was requested.
   */
  readonly cleanup?: CleanupEvidence;
  /**
   * ADR-0134: true when the run was ended by its own `deadlineMs` rather than
   * by a caller abort, a natural exit or a spawn failure. The process plane
   * cannot tell an abort from a deadline on its own, so the caller records the
   * cause on the way in and this flag is the read-back of it — the two
   * outcomes must stay distinguishable downstream.
   */
  readonly deadlineExpired?: boolean;
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
 *
 * Every terminal transition carries CleanupEvidence: a stop is confirmed only
 * when the group was probed and found absent. A failed signal or a bounded
 * observation that ended with members alive both settle as `unconfirmed` — the
 * chain closes on a deadline either way, so the caller is never left waiting
 * and never told a lie about what is still running.
 */
function createTreeTeardown(
  child: ChildProcess,
  graceMs: number,
  observeMs: number,
  settle: (outcome: SpawnResult, evidence: CleanupEvidence) => void,
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
  /** First non-ESRCH signal failure of this chain; turns the verdict into `unconfirmed`. */
  let teardownFailure: string | undefined;

  const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
    sendSignalToProcessGroup(pgid, signal, (detail) => {
      teardownFailure ??= detail;
    });
  };

  /** Exit condition of the bounded chain: observed gone, or a deadline / failure produced an unconfirmed verdict. */
  const closeOut = (pgid: number, gone: boolean): void => {
    groupClear = true;
    if (gone) {
      finish(confirmedStopped(pgid));
      return;
    }
    finish(
      unconfirmedCleanup(
        pgid,
        teardownFailure !== undefined
          ? "teardown_failed"
          : "observation_expired",
        teardownFailure ??
          "process group still alive when the bounded observation ended"
      )
    );
  };

  /**
   * Single settle point (single-wins): honoured once the direct child has
   * acknowledged. Callers only reach this when "the teardown chain is closed
   * out" — the group-emptiness decision stays at the call sites, this function
   * does not re-judge it.
   */
  const finish = (evidence: CleanupEvidence): void => {
    // EXIT: already settled, or the direct child has not acknowledged yet (nothing to honour).
    if (settled || closeOutcome === undefined) return;
    settled = true;
    if (killTimer !== undefined) clearTimeout(killTimer);
    settle(closeOutcome, evidence);
  };

  /**
   * Close-out when `close` arrives: no teardown requested (natural exit), the
   * teardown chain already closed out, or the group is empty on the spot →
   * settle; otherwise hand the wait to the already-armed SIGKILL escalation.
   */
  const close = (outcome: SpawnResult): void => {
    closeOutcome = outcome;
    const pid = child.pid;
    if (!teardownRequested) {
      // No teardown was ever requested: this is a natural exit, not a stop.
      finish(NOT_STARTED_CLEANUP);
      return;
    }
    // EXIT: teardown closed out, or pid unavailable → nothing left to wait for.
    if (groupClear || pid === undefined) {
      finish(
        unconfirmedCleanup(
          pid ?? -1,
          teardownFailure !== undefined
            ? "teardown_failed"
            : "observation_expired",
          teardownFailure ?? "process group was never observed gone"
        )
      );
      return;
    }
    // EXIT: group empty on the spot → the observation confirms the stop.
    if (isProcessGroupGone(pid)) {
      closeOut(pid, true);
      return;
    }
    // Members survived the direct child's exit — the armed SIGKILL escalation
    // still owns settlement for this group.
  };

  const stop = (): void => {
    const pid = child.pid;
    // EXIT: idempotent — already settled or teardown already in flight, or pid unavailable (nothing to kill).
    if (settled || teardownRequested || pid === undefined) return;
    teardownRequested = true;
    signalGroup(pid, "SIGTERM");
    killTimer = setTimeout(() => {
      signalGroup(pid, "SIGKILL");
      // SIGKILL cannot be ignored either, but landing on the group takes a
      // tick; once the window is spent the chain closes unconditionally — an
      // unkillable group (D state) must not hang the caller.
      void waitForProcessGroupGone(pid, observeMs).then((gone) => {
        // close has not arrived yet (uninterruptible child) → fall back to the
        // SIGKILL outcome, otherwise the promise hangs forever.
        closeOutcome ??= killedOutcome();
        closeOut(pid, gone);
      });
    }, graceMs);
    // Deliberately not unref'd: when close arrives before the group drains
    // (exactly the incident shape), this timer is the only settlement path —
    // unref'ing it would leave the caller's promise hanging forever.
    void waitForProcessGroupGone(pid, observeMs).then((gone) => {
      // EXIT: group not empty within the observation window → the escalation chain (killTimer) takes over settlement.
      if (!gone) return; // the escalation takes over
      closeOut(pid, true);
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
 * The two bounded-teardown budgets, resolved once. Both are per-caller
 * overrides of a default with the same meaning — how long the escalation
 * waits before escalating, and how long it then waits for the group to
 * vanish — so they are read together rather than inlined per call site.
 */
function teardownBudgets(options: SpawnWithStopSignalOptions): {
  readonly graceMs: number;
  readonly observeMs: number;
} {
  return {
    graceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    observeMs: options.groupObserveMs ?? GROUP_SETTLE_MS,
  };
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

  // The teardown sequence is consolidated in one place: shared by the
  // foreground exec path (abort / tier timeout / natural exit) and by the
  // background server path, which drives the same shape through
  // `createStopHandle` in sandbox/server/spawn.ts. Both planes report the same
  // CleanupEvidence vocabulary, so a stop cannot be reported two different ways.
  const { graceMs, observeMs } = teardownBudgets(options);
  // ADR-0134: the deadline's own cause, recorded by the timer that fires it and
  // read back on the single settlement path. A caller abort reaching the
  // teardown first wins over an expired deadline, which is why the flag is
  // set by the timer rather than inferred from a stop.
  let deadlineFired = false;
  const teardown = createTreeTeardown(
    child,
    graceMs,
    observeMs,
    (outcome, evidence) => {
      options.signal?.removeEventListener("abort", teardown.stop);
      resolveDone({
        ...outcome,
        cleanup: evidence,
        ...(deadlineFired ? { deadlineExpired: true } : {}),
      });
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

  // ADR-0134: the runtime deadline rides the same teardown entry as an abort,
  // so an expiring deadline produces the same bounded TERM/grace/KILL route and
  // the same CleanupEvidence an abort does.
  const clearDeadline = armRunDeadline({
    deadlineMs: options.deadlineMs,
    onExpire: () => {
      deadlineFired = true;
      teardown.stop();
    },
  });
  child.once("close", clearDeadline);
  child.once("error", clearDeadline);

  return { child, done };
}

/**
 * ADR-0134: arm this run's runtime deadline, or arm nothing at all.
 *
 * A non-positive or absent `deadlineMs` means "no deadline" — the same reading
 * `teardownBudgets` gives the grace pair — so the timer is not armed rather
 * than armed with a delay that would fire immediately.
 *
 * The returned cancel is what a settlement path (natural exit, abort, spawn
 * failure) calls: a timer that outlived its run would keep the event loop
 * alive for the rest of its duration after nobody is waiting on it.
 *
 * Deliberately not unref'd: on the deadline path this timer is the only thing
 * that can end a command the caller is still waiting on, and unref'ing it
 * would let the process exit out from under a live call.
 */
function armRunDeadline(args: {
  readonly deadlineMs: number | undefined;
  readonly onExpire: () => void;
}): () => void {
  const { deadlineMs, onExpire } = args;
  let timer: NodeJS.Timeout | undefined;
  if (deadlineMs !== undefined && deadlineMs > 0) {
    timer = setTimeout(() => {
      // Disarm first: the handler that runs next may cancel, and cancelling an
      // already-fired timer is a no-op it must not have to know about.
      timer = undefined;
      onExpire();
    }, deadlineMs);
  }
  return (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

/** Process-group liveness probe: true if any member is present (EPERM is undecidable → conservatively treated as present). */
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
  /**
   * Set only when the fence died by signal (the name, e.g. "SIGKILL").
   * `exitCode` on such a run is 128 + signal number — a shell convention that
   * hides the cause — so the two fields together are the whole story.
   */
  readonly signal?: string;
  /**
   * Bounded-teardown evidence for the fence's process group. A timeout or an
   * abort that could not confirm disappearance reports `unconfirmed` here
   * instead of an exit code that reads like a clean finish. Absent only when
   * the fence never started (startup failure path, no group to report on).
   */
  readonly cleanup?: CleanupEvidence;
  /**
   * ADR-0134: true when this run ended because its own `deadlineMs` expired
   * (see SandboxRunOptions.deadlineMs). Absent for every run without a
   * deadline, so a pre-ADR-0134 consumer reads an unchanged result.
   */
  readonly deadline_expired?: boolean;
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
  /**
   * ADR-0134: this run's runtime deadline, enforced by the process plane (see
   * SpawnWithStopSignalOptions.deadlineMs). Undefined = no deadline, the
   * pre-ADR-0134 shape every non-Bash consumer still uses.
   */
  readonly deadlineMs?: number;
  /** Bounded wait for process-group disappearance before reporting `unconfirmed`; default GROUP_SETTLE_MS. */
  readonly groupObserveMs?: number;
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
  const result = await server.exec({
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
    ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
    ...(opts.groupObserveMs !== undefined
      ? { groupObserveMs: opts.groupObserveMs }
      : {}),
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.signal !== undefined ? { signal: result.signal } : {}),
    ...(result.cleanup !== undefined ? { cleanup: result.cleanup } : {}),
    ...(result.deadline_expired !== undefined
      ? { deadline_expired: result.deadline_expired }
      : {}),
  };
}
