/**
 * Real-PTY substrate for the #1219 calibration driver, plus the non-submitting
 * readiness probe.
 *
 * WHY a relay script rather than pipes or `node-pty`: the surface under test is
 * a terminal UI, and a tty-shaped pipe is not a terminal — the child checks
 * `isatty` and sets raw mode. This repository has no `node-pty` dependency and
 * adding one is a lockfile change outside the task, so the PTY path is the
 * platform's own: a generated Python relay (`pty-relay.py`, sibling of this
 * file) does `pty.fork()` so the child gets a real controlling terminal, relays
 * the master VERBATIM on stdout, and reports the child's exit on stderr so a
 * clean `/quit` is distinguishable from a teardown discovery. This is the same
 * mechanism `tests/session-api/crash/pty-harness.ts` uses; it fails loudly if
 * `python3` is missing rather than silently skipping.
 *
 * `probeReadiness` exists because there is NO machine-readable READY event on
 * this entry, and a fixed sleep is not readiness: the historical driver's
 * `--warmup 20` was the only reason its Enter landed. The probe types a unique
 * token, asserts the surface visibly echoes it, clears the composer and asserts
 * the token is gone from everything rendered afterwards. It NEVER writes a CR —
 * `PtySession.writes` is retained so a test can prove that structurally — and
 * its verdict is recorded separately from the measured stimulus sequence.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { composerClear, planChunks } from "./delivery.js";
import type { ExitStatus } from "./stop-policy.js";
import type { ReadinessPolicy } from "./protocol.js";

/** The relay that owns the real pty master. */
const RELAY_PATH = fileURLToPath(new URL("./pty-relay.py", import.meta.url));

/** Python 3 is the PTY path this repository has. */
export const PTY_RELAY_PYTHON = "python3";

const RELAY_REAP_GRACE_MS = 2000;
const CHILD_REAP_GRACE_MS = 2000;
const RELAY_KILL_GRACE_MS = 1000;

export interface PtySpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly rows?: number;
  readonly cols?: number;
}

/** One live PTY child plus the relay that owns the master fd. */
export interface PtySession {
  readonly childPid: number;
  readonly relayPid: number;
  /** Everything the relay wrote on its control channel (stderr). */
  readonly relayLog: () => string;
  write(text: string): void;
  setSize(rows: number, cols: number): void;
  /** Offset into the captured byte stream, for `since()`. */
  readonly captureMark: number;
  /** Verbatim bytes captured after `mark`. */
  since(mark: number): string;
  readonly totalBytes: number;
  /** Every write this session made, in order (readiness-proof evidence). */
  readonly writes: readonly string[];
  /** Wait for an observed exit, bounded. Null when the deadline passed. */
  waitExit(ms: number): Promise<ExitStatus | null>;
  /** Stop the child's process group through the relay and await its reaping. */
  killGroup(reason: string): Promise<void>;
  /** Close the pipes and reap both the child and the relay. Idempotent. */
  dispose(): Promise<void>;
  readonly disposed: boolean;
}

/** The readiness probe's verdict. `ready` requires BOTH observations. */
export interface ReadinessVerdict {
  readonly ready: boolean;
  readonly echoed: boolean;
  readonly cleared: boolean;
  readonly token: string;
  readonly attempts: number;
  /** How many writes contained a carriage return. Must be 0. */
  readonly enterWrites: number;
  readonly detail: string;
  readonly evidence: string;
}

/** A bounded PTY shutdown that could not reap every process it owns. */
export class PtyCleanupError extends Error {
  readonly remainingPids: readonly number[];
  readonly relayClosed: boolean;
  readonly childExitReported: boolean;
  readonly details: readonly string[];

  constructor(args: {
    readonly remainingPids: readonly number[];
    readonly relayClosed: boolean;
    readonly childExitReported: boolean;
  }) {
    const details = [
      ...(args.remainingPids.length > 0
        ? [`owned PIDs remain: ${args.remainingPids.join(", ")}`]
        : []),
      ...(!args.relayClosed ? ["relay did not close"] : []),
      ...(!args.childExitReported ? ["child EXIT was not reported"] : []),
    ];
    super(`PTY cleanup incomplete: ${details.join("; ")}`);
    this.name = "PtyCleanupError";
    this.remainingPids = [...args.remainingPids];
    this.relayClosed = args.relayClosed;
    this.childExitReported = args.childExitReported;
    this.details = details;
  }
}

