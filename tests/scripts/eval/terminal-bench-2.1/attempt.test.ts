/**
 * Attempt lifecycle durability: fsynced `started` records, exclusive reservation, recovery.
 *
 * Why this matters (issue 1219 requirement 2, required regressions 1 and 5):
 *  - #1212 appended its ledger row only after the runner returned and after tallying, so a
 *    driver killed mid-attempt left real spend and NO row. These tests spawn a REAL child
 *    process, SIGKILL it after its `started` record is fsynced, and assert the attempt is
 *    discoverable and classifiable as `interrupted` — not `missing`.
 *  - Output directories and manifest slots must be reserved EXCLUSIVELY, so an accidental
 *    re-run cannot overwrite prior evidence and two concurrent drivers cannot both claim
 *    the same slot. Both cases run as REAL concurrent subprocesses.
 *  - The OTHER half of requirement 2 is the catchable signal: a graceful SIGTERM/SIGINT
 *    cannot wait for reconciliation, so `runAttempt` must finalize the attempt inline at
 *    signal time with its known status and observed usage, keep the partial artifacts, and
 *    reap what the attempt owns — while still letting the driver die by that signal rather
 *    than reporting a success. These cases send a REAL signal to a REAL child; the
 *    signal's exit semantics and the process-level listener hygiene are both asserted.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, it } from "vitest";

import {
  allocateAttemptId,
  AttemptDirReservedError,
  beginAttempt,
  claimSlot,
  classifyRetained,
  finalizeAttempt,
  hasStartedRecord,
  readAttemptRecords,
  reconcileInterrupted,
  releaseSlot,
  reserveAttemptDir,
  runAttempt,
  SlotClaimError,
  type AttemptRecord,
  type FinalRecord,
  type StartedRecord,
} from "../../../../scripts/eval/terminal-bench-2.1/attempt.ts";
import type { RunIdentity } from "../../../../scripts/eval/terminal-bench-2.1/identities.ts";
import {
  finalizationOf,
  readLedger,
  unfinishedAttempts,
  type LedgerRow,
  type UsageRecord,
} from "../../../../scripts/eval/terminal-bench-2.1/ledger.ts";
import type {
  ProvisionSpec,
  RunnerPort,
} from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";
import { cleanupTempRoots, identityFor, tempRoot } from "./fixtures.ts";

afterAll(cleanupTempRoots);
afterEach(() => {
  // A killed child can leave a claim file behind; clean the shared /tmp staging root.
  for (const dir of stagingDirs.splice(0, stagingDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const stagingDirs: string[] = [];
/**
 * Repo root derived from this file's own location.
 *
 * Why not a literal: a hardcoded checkout path makes these child-process cases depend on one
 * operator's machine. Off that machine `spawn` fails ENOENT and the case reports a false
 * failure; on it, the child validates whatever happens to be checked out THERE rather than the
 * tree under review. Deriving from `import.meta.url` keeps the child pointed at this checkout.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCRIPT_DIR = join(REPO_ROOT, "scripts/eval/terminal-bench-2.1");

/** Wait for a condition the child satisfies, so the test does not race the fsync. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the child to reach its marker");
}

interface Fixture {
  readonly runRoot: string;
  readonly slotsDir: string;
  readonly ledgerPath: string;
  readonly bundlePath: string;
  readonly settingsPath: string;
}

function fixture(): Fixture {
  const root = tempRoot("attempt-lifecycle");
  const runRoot = join(root, "runs");
  const slotsDir = join(root, "slots");
  mkdirSync(runRoot, { recursive: true });
  const bundlePath = join(root, "bundle.tgz");
  const settingsPath = join(root, "settings.json");
  writeFileSync(bundlePath, "fake bundle bytes");
  // A real settings file, but only its sha256 may ever enter a record.
  writeFileSync(
    settingsPath,
    JSON.stringify({ llm: { model: "secret-model" } })
  );
  return {
    runRoot,
    slotsDir,
    ledgerPath: join(root, "ledger.jsonl"),
    bundlePath,
    settingsPath,
  };
}

/** Write a child script that calls `beginAttempt` and then blocks so we can kill it. */
function writeChildScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-attempt-child-"));
  stagingDirs.push(dir);
  const script = join(dir, "child.ts");
  writeFileSync(
    script,
    `import { beginAttempt } from "${SCRIPT_DIR}/attempt.ts";\n${body}\n`
  );
  return script;
}

