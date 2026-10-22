/**
 * scripts/perf/subagent-spawn.ts — subagent spawn-to-envelope latency
 * (measurement tool, no pass/fail gate).
 *
 * Measures the wall-clock time from "spawn requested" to "the child's first
 * stdout line", for one subagent and for three subagents spawned in parallel.
 * It backs the git-snapshot change: the snapshot used to be captured with a
 * synchronous `spawnSync` during worker assembly, which delayed subagent
 * startup; capturing it asynchronously takes that delay off the startup path.
 *
 * Usage:
 *   npx tsx scripts/perf/subagent-spawn.ts
 *
 * WHAT IS MEASURED (read this before quoting a number) — there are TWO
 * numbers, and they measure DIFFERENT things:
 *
 *   1. `envelopeAtMs` — spawn request → the child's END-OF-TURN ENVELOPE.
 *      That is a FULL MODEL ROUND TRIP: it is network-dominated and
 *      environment-dependent (provider latency, model, load), so the git
 *      snapshot's millisecond-scale cost cannot be isolated from it.
 *
 *   2. `gitCaptureMs` — provider creation → the capture settled. This is the
 *      cost the async change moves OFF the startup path: the three git reads
 *      still happen (nothing is skipped), they just happen in the background
 *      instead of blocking the assembly. It is measured directly against the
 *      repository cwd, on its own labelled output line.
 *
 * NEITHER number is a gate: no threshold, no pass/fail. A duration is never a
 * failure here.
 *
 * WHAT IS OBSERVED ON THE WIRE:
 *   The worker writes on ONE stdout wire. Its terminal envelope is written
 *   AFTER the run phase resolves (the worker writes the envelope once
 *   `runWorkerPhase` returned), so for a short task the child's first stdout
 *   line is the END-OF-TURN ENVELOPE — not the first model output. The
 *   worker's `final_text` frame (the raw pre-fold report) is emitted only
 *   when the report was FOLDED, i.e. when it exceeded the IPC character cap;
 *   a short task is never folded, so the envelope is the only line on the
 *   wire. The output therefore carries the label `measures`
 *   ("end-of-turn envelope"), and `firstLineSource` discloses which line was
 *   actually observed ("final_text" only for a folded report).
 *
 * Output (JSON lines on stdout):
 *   {"type":"subagent-spawn-perf-git-capture","gitCaptureMs":…,"snapshotObserved":…}
 *   {"type":"subagent-spawn-perf","case":"n1","workerCount":1,...}
 *   {"type":"subagent-spawn-perf","case":"n3","workerCount":3,...}
 *   {"type":"subagent-spawn-perf-summary",...}
 *
 * The git-capture line is printed BEFORE the provider-key check, so the
 * capture cost is reproducible even without a live model key.
 *
 * The only non-zero exits are a genuine crash and a config fault that makes the
 * measurement impossible. A missing provider API key → one Not-run marker on
 * stdout, exit 0 (the repo convention — never a false pass). A config fault
 * (e.g. no `settings.llm.model`) → a crash message on stderr, exit 1.
 *
 * The measurement runs the PRODUCTION worker path: the child is started with
 * the production helpers from src/harness/subagent/spawn.ts
 * (`resolveSubagentWorkerSpawnArgs` for the argv, `buildSubAgentChildEnv`
 * for the env wire) as ONE process —
 * `node --import <tsx loader> <repo>/src/cli.ts --subagent-worker` — and is
 * driven through `createSubAgentManager`, so the envelope / manager contract
 * is the production one. Nothing is stubbed and no receipt is fabricated.
 *
 * Teardown: the child is spawned DETACHED (its own process group) so the
 * teardown can signal the whole group — SIGTERM → grace → SIGKILL — and no
 * descendant of a worker survives this script. `detached` is the one
 * teardown-only deviation from the production spawn (production shares the
 * parent's process group); it does not touch the measured path.
 *
 * The child's cwd is the repository root on purpose: the worker's git
 * snapshot is captured against the project identity root (cwd when
 * `IKNOW_PRODUCT_ROOT` is absent), so a temp-dir cwd would silently measure a
 * degraded (no-snapshot) assembly instead of the real one. Every worker gets
 * its own sandbox root under the OS temp dir, the worker trace goes to a temp
 * dir as well, and both are removed afterwards — nothing is written into the
 * repository working tree.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createSubAgentManager } from "../../src/harness/subagent/manager.js";
import type { SubAgentManager, SubAgentSpawn } from "../../src/harness/subagent/manager.js";
import {
  buildSubAgentChildEnv,
  resolveSubagentTraceDir,
  resolveSubagentWorkerSpawnArgs,
} from "../../src/harness/subagent/spawn.js";
import { frameTag } from "../../src/harness/subagent/envelope.js";
import { createGitSnapshotProvider } from "../../src/harness/identity/git-snapshot.js";
import { loadRealLlmEnv } from "../../real-llm/real-llm-env.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli.ts");

/** Trivial task: the number must reflect startup, not task complexity. */
const TASK = "Reply with the single word: ready. Do not call any tools.";