const openSessions: PtySession[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void timer.unref?.();
  });
}

/** True while a pid is still signallable — used only for leak checks. */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalQuietly(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  if (pid <= 0) return;
  try {
    process.kill(pid, signal);
  } catch {
    // EXIT: already gone.
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  if (pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    signalQuietly(pid, signal);
  }
}

function parseExit(log: string): ExitStatus | null {
  const match = /EXIT (\S+) (\S+)/.exec(log);
  if (match === null) return null;
  const code = match[1] === "None" ? null : Number(match[1]);
  const signal = match[2] === "None" ? null : match[2]!;
  return {
    exited: code !== null,
    code,
    signaled: signal !== null,
    signal,
    detectedBy: "relay-waitpid",
  };
}

interface RelayState {
  readonly relay: ChildProcess;
  childPid: number;
  capture: string;
  relayLog: string;
  /** True once the relay process is gone: nothing more will ever be reported,
   *  so a later `waitExit` must answer immediately instead of burning its
   *  whole deadline. */
  closed: boolean;
  exitWaiters: Array<{ resolve: (s: ExitStatus | null) => void }>;
}

function notifyExit(state: RelayState): void {
  const status = parseExit(state.relayLog);
  for (const waiter of state.exitWaiters.splice(0)) waiter.resolve(status);
}

function spawnRelay(spec: PtySpawn): RelayState {
  return {
    relay: spawn(
      PTY_RELAY_PYTHON,
      [RELAY_PATH, spec.cwd, spec.command, ...spec.args],
      {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: spec.cwd,
        env: spec.env ?? process.env,
      }
    ),
    childPid: -1,
    capture: "",
    relayLog: "",
    closed: false,
    exitWaiters: [],
  };
}

/**
 * Wire the relay's three streams.
 *
 * stdout carries `CHILDPID <pid>` once and the pty master VERBATIM after it, so
 * the byte capture is never filtered. stderr is the relay's own control channel
 * (the child's stderr is the pty slave), which is where the observed child exit
 * arrives — that is what makes a clean `/quit` distinguishable from a teardown
 * discovery.
 */
function attachStreams(state: RelayState): void {
  state.relay.stdout?.on("data", (chunk: Buffer) => {
    let text = chunk.toString("utf8");
    if (state.childPid < 0 && text.startsWith("CHILDPID ")) {
      const nl = text.indexOf("\n");
      state.childPid = Number(text.slice("CHILDPID ".length, nl));
      text = text.slice(nl + 1);
    }
    state.capture += text;
  });
  state.relay.stderr?.on("data", (chunk: Buffer) => {
    state.relayLog += chunk.toString("utf8");
    if (state.relayLog.includes("EXIT ")) notifyExit(state);
  });
  state.relay.once("close", () => {
    state.closed = true;
    notifyExit(state);
  });
  state.relay.once("error", (err: Error) => {
    state.relayLog += `relay error: ${String(err)}`;
    notifyExit(state);
  });
}

/** Release everything this session owns. Safe to call repeatedly. */
async function disposeSession(
  state: RelayState,
  session: PtySession,
  relayPid: number
): Promise<void> {
  endRelayInput(state);
  await stopRelayAndChild(state, relayPid);
  destroyRelayPipes(state);
  assertPtyCleanupComplete(state, relayPid);
  removeOpenSession(session);
}

function endRelayInput(state: RelayState): void {
  try {
    state.relay.stdin?.end();
  } catch {
    // EXIT: the pipe is already closed.
  }
}

async function stopRelayAndChild(
  state: RelayState,
  relayPid: number
): Promise<void> {
  // EOF makes the relay kill the child group, waitpid it, and report EXIT.
  // Keep the relay alive for that reap; only signal the child directly if the
  // relay does not finish within its bounded grace period.
  let relayClosed = await waitForRelayClose(state, RELAY_REAP_GRACE_MS);
  if (!relayClosed) {
    relayClosed = await killChildAndWaitForRelay(state);
  }

  if (!relayClosed) {
    // EXIT: the child group was killed, but its reap grace expired with relay open.
    signalQuietly(relayPid);
    await waitForRelayClose(state, RELAY_KILL_GRACE_MS);
  }

  await stopChildIfStillAlive(state);
}

async function killChildAndWaitForRelay(state: RelayState): Promise<boolean> {
  // EXIT: the relay did not close within the initial grace period.
  signalGroup(state.childPid);
  await waitGone(state.childPid, CHILD_REAP_GRACE_MS);
  return waitForRelayClose(state, RELAY_REAP_GRACE_MS);
}

async function stopChildIfStillAlive(state: RelayState): Promise<void> {
  if (state.childPid > 0 && isProcessAlive(state.childPid)) {
    // EXIT: the relay closed but the child PID remains signalable.
    signalGroup(state.childPid);
    await waitGone(state.childPid, CHILD_REAP_GRACE_MS);
  }
}

function destroyRelayPipes(state: RelayState): void {
  state.relay.stdout?.destroy();
  state.relay.stderr?.destroy();
  state.relay.stdin?.destroy();
}

function assertPtyCleanupComplete(state: RelayState, relayPid: number): void {
  const remainingPids = [state.childPid, relayPid].filter(isProcessAlive);
  const childExitReported =
    state.childPid <= 0 || parseExit(state.relayLog) !== null;
  if (remainingPids.length > 0 || !state.closed || !childExitReported) {
    throw new PtyCleanupError({
      remainingPids,
      relayClosed: state.closed,
      childExitReported,
    });
  }
}

function removeOpenSession(session: PtySession): void {
  const at = openSessions.indexOf(session);
  if (at >= 0) openSessions.splice(at, 1);
}

/** Start a child under a real controlling terminal. */
export async function openPty(spec: PtySpawn): Promise<PtySession> {
  const state = spawnRelay(spec);
  const relayPid = state.relay.pid ?? -1;
  const writes: string[] = [];
  let disposed = false;
  let disposal: Promise<void> | null = null;
  attachStreams(state);
  const dispose = (): Promise<void> => {
    if (disposal === null) {
      disposed = true;
      disposal = disposeSession(state, session, relayPid);
    }
    return disposal;
  };
  const session: PtySession = {
    get childPid() {
      return state.childPid;
    },
    relayPid,
    relayLog: () => state.relayLog,
    write(text: string) {
      writes.push(text);
      state.relay.stdin?.write(text);
    },
    setSize(rows: number, cols: number) {
      state.relay.stdin?.write(`SIZE ${rows} ${cols}\n`);
    },
    get captureMark() {
      return state.capture.length;
    },
    since(mark: number) {
      return state.capture.slice(mark);
    },
    get totalBytes() {
      return state.capture.length;
    },
    writes,
    waitExit: (ms: number) => waitForExit(state, ms),
    killGroup(reason: string) {
      state.relayLog += `kill: ${reason}\n`;
      return dispose();
    },
    get disposed() {
      return disposed;
    },
    dispose,
  };
  await waitForChildPid(session, state);
  if (spec.rows !== undefined && spec.cols !== undefined)
    session.setSize(spec.rows, spec.cols);
  openSessions.push(session);
  return session;
}

function waitForExit(
  state: RelayState,
  ms: number
): Promise<ExitStatus | null> {
  const reported = parseExit(state.relayLog);
  if (reported !== null) return Promise.resolve(reported);
  // The relay is already gone: nothing more can be reported, so answering null
  // now is the truth rather than burning the whole deadline.
  if (state.closed) return Promise.resolve(null);
  return new Promise<ExitStatus | null>((resolve) => {
    const waiter = { resolve };
    state.exitWaiters.push(waiter);
    const timer = setTimeout(() => {
      const at = state.exitWaiters.indexOf(waiter);
      if (at >= 0) state.exitWaiters.splice(at, 1);
      resolve(null);
    }, ms);
    void timer.unref?.();
  });
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(25);
  }
  return !isProcessAlive(pid);
}