describe("attempt id allocation", () => {
  it("allocates a unique id per slot, start time and pid", () => {
    const first = allocateAttemptId("t:arm40:40", 1000, 42);
    const second = allocateAttemptId("t:arm40:40", 1001, 42);

    assert.notEqual(first, second, "two attempts must not share an id");
    assert.ok(
      first.startsWith("t:arm40:40@"),
      `id must retain the slot key; got: ${JSON.stringify(first)}`
    );
  });

  it("allocates different ids for the two arms of one task", () => {
    const arm40 = allocateAttemptId("t:arm40:40", 1000, 42);
    const arm80 = allocateAttemptId("t:arm80:80", 1000, 42);

    assert.notEqual(arm40, arm80, "each arm is a distinct attempt");
  });
});

describe("exclusive attempt-directory reservation (required test 5)", () => {
  it("reserves a fresh attempt directory", () => {
    const { runRoot } = fixture();

    const dir = reserveAttemptDir(runRoot, "db-wal-recovery:arm40:40");

    assert.ok(
      existsSync(dir),
      `expected the directory to exist; got: ${JSON.stringify(dir)}`
    );
  });

  it("refuses to reuse an existing attempt directory instead of overwriting it", () => {
    const { runRoot } = fixture();
    const dir = reserveAttemptDir(runRoot, "db-wal-recovery:arm40:40");
    const marker = join(dir, "grader.log");
    writeFileSync(marker, "prior evidence");

    assert.throws(
      () => reserveAttemptDir(runRoot, "db-wal-recovery:arm40:40"),
      (error: unknown) => error instanceof AttemptDirReservedError,
      "a second reservation of the same slot must be refused"
    );
    assert.equal(
      readFileSync(marker, "utf8"),
      "prior evidence",
      "the refusal must leave the prior attempt's evidence untouched"
    );
  });

  it("reports which directory it refused", () => {
    const { runRoot } = fixture();
    const dir = reserveAttemptDir(runRoot, "db-wal-recovery:arm40:40");

    assert.throws(
      () => reserveAttemptDir(runRoot, "db-wal-recovery:arm40:40"),
      (error: unknown) =>
        error instanceof AttemptDirReservedError && error.dir === dir,
      "the error must name the reserved directory"
    );
  });
});

describe("exclusive manifest slot claim (required test 5)", () => {
  it("grants a slot to the first claimer", () => {
    const { slotsDir } = fixture();

    const claimPath = claimSlot(
      slotsDir,
      "db-wal-recovery:arm40:40",
      "attempt-a"
    );

    assert.ok(
      existsSync(claimPath),
      `expected a claim file; got: ${JSON.stringify(claimPath)}`
    );
  });

  it("refuses a second claim of the same slot and names the holder", () => {
    const { slotsDir } = fixture();
    claimSlot(slotsDir, "db-wal-recovery:arm40:40", "attempt-a");

    assert.throws(
      () => claimSlot(slotsDir, "db-wal-recovery:arm40:40", "attempt-b"),
      (error: unknown) => {
        assert.ok(
          error instanceof SlotClaimError,
          "a taken slot must raise SlotClaimError"
        );
        assert.equal(
          error.holder,
          "attempt-a",
          "the refusal must name the current holder"
        );
        return true;
      },
      "two drivers must not both hold the same manifest slot"
    );
  });

  it("grants the same slot again once the claim is released", () => {
    const { slotsDir } = fixture();
    const claimPath = claimSlot(
      slotsDir,
      "db-wal-recovery:arm40:40",
      "attempt-a"
    );

    releaseSlot(claimPath);

    assert.doesNotThrow(
      () => claimSlot(slotsDir, "db-wal-recovery:arm40:40", "attempt-b"),
      "a released slot must be claimable again"
    );
  });

  it("grants the two arms of one task independently", () => {
    const { slotsDir } = fixture();

    claimSlot(slotsDir, "db-wal-recovery:arm40:40", "attempt-a");
    assert.doesNotThrow(
      () => claimSlot(slotsDir, "db-wal-recovery:arm80:80", "attempt-b"),
      "the paired study must be able to run both arms"
    );
  });

  it("lets exactly one of two concurrent drivers claim a slot", async () => {
    const root = tempRoot("attempt-concurrent");
    const slotsDir = join(root, "slots");
    mkdirSync(root, { recursive: true });
    const script =
      writeChildScript(`import { claimSlot, SlotClaimError } from "${SCRIPT_DIR}/attempt.ts";
const slotsDir = process.argv[2];
const slot = process.argv[3];
try {
  claimSlot(slotsDir, slot, "pid-" + process.pid);
  console.log("CLAIMED");
} catch (error) {
  if (error instanceof SlotClaimError) { console.log("REFUSED"); } else { throw error; }
}`);

    const results = await Promise.all([
      runChild(script, [slotsDir, "db-wal-recovery:arm40:40"]),
      runChild(script, [slotsDir, "db-wal-recovery:arm40:40"]),
    ]);

    const claimed = results.filter((result) => result.trim() === "CLAIMED");
    assert.equal(
      claimed.length,
      1,
      `exactly one driver must win; got: ${JSON.stringify(results)}`
    );
    assert.equal(
      results.filter((result) => result.trim() === "REFUSED").length,
      1,
      `the loser must be refused, not crash; got: ${JSON.stringify(results)}`
    );
  }, 20_000);
});