/** Per-worker wallclock cap (the manager SIGTERMs the child when it expires). */
const WORKER_TIMEOUT_MS = 180_000;

/** waitFor cap — above the worker cap, so the manager's own timeout settles first. */
const WAIT_FOR_TIMEOUT_MS = 200_000;

/** Worker counts to measure: one alone, then three in parallel. */
const WORKER_COUNTS: ReadonlyArray<number> = [1, 3];

/** Machine-readable label for what the timing actually measures. */
const MEASURES = "end-of-turn envelope";

/** Machine-readable label for the git-capture timing (its own measurement). */
const GIT_CAPTURE_MEASURES = "git capture";

/** Grace period between the teardown's SIGTERM and its SIGKILL escalation. */
const TEARDOWN_GRACE_MS = 2_000;

/** Wait after the SIGKILL to confirm the children are gone. */
const TEARDOWN_KILL_WAIT_MS = 1_000;

/** Which stdout line came first: the folded report frame or the terminal envelope. */
type FirstLineSource = "final_text" | "envelope";

/** One worker's observation (filled in as the wire speaks). */
interface ChildObservation {
  index: number;
  /** Absolute clock of the spawn request that created this worker. */
  requestAt: number;
  /** Absolute clock of the child's process creation. */
  childSpawnedAt: number;
  /** Absolute clock of the child's first stdout line, or null if none arrived. */
  firstLineAt: number | null;
  firstLineSource: FirstLineSource | null;
  /** Absolute clock of the first `final_text` frame, or null if none arrived. */
  finalTextFrameAt: number | null;
  /** The child's PID (teardown evidence: it must be gone when the script exits). */
  pid: number | null;
}

/** Per-child projection of one observation. */
interface ChildReport {
  readonly index: number;
  readonly pid: number | null;
  /** Spawn request → the child's first stdout line (the end-of-turn envelope). */
  readonly envelopeAtMs: number | null;
  readonly envelopeObserved: boolean;
  /** Which stdout line came first: the folded report or the terminal envelope. */
  readonly firstLineSource: FirstLineSource | null;
  readonly finalTextFrameObserved: boolean;
  readonly finalTextFrameMs: number | null;
  /** Parent-side share: spawn request → child process created. */
  readonly spawnRequestToChildMs: number | null;
  readonly status: "ok" | "failed" | "unknown";
  readonly reason: string | null;
}

/** What was still alive after the teardown (must be all zeros). */
interface TeardownReport {
  readonly children: number;
  readonly leadersAlive: number;
  readonly groupMembersAlive: number;
}

