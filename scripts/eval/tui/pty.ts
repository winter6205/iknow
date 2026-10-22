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
 * token, requires every chunk of it to come back as an APP PAINT — a renderer
 * that changes a cell addresses it first, and the kernel echo cannot — then
 * clears the composer and requires the token to stop being rendered. It NEVER
 * writes a CR — `PtySession.writes` is retained so a test can prove that
 * structurally — and its verdict is recorded separately from the measured
 * stimulus sequence.
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

/** A ref'd hold on the event loop, released when the run is over. */
export interface ProcessLifetime {
  readonly label: string;
  release(): void;
}

/**
 * Keep the process alive for as long as a run is pending.
 *
 * WHY this exists (#1221): before the repair, EVERY deadline this driver
 * awaited was an UNREF'd timer — `delay` below (still unref'd today), the
 * outer watchdog (still unref'd, but covered by this guard), the paced writes,
 * the poll loop and the horizon hold, plus `waitForExit`'s deadline, which was
 * made REF'D as part of the same repair because it is the one wait phase 3
 * blocks on directly. A relay/child whose handles closed while the driver was
 * parked on one of the still-unref'd waits left nothing ref'd, the event loop
 * drained, and Node exited with the DEFAULT status 0: no report printed, no
 * `check-report.json` written, no non-zero signal at all.
 *
 * The handle below is deliberately REF'D (never `unref()`ed — that is the
 * defect, not the fix) and is held for the WHOLE run, teardown included. A
 * pending run therefore cannot drain to a default 0; it can only end by
 * finishing, failing, or being killed from outside.
 *
 * This does NOT explain the original 24-second measured run: that run
 * preserved neither the relay's `EXIT` line nor any post-sample process
 * status, so why its child/relay handles disappeared is still unknown.
 */
export function holdProcessAlive(label: string): ProcessLifetime {
  const timer = setInterval(() => {}, 60_000);
  let released = false;
  return {
    label,
    release(): void {
      if (released) return;
      released = true;
      clearInterval(timer);
    },
  };
}

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
  exitWaiters: Array<{
    resolve: (s: ExitStatus | null) => void;
    /** Present once the deadline timer exists, so it can be cleared on settle.
     *  Accepts `null` too: a relay that closed without an `EXIT` record is
     *  also an answer, and the ref'd timer must not outlive it. */
    settle?: (s: ExitStatus | null) => void;
  }>;
}

function notifyExit(state: RelayState): void {
  const status = parseExit(state.relayLog);
  for (const waiter of state.exitWaiters.splice(0)) {
    // Clear the ref'd deadline on BOTH settlement kinds — a parsed status and a
    // null (relay closed without `EXIT`) — otherwise the answerless closure
    // leaves the timer alive for the rest of its window.
    if (waiter.settle !== undefined) waiter.settle(status);
    else waiter.resolve(status);
  }
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
  try {
    assertPtyCleanupComplete(state, relayPid);
  } finally {
    // WHY unregister even on failure: the disposal promise is memoised, so a
    // session that could not be proven clean would otherwise stay in the
    // module registry forever and make every LATER `disposeAllPtySessions()`
    // rethrow the same `PtyCleanupError`. Unproven is reported, not retried.
    removeOpenSession(session);
  }
}

function endRelayInput(state: RelayState): void {
  try {
    state.relay.stdin?.end();
  } catch {
    // EXIT: the pipe is already closed.
  }
}

/** The next bounded teardown step, or null when nothing is left to release. */
export type TeardownStep = "kill_relay" | "stop_child";

/**
 * The teardown ladder, as a pure decision over what was OBSERVED.
 *
 * WHY it is a decision and not a branch chain: the escalation that SIGKILLs a
 * relay which never closed is the one path that runs when teardown has already
 * gone wrong, and it had zero test references — nothing could reach it. Naming
 * the steps makes the ladder testable without a process that refuses to die,
 * which is the only kind of fixture available.
 */
export function nextTeardownStep(observed: {
  readonly relayClosed: boolean;
  readonly childAlive: boolean;
  /** True once this run has already sent the relay's own kill signal. */
  readonly relayKillSent: boolean;
}): TeardownStep | null {
  if (observed.relayClosed && !observed.childAlive) return null;
  if (observed.relayClosed) return "stop_child";
  if (observed.relayKillSent) return "stop_child";
  return "kill_relay";
}