function runChild(
  script: string,
  args: ReadonlyArray<string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", script, ...args],
      {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err))
    );
  });
}

describe("durable started record before dispatch (required test 1)", () => {
  it("fsyncs a started record and a ledger intent row before the runner is invoked", () => {
    const { runRoot, slotsDir, ledgerPath, bundlePath, settingsPath } =
      fixture();

    const handle = beginAttempt({
      runRoot,
      slotsDir,
      ledgerPath,
      bundlePath,
      settingsPath,
      slotKey: "db-wal-recovery:arm40:40",
      task: "db-wal-recovery",
      arm: "arm40",
      maxTurns: 40,
      identity: identityFor(),
    });

    assert.ok(
      hasStartedRecord(handle.dir),
      "the started record must exist before any dispatch"
    );
    const records = readAttemptRecords(handle.dir);
    const started = records[0];
    assert.equal(
      started?.recordType,
      "attempt-started",
      "the first record must be the started one"
    );
    assert.equal(
      started?.modelDispatched,
      false,
      "model dispatch must be a real boolean, not pending"
    );
    assert.equal(
      started?.attemptStarted,
      true,
      "attempt started must be a real boolean"
    );

    const ledger = readLedger(ledgerPath);
    assert.equal(
      ledger.rows.length,
      1,
      "the intent row must be written before dispatch"
    );
    assert.equal(
      ledger.rows[0]?.phase,
      "intent",
      "the pre-dispatch row must be an intent"
    );
  });

  it("records the settings identity as a hash, never as contents", () => {
    const { runRoot, slotsDir, ledgerPath, bundlePath, settingsPath } =
      fixture();

    const handle = beginAttempt({
      runRoot,
      slotsDir,
      ledgerPath,
      bundlePath,
      settingsPath,
      slotKey: "db-wal-recovery:arm40:40",
      task: "db-wal-recovery",
      arm: "arm40",
      maxTurns: 40,
      identity: identityFor(),
    });

    const body = JSON.stringify(readAttemptRecords(handle.dir));
    assert.equal(
      body.includes("secret-model"),
      false,
      "settings contents must never enter a record or a fixture"
    );
    assert.match(
      handle.started.settingsSha256,
      /^[0-9a-f]{64}$/,
      "the settings hash must be a sha256"
    );
  });

  it("recomputes the bundle sha256 from the bundle file rather than writing a constant", () => {
    const first = fixture();
    const second = fixture();
    writeFileSync(second.bundlePath, "different bundle bytes");
    const identity = identityFor({
      bundleSha256: "ignored-for-this-assertion",
    });

    const hashFor = (fx: Fixture): string =>
      beginAttempt({
        runRoot: fx.runRoot,
        slotsDir: fx.slotsDir,
        ledgerPath: fx.ledgerPath,
        bundlePath: fx.bundlePath,
        settingsPath: fx.settingsPath,
        slotKey: "db-wal-recovery:arm40:40",
        task: "db-wal-recovery",
        arm: "arm40",
        maxTurns: 40,
        identity,
      }).started.bundleSha256;

    assert.notEqual(
      hashFor(first),
      hashFor(second),
      "the bundle sha must come from the file's bytes"
    );
  });

  it("classifies an attempt killed by SIGKILL after its started record as interrupted (required test 1)", async () => {
    const fx = fixture();
    const script = writeChildScript(`const handle = beginAttempt({
  runRoot: process.argv[2],
  slotsDir: process.argv[3],
  ledgerPath: process.argv[4],
  bundlePath: process.argv[5],
  settingsPath: null,
  slotKey: "db-wal-recovery:arm40:40",
  task: "db-wal-recovery",
  arm: "arm40",
  maxTurns: 40,
  identity: ${JSON.stringify(identityFor())},
});
console.log("STARTED " + handle.dir);
// Block forever so the parent can SIGKILL us mid-runner, as a killed driver would.
setInterval(() => {}, 1000);`);

    const attemptDir = join(fx.runRoot, "db-wal-recovery:arm40:40");
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        script,
        fx.runRoot,
        fx.slotsDir,
        fx.ledgerPath,
        fx.bundlePath,
      ],
      {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));

    await waitFor(() => out.includes("STARTED"));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("close", resolve));

    assert.ok(
      hasStartedRecord(attemptDir),
      "the fsynced started record must survive SIGKILL"
    );
    assert.notEqual(
      classifyRetained(attemptDir),
      "missing",
      "an attempt with a started record must never read as missing"
    );
    assert.equal(
      classifyRetained(attemptDir),
      "interrupted",
      "started with no finalization means the driver died before the runner returned"
    );

    const ledger = readLedger(fx.ledgerPath);
    const unsettled = unfinishedAttempts(ledger.rows);
    assert.equal(
      unsettled.length,
      1,
      "the killed attempt must stay visible as an unsettled intent"
    );
    assert.equal(
      settledIds(ledger.rows).length,
      0,
      "a killed attempt has no finalization row"
    );
  }, 20_000);

  it("reconciles an unfinished attempt from retained artifacts as interrupted", () => {
    const fx = fixture();
    const handle = beginAttempt({
      runRoot: fx.runRoot,
      slotsDir: fx.slotsDir,
      ledgerPath: fx.ledgerPath,
      bundlePath: fx.bundlePath,
      settingsPath: null,
      slotKey: "db-wal-recovery:arm40:40",
      task: "db-wal-recovery",
      arm: "arm40",
      maxTurns: 40,
      identity: identityFor(),
    });
    assert.equal(
      classifyRetained(handle.dir),
      "interrupted",
      "precondition: the attempt is unfinished"
    );

    const reconciled = reconcileInterrupted(
      fx.ledgerPath,
      new Map([[handle.attemptId, handle]]),
      1_700_000_500_000
    );

    assert.deepEqual(
      [...reconciled],
      [handle.attemptId],
      "the unfinished attempt must be reconciled"
    );
    assert.equal(
      classifyRetained(handle.dir),
      "interrupted",
      "it stays classified as interrupted"
    );
    const ledger = readLedger(fx.ledgerPath);
    assert.equal(
      unfinishedAttempts(ledger.rows).length,
      0,
      "reconciliation must close the intent so a restart does not redispatch silently"
    );
    assert.equal(
      settledIds(ledger.rows)[0],
      "interrupted",
      "the finalization must record interrupted"
    );
  });

  it("does not redispatch an attempt that already settled", () => {
    const fx = fixture();
    const handle = beginAttempt({
      runRoot: fx.runRoot,
      slotsDir: fx.slotsDir,
      ledgerPath: fx.ledgerPath,
      bundlePath: fx.bundlePath,
      settingsPath: null,
      slotKey: "db-wal-recovery:arm40:40",
      task: "db-wal-recovery",
      arm: "arm40",
      maxTurns: 40,
      identity: identityFor(),
    });
    finalizeAttempt(handle, fx.ledgerPath, {
      status: "completed",
      finishedAtEpochMs: 1,
      modelDispatched: true,
      exitCodes: {},
      reward: "1",
      graderExit: 0,
      usage: null,
      model: "test-model",
      reason: "done",
    });

    const reconciled = reconcileInterrupted(
      fx.ledgerPath,
      new Map([[handle.attemptId, handle]]),
      2
    );

    assert.deepEqual(
      [...reconciled],
      [],
      "a settled attempt must not be reconciled again"
    );
  });

  it("classifies a directory with no started record as missing", () => {
    const root = tempRoot("attempt-missing");
    const dir = join(root, "never-started");
    mkdirSync(dir, { recursive: true });

    assert.equal(
      classifyRetained(dir),
      "missing",
      "an unallocated directory is missing, not interrupted"
    );
  });

  it("reports the final status once a finalization record exists", () => {
    const fx = fixture();
    const handle = beginAttempt({
      runRoot: fx.runRoot,
      slotsDir: fx.slotsDir,
      ledgerPath: fx.ledgerPath,
      bundlePath: fx.bundlePath,
      settingsPath: null,
      slotKey: "db-wal-recovery:arm40:40",
      task: "db-wal-recovery",
      arm: "arm40",
      maxTurns: 40,
      identity: identityFor(),
    });
    finalizeAttempt(handle, fx.ledgerPath, {
      status: "invalid",
      finishedAtEpochMs: 1,
      modelDispatched: true,
      exitCodes: { grader: 3 },
      reward: null,
      graderExit: 3,
      usage: null,
      model: "test-model",
      reason: "grader failed",
    });

    assert.equal(
      classifyRetained(handle.dir),
      "invalid",
      "a finalization record decides the class"
    );
  });
});

