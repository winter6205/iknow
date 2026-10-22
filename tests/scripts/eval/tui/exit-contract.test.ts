/**
 * The CLI exit contract (#1221).
 *
 * WHY a CHILD PROCESS and not `runTuiCalibration` in-process: the defect is an
 * event-loop DRAIN. In-process, Vitest itself holds the loop open, so the drain
 * is structurally masked and a test would pass against the broken code. The
 * only faithful observation is the child's real exit status and the real
 * artifacts on its disk — the same treatment
 * `tests/scripts/eval/terminal-bench-2.1/cli.test.ts` gives the other CLI.
 *
 * The contract: exit 0 REQUIRES a persisted, unconditional `usable` verdict.
 * Every bounded failure must keep an UNUSABLE report on disk, exit non-zero,
 * and leave no process behind. Before the fix, a child that exited during
 * readiness made the driver drain on an UNREF'd timer: the process ended with
 * Node's DEFAULT status 0, printed nothing and wrote no `check-report.json`.
 *
 * No model, no credentials: the child is a fresh `python3` that prints a marker
 * and exits, so it can never dispatch a real model.
 */
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CheckReport } from "../../../../scripts/eval/tui/check-report.ts";
import { parseProtocol } from "../../../../scripts/eval/tui/protocol.ts";
import { verdictExitCode } from "../../../../scripts/eval/tui/run.ts";
import { validProtocol } from "./fixture.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLI_PATH = fileURLToPath(
  new URL("../../../../scripts/eval/tui/run.ts", import.meta.url)
);

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface ChildRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
}

/** Drive the real CLI in a child process; the exit status is DATA, not a check. */
function spawnCli(protocolPath: string, timeoutMs: number): ChildRun {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI_PATH, "--protocol", protocolPath],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: timeoutMs }
  );
  return {
    code: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    elapsedMs: Date.now() - started,
  };
}

interface DrainHarness {
  readonly root: string;
  readonly protocolPath: string;
  readonly artifactsDir: string;
  readonly runDir: string;
  readonly verdictPath: string;
}

/**
 * A fresh protocol whose child prints a marker and exits after `childExitSec`,
 * against a readiness echo timeout much longer than that.
 *
 * The child closing mid-probe is the drain trigger: the relay's handles go away
 * while the driver is parked on an unref'd echo wait, and nothing else is ref'd
 * to keep the loop alive.
 */