/** One measurement case (N workers spawned in parallel). */
interface CaseResult {
  readonly case: string;
  readonly workerCount: number;
  /** What the timing measures (machine-readable label). */
  readonly measures: string;
  /** Batch's first spawn request → the earliest child's first stdout line. */
  readonly envelopeAtMs: number | null;
  readonly envelopeObserved: boolean;
  readonly firstLineSource: FirstLineSource | null;
  readonly children: ReadonlyArray<ChildReport>;
  readonly teardown: TeardownReport;
}

/**
 * The git-capture measurement: provider creation → the capture settled.
 *
 * This is the cost the async change takes OFF the startup path (the three
 * git reads still happen, in the background). It is measured on its own, so
 * it is not diluted by the network-dominated end-of-turn envelope number.
 */
interface GitCaptureReport {
  /** Provider creation → the capture settled (ms). */
  readonly gitCaptureMs: number;
  /** Whether the capture produced a snapshot (false = degraded / failed). */
  readonly snapshotObserved: boolean;
}

/** The spawn factory runs synchronously inside manager.spawn, so one slot suffices. */
interface RequestClock {
  at: number;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** Every child this script spawned (the process-exit safety net walks this). */
const SPAWNED_CHILDREN = new Set<ChildProcess>();

/** The temp dirs this script owns (removed on exit, even on a hard interrupt). */
const TEMP_DIRS = new Set<string>();

/**
 * Tap the child's stdout for its first line. The manager keeps its own
 * reader on the same stream; this one only observes.
 */
function tapFirstLine(
  child: ChildProcess,
  observations: Map<string, ChildObservation>,
  taskId: string
): void {
  let buffered = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let index: number;
    while ((index = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line.trim().length === 0) continue;
      recordWireLine(observations, taskId, line);
    }
  });
}

/**
 * One complete stdout line of a worker. A tagged `final_text` frame is the
 * raw model report (emitted only for a FOLDED report); an untagged line is
 * the terminal envelope — the end-of-turn line for a short report.
 */
function recordWireLine(
  observations: Map<string, ChildObservation>,
  taskId: string,
  line: string
): void {
  const observation = observations.get(taskId);
  if (observation === undefined) return;
  const now = performance.now();
  const tag = frameTag(line);
  if (tag === "final_text") {
    if (observation.finalTextFrameAt === null) observation.finalTextFrameAt = now;
    if (observation.firstLineAt === null) {
      observation.firstLineAt = now;
      observation.firstLineSource = "final_text";
    }
    return;
  }
  if (tag !== undefined) return; // other tagged frames carry no model output
  if (observation.firstLineAt === null) {
    observation.firstLineAt = now;
    observation.firstLineSource = "envelope";
  }
}

/**
 * Production-shaped worker spawn: one real child process, built from the
 * production helpers and tapped for its first stdout line.
 *
 * The argv comes from `resolveSubagentWorkerSpawnArgs` (the same call the
 * production spawn factory makes) with the repo's CLI entry as `argv1` — the
 * perf script itself is NOT a valid entry, it does not accept
 * `--subagent-worker`. The env comes from `buildSubAgentChildEnv` (the
 * production env-wire builder), so the child env cannot drift from
 * production: the ambient fence spellings are scrubbed and the root / mode
 * wires are written by the production code.
 */