describe("ledger recovery after a kill", () => {
  it("counts a torn final line as torn rather than as a complete row", () => {
    const fx = fixture();
    beginAttempt({
      runRoot: fx.runRoot,
      slotsDir: fx.slotsDir,
      ledgerPath: fx.ledgerPath,
      bundlePath: fx.bundlePath,
      settingsPath: null,
      slotKey: "db-wal-recovery:arm40:40",
      task: "db-wal-recovery",
      arm: "arm40",
      maxTurns: 40,
      identity: identityFor(),
    });
    // Simulate a process killed mid-append: a torn JSON object with no newline.
    execFileSync("bash", [
      "-c",
      `printf '%s' '{"attemptId":"torn","phase":"comp' >> ${fx.ledgerPath}`,
    ]);

    const ledger = readLedger(fx.ledgerPath);

    assert.equal(
      ledger.tornLines,
      1,
      "the torn line must be counted explicitly"
    );
    assert.equal(
      ledger.rows.length,
      1,
      "the earlier complete row must survive the torn line"
    );
  });

  it("reads an absent ledger as empty without throwing", () => {
    const root = tempRoot("ledger-absent");

    const ledger = readLedger(join(root, "never-written.jsonl"));

    assert.deepEqual(
      ledger.rows,
      [],
      "an absent ledger is empty, not an error"
    );
    assert.equal(ledger.tornLines, 0, "an absent ledger has no torn lines");
  });
});