async function stopRelayAndChild(
  state: RelayState,
  relayPid: number
): Promise<void> {
  // EOF makes the relay kill the child group, waitpid it, and report EXIT.
  // Keep the relay alive for that reap; only signal the child directly if the
  // relay does not finish within its bounded grace period.
  if (await waitForRelayClose(state, RELAY_REAP_GRACE_MS)) {
    await stopChildIfStillAlive(state);
    return;
  }
  await killChildAndWaitForRelay(state);
  const step = nextTeardownStep({
    relayClosed: state.closed,
    childAlive: isProcessAlive(state.childPid),
    relayKillSent: false,
  });
  if (step === "kill_relay") {
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
    const waiter: RelayState["exitWaiters"][number] = { resolve };
    state.exitWaiters.push(waiter);
    // REF'D on purpose: this is the deadline phase 3 blocks on, and an unref'd
    // one let the process drain out of it with Node's default status 0. The
    // run-level `holdProcessAlive` guard covers the waits made outside a run.
    //
    // Cleared once the answer is delivered. Being ref'd, an uncleared timer keeps
    // the loop alive for the rest of its window, so a fast child exit could delay
    // a process that is otherwise ready to exit by up to `exitGraceMs`.
    const timer = setTimeout(() => {
      const at = state.exitWaiters.indexOf(waiter);
      if (at >= 0) state.exitWaiters.splice(at, 1);
      resolve(null);
    }, ms);
    // `notifyExit` resolves from OUTSIDE this promise, so the clear has to live
    // on the waiter it shares with them. It takes `null` as well: a relay that
    // closed without an `EXIT` record is an answer too, and must clear the timer.
    waiter.settle = (status: ExitStatus | null) => {
      clearTimeout(timer);
      resolve(status);
    };
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

/**
 * How the probe types, and the paced-chunk geometry it then has to recognize.
 *
 * The probe must type in paced chunks — that is the whole point of a readiness
 * probe, since an unpaced burst can land before the renderer is attached — but
 * a paced token is repainted CHUNK BY CHUNK, so the geometry below is also the
 * shape the echo observation has to survive.
 */
const PROBE_CHUNK_BYTES = 8;
const PROBE_CHUNK_DELAY_MS = 20;

/** Any CSI escape sequence: the cell-addressing a renderer must emit. */
const CSI_RE = /\u001b\[/;

/**
 * The shortest token fragment treated as residue.
 *
 * Long enough that a hex digest cannot collide by chance in a few KB of raw
 * terminal bytes, short enough to catch a composer that kept a prefix of the
 * probe token — the partial-echo case, where the composer holds all the
 * characters but only some of them were ever painted.
 */
const RESIDUE_MIN_FRAGMENT = 6;

/**
 * How long the composer must render WITHOUT the token before the clear counts
 * as done, and the ceiling on how long that may be waited for.
 *
 * The wait is for the SETTLED composer, never for a fixed sleep to elapse: a
 * surface that repaints continuously keeps re-proving the absence, and a
 * surface whose clear did not take re-renders the text on its next frame and
 * fails inside the budget. A fixed sleep would prove neither.
 */
const CLEAR_QUIET_MS = 400;
const CLEAR_BUDGET_MS = 1500;

/** How the terminal produced one chunk of the probe token. */
type ChunkOrigin = "painted" | "bare-echo" | "absent";

/** What the raw stream showed for the whole token. */
interface PaintObservation {
  readonly painted: number;
  readonly bare: number;
  readonly absent: readonly string[];
  /** True when EVERY chunk was produced by a cell-addressing repaint. */
  readonly complete: boolean;
}

/**
 * Classify one chunk by what produced it.
 *
 * WHY THE ESCAPE IS THE SIGNAL. A renderer that changes a cell must address it,
 * so it emits a CSI before the glyphs. The kernel line-discipline — the thing
 * that echoes typed bytes before the TUI has put the terminal in raw mode —
 * cannot do that: it writes back exactly the bytes the parent wrote, with no
 * escape and no addressing. Measured on the real surface, a pre-readiness token
 * lands in the raw stream BARE, which is precisely why finding a token in those
 * bytes is not proof of a rendered composer.
 *
 * `from` is where the previous chunk's occurrence ended (the probe mark for the
 * first chunk), so the escape has to lie BETWEEN two consecutive chunks. A
 * chunk that follows its predecessor with nothing in between belongs to the SAME
 * burst and inherits its origin: a renderer may paint the whole line at once,
 * and then the run after the first escape is still that renderer's work.
 */
function classifyChunk(
  since: string,
  chunk: string,
  from: number,
  carried: ChunkOrigin | null
): { readonly at: number; readonly origin: ChunkOrigin } {
  const at = since.indexOf(chunk, from);
  if (at < 0) return { at: -1, origin: "absent" };
  if (carried !== null && carried !== "absent" && at === from)
    return { at, origin: carried };
  return {
    at,
    origin: CSI_RE.test(since.slice(from, at)) ? "painted" : "bare-echo",
  };
}

/** Walk the token chunk by chunk through the stream, in write order. */
function observePaint(
  since: string,
  chunks: readonly string[]
): PaintObservation {
  let from = 0;
  let carried: ChunkOrigin | null = null;
  let painted = 0;
  let bare = 0;
  const absent: string[] = [];
  for (const chunk of chunks) {
    const found = classifyChunk(since, chunk, from, carried);
    carried = found.origin;
    if (found.origin === "painted") painted += 1;
    else if (found.origin === "bare-echo") bare += 1;
    else {
      absent.push(chunk);
      continue;
    }
    // Resume after this occurrence so the next chunk is matched LATER in the
    // stream, which is the order the probe wrote them in.
    from = found.at + chunk.length;
  }
  return {
    painted,
    bare,
    absent,
    complete: painted === chunks.length && chunks.length > 0,
  };
}

/**
 * Wait, bounded, for the composer to have PAINTED every chunk of the token.
 *
 * Fails loudly by returning an incomplete observation; it never degrades into a
 * sleep that assumes success, because a sleep is exactly what the historical
 * `--warmup 20` was and what #1219 exists to remove.
 */
async function waitForPaint(
  session: PtySession,
  mark: number,
  chunks: readonly string[],
  ms: number
): Promise<PaintObservation> {
  const deadline = Date.now() + ms;
  for (;;) {
    const seen = observePaint(session.since(mark), chunks);
    if (seen.complete || Date.now() >= deadline) return seen;
    await delay(20);
  }
}

/**
 * True when `after` still shows any readable piece of `token`.
 *
 * Scanning FRAGMENTS rather than the whole token is what makes the check cover
 * a partially echoed token: a composer that kept the first 14 of 24 characters
 * renders the whole token nowhere, so a whole-token search would call that
 * clean.
 */
function holdsResidue(after: string, token: string): boolean {
  if (after.includes(token)) return true;
  for (let n = RESIDUE_MIN_FRAGMENT; n < token.length; n++)
    for (let i = 0; i + n <= token.length; i++)
      if (after.includes(token.slice(i, i + n))) return true;
  return false;
}

/**
 * Prove, bounded, that the composer holds no probe text.
 *
 * Only bytes rendered FROM THIS POINT are inspected, and the proof requires the
 * token to be absent for a whole `CLEAR_QUIET_MS` window inside `CLEAR_BUDGET_MS`.
 * That distinction matters because a clearing composer is repainted WHILE the
 * backspaces are processed: the bytes emitted by the clear itself still show the
 * shrinking token, and reading them as residue would report a clean clear as
 * dirty. A composer that really still holds text re-renders it on its next
 * frame, so the window keeps watching and the budget ends the wait.
 */
async function confirmNoResidue(
  session: PtySession,
  token: string,
  budgetMs: number
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let mark = session.captureMark;
  let lastSeen = Date.now();
  while (Date.now() < deadline) {
    await delay(20);
    if (holdsResidue(session.since(mark), token)) lastSeen = Date.now();
    mark = session.captureMark;
    if (Date.now() - lastSeen >= CLEAR_QUIET_MS) return true;
  }
  return Date.now() - lastSeen >= CLEAR_QUIET_MS;
}

/**
 * Prove the surface is ready WITHOUT submitting anything.
 *
 * Steps: type a unique token in paced chunks → wait, bounded, until EVERY chunk
 * has been produced by a cell-addressing repaint → send one backspace per
 * CHARACTER OF THE WHOLE TOKEN → prove, bounded, that the composer stopped
 * rendering any piece of it.
 *
 * WHY CHUNK BY CHUNK. A paced token is repainted chunk by chunk at the cursor,
 * so it is never CONTIGUOUS in the raw byte stream; demanding one contiguous
 * occurrence reported `ready:false` on a surface that was up, focused and
 * rendering. WHY AN ESCAPE AND NOT JUST THE TOKEN. The kernel echoes the bytes
 * the parent wrote, bare, before the TUI owns the terminal, so a token in the
 * stream proves nothing on its own — `observePaint` requires each chunk to be
 * preceded by cell addressing, which the echo cannot produce.
 *
 * WHY THE CLEAR IS UNCONDITIONAL. It used to be skipped on the `!echoed` path,
 * and that skip WAS the #1221 defect: every attempt typed its token on top of
 * the previous attempt's leftovers, and the next real stimulus was persisted as
 * one user event reading `"<token><token>EVID-AFTER-PROBE"`. A probe may never
 * leave residue, so the clear runs on every attempt, for the FULL token length
 * even when only part of it was ever painted — the composer can hold characters
 * that were never echoed.
 *
 * A surface that paints nothing keeps returning `ready:false` with a detail
 * naming the missing proof, and `enterWrites` stays 0 because nothing here
 * writes a CR.
 */
export async function probeReadiness(
  session: PtySession,
  policy: ReadinessPolicy
): Promise<ReadinessVerdict> {
  const token = makeToken(policy.tokenPrefix);
  const chunks = planChunks(token, {
    chunkBytes: PROBE_CHUNK_BYTES,
    chunkDelayMs: PROBE_CHUNK_DELAY_MS,
  });
  const enterBefore = countEnterWrites(session);
  let echoed = false;
  let cleared = false;
  let painted = 0;
  let bare = 0;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    const mark = session.captureMark;
    for (const chunk of chunks) {
      if (chunk.delayMs > 0) await delay(chunk.delayMs);
      session.write(chunk.text);
    }
    const seen = await waitForPaint(
      session,
      mark,
      chunkTexts(chunks),
      policy.echoTimeoutMs
    );
    painted = seen.painted;
    bare = seen.bare;
    echoed = seen.complete;
    // UNCONDITIONAL, including on the `!echoed` path: residue is the defect.
    for (const key of composerClear(token.length)) session.write(key);
    cleared = await confirmNoResidue(session, token, CLEAR_BUDGET_MS);
    if (echoed && cleared) break;
  }
  const enterWrites = countEnterWrites(session) - enterBefore;
  return {
    ready: echoed && cleared && enterWrites === 0,
    echoed,
    cleared,
    token,
    attempts: policy.attempts,
    enterWrites,
    detail: describeReadiness(echoed, cleared, enterWrites, { painted, bare }),
    evidence: tail(session.since(Math.max(0, session.captureMark - 4000))),
  };
}

function chunkTexts(
  chunks: ReadonlyArray<{ readonly text: string }>
): readonly string[] {
  return chunks.map((c) => c.text);
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
  enterWrites: number,
  paint: { readonly painted: number; readonly bare: number }
): string {
  if (enterWrites > 0)
    return `probe submitted ${enterWrites} Enter keystroke(s); a readiness probe must never submit`;
  if (!echoed)
    return (
      `the composer never echoed the unique probe token as an app paint ` +
      `(${paint.painted} chunk(s) cell-addressed, ${paint.bare} bare kernel echo); ` +
      `the surface is not proven ready`
    );
  if (!cleared)
    return "the token survived the composer clear; the composer line never re-rendered";
  return "the composer echoed a unique token chunk by chunk and cleared it without submitting";
}

/** The last `n` bytes of the capture, ANSI-stripped for a readable artifact. */
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function tail(text: string, n = 2000): string {
  const clean = text.replace(ANSI_RE, "").replace(/\r/g, "\\r");
  return clean.length <= n ? clean : clean.slice(clean.length - n);
}