function createProductionSpawn(
  traceDir: string,
  observations: Map<string, ChildObservation>,
  clock: RequestClock,
  liveChildren: Set<ChildProcess>
): SubAgentSpawn {
  return (_def, taskId) => {
    const args = resolveSubagentWorkerSpawnArgs({
      execPath: process.execPath,
      argv1: CLI_ENTRY,
      installRoot: REPO_ROOT,
    });
    const env = buildSubAgentChildEnv({
      traceDir: resolveSubagentTraceDir(traceDir),
      workspaceRoot: REPO_ROOT,
      projectIdentityRoot: REPO_ROOT,
      // Fail-closed posture of a DEFAULT production session, and the reason
      // for each value:
      //   - fenceRetired: undefined → the `IKNOW_FENCE_RETIRED` key is NOT
      //     written, and `buildSubAgentChildEnv` scrubs both ambient fence
      //     spellings (`IKNOW_FENCE_RETIRED` / `IKNOW_YOLO`) from the
      //     inherited env. The worker reads an absent key as "fence present",
      //     so the measured child runs FENCED — the posture this tool
      //     measures. An ambient `IKNOW_YOLO=1` can no longer retire it.
      //   - fsModeToken: undefined → no fs-mode channel is wired, so the
      //     worker keeps its default tier. No token is synthesized here, and
      //     the ambient value cannot loosen anything: the only tokens are
      //     "global" (the default) and "workspace" (the stricter one).
      //   - worktreeGateOn: false → the gate is at its production default
      //     (settings `isolation.worktreeOnMutate` is default-OFF, read
      //     fail-closed as `=== true`), written explicitly as "0" so an
      //     ambient `IKNOW_WORKTREE_GATE_ON` cannot change the posture of
      //     the measured child.
      fsModeToken: undefined,
      worktreeGateOn: false,
      fenceRetired: undefined,
    });
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: REPO_ROOT,
      env,
      // Own process group → the teardown can signal the group, so no
      // descendant of a worker outlives this script. Teardown-only difference
      // from the production spawn (production shares the parent's group).
      detached: true,
    });
    observations.set(taskId, {
      index: -1,
      requestAt: clock.at,
      childSpawnedAt: performance.now(),
      firstLineAt: null,
      firstLineSource: null,
      finalTextFrameAt: null,
      pid: child.pid ?? null,
    });
    liveChildren.add(child);
    SPAWNED_CHILDREN.add(child);
    tapFirstLine(child, observations, taskId);
    return child;
  };
}

/** Spawn N workers, each with its own sandbox root under the case root. */
async function spawnWorkers(
  manager: SubAgentManager,
  caseRoot: string,
  workerCount: number,
  clock: RequestClock,
  observations: Map<string, ChildObservation>
): Promise<{ taskIds: string[]; batchRequestAt: number }> {
  const taskIds: string[] = [];
  let batchRequestAt = 0;
  for (let index = 0; index < workerCount; index++) {
    const childRoot = join(caseRoot, `child-${index}`);
    await mkdir(childRoot, { recursive: true });
    clock.at = performance.now();
    if (index === 0) batchRequestAt = clock.at;
    const { taskId } = manager.spawn({
      task: TASK,
      maxTurns: 3,
      timeoutMs: WORKER_TIMEOUT_MS,
      sandboxRoot: childRoot,
    });
    taskIds.push(taskId);
    const observation = observations.get(taskId);
    if (observation !== undefined) observation.index = index;
  }
  return { taskIds, batchRequestAt };
}

/** Terminal outcome of one worker (a waitFor rejection becomes a failed outcome). */
interface WorkerOutcome {
  readonly status: "ok" | "failed" | "unknown";
  readonly reason: string | null;
}