function settledIds(rows: ReadonlyArray<LedgerRow>): string[] {
  return rows.filter((row) => row.phase !== "intent").map((row) => row.phase);
}

/**
 * Catchable-signal handling (the other half of issue 1219 requirement 2).
 *
 * Every case here delivers a REAL signal to a REAL `node --import tsx` child rather than
 * calling `process.emit` in-process: the property under test is what the operating system
 * does to a live process, and a mocked emit cannot show whether the handler is removed
 * before the re-raise or whether the re-raise reaches the default disposition at all.
 */
const SLOT_KEY = "db-wal-recovery:arm40:40";
const CWD = REPO_ROOT;

/** The tokens the child's fake dispatch retains before the signal lands. */
const OBSERVED_USAGE: UsageRecord = {
  inputTokens: 111,
  outputTokens: 22,
  cacheCreationInputTokens: 3,
  cacheReadInputTokens: 4,
};

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface Instrumented {
  readonly identity: RunIdentity;
  readonly spec: ProvisionSpec;
}

/**
 * An identity whose pinned shas match the fixture's REAL bytes, so the child's
 * instrument-integrity gate passes and the attempt genuinely reaches dispatch. A fixture
 * identity would be refused at the gate and the signal path would never be exercised.
 */
function instrumented(fx: Fixture): Instrumented {
  const root = dirname(fx.bundlePath);
  const nodeArchivePath = join(root, "node-dist.tar.gz");
  writeFileSync(nodeArchivePath, "fake node archive bytes");
  const identity = identityFor({
    bundleSha256: sha256Of(fx.bundlePath),
    nodeArchiveSha256: sha256Of(nodeArchivePath),
  });
  return {
    identity,
    spec: {
      identity,
      taskDir: join(root, "task"),
      outDir: join(fx.runRoot, SLOT_KEY),
      bundlePath: fx.bundlePath,
      nodeArchivePath,
      settingsPath: fx.settingsPath,
    },
  };
}

/** Holds the child open long enough for a re-raised signal to be delivered, then never settles. */
const BLOCK_FOREVER =
  "await new Promise<never>(() => { setTimeout(() => {}, 60000); });";
const PASSING_GRADE =
  'return { exitCode: 0, reward: "1", ctrfBytes: 256, resultLine: "7 passed", networkFailureMarker: false };';

interface ChildPlan {
  /** Runs inside `dispatch`, after the partial artifacts are on disk. */
  readonly dispatchTail: string;
  /** Runs inside `reap`; the reap marker is already written when it executes. */
  readonly reapTail?: string;
  /** A grading observation; defaults to throwing, because a signal path must not grade. */
  readonly gradeBody?: string;
  /** Keep the child alive after `runAttempt` resolves, so a later signal is post-settle. */
  readonly holdAfter?: boolean;
}