function makeDrainHarness(
  label: string,
  childExitSec: number,
  over: Record<string, unknown> = {}
): DrainHarness {
  const root = mkdtempSync(join(tmpdir(), "iknow-1221-exit-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const cwd = join(root, "workspace");
  const artifactsDir = join(root, "artifacts");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const protocolPath = join(root, "protocol.json");
  const doc = validProtocol({
    label,
    dataDir,
    cwd,
    artifactsDir,
    conversationId: `conv-${label}`,
    child: {
      command: "python3",
      args: [
        "-c",
        `import time; print('DRAIN_CHILD_STARTED', flush=True); time.sleep(${childExitSec})`,
      ],
    },
    stimuli: [{ at: 0, tag: "S1", text: "NO MODEL CALL" }],
    readiness: {
      tokenPrefix: "IKNOW-1221-",
      probeTimeoutMs: 1000,
      echoTimeoutMs: 5000,
      attempts: 1,
    },
    delivery: {
      chunkBytes: 8,
      chunkDelayMs: 20,
      settleBeforeSubmit: true,
      settleWaitMs: 60000,
      acceptTimeoutMs: 30000,
      retryEnter: false,
    },
    stop: {
      minSettleMs: 100,
      horizonMs: 100,
      exitGraceMs: 500,
      innerWallMs: 3000,
    },
    outerWatchdogMs: 8000,
    rssIntervalMs: 100,
    snapshotIntervalMs: 100,
    ...over,
  });
  writeFileSync(protocolPath, JSON.stringify(doc, null, 2), "utf8");
  return {
    root,
    protocolPath,
    artifactsDir,
    runDir: join(artifactsDir, label),
    verdictPath: join(artifactsDir, label, "check-report.json"),
  };
}

describe("run.ts CLI — a child that exits during readiness", () => {
  it("exits NON-ZERO and keeps an UNUSABLE verdict on disk", () => {
    const h = makeDrainHarness("drain-mid-readiness", 1.5);
    const run = spawnCli(h.protocolPath, 60_000);

    assert.notEqual(
      run.code,
      0,
      `a child that dies mid-readiness must never be exit 0; code=${String(run.code)} stderr=${run.stderr} stdout=${run.stdout}`
    );
    assert.ok(
      existsSync(h.verdictPath),
      `an unusable verdict must be RETAINED on disk; nothing was written under ${h.runDir}`
    );
    const verdict = JSON.parse(readFileSync(h.verdictPath, "utf8")) as {
      report: CheckReport;
      stray_processes: readonly number[];
    };
    assert.equal(
      verdict.report.usable,
      false,
      `the retained verdict must be unusable; got: ${JSON.stringify(verdict.report)}`
    );
    assert.equal(verdict.report.verdict, "unusable");
    assert.ok(
      verdict.report.blockedBy.length > 0,
      "an unusable verdict must name what blocked it"
    );
    assert.ok(
      run.stdout.trim().startsWith("{"),
      `the report must still be printed; got: ${run.stdout.slice(0, 300)}`
    );
    assert.deepEqual(
      verdict.stray_processes,
      [],
      `a bounded failure must still reap the child and relay it started; verdict: ${JSON.stringify(verdict)}`
    );
  }, 60_000);

  it("exits NON-ZERO with a retained unusable verdict when the child dies DURING delivery, not just during readiness", () => {
    // WHY a longer child life: the readiness-drain cases above kill the child
    // while the probe is still waiting. This case lets readiness COMPLETE
    // (echo timeout 1000ms < child lifetime 3000ms, one attempt) so the run
    // reaches the measured sequence, and only then does the surface die: the
    // stimulus at 0ms is typed into a dead terminal and can never persist an
    // acceptance. The contract must hold on this path too — no verdict loss,
    // no default-zero exit, no stray.
    const h = makeDrainHarness("drain-mid-delivery", 3, {
      readiness: {
        tokenPrefix: "IKNOW-1221-",
        probeTimeoutMs: 1000,
        echoTimeoutMs: 1000,
        attempts: 1,
      },
      delivery: {
        chunkBytes: 8,
        chunkDelayMs: 20,
        settleBeforeSubmit: true,
        settleWaitMs: 5000,
        acceptTimeoutMs: 30000,
        retryEnter: false,
      },
      stop: {
        minSettleMs: 100,
        horizonMs: 100,
        exitGraceMs: 500,
        innerWallMs: 8000,
      },
      outerWatchdogMs: 20000,
    });
    const run = spawnCli(h.protocolPath, 60_000);

    // A number, not just non-zero: a spawnSync timeout kill surfaces as
    // `code: null`, which would let a hung (timer-leaking) CLI pass a bare
    // notEqual. The bounded-termination claim rests on the process actually
    // exiting with a status inside the timeout.
    assert.equal(
      typeof run.code,
      "number",
      `the CLI must exit on its own within the timeout, not be killed by it; code=${String(run.code)} elapsed=${run.elapsedMs}ms stderr=${run.stderr}`
    );
    assert.notEqual(
      run.code,
      0,
      `a surface that dies mid-delivery must never be exit 0; code=${String(run.code)} stderr=${run.stderr} stdout=${run.stdout}`
    );
    assert.ok(
      run.elapsedMs < 60_000,
      `the run must terminate well inside its timeout; elapsed=${run.elapsedMs}ms`
    );
    assert.ok(
      existsSync(h.verdictPath),
      `the verdict must be RETAINED on disk even though the phase that lost the child was delivery, not readiness; nothing was written under ${h.runDir}`
    );
    const verdict = JSON.parse(readFileSync(h.verdictPath, "utf8")) as {
      report: CheckReport;
      stray_processes: readonly number[];
    };
    assert.equal(
      verdict.report.usable,
      false,
      `the retained verdict must be unusable; got: ${JSON.stringify(verdict.report)}`
    );
    assert.equal(verdict.report.verdict, "unusable");
    assert.ok(
      verdict.report.blockedBy.length > 0,
      `an unusable verdict must name what blocked it; got: ${JSON.stringify(verdict.report.blockedBy)}`
    );
    assert.ok(
      verdict.report.blockedBy.includes("acceptance.all_required"),
      `the stimulus was typed into a dead surface, so no acceptance could persist; blockedBy: ${JSON.stringify(verdict.report.blockedBy)}`
    );
    assert.deepEqual(
      verdict.stray_processes,
      [],
      `a bounded failure must leave no process behind; verdict: ${JSON.stringify(verdict)}`
    );
    assert.ok(
      run.stdout.trim().startsWith("{"),
      `the report must still be printed on this path too; got: ${run.stdout.slice(0, 300)}`
    );
  }, 60_000);

  it("keeps the process alive long enough to reach a verdict instead of draining early", () => {
    const h = makeDrainHarness("drain-lifetime", 1.5);
    const run = spawnCli(h.protocolPath, 60_000);

    // The child dies at ~1.5s. The readiness echo wait alone is 5s, so a run
    // that drained early cannot have reached a verdict. Before the fix this
    // exited 0 in ~2.9s with no artifacts at all.
    assert.ok(
      existsSync(h.verdictPath),
      "the run must reach a verdict rather than drain out of the echo wait"
    );
    assert.notEqual(
      run.code,
      0,
      `expected a non-zero exit; got ${String(run.code)}`
    );
  }, 60_000);
});

/**
 * A teardown that cannot be PROVEN (#1224 requirement 6).
 *
 * WHY a child process: the contract under test spans the whole CLI — an
 * unproven teardown must be FOLDED INTO the retained verdict (`cleanup_error`
 * non-null, `teardown.no_stray_process` failed, verdict unusable), never thrown
 * out of the `finally` (which would skip the verdict entirely) and never
 * allowed to default the exit to 0. Only the child's real artifacts prove that.
 *
 * Mechanism: SIGSTOP the relay just before `/quit` is typed. The relay stays
 * ALIVE (signals accepted, liveness probes fooled) but can never process stdin
 * EOF, never kill the child group, and never write `EXIT`. The teardown ladder
 * exhausts its graces, SIGKILLs the child group, then SIGKILLs the relay — so
 * every process IS reaped, but the child's exit was never REPORTED through the
 * control channel, which is exactly what `PtyCleanupError` records and what the
 * verdict must retain. (Same fixture the session-level case in
 * pty-shutdown.test.ts uses; here the run-level folding is the subject.)
 */
describe("run.ts CLI — a teardown that cannot be proven", () => {
  it("folds the unproven teardown into a retained unusable verdict with cleanup_error and exits NON-ZERO", async () => {
    const h = makeDrainHarness("teardown-unproven", 120, {
      // Readiness must complete (echo timeout < child lifetime) so the run
      // reaches the quit path; the stimulus acceptance can never persist (no
      // one reads the composer's output), which independently blocks the
      // verdict — the teardown fault must ALSO be visible beside it.
      readiness: {
        tokenPrefix: "IKNOW-1221-",
        probeTimeoutMs: 1000,
        echoTimeoutMs: 1000,
        attempts: 1,
      },
      delivery: {
        chunkBytes: 8,
        chunkDelayMs: 20,
        settleBeforeSubmit: true,
        settleWaitMs: 5000,
        acceptTimeoutMs: 8000,
        retryEnter: false,
      },
      stop: {
        minSettleMs: 100,
        horizonMs: 100,
        exitGraceMs: 500,
        innerWallMs: 20_000,
      },
      outerWatchdogMs: 45_000,
    });

    // Stop the relay while the measured sequence runs — before the quit write,
    // so the relay cannot process the EOF that would have produced a clean
    // EXIT, and cannot itself quit-and-reap (the python3 child sleeps 120s).
    const run = await spawnCliWithStoppedRelay(
      h.protocolPath,
      h.artifactsDir,
      90_000
    );

    assert.equal(
      typeof run.code,
      "number",
      `the CLI must exit on its own within the timeout; code=${String(run.code)} elapsed=${run.elapsedMs}ms stderr=${run.stderr}`
    );
    assert.notEqual(run.code, 0, "an unproven teardown is never exit 0");
    assert.ok(
      existsSync(h.verdictPath),
      `the verdict must be RETAINED even though teardown could not be proven; nothing under ${h.runDir}`
    );
    const verdict = JSON.parse(readFileSync(h.verdictPath, "utf8")) as {
      report: CheckReport;
      stray_processes: readonly number[];
      cleanup_error: string | null;
    };
    assert.ok(
      verdict.cleanup_error !== null,
      `the unproven teardown must be folded into the verdict as cleanup_error; verdict: ${JSON.stringify(verdict)}`
    );
    assert.match(
      verdict.cleanup_error,
      /PTY cleanup incomplete/,
      `the folded fault must be the typed teardown failure, not a generic string; got: ${verdict.cleanup_error}`
    );
    const teardownGate = verdict.report.checks.find(
      (c) => c.id === "teardown.no_stray_process"
    );
    assert.equal(
      teardownGate?.ok,
      false,
      `an unproven teardown is not a clean one and must fail the gate; got: ${JSON.stringify(teardownGate)}`
    );
    assert.ok(
      verdict.report.blockedBy.includes("teardown.no_stray_process"),
      `the teardown gate must block the verdict; got: ${JSON.stringify(verdict.report.blockedBy)}`
    );
    assert.equal(verdict.report.usable, false);
    // Nothing actually SURVIVED (the ladder SIGKILLs everyone); the verdict
    // must say the leak was not real while still reporting the unproven claim.
    assert.deepEqual(
      verdict.stray_processes,
      [],
      `the ladder still reaps everything, so the stray list stays empty beside the cleanup_error; verdict: ${JSON.stringify(verdict)}`
    );
  }, 90_000);
});

/**
 * Spawn the CLI and SIGSTOP its relay the moment the child pid is knowable.
 *
 * The CLI writes the CHILD's pid into `rss.csv` on the first measured tick, one
 * run under the artifacts directory given in `artifactsDir`. The relay is that
 * child's parent (pty.fork), so the child pid pins the relay: the relay's own
 * stderr control channel never reaches the CLI, but `/proc/<child>/status`
 * always names `PPid`. Stopping the relay at that moment parks it ALIVE but
 * deaf — it can never process stdin EOF and never writes `EXIT` — without ever
 * racing the quit write (the run cannot reach the quit path this early).
 */
async function spawnCliWithStoppedRelay(
  protocolPath: string,
  artifactsDir: string,
  timeoutMs: number
): Promise<ChildRun> {
  const run = await spawnCliAsync(protocolPath, timeoutMs, () =>
    stopRelayOnceChildIsKnown(artifactsDir)
  );
  return run;
}

/**
 * SIGSTOP the relay once the child pid is knowable from the run's rss.csv.
 *
 * Polls, because the CLI itself prints nothing until it exits. Idempotent once
 * it has stopped a relay: the pid files keep existing but SIGSTOP on an
 * already-stopped process is a no-op.
 */
function stopRelayOnceChildIsKnown(artifactsDir: string): void {
  // The child's pid lands in rss.csv on the first measured tick, well before
  // the quit path. `/proc/<child>/status` names the relay as PPid (pty.fork).
  // The CLI creates artifactsDir on init — an early tick legitimately finds
  // nothing there yet.
  let runDirs: Dirent[];
  try {
    runDirs = readdirSync(artifactsDir, { withFileTypes: true });
  } catch {
    return; // EXIT: artifactsDir not created yet — poll again.
  }
  for (const entry of runDirs) {
    if (!entry.isDirectory()) continue;
    const csv = join(artifactsDir, entry.name, "rss.csv");
    if (!existsSync(csv)) continue;
    const row = readFileSync(csv, "utf8").split("\n")[1];
    if (row === undefined) continue;
    const pid = Number(row.split(",")[2]);
    if (!(pid > 0)) continue;
    const status = `/proc/${pid}/status`;
    if (!existsSync(status)) continue;
    const ppidMatch = /^PPid:\s+(\d+)/m.exec(readFileSync(status, "utf8"));
    if (ppidMatch === null) continue;
    const relayPid = Number(ppidMatch[1]);
    try {
      process.kill(relayPid, "SIGSTOP");
    } catch {
      // EXIT: the relay died between the probe and the signal — the case then
      // degrades to a dead-relay run, whose verdict still records a fault.
    }
    return;
  }
}

/**
 * Run the CLI async with a 100ms poll; `onTick` fires on every tick (it may
 * stop external processes the CLI revealed on disk).
 */
async function spawnCliAsync(
  protocolPath: string,
  timeoutMs: number,
  onTick: () => void
): Promise<ChildRun> {
  const started = Date.now();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", CLI_PATH, "--protocol", protocolPath],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c: Buffer) => {
    stdout += c.toString("utf8");
  });
  child.stderr?.on("data", (c: Buffer) => {
    stderr += c.toString("utf8");
  });
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    const poll = setInterval(onTick, 100);
    child.on("close", (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

/**
 * Initialization failures (#1224 requirement 5).
 *
 * `initSession` holds a REF'D keep-alive guard from before any resource is
 * created; every failure between that point and a usable state must release it
 * again. Before the repair, `artifactsFor` sat OUTSIDE the guard-protected try,
 * so an unwritable artifacts directory threw with the guard still held: the CLI
 * printed the error and then HUNG forever (observed: `timeout` killed it, code
 * 124). The only faithful observation is again the child's real exit status —
 * a hung process surfaces as `code: null`, which a bare notEqual would accept.
 *
 * No model, no credentials: both children are plain `python3` that can never
 * dispatch a model — and in the first case nothing is spawned at all, because
 * the failure precedes `openPty`.
 */
describe("run.ts CLI — an initialization failure", () => {
  it("exits bounded NON-ZERO with the diagnostic on stderr when the artifacts directory cannot be created", () => {
    const root = mkdtempSync(join(tmpdir(), "iknow-1221-init-"));
    roots.push(root);
    // `artifactsFor` mkdirs under artifactsDir; a FILE at that path makes every
    // mkdir throw ENOTDIR — the deterministic stand-in for an unwritable path.
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    const dataDir = join(root, "data");
    const cwd = join(root, "workspace");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const protocolPath = join(root, "protocol.json");
    writeFileSync(
      protocolPath,
      JSON.stringify(
        validProtocol({
          label: "init-fail-artifacts",
          dataDir,
          cwd,
          artifactsDir: join(blocker, "artifacts"),
          conversationId: "conv-init-fail",
          child: {
            command: "python3",
            args: ["-c", "import time; time.sleep(300)"],
          },
        }),
        null,
        2
      ),
      "utf8"
    );

    const run = spawnCli(protocolPath, 60_000);

    assert.equal(
      typeof run.code,
      "number",
      `the CLI must exit on its own, not be killed by the timeout — with the guard leaked it hung until the timeout killed it; code=${String(run.code)} elapsed=${run.elapsedMs}ms stderr=${run.stderr}`
    );
    assert.notEqual(run.code, 0, "a failed initialization is never exit 0");
    assert.ok(
      run.elapsedMs < 60_000,
      `the run must terminate well inside its timeout; elapsed=${run.elapsedMs}ms`
    );
    assert.match(
      run.stderr,
      /ENOTDIR/,
      `the initialization error must be retained on stderr, not swallowed; got: ${run.stderr}`
    );
    // No verdict could be written for a run that never started — and none may
    // be fabricated either.
    assert.ok(
      !existsSync(join(blocker, "artifacts", "init-fail-artifacts")),
      "a run that failed initialization must leave no artifact directory behind"
    );
    // Structurally no child/relay can survive here: the failure precedes
    // `openPty`, so nothing was ever spawned. The post-spawn release path is
    // the next case and the session-level contracts in pty-shutdown.test.ts.
  }, 60_000);

  it("exits bounded NON-ZERO when the PTY relay cannot start, releasing the session it failed to initialize", () => {
    // A cwd that does not exist fails the relay spawn itself. Here a process
    // WAS in the middle of being started, so `initSession` must run its
    // release path (dispose the half-open session, release the guard) before
    // propagating — a leaked guard hung the process even though the error was
    // already on stderr.
    const root = mkdtempSync(join(tmpdir(), "iknow-1221-init-"));
    roots.push(root);
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const protocolPath = join(root, "protocol.json");
    writeFileSync(
      protocolPath,
      JSON.stringify(
        validProtocol({
          label: "init-fail-relay",
          dataDir,
          cwd: join(root, "workspace", "missing"),
          artifactsDir: join(root, "artifacts"),
          conversationId: "conv-init-fail-relay",
          child: {
            command: "python3",
            args: ["-c", "import time; time.sleep(300)"],
          },
        }),
        null,
        2
      ),
      "utf8"
    );

    const run = spawnCli(protocolPath, 60_000);

    assert.equal(
      typeof run.code,
      "number",
      `the CLI must exit on its own, not be killed by the timeout; code=${String(run.code)} elapsed=${run.elapsedMs}ms stderr=${run.stderr}`
    );
    assert.notEqual(run.code, 0, "a failed initialization is never exit 0");
    assert.ok(
      run.elapsedMs < 60_000,
      `the run must terminate well inside its timeout; elapsed=${run.elapsedMs}ms`
    );
    assert.match(
      run.stderr,
      /pty relay could not start/,
      `the relay-start diagnostic must reach stderr; got: ${run.stderr}`
    );
  }, 60_000);
});

describe("verdictExitCode — exit 0 requires a PERSISTED verdict", () => {
  const usableReport = {
    label: "unit",
    runKind: "measured",
    checks: [],
    blockedBy: [],
    verdict: "usable",
    usable: true,
  } as unknown as CheckReport;
  const unusableReport = {
    ...usableReport,
    verdict: "unusable",
    usable: false,
  } as unknown as CheckReport;

  function protocolIn(root: string, body: string | null) {
    const protocol = parseProtocol(validProtocol({ artifactsDir: root }));
    mkdirSync(join(root, protocol.label), { recursive: true });
    if (body !== null)
      writeFileSync(
        join(root, protocol.label, "check-report.json"),
        body,
        "utf8"
      );
    return protocol;
  }

  function tempRoot(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `iknow-1221-${name}-`));
    roots.push(root);
    return root;
  }

  it("returns 0 only when the verdict file is on disk AND usable", () => {
    const root = tempRoot("v-good");
    const protocol = protocolIn(
      root,
      JSON.stringify({ report: usableReport }, null, 2)
    );

    assert.equal(verdictExitCode(protocol, usableReport), 0);
  });

  it("returns 1 when the verdict file is missing, unusable or corrupt", () => {
    const missing = protocolIn(tempRoot("v-missing"), null);
    assert.equal(
      verdictExitCode(missing, usableReport),
      1,
      "a usable report whose verdict was never persisted must not exit 0"
    );

    const root = tempRoot("v-unusable");
    const written = protocolIn(
      root,
      JSON.stringify({ report: usableReport }, null, 2)
    );
    assert.equal(
      verdictExitCode(written, unusableReport),
      1,
      "an unusable verdict is never exit 0"
    );

    const corrupt = protocolIn(tempRoot("v-corrupt"), '{"repo');
    assert.equal(
      verdictExitCode(corrupt, usableReport),
      1,
      "a truncated verdict file is not a verdict"
    );
  });
});