/** Wait for every worker's terminal envelope. */
async function awaitOutcomes(
  manager: SubAgentManager,
  taskIds: ReadonlyArray<string>
): Promise<WorkerOutcome[]> {
  return Promise.all(
    taskIds.map(async (taskId): Promise<WorkerOutcome> => {
      try {
        const envelope = await manager.waitFor(taskId, WAIT_FOR_TIMEOUT_MS);
        return { status: envelope.status, reason: envelope.reason ?? null };
      } catch (err) {
        return {
          status: "failed",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );
}

/** Per-child report for a worker whose observation never landed. */
function absentChildReport(position: number, outcome: WorkerOutcome): ChildReport {
  return {
    index: position,
    pid: null,
    envelopeAtMs: null,
    envelopeObserved: false,
    firstLineSource: null,
    finalTextFrameObserved: false,
    finalTextFrameMs: null,
    spawnRequestToChildMs: null,
    status: outcome.status,
    reason: outcome.reason,
  };
}

/** Per-child report for an observed worker. */
function buildChildReport(
  observation: ChildObservation,
  outcome: WorkerOutcome
): ChildReport {
  const envelopeAtMs =
    observation.firstLineAt === null
      ? null
      : round(observation.firstLineAt - observation.requestAt);
  const finalTextFrameMs =
    observation.finalTextFrameAt === null
      ? null
      : round(observation.finalTextFrameAt - observation.requestAt);
  return {
    index: observation.index,
    pid: observation.pid,
    envelopeAtMs,
    envelopeObserved: observation.firstLineAt !== null,
    firstLineSource: observation.firstLineSource,
    finalTextFrameObserved: observation.finalTextFrameAt !== null,
    finalTextFrameMs,
    spawnRequestToChildMs: round(observation.childSpawnedAt - observation.requestAt),
    status: outcome.status,
    reason: outcome.reason,
  };
}

/** Project the observations into per-child reports and the batch's earliest line. */
function buildChildReports(
  observations: Map<string, ChildObservation>,
  taskIds: ReadonlyArray<string>,
  outcomes: ReadonlyArray<WorkerOutcome>
): { children: ChildReport[]; earliestFirstLine: number | null } {
  const children: ChildReport[] = [];
  let earliestFirstLine: number | null = null;
  for (const [position, taskId] of taskIds.entries()) {
    const outcome = outcomes[position];
    const observation = observations.get(taskId);
    if (observation === undefined) {
      children.push(absentChildReport(position, outcome));
      continue;
    }
    children.push(buildChildReport(observation, outcome));
    const firstLineAt = observation.firstLineAt;
    if (firstLineAt === null) continue;
    if (earliestFirstLine === null) {
      earliestFirstLine = firstLineAt;
      continue;
    }
    if (firstLineAt < earliestFirstLine) earliestFirstLine = firstLineAt;
  }
  return { children, earliestFirstLine };
}

/** True while the child process is still running. */
function childAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * Signal the child's PROCESS GROUP (POSIX) — the child was spawned detached,
 * so it leads its own group and the group signal also reaches every
 * descendant it spawned. Falls back to the direct signal on platforms
 * without process groups (or when the group is already gone).
 */
function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      /* no such group (already gone) → fall through to the direct signal */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* ESRCH et al. — the child is already gone */
  }
}

/** Wait until every child exited, or the cap expires. */
function waitForExit(
  children: ReadonlySet<ChildProcess>,
  capMs: number
): Promise<void> {
  const pending = [...children].filter(childAlive);
  if (pending.length === 0) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const child of pending) child.off("exit", onExit);
      resolvePromise();
    };
    const onExit = (): void => {
      if (pending.every((child) => !childAlive(child))) finish();
    };
    // Not unref'd: the teardown must keep the event loop alive until the
    // grace period is over, otherwise the temp dirs would never be removed.
    const timer = setTimeout(finish, capMs);
    for (const child of pending) child.once("exit", onExit);
  });
}

/**
 * Live PIDs of a process group (Linux /proc scan). A process group outlives
 * its leader, so this is how a descendant of an already-exited worker is
 * found. Non-Linux → no answer (the group signal is POSIX-only anyway).
 */
async function liveGroupMembers(pgid: number): Promise<number[]> {
  if (process.platform === "win32") return [];
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  const members: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = await readFile(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue; // the process exited between the two reads
    }
    // "pid (comm) state ppid pgrp session ..." — comm may contain spaces and
    // parentheses, so parse after the LAST ')': state, ppid, pgrp, ...
    const close = stat.lastIndexOf(")");
    if (close === -1) continue;
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    if (Number(fields[2]) === pgid) members.push(Number(entry));
  }
  return members;
}