/**
 * Write a child that runs ONE real attempt through a fake runner. `grade` throws unless a
 * plan supplies it, so a test that accidentally grades after a signal fails loudly.
 */
function writeRunAttemptChild(arm: Instrumented, plan: ChildPlan): string {
  return writeChildScript(`import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAttempt } from "${SCRIPT_DIR}/attempt.ts";

// A temp-dir child has no "type": "module", so tsx transforms it to CJS and rejects
// top-level await: the attempt runs inside an async IIFE instead.
void (async () => {
const handle = beginAttempt({
  runRoot: process.argv[2],
  slotsDir: process.argv[3],
  ledgerPath: process.argv[4],
  bundlePath: process.argv[5],
  settingsPath: null,
  slotKey: ${JSON.stringify(SLOT_KEY)},
  task: "db-wal-recovery",
  arm: "arm40",
  maxTurns: 40,
  identity: ${JSON.stringify(arm.identity)},
});
const dir = handle.dir;
const runner = {
  version: "test/1",
  provision: async () => ({ exitCode: 0, bootVerified: true, logsMountWritable: true, glibcxxMeasured: "GLIBCXX_3.4.30", stdout: "" }),
  dispatch: async () => {
    // The partial artifacts a real dispatch has already retained when a signal lands.
    mkdirSync(join(dir, "trace"), { recursive: true });
    writeFileSync(join(dir, "trace", "session.jsonl"), JSON.stringify({ record_type: "llm_call", input_tokens: 111, output_tokens: 22, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }) + "\\n");
    console.log("DISPATCHING");
    ${plan.dispatchTail}
  },
  grade: async () => { ${plan.gradeBody ?? 'throw new Error("grade must not run once an attempt was signalled");'} },
  reap: async () => {
    writeFileSync(join(dir, "reaped.json"), JSON.stringify({
      sigtermListeners: process.listenerCount("SIGTERM"),
      sigintListeners: process.listenerCount("SIGINT")
    }));
    ${plan.reapTail ?? ""}
  },
};
const readUsage = (target) => {
  try {
    const record = JSON.parse(readFileSync(join(target, "trace", "session.jsonl"), "utf8").trim());
    return {
      inputTokens: record.input_tokens,
      outputTokens: record.output_tokens,
      cacheCreationInputTokens: record.cache_creation_input_tokens,
      cacheReadInputTokens: record.cache_read_input_tokens
    };
  } catch {
    return null;
  }
};
const result = await runAttempt(handle, process.argv[4], {
  runner,
  provisionSpec: ${JSON.stringify(arm.spec)},
  maxTurns: 40,
  agentWallSec: 1,
  graderGraceSec: 1,
  declaredVerifierTimeoutSec: 1,
  readUsage
});
console.log("RETURNED " + JSON.stringify(result));
${plan.holdAfter === true ? "setTimeout(() => {}, 60000);" : ""}
})();`);
}

interface ChildOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly out: string;
  readonly err: string;
}

/** Spawn a real child, wait for its marker, deliver a real signal, then wait for its exit. */
function runAndSignal(
  script: string,
  fx: Fixture,
  marker: string,
  signal: NodeJS.Signals
): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        script,
        fx.runRoot,
        fx.slotsDir,
        fx.ledgerPath,
        fx.bundlePath,
      ],
      { cwd: CWD, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("error", reject);
    // A handler that never disposes leaves the child alive, so the wait must not hang.
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `child did not exit after ${signal}; stdout=${out} stderr=${err}`
        )
      );
    }, 15_000);
    void waitFor(() => out.includes(marker)).then(
      () => child.kill(signal),
      (error: unknown) => {
        clearTimeout(watchdog);
        child.kill("SIGKILL");
        reject(error);
      }
    );
    child.on("close", (code, killedBy) => {
      clearTimeout(watchdog);
      resolve({ code, signal: killedBy, out, err });
    });
  });
}

function isFinal(record: AttemptRecord): record is FinalRecord {
  return record.recordType === "attempt-finalized";
}

function isStarted(record: AttemptRecord): record is StartedRecord {
  return record.recordType === "attempt-started";
}

function recordOf<T extends AttemptRecord>(
  dir: string,
  guard: (record: AttemptRecord) => record is T
): T {
  const found = readAttemptRecords(dir).find(guard);
  assert.ok(
    found !== undefined,
    `expected a retained record in ${dir}; got: ${JSON.stringify(readAttemptRecords(dir))}`
  );
  return found;
}