async function waitForRelayClose(
  state: RelayState,
  ms: number
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!state.closed && Date.now() < deadline) await delay(25);
  return state.closed;
}

async function waitForChildPid(
  session: PtySession,
  state: RelayState
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (state.childPid > 0) return;
    if (
      state.relayLog.includes("Traceback") ||
      state.relayLog.includes("relay error")
    ) {
      await session.dispose();
      throw new Error(
        `the pty relay could not start:\n${state.relayLog}\n` +
          `A real pty is required. This repository has no node-pty dependency; the ` +
          `available path is Python's pty.fork(), so ${PTY_RELAY_PYTHON} must be on PATH.`
      );
    }
    await delay(25);
  }
  await session.dispose();
  throw new Error("the pty relay never reported a child pid");
}

/** Drain every PTY this module started. Safe to call repeatedly. */
export async function disposeAllPtySessions(): Promise<void> {
  await Promise.all([...openSessions].map((s) => s.dispose()));
}

async function waitForToken(
  session: PtySession,
  mark: number,
  token: string,
  ms: number
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (session.since(mark).includes(token)) return true;
    await delay(20);
  }
  return session.since(mark).includes(token);
}

/**
 * Prove the surface is ready WITHOUT submitting anything.
 *
 * Steps: type a unique token in paced chunks → assert it is visibly echoed →
 * send one backspace per character → assert nothing rendered after the clear
 * still contains the token. A surface that never re-renders its composer returns
 * `cleared:false` and the run refuses to start; that is deliberate, because
 * "probably ready" is exactly what the historical fixed sleep provided.
 */