/** SIGTERM every live leader, then SIGKILL the survivors. */
async function escalateSignals(
  children: ReadonlySet<ChildProcess>
): Promise<void> {
  for (const child of children) {
    if (childAlive(child)) signalChild(child, "SIGTERM");
  }
  await waitForExit(children, TEARDOWN_GRACE_MS);
  for (const child of children) {
    if (childAlive(child)) signalChild(child, "SIGKILL");
  }
  await waitForExit(children, TEARDOWN_KILL_WAIT_MS);
}

/**
 * Kill whatever is left of a worker's process group. A group outlives its
 * leader, so a worker that exited may still have descendants in its group.
 */
async function killLeftoverGroupMembers(
  children: ReadonlySet<ChildProcess>
): Promise<void> {
  for (const child of children) {
    const pid = child.pid;
    if (pid === undefined) continue;
    if ((await liveGroupMembers(pid)).length === 0) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* the group is already gone */
    }
    await waitForExit(children, TEARDOWN_KILL_WAIT_MS);
  }
}

/** Count the live process-group members of every recorded child. */
async function countGroupMembers(
  children: ReadonlySet<ChildProcess>
): Promise<number> {
  let total = 0;
  for (const child of children) {
    const pid = child.pid;
    if (pid === undefined) continue;
    total += (await liveGroupMembers(pid)).length;
  }
  return total;
}

/**
 * Teardown: SIGTERM → grace → SIGKILL, over the process GROUP, so no
 * descendant of a worker survives this script. Returns what was still alive
 * afterwards (the evidence that the teardown was complete).
 */
async function teardownChildren(
  children: ReadonlySet<ChildProcess>
): Promise<TeardownReport> {
  await escalateSignals(children);
  await killLeftoverGroupMembers(children);
  return {
    children: children.size,
    leadersAlive: [...children].filter(childAlive).length,
    groupMembersAlive: await countGroupMembers(children),
  };
}

/** Spawn one case: N workers in parallel, each with its own sandbox root. */
async function runCase(workerCount: number): Promise<CaseResult> {
  const caseRoot = await mkdtemp(join(tmpdir(), "iknow-subagent-perf-"));
  const traceDir = await mkdtemp(join(tmpdir(), "iknow-subagent-perf-trace-"));
  TEMP_DIRS.add(caseRoot);
  TEMP_DIRS.add(traceDir);
  const observations = new Map<string, ChildObservation>();
  const liveChildren = new Set<ChildProcess>();
  const clock: RequestClock = { at: 0 };
  const manager = createSubAgentManager({
    spawn: createProductionSpawn(traceDir, observations, clock, liveChildren),
    sandboxRoot: caseRoot,
    taskTimeoutMs: WORKER_TIMEOUT_MS,
  });
  let measured: Omit<CaseResult, "teardown"> | undefined;
  let teardown: TeardownReport = {
    children: 0,
    leadersAlive: 0,
    groupMembersAlive: 0,
  };
  try {
    const { taskIds, batchRequestAt } = await spawnWorkers(
      manager,
      caseRoot,
      workerCount,
      clock,
      observations
    );
    const outcomes = await awaitOutcomes(manager, taskIds);
    const { children, earliestFirstLine } = buildChildReports(
      observations,
      taskIds,
      outcomes
    );
    const firstSource =
      children.find((child) => child.envelopeObserved)?.firstLineSource ?? null;
    measured = {
      case: `n${workerCount}`,
      workerCount,
      measures: MEASURES,
      envelopeAtMs:
        earliestFirstLine === null ? null : round(earliestFirstLine - batchRequestAt),
      envelopeObserved: earliestFirstLine !== null,
      firstLineSource: firstSource,
      children,
    };
  } finally {
    await manager.shutdown();
    // The teardown report is the evidence that no worker survived this case.
    teardown = await teardownChildren(liveChildren);
    for (const child of liveChildren) SPAWNED_CHILDREN.delete(child);
    await rm(caseRoot, { recursive: true, force: true });
    await rm(traceDir, { recursive: true, force: true });
    TEMP_DIRS.delete(caseRoot);
    TEMP_DIRS.delete(traceDir);
  }
  if (measured === undefined) {
    throw new Error(`case n${workerCount} produced no measurement`);
  }
  return { ...measured, teardown };
}