interface ReapMarker {
  readonly sigtermListeners: number;
  readonly sigintListeners: number;
}

function reapMarkerOf(dir: string): ReapMarker {
  const path = join(dir, "reaped.json");
  assert.ok(
    existsSync(path),
    `the owned resource must be reaped; no reap marker at ${path}`
  );
  return JSON.parse(readFileSync(path, "utf8")) as ReapMarker;
}

describe("graceful TERM/INT finalization (issue 1219 requirement 2)", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "finalizes inline, reaps the owned resource and still dies by %s when a real signal lands mid-dispatch",
    async (signal) => {
      const fx = fixture();
      const arm = instrumented(fx);
      const script = writeRunAttemptChild(arm, { dispatchTail: BLOCK_FOREVER });
      const attemptDir = join(fx.runRoot, SLOT_KEY);

      const child = await runAndSignal(script, fx, "DISPATCHING", signal);

      assert.equal(
        child.signal,
        signal,
        `the driver must still die by ${signal} rather than reporting a success; stderr=${child.err}`
      );

      const final = recordOf(attemptDir, isFinal);
      assert.equal(
        final.status,
        "interrupted",
        "a signalled attempt must finalize with a known status"
      );
      assert.equal(
        final.modelDispatched,
        true,
        "the model was already dispatched when the signal landed"
      );
      assert.deepEqual(
        final.usage,
        OBSERVED_USAGE,
        "usage must be the observed partial tally, not a constant"
      );
      assert.equal(
        final.reward,
        null,
        "an attempt that never graded has no reward"
      );
      assert.equal(
        final.graderExit,
        null,
        "the grader never ran, so it has no exit code"
      );
      assert.match(
        final.reason,
        new RegExp(signal),
        `the record must name ${signal}; got: ${final.reason}`
      );

      // Retained partial artifacts: the signal path finalizes, it never cleans up.
      const trace = join(attemptDir, "trace", "session.jsonl");
      assert.ok(
        existsSync(trace),
        "partial artifacts must be retained across a signal"
      );
      assert.match(
        readFileSync(trace, "utf8"),
        /llm_call/,
        "the retained trace must be the real partial write"
      );

      // The owned container/process is reaped, and only because our own listener is already
      // gone: re-raising while the handler is still installed is a swallowed, spinning signal.
      const reaped = reapMarkerOf(attemptDir);
      assert.equal(
        reaped.sigtermListeners,
        0,
        "the SIGTERM listener must be removed before the re-raise"
      );
      assert.equal(
        reaped.sigintListeners,
        0,
        "the SIGINT listener must be removed before the re-raise"
      );

      // A SETTLED finalization row, so spend accounting is not left with an unresolved intent.
      const rows = readLedger(fx.ledgerPath).rows;
      const attemptId = recordOf(attemptDir, isStarted).attemptId;
      assert.equal(
        unfinishedAttempts(rows).length,
        0,
        `a signal-finalized attempt must settle its intent row; rows=${JSON.stringify(rows)}`
      );
      const settlement = finalizationOf(rows, attemptId);
      assert.ok(
        settlement !== null,
        "the ledger must carry a finalization row for the signalled attempt"
      );
      assert.equal(
        settlement.phase,
        "interrupted",
        "the finalization row must record the interruption"
      );
      assert.deepEqual(
        settlement.usage,
        OBSERVED_USAGE,
        "the settled row must carry the observed usage"
      );
      assert.equal(
        classifyRetained(attemptDir),
        "interrupted",
        "retained records must classify as interrupted"
      );
    },
    20_000
  );

  it("does not double-finalize when a second signal arrives during teardown", async () => {
    const fx = fixture();
    const arm = instrumented(fx);
    // The reap sends a SECOND real signal, which lands while teardown is still running.
    const script = writeRunAttemptChild(arm, {
      dispatchTail: BLOCK_FOREVER,
      reapTail: 'process.kill(process.pid, "SIGTERM");',
    });
    const attemptDir = join(fx.runRoot, SLOT_KEY);

    const child = await runAndSignal(script, fx, "DISPATCHING", "SIGTERM");

    assert.equal(
      child.signal,
      "SIGTERM",
      `a repeated signal must still terminate; stderr=${child.err}`
    );
    const rows = readLedger(fx.ledgerPath).rows;
    const attemptId = recordOf(attemptDir, isStarted).attemptId;
    assert.equal(
      rows.filter(
        (row) => row.attemptId === attemptId && row.phase === "interrupted"
      ).length,
      1,
      `exactly one finalization row may be written per attempt; rows=${JSON.stringify(rows)}`
    );
    assert.equal(
      readAttemptRecords(attemptDir).filter(isFinal).length,
      1,
      "a second signal must not append a second finalization record"
    );
    assert.equal(
      classifyRetained(attemptDir),
      "interrupted",
      "the attempt stays classified as interrupted"
    );
  }, 20_000);

  it("leaves a settled attempt untouched and keeps no listener that would swallow a later signal", async () => {
    const fx = fixture();
    const arm = instrumented(fx);
    const script = writeRunAttemptChild(arm, {
      dispatchTail:
        'return { exitCode: 0, model: "test-model", stopReason: "turn-limit" };',
      gradeBody: PASSING_GRADE,
      holdAfter: true,
    });
    const attemptDir = join(fx.runRoot, SLOT_KEY);

    const child = await runAndSignal(script, fx, "RETURNED", "SIGTERM");

    assert.match(
      child.out,
      /"status":"completed"/,
      `the attempt must have settled first; stdout=${child.out}`
    );
    assert.equal(
      child.signal,
      "SIGTERM",
      `a post-settle signal must take the default disposition, proving no listener was left; stderr=${child.err}`
    );
    const final = recordOf(attemptDir, isFinal);
    assert.equal(
      final.status,
      "completed",
      "a later signal must not rewrite a settled attempt"
    );
    const attemptId = recordOf(attemptDir, isStarted).attemptId;
    const rows = readLedger(fx.ledgerPath).rows;
    assert.equal(
      rows.filter(
        (row) => row.attemptId === attemptId && row.phase === "completed"
      ).length,
      1,
      `a settled attempt must keep exactly one finalization row; rows=${JSON.stringify(rows)}`
    );
  }, 20_000);

  it("leaks no process-level signal listener across repeated attempts in one process", async () => {
    const baseline = {
      term: process.listenerCount("SIGTERM"),
      interrupt: process.listenerCount("SIGINT"),
    };
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning.name);
    };
    process.on("warning", onWarning);
    try {
      // 12 attempts is past the default maxListeners of 10, so an unremoved listener per
      // attempt would trip MaxListenersExceededWarning rather than pass quietly.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const fx = fixture();
        const arm = instrumented(fx);
        const handle = beginAttempt({
          runRoot: fx.runRoot,
          slotsDir: fx.slotsDir,
          ledgerPath: fx.ledgerPath,
          bundlePath: fx.bundlePath,
          settingsPath: null,
          slotKey: SLOT_KEY,
          task: "db-wal-recovery",
          arm: "arm40",
          maxTurns: 40,
          identity: arm.identity,
        });

        const result = await runAttempt(handle, fx.ledgerPath, {
          runner: passingRunner(),
          provisionSpec: arm.spec,
          maxTurns: 40,
          agentWallSec: 1,
          graderGraceSec: 1,
          declaredVerifierTimeoutSec: 1,
          readUsage: () => OBSERVED_USAGE,
        });

        assert.equal(
          result.status,
          "completed",
          `attempt ${attempt} must still settle normally`
        );
        assert.equal(
          process.listenerCount("SIGTERM"),
          baseline.term,
          `attempt ${attempt} must not leave a process SIGTERM listener behind`
        );
        assert.equal(
          process.listenerCount("SIGINT"),
          baseline.interrupt,
          `attempt ${attempt} must not leave a process SIGINT listener behind`
        );
      }
      // Warnings are emitted on a later tick, so let them flush before asserting.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.removeListener("warning", onWarning);
    }
    assert.deepEqual(
      warnings,
      [],
      "one listener per attempt must never trip the max-listeners warning"
    );
  });
});

/** A runner whose every stage succeeds, so an attempt settles normally. */
function passingRunner(): RunnerPort {
  return {
    version: "test/1",
    provision: async () => ({
      exitCode: 0,
      bootVerified: true,
      logsMountWritable: true,
      glibcxxMeasured: "GLIBCXX_3.4.31",
      stdout: "",
    }),
    dispatch: async () => ({
      exitCode: 0,
      model: "test-model",
      stopReason: "turn-limit",
    }),
    grade: async () => ({
      exitCode: 0,
      reward: "1",
      ctrfBytes: 256,
      resultLine: "7 passed",
      networkFailureMarker: false,
    }),
    reap: async () => {},
  };
}