export async function probeReadiness(
  session: PtySession,
  policy: ReadinessPolicy
): Promise<ReadinessVerdict> {
  const token = makeToken(policy.tokenPrefix);
  const enterBefore = countEnterWrites(session);
  let echoed = false;
  let cleared = false;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    const mark = session.captureMark;
    for (const chunk of planChunks(token, {
      chunkBytes: 8,
      chunkDelayMs: 20,
    })) {
      if (chunk.delayMs > 0) await delay(chunk.delayMs);
      session.write(chunk.text);
    }
    echoed = await waitForToken(session, mark, token, policy.echoTimeoutMs);
    if (!echoed) continue;
    const clearMark = session.captureMark;
    for (const key of composerClear(token.length)) session.write(key);
    await delay(Math.min(500, policy.echoTimeoutMs));
    cleared = !session.since(clearMark).includes(token);
    if (cleared) break;
  }
  const enterWrites = countEnterWrites(session) - enterBefore;
  return {
    ready: echoed && cleared && enterWrites === 0,
    echoed,
    cleared,
    token,
    attempts: policy.attempts,
    enterWrites,
    detail: describeReadiness(echoed, cleared, enterWrites),
    evidence: tail(session.since(Math.max(0, session.captureMark - 4000))),
  };
}

function countEnterWrites(session: PtySession): number {
  return session.writes.filter((w) => w.includes("\r")).length;
}

function makeToken(prefix: string): string {
  const suffix = randomBytes(6).toString("hex");
  const token = `${prefix}-${suffix}`;
  // A CR or LF in the probe token would submit. Refuse rather than sanitize.
  if (/[\r\n]/.test(token))
    throw new Error(
      `readiness token must not contain CR or LF; got: ${JSON.stringify(token)}`
    );
  return token;
}

function describeReadiness(
  echoed: boolean,
  cleared: boolean,
  enterWrites: number
): string {
  if (enterWrites > 0)
    return `probe submitted ${enterWrites} Enter keystroke(s); a readiness probe must never submit`;
  if (!echoed)
    return "the composer never echoed the unique probe token; the surface is not ready";
  if (!cleared)
    return "the token survived the composer clear; the composer line never re-rendered";
  return "the composer echoed a unique token and cleared it without submitting";
}

/** The last `n` bytes of the capture, ANSI-stripped for a readable artifact. */
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function tail(text: string, n = 2000): string {
  const clean = text.replace(ANSI_RE, "").replace(/\r/g, "\\r");
  return clean.length <= n ? clean : clean.slice(clean.length - n);
}