/**
 * Measure the git-capture cost directly: provider creation → the capture
 * settled, against the repository cwd (the same cwd the worker's snapshot is
 * captured against, so the measurement is the real one and not a degraded
 * no-snapshot path).
 *
 * A failed capture (the capture rejects — an unexpected failure, not a
 * degradation) is recorded as "no snapshot observed"; it never crashes the
 * measurement tool.
 */
async function measureGitCapture(): Promise<GitCaptureReport> {
  const startedAt = performance.now();
  const provider = createGitSnapshotProvider({ cwd: REPO_ROOT });
  let snapshotObserved = false;
  try {
    const snapshot = await provider();
    snapshotObserved = snapshot !== undefined;
  } catch {
    // EXIT: an unexpected capture failure is not a measurement error — the
    // capture cost is still reported, with no snapshot observed.
    snapshotObserved = false;
  }
  return {
    gitCaptureMs: round(performance.now() - startedAt),
    snapshotObserved,
  };
}

async function main(): Promise<void> {
  // The git-capture measurement runs BEFORE the provider-key check, so the
  // number is reproducible even without a live model key.
  const gitCapture = await measureGitCapture();
  console.log(
    JSON.stringify({
      type: "subagent-spawn-perf-git-capture",
      measures: GIT_CAPTURE_MEASURES,
      gitCaptureMs: gitCapture.gitCaptureMs,
      snapshotObserved: gitCapture.snapshotObserved,
    })
  );

  // Not-run convention (real-llm/real-llm-env.ts): no live provider → Not run, never a false pass.
  const env = loadRealLlmEnv(REPO_ROOT);
  if (env === undefined) {
    console.log(
      JSON.stringify({
        type: "subagent-spawn-perf",
        status: "not-run",
        measures: MEASURES,
        reason: "no live LLM provider configured",
      })
    );
    console.error(
      "[subagent-spawn-perf] not run: no live LLM provider configured (settings.llm provider key env unset)."
    );
    return;
  }

  const results: CaseResult[] = [];
  for (const workerCount of WORKER_COUNTS) {
    const result = await runCase(workerCount);
    results.push(result);
    console.log(
      JSON.stringify({
        type: "subagent-spawn-perf",
        case: result.case,
        workerCount: result.workerCount,
        measures: result.measures,
        envelopeAtMs: result.envelopeAtMs,
        envelopeObserved: result.envelopeObserved,
        firstLineSource: result.firstLineSource,
        children: result.children,
        teardown: result.teardown,
      })
    );
  }

  console.log(
    JSON.stringify({
      type: "subagent-spawn-perf-summary",
      measures: MEASURES,
      gitCaptureMs: gitCapture.gitCaptureMs,
      snapshotObserved: gitCapture.snapshotObserved,
      cases: results.map((result) => ({
        case: result.case,
        workerCount: result.workerCount,
        envelopeAtMs: result.envelopeAtMs,
        envelopeObserved: result.envelopeObserved,
      })),
      note: "measurement only — no threshold, no pass/fail gate",
    })
  );
}

/**
 * Process-exit safety net: a detached child outlives its parent, so every
 * group this script created is SIGKILLed on the way out (the normal path
 * already tore them down — this only covers a crash between spawn and
 * teardown). The temp dirs go with it: an interrupted run must not leave a
 * sandbox root or a trace dir behind. `rmSync` because the exit handler may
 * only do synchronous work.
 */
process.on("exit", () => {
  for (const child of SPAWNED_CHILDREN) {
    if (!childAlive(child)) continue;
    const pid = child.pid;
    if (pid === undefined) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  for (const dir of TEMP_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS will keep it; nothing else can be done from an exit handler */
    }
  }
});

process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

main().catch((err: unknown) => {
  console.error(
    `[subagent-spawn-perf] crashed: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
});
