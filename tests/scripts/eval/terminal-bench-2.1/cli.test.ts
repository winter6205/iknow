/**
 * CLI wiring: usage extraction and the provisioning spec's identity.
 *
 * Why this matters (issue 1219): two defects found while wiring the entry point, both of
 * which would have silently corrupted a run.
 *
 *  - Usage extraction was gated on the evidence-completeness verdict. Completeness depends
 *    on an EXPECTED trace count that no caller can know up front, so the verdict always
 *    failed and every attempt's real spend was reported `unknown` — which then halted the
 *    entire run against the budget. Usage is a measurement; completeness is a different
 *    question, and the two must not be conflated.
 *  - The provisioning spec was built with an identity whose `runId`/`bundleSha256`/
 *    `nodeArchiveSha256`/etc. were empty strings. Those are precisely the placeholder
 *    values the tooling exists to refuse, and a runner provisioned against them cannot
 *    prove which instrument it ran.
 *
 * The third block is the REPORT the entry point actually emits (issue 1219). `summarize`
 * existed and was tested, but nothing ever called it: an operator ran the driver and got a
 * stop reason with no denominators and no spend, which is the #1212 failure mode where the
 * totals were computed by hand from a ledger whose last attempt was never ledgered at all.
 * The artifact is proven by DRIVING THE REAL CLI IN A CHILD PROCESS
 * (`node --import tsx …/cli.ts --report-only`) against real files on disk, so what is
 * asserted is the operator-visible output, not an in-process return value.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";

import {
  buildReport,
  dockerRunnerFor,
  GATES_DIR,
  GATE_SCRATCH_DIR,
  identityForSlot,
  LEDGER_FILE,
  main,
  OracleGateRefusal,
  oracleRefusalDecision,
  parseArgs,
  recordGateExclusion,
  REPORT_FILE,
  retainGateRecord,
  summarize,
  usageFromEvidence,
  wireDeps,
  type RunReport,
} from "../../../../scripts/eval/terminal-bench-2.1/cli.ts";
import {
  AttemptDirReservedError,
  beginAttempt,
  finalizeAttempt,
  recordGateFailure,
  releaseSlot,
  type StartedRecord,
} from "../../../../scripts/eval/terminal-bench-2.1/attempt.ts";
import {
  driverSlotsOf,
  resolveConfig,
  type DriverSlot,
  type EvalManifest,
  type ManifestSlot,
} from "../../../../scripts/eval/terminal-bench-2.1/config.ts";
import type { RunIdentity } from "../../../../scripts/eval/terminal-bench-2.1/identities.ts";
import {
  runGate,
  type GateRecord,
  type PreflightMeasurement,
} from "../../../../scripts/eval/terminal-bench-2.1/preflight.ts";
import type { DriverExit } from "../../../../scripts/eval/terminal-bench-2.1/driver.ts";
import {
  OracleFailedError,
  OracleNotApplicableError,
  type ExecFn,
} from "../../../../scripts/eval/terminal-bench-2.1/docker.ts";
import {
  ensureMountAlias,
  mountBindSource,
  sha256File,
  type DispatchOptions,
  type ProvisionSpec,
  type RunnerPort,
} from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";
import {
  cleanupTempRoots,
  identityFor,
  makeAttemptDir,
  PASSING_GRADER_LOG,
  tempRoot,
  writeTrace,
} from "./fixtures.ts";

afterAll(cleanupTempRoots);

/** Real CLI, real argv, real child process — the artifact an operator actually reads. */
const CLI_PATH = fileURLToPath(
  new URL("../../../../scripts/eval/terminal-bench-2.1/cli.ts", import.meta.url)
);
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Temp roots this file creates; removed in `afterAll` even when a child process ran. */
const cliRoots: string[] = [];

afterAll(() => {
  for (const root of cliRoots.splice(0, cliRoots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Credential-free stand-in for the host settings file. Never a real `~/.iknow` path. */
const SETTINGS_BODY =
  '{\n  "_note": "issue-1219 cli test placeholder; no credentials"\n}\n';

interface ChildRun {
  readonly code: number;
  readonly stderr: string;
  readonly report: RunReport;
}

interface ChildExit {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Drive the real CLI in a child process with no assumption about its exit status, so a
 * refusal case can be observed rather than assumed. The exit status is data, not a check.
 */
function spawnCli(args: ReadonlyArray<string>): ChildExit {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI_PATH, ...args],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 }
  );
  return {
    code: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/** Drive the real CLI in a child process and parse the single JSON line it prints. */
function runCli(args: ReadonlyArray<string>): ChildRun {
  const result = spawnCli(args);
  assert.equal(
    result.code,
    0,
    `child CLI must exit 0; stderr=${result.stderr}`
  );
  const line = result.stdout.trim();
  assert.ok(
    line.startsWith("{"),
    `the CLI must print one JSON object; got: ${line.slice(0, 400)}`
  );
  assert.equal(
    line.split("\n").length,
    1,
    `the report must be a single machine-readable line; got ${line.split("\n").length}`
  );
  return {
    code: result.code ?? -1,
    stderr: result.stderr,
    report: JSON.parse(line) as RunReport,
  };
}

type SlotKind =
  "valid-attempt" | "interrupted-attempt" | "gate-refusal" | "gate-exclusion";

interface PlannedSlot {
  readonly task: string;
  readonly kind: SlotKind;
  readonly maxTurns?: number;
}

interface RunFiles {
  readonly root: string;
  readonly runRoot: string;
  readonly manifestPath: string;
  readonly ledgerPath: string;
  readonly manifest: EvalManifest;
  readonly bundlePath: string;
  readonly nodeArchivePath: string;
  readonly settingsPath: string;
  readonly plan: ReadonlyArray<PlannedSlot>;
}

/**
 * Build the on-disk world a headless run leaves behind: a real manifest whose pinned shas are
 * the REAL shas of the temp bundle/node files, plus a run root. No lifecycle is materialized
 * here, so an in-process `main()` run starts from nothing, exactly as an operator would.
 */
function newRun(plan: ReadonlyArray<PlannedSlot>): RunFiles {
  const root = mkdtempSync(join(tmpdir(), "iknow-cli-"));
  cliRoots.push(root);
  const runRoot = join(root, "runs/run-1219");
  mkdirSync(runRoot, { recursive: true });
  const bundlePath = join(root, "bundle.tgz");
  const nodeArchivePath = join(root, "node.tar.gz");
  const settingsPath = join(root, "settings.json");
  writeFileSync(bundlePath, "placeholder bundle for issue-1219 cli tests\n");
  writeFileSync(
    nodeArchivePath,
    "placeholder node archive for issue-1219 cli tests\n"
  );
  writeFileSync(settingsPath, SETTINGS_BODY);
  const manifest: EvalManifest = {
    runId: "run-1219",
    datasetCommit: "7131e437",
    bundleSha256: sha256File(bundlePath),
    nodeArchiveSha256: sha256File(nodeArchivePath),
    runnerVersion: "tb2.1-attempt/1",
    outputLayout: "trace/ logs/ process/ meta/",
    frozenBeforeAnyOutcome: true,
    slots: plan.map((entry) => ({
      task: entry.task,
      image: "python:3.11-slim",
      imageDigest: "sha256:aaa111",
      maxTurns: entry.maxTurns ?? 40,
      arm: "arm40",
    })),
  };
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return {
    root,
    runRoot,
    manifestPath,
    ledgerPath: join(runRoot, LEDGER_FILE),
    manifest,
    bundlePath,
    nodeArchivePath,
    settingsPath,
    plan,
  };
}

/** The identity the manifest requires for a slot — the oracle for gate-record freshness. */
function expectedIdentity(
  manifest: EvalManifest,
  slot: ManifestSlot
): RunIdentity {
  return {
    runId: manifest.runId,
    task: slot.task,
    image: slot.image,
    imageDigest: slot.imageDigest,
    datasetCommit: manifest.datasetCommit,
    bundleSha256: manifest.bundleSha256,
    nodeArchiveSha256: manifest.nodeArchiveSha256,
    runnerVersion: manifest.runnerVersion,
    outputLayout: manifest.outputLayout,
  };
}

/** A gate probe that passes, so a retained record is a REAL judged verdict. */
const PASSING_MEASUREMENT: PreflightMeasurement = {
  glibcxxMeasured: "GLIBCXX_3.4.31",
  bundleGlibcxxFloor: "GLIBCXX_3.4.31",
  runnerWiringOk: true,
  graderExit: 0,
  oracleReward: "1",
  ctrfBytes: 512,
  resultLine: "7 passed",
  networkFailureMarker: false,
};

/** A measurement whose measured library is BELOW the floor: a real EXCLUDE:glibcxx. */
const LOW_GLIBCXX_MEASUREMENT: PreflightMeasurement = {
  ...PASSING_MEASUREMENT,
  glibcxxMeasured: "GLIBCXX_3.4.30",
};

/** Leave in the attempt dir what a real container would have retained through `/artifacts`. */
function writeAttemptArtifacts(dir: string): void {
  mkdirSync(join(dir, "trace/blobs"), { recursive: true });
  mkdirSync(join(dir, "logs/verifier"), { recursive: true });
  mkdirSync(join(dir, "process"), { recursive: true });
  writeFileSync(
    join(dir, "trace/session.jsonl"),
    `${JSON.stringify({
      record_type: "llm_call",
      input_tokens: 15645,
      output_tokens: 2100,
      cache_creation_input_tokens: 3000,
      cache_read_input_tokens: 179410,
    })}\n`
  );
  writeFileSync(join(dir, "logs/verifier/ctrf.json"), "x".repeat(512));
  writeFileSync(join(dir, "process/grader.log"), PASSING_GRADER_LOG);
}

/** A `started`-shaped context for a slot whose attempt never began (gate refusal). */
function unstartedAttempt(
  files: RunFiles,
  slot: ManifestSlot,
  identity: RunIdentity,
  startedAtEpochMs: number
): StartedRecord {
  return {
    recordType: "attempt-started",
    attemptId: `${slot.task}:arm40:40@gate-${startedAtEpochMs}-1`,
    slotKey: `${slot.task}:arm40:${slot.maxTurns}`,
    task: slot.task,
    arm: slot.arm,
    maxTurns: slot.maxTurns,
    identity,
    pid: 1,
    startedAtEpochMs,
    attemptStarted: false,
    modelDispatched: false,
    bundleSha256: files.manifest.bundleSha256,
    settingsSha256: "absent",
  };
}

/**
 * Materialize the planned lifecycle for each slot using the REAL attempt/ledger/gate writers,
 * so the report is derived from records the production code path would have written.
 */
async function materializeRun(files: RunFiles): Promise<void> {
  let clock = 1_700_000_000_000;
  for (const entry of files.plan) {
    clock += 1_000;
    await materializeSlot(files, entry, clock);
  }
}

async function materializeSlot(
  files: RunFiles,
  entry: PlannedSlot,
  clock: number
): Promise<void> {
  const slot = files.manifest.slots.find((s) => s.task === entry.task);
  assert.ok(
    slot !== undefined,
    `the plan must name a manifest slot; missing ${entry.task}`
  );
  const identity = expectedIdentity(files.manifest, slot);
  const slotKey = `${slot.task}:arm40:${slot.maxTurns}`;
  if (entry.kind === "gate-refusal") {
    // A record whose identity drifted: the run's own selection must REJECT it even though
    // the file is right there. This is the #1212 defect, reproduced rather than described.
    const stale = await runGate(
      { ...identity, runId: "run-1189" },
      async () => PASSING_MEASUREMENT,
      clock
    );
    retainGateRecord(join(files.runRoot, GATES_DIR), slotKey, stale);
    recordGateFailure(
      files.ledgerPath,
      unstartedAttempt(files, slot, identity, clock),
      "REJECT:stale-identity",
      clock
    );
    return;
  }
  const decision = await runGate(
    identity,
    async () =>
      entry.kind === "gate-exclusion"
        ? LOW_GLIBCXX_MEASUREMENT
        : PASSING_MEASUREMENT,
    clock
  );
  retainGateRecord(join(files.runRoot, GATES_DIR), slotKey, decision);
  if (entry.kind === "gate-exclusion") {
    recordGateExclusion(
      files.ledgerPath,
      unstartedAttempt(files, slot, identity, clock),
      decision.verdict
    );
    return;
  }
  const handle = beginAttempt({
    runRoot: files.runRoot,
    slotsDir: join(files.runRoot, "slots"),
    slotKey,
    task: slot.task,
    arm: slot.arm,
    maxTurns: slot.maxTurns,
    identity,
    ledgerPath: files.ledgerPath,
    bundlePath: files.bundlePath,
    settingsPath: files.settingsPath,
    startedAtEpochMs: clock,
    pid: 4242,
  });
  writeAttemptArtifacts(handle.dir);
  if (entry.kind === "interrupted-attempt") {
    // Intent written, no finalization: exactly what a SIGKILL leaves behind.
    return;
  }
  finalizeAttempt(handle, files.ledgerPath, {
    status: "completed",
    finishedAtEpochMs: clock + 10,
    modelDispatched: true,
    exitCodes: { provision: 0, dispatch: 0 },
    reward: "1",
    graderExit: 0,
    // Read back from the retained trace, so the reported spend is measured, not declared.
    usage: usageFromEvidence(handle.dir),
    model: "fake/model-1",
    reason: "done",
  });
}

/** The full explicit argv an operator passes, plus any extra flags a case needs. */
function argvFor(files: RunFiles, extra: ReadonlyArray<string> = []): string[] {
  return [
    "--manifest",
    files.manifestPath,
    "--dataset-root",
    join(files.root, "dataset"),
    "--bundle",
    files.bundlePath,
    "--node-archive",
    files.nodeArchivePath,
    "--settings",
    files.settingsPath,
    "--run-root",
    files.runRoot,
    "--agent-wall-sec",
    "2700",
    "--grader-grace-sec",
    "600",
    "--bundle-glibcxx-floor",
    "GLIBCXX_3.4.31",
    "--token-ceiling-input",
    "4000000",
    "--token-ceiling-output",
    "3000000",
    ...extra,
  ];
}

const AUDITED_PLAN: ReadonlyArray<PlannedSlot> = [
  { task: "db-wal-recovery", kind: "valid-attempt" },
  { task: "password-recovery", kind: "interrupted-attempt" },
  { task: "custom-memory-heap-crash", kind: "gate-refusal" },
  { task: "sqlite-wal-mode", kind: "gate-exclusion" },
];

/** A recording `ExecFn`: captures every argv, so the real `docker run` line is assertable. */
function recordingExec(): {
  readonly exec: ExecFn;
  readonly calls: ReadonlyArray<ReadonlyArray<string>>;
} {
  const calls: ReadonlyArray<string>[] = [];
  const exec: ExecFn = async (_file, args) => {
    calls.push([...args]);
    return { stdout: "", stderr: "", code: 0 };
  };
  return { exec, calls };
}

/**
 * The `docker run -d` argv the CLI builds for `argv`, through the CLI's OWN runner factory
 * over a recording exec. `main` accepts an injected `RunnerPort`, which means it has no exec
 * seam: the only way to observe what the real attempt path would hand to `docker` is to call
 * the same factory `main` calls.
 */
async function dockerRunArgsFor(
  argv: ReadonlyArray<string>,
  outDir: string
): Promise<ReadonlyArray<string>> {
  const { exec, calls } = recordingExec();
  await dockerRunnerFor(parseArgs(argv), exec).provision({
    identity: identityFor(),
    taskDir: join(outDir, "tasks/db-wal-recovery"),
    outDir,
    bundlePath: join(outDir, "bundle.tgz"),
    nodeArchivePath: join(outDir, "node.tar.gz"),
    settingsPath: join(outDir, "settings.json"),
  });
  const line = calls.find((args) => args[0] === "run" && args.includes("-d"));
  assert.ok(
    line !== undefined,
    `expected a docker run -d line; got: ${JSON.stringify(calls)}`
  );
  return line;
}

/** Run `dockerRunnerFor` and return the refusal it raised, asserting that it raised one. */
function captureRefusal(extra: ReadonlyArray<string>, files: RunFiles): Error {
  try {
    dockerRunnerFor(parseArgs(argvFor(files, extra)));
  } catch (error) {
    return error as Error;
  }
  throw new Error(
    `expected a refusal for ${JSON.stringify(extra)}, but the runner accepted it`
  );
}

/**
 * Assert every `-v` value is a spec `docker run` can parse.
 *
 * `docker run -v HOST:CONTAINER[:ro]` splits on `:` and reports `too many colons` past two,
 * which is why the real failure was a driver that excluded every slot instead of dispatching
 * one. Reproduced live: `docker: invalid spec: …/db-wal-recovery:arm40:40/logs:/logs`.
 */
function assertNoUnparseableVolume(args: ReadonlyArray<string>): void {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "-v") continue;
    const spec = args[i + 1] ?? "";
    const colons = spec.split(":").length - 1;
    assert.ok(
      colons <= 2,
      `a -v value carrying ${String(colons)} colons is unparsable by docker; argv=${JSON.stringify(args)}`
    );
  }
}

/** True when `alias` is a symlink resolving to `target`. */
function resolveAlias(alias: string, target: string): boolean {
  try {
    return lstatSync(alias).isSymbolicLink() && readlinkSync(alias) === target;
  } catch {
    return false;
  }
}

/**
 * Dispatch options the fakes accept and ignore. The real `dispatch` needs them, and a fake
 * that forwards an incomplete call would be a type error the headless suite never catches.
 */
const FAKE_DISPATCH_OPTIONS: DispatchOptions = {
  maxTurns: 40,
  agentWallSec: 2700,
  graderGraceSec: 600,
};

/**
 * A `RunnerPort` with no Docker behind it. `dispatch` writes what a real container would leave
 * in the mounted output dir, so usage and validity are measured from real retained evidence.
 * It never writes during the preflight probe: writing the attempt dir would make the later
 * `reserveAttemptDir` refuse, which is itself the exclusivity guarantee under test.
 *
 * Both grading entry points are present, because they are SEPARATE methods on purpose: `grade`
 * is the agent path (an untouched-by-any-solution workspace) and `gradeOracle` is the gate's
 * measurement path (the task's own reference solution applied first). The gate must reach the
 * second one; `pristineFailingRunner` below is what proves which one it reaches.
 */
function fakeRunner(options: { glibcxxMeasured?: string } = {}): RunnerPort {
  const leave = (spec: ProvisionSpec): void => {
    mkdirSync(join(spec.outDir, "logs/verifier"), { recursive: true });
    mkdirSync(join(spec.outDir, "process"), { recursive: true });
    mkdirSync(join(spec.outDir, "trace"), { recursive: true });
    writeFileSync(
      join(spec.outDir, "logs/verifier/ctrf.json"),
      "x".repeat(256)
    );
    writeFileSync(join(spec.outDir, "process/grader.log"), PASSING_GRADER_LOG);
    writeFileSync(
      join(spec.outDir, "trace/session.jsonl"),
      `${JSON.stringify({
        record_type: "llm_call",
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 900,
      })}\n`
    );
  };
  return {
    version: "fake/1",
    provision: async () => ({
      exitCode: 0,
      bootVerified: true,
      logsMountWritable: true,
      glibcxxMeasured: options.glibcxxMeasured ?? "GLIBCXX_3.4.31",
      stdout: "logs-mount-writable",
    }),
    dispatch: async (spec) => {
      leave(spec);
      return { exitCode: 0, model: "fake/model-1", stopReason: "done" };
    },
    grade: async () => ({
      exitCode: 0,
      reward: "1",
      ctrfBytes: 256,
      resultLine: "7 passed",
      networkFailureMarker: false,
    }),
    gradeOracle: async () => ({
      exitCode: 0,
      reward: "1",
      ctrfBytes: 256,
      resultLine: "7 passed",
      networkFailureMarker: false,
      oracle: {
        state: "applied",
        solvePath: "<taskDir>/solution/solve.sh",
        exitCode: 0,
        stdout: "--- applying oracle ---\noracle_exit=0",
      },
    }),
    reap: async () => undefined,
  };
}

function slot(): DriverSlot {
  const manifest = {
    runId: "run-1219",
    datasetCommit: "dc",
    bundleSha256: "bs",
    nodeArchiveSha256: "ns",
    runnerVersion: "v",
    outputLayout: "o",
    frozenBeforeAnyOutcome: true,
    slots: [
      {
        task: "db-wal-recovery",
        image: "python:3.11-slim",
        imageDigest: "sha256:aaa111",
        maxTurns: 40,
        arm: "arm40",
      },
    ],
  } as unknown as Parameters<typeof driverSlotsOf>[0];
  return driverSlotsOf(manifest)[0]!;
}

describe("usage read back from retained traces", () => {
  it("reports measured usage even when the evidence is not complete", () => {
    const root = tempRoot("cli-usage-partial");
    const dir = makeAttemptDir(root);
    // A lone trace with no blobs: incomplete evidence, but the token counts are real.
    writeTrace(dir, "session.jsonl", [
      {
        recordType: "llm_call",
        inputTokens: 15645,
        outputTokens: 2100,
        cacheReadInputTokens: 179410,
      },
    ]);

    const usage = usageFromEvidence(dir);

    assert.ok(usage !== null, "measured usage must not be reported as unknown");
    assert.equal(
      usage?.inputTokens,
      15645,
      "input tokens must come from the traces"
    );
    assert.equal(
      usage?.cacheReadInputTokens,
      179410,
      "cache reads must be included in usage"
    );
    assert.equal(
      (usage?.inputTokens ?? 0) +
        (usage?.outputTokens ?? 0) +
        (usage?.cacheCreationInputTokens ?? 0) +
        (usage?.cacheReadInputTokens ?? 0),
      197155,
      "the total must include cache reads"
    );
  });

  it("reports zero-token usage for an attempt that retained no trace", () => {
    const root = tempRoot("cli-usage-empty");

    const usage = usageFromEvidence(makeAttemptDir(root));

    assert.deepEqual(
      usage,
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      "an attempt with no traces spent nothing, which is a real zero, not unknown"
    );
  });

  it("reports unknown rather than zero when the attempt directory does not exist", () => {
    const root = tempRoot("cli-usage-absent");

    assert.equal(
      usageFromEvidence(join(root, "never-started")),
      null,
      "an unreadable attempt must be unknown, never a free zero"
    );
  });
});

describe("argument parsing refuses rather than defaulting", () => {
  it("parses every explicit flag", () => {
    const parsed = parseArgs([
      "--manifest",
      "/m.json",
      "--dataset-root",
      "/d",
      "--bundle",
      "/b.tgz",
      "--node-archive",
      "/n.tar.gz",
      "--settings",
      "/s.json",
      "--run-root",
      "/r",
      "--agent-wall-sec",
      "2700",
      "--grader-grace-sec",
      "600",
      "--bundle-glibcxx-floor",
      "GLIBCXX_3.4.31",
      "--token-ceiling-input",
      "4000000",
      "--token-ceiling-output",
      "3000000",
    ]);

    assert.equal(
      parsed["dataset-root"],
      "/d",
      "explicit paths must survive parsing"
    );
    assert.equal(
      parsed["bundle-glibcxx-floor"],
      "GLIBCXX_3.4.31",
      "the floor must be explicit"
    );
  });

  it("rejects an unknown flag instead of ignoring it", () => {
    assert.throws(
      () => parseArgs(["--dataset", "/d"]),
      /unknown flag --dataset/,
      "a typo must not silently fall back to a default"
    );
  });

  it("rejects a flag with no value", () => {
    assert.throws(
      () => parseArgs(["--manifest"]),
      /missing value/,
      "a valueless flag must be refused"
    );
  });
});

describe("the repeatable --container-env flag reaches the real docker run line", () => {
  it("accumulates every occurrence instead of keeping only the last", () => {
    const parsed = parseArgs([
      "--container-env",
      "HTTP_PROXY=http://a.invalid:1",
      "--container-env",
      "HTTPS_PROXY=http://b.invalid:2",
    ]);

    assert.deepEqual(
      parsed["container-env"],
      ["HTTP_PROXY=http://a.invalid:1", "HTTPS_PROXY=http://b.invalid:2"],
      "a proxy needs several variables, so the flag must accumulate rather than overwrite"
    );
  });

  it("forwards every occurrence as one -e flag, placed before the image", async () => {
    const files = newRun(AUDITED_PLAN);
    const outDir = makeAttemptDir(tempRoot("cli-env-fwd"));
    const args = await dockerRunArgsFor(
      argvFor(files, [
        "--container-env",
        "HTTP_PROXY=http://proxy.invalid:7890",
        "--container-env",
        "HTTPS_PROXY=http://proxy.invalid:7890",
        "--container-env",
        "NO_PROXY=localhost,127.0.0.1",
      ]),
      outDir
    );

    for (const entry of [
      "HTTP_PROXY=http://proxy.invalid:7890",
      "HTTPS_PROXY=http://proxy.invalid:7890",
      "NO_PROXY=localhost,127.0.0.1",
    ]) {
      assert.ok(
        args.includes(entry),
        `expected -e ${entry} on the run line; got: ${JSON.stringify(args)}`
      );
    }
    assert.equal(
      args.filter((arg) => arg === "-e").length,
      3,
      `one -e per supplied variable, no more; got: ${JSON.stringify(args)}`
    );
    const imageAt = args.indexOf(identityFor().image);
    assert.ok(
      imageAt > 0,
      `the image must appear on the run line; got: ${JSON.stringify(args)}`
    );
    assert.ok(
      args.lastIndexOf("-e") < imageAt,
      `docker run rejects options after the image; got: ${JSON.stringify(args)}`
    );
  });

  it("emits no -e flag at all when the flag is absent", async () => {
    const files = newRun(AUDITED_PLAN);
    const outDir = makeAttemptDir(tempRoot("cli-env-default"));

    const args = await dockerRunArgsFor(argvFor(files), outDir);

    assert.equal(
      args.filter((arg) => arg === "-e").length,
      0,
      `the default run must be byte-identical to before the flag existed; got: ${JSON.stringify(args)}`
    );
  });

  it("keeps a value containing = and a space inside one argv element", async () => {
    const files = newRun(AUDITED_PLAN);
    const outDir = makeAttemptDir(tempRoot("cli-env-split"));
    const value = "http://user:p=a ss@proxy.invalid:7890";

    const args = await dockerRunArgsFor(
      argvFor(files, ["--container-env", `HTTP_PROXY=${value}`]),
      outDir
    );

    assert.ok(
      args.includes(`HTTP_PROXY=${value}`),
      `only the first = separates the name, so the value must arrive unsplit; got: ${JSON.stringify(args)}`
    );
  });

  it("refuses a value with no = rather than forwarding a nameless flag", () => {
    const files = newRun(AUDITED_PLAN);

    assert.throws(
      () =>
        dockerRunnerFor(
          parseArgs(argvFor(files, ["--container-env", "HTTP_PROXY"]))
        ),
      /--container-env needs NAME=VALUE/,
      "a malformed entry must be a refusal, not a silently dropped -e flag"
    );
  });

  it("refuses a name docker would not accept, and an empty value the runner would drop", () => {
    const files = newRun(AUDITED_PLAN);

    assert.throws(
      () =>
        dockerRunnerFor(
          parseArgs(argvFor(files, ["--container-env", "not-a-name=x"]))
        ),
      /shell-style NAME/,
      "a name docker exec would reject must be refused before the run starts"
    );
    assert.throws(
      () =>
        dockerRunnerFor(
          parseArgs(argvFor(files, ["--container-env", "HTTP_PROXY="]))
        ),
      /empty value/,
      "the runner drops an empty value, so accepting one here would silently apply nothing"
    );
  });

  it("exits nonzero with a clear message on a malformed value", () => {
    const files = newRun(AUDITED_PLAN);

    const run = spawnCli(argvFor(files, ["--container-env", "HTTP_PROXY"]));

    assert.equal(
      run.code,
      1,
      `a malformed value must fail the run; stdout=${run.stdout} stderr=${run.stderr}`
    );
    assert.match(
      run.stderr,
      /--container-env needs NAME=VALUE/,
      `the operator must be told which entry was wrong; stderr=${run.stderr}`
    );
  });
});

describe("wired dependencies carry the resolved identity", () => {
  it("provisions with a fully populated identity and no placeholder field", async () => {
    const root = tempRoot("cli-identity");
    const runRoot = join(root, "runs");
    mkdirSync(runRoot, { recursive: true });
    const seen: ProvisionSpec[] = [];
    const runner: RunnerPort = {
      version: "fake/1",
      provision: async (spec) => {
        seen.push(spec);
        return {
          exitCode: 0,
          bootVerified: true,
          logsMountWritable: true,
          glibcxxMeasured: "GLIBCXX_3.4.31",
          stdout: "",
        };
      },
      dispatch: async () => ({ exitCode: 0, model: "m", stopReason: "done" }),
      grade: async () => ({
        exitCode: 0,
        reward: "1",
        ctrfBytes: 2878,
        resultLine: "7 passed",
        networkFailureMarker: false,
      }),
      // The gate measures through the oracle, so a port that cannot run one refuses outright
      // and never reaches `provision` — which is the point of the refusal case's own test.
      gradeOracle: async () => ({
        exitCode: 0,
        reward: "1",
        ctrfBytes: 2878,
        resultLine: "7 passed",
        networkFailureMarker: false,
        oracle: {
          state: "applied",
          solvePath: "<taskDir>/solution/solve.sh",
          exitCode: 0,
          stdout: "oracle_exit=0",
        },
      }),
      reap: async () => undefined,
    };
    const manifest = {
      runId: "run-1219",
      datasetCommit: "7131e437",
      bundleSha256: "bundle-sha",
      nodeArchiveSha256: "node-sha",
      runnerVersion: "tb2.1-attempt/1",
      outputLayout: "trace/ logs/ process/ meta/",
      frozenBeforeAnyOutcome: true,
      slots: [
        {
          task: "db-wal-recovery",
          image: "python:3.11-slim",
          imageDigest: "sha256:aaa111",
          maxTurns: 40,
          arm: "arm40",
        },
      ],
    } as unknown as Parameters<typeof driverSlotsOf>[0];

    const wiring = {
      config: {
        params: {
          datasetRoot: join(root, "dataset"),
          bundlePath: join(root, "bundle.tgz"),
          nodeArchivePath: join(root, "node.tar.gz"),
          settingsPath: join(root, "settings.json"),
          runRoot,
          agentWallSec: 2700,
          graderGraceSec: 600,
          bundleGlibcxxFloor: "GLIBCXX_3.4.31",
          tokenCeiling: { input: 4_000_000, output: 3_000_000 },
        },
        manifest,
        identityFor: (s: ManifestSlot) => ({
          ...identityFor(),
          runId: "run-1219",
          datasetCommit: "7131e437",
          bundleSha256: "bundle-sha",
          nodeArchiveSha256: "node-sha",
          runnerVersion: "tb2.1-attempt/1",
          outputLayout: "trace/ logs/ process/ meta/",
          task: s.task,
          image: s.image,
          imageDigest: s.imageDigest,
        }),
      },
      runner,
      ledgerPath: join(root, "ledger.jsonl"),
      params: {
        datasetRoot: join(root, "dataset"),
        bundlePath: join(root, "bundle.tgz"),
        nodeArchivePath: join(root, "node.tar.gz"),
        settingsPath: join(root, "settings.json"),
        runRoot,
        agentWallSec: 2700,
        graderGraceSec: 600,
        bundleGlibcxxFloor: "GLIBCXX_3.4.31",
        tokenCeiling: { input: 4_000_000, output: 3_000_000 },
      },
    };
    const deps = wireDeps(wiring);

    await deps.gate(slot());

    assert.equal(
      seen.length,
      1,
      "the gate must provision through the real runner path"
    );
    const identity = seen[0]?.identity;
    assert.ok(
      identity !== undefined,
      "the provision spec must carry an identity"
    );
    for (const [field, value] of Object.entries(identity!)) {
      assert.ok(
        typeof value === "string" && value.length > 0,
        `identity field ${field} must be populated; got: ${JSON.stringify(value)}`
      );
    }
    assert.equal(
      identity?.bundleSha256,
      "bundle-sha",
      "the identity must come from the manifest"
    );
  });
});

describe("summarize derives counts from retained artifacts", () => {
  it("reports a zero denominator for a run that dispatched nothing", () => {
    const root = tempRoot("cli-summarize-empty");

    const summary = summarize(join(root, "ledger.jsonl"), {
      params: { runRoot: join(root, "runs") },
      manifest: { slots: [] },
      identityFor: (s: ManifestSlot) => identityFor({ task: s.task }),
    } as unknown as Parameters<typeof summarize>[1]);

    assert.equal(
      summary.denominator.attempted,
      0,
      "no ledger rows means no attempts"
    );
    assert.equal(summary.spend.totalTokens, 0, "no ledger rows means no spend");
    assert.equal(summary.tornLines, 0, "an absent ledger has no torn lines");
  });

  it("counts an unsettled attempt in attempted rather than hiding it", () => {
    const root = tempRoot("cli-summarize-unsettled");
    const runRoot = join(root, "runs");
    const ledgerPath = join(root, "ledger.jsonl");
    const started = {
      recordType: "attempt-started",
      attemptId: "a-1",
      slotKey: "db-wal-recovery:arm40:40",
      task: "db-wal-recovery",
      arm: "arm40",
      maxTurns: 40,
      identity: identityFor(),
      pid: 1,
      startedAtEpochMs: 1,
      attemptStarted: true,
      modelDispatched: false,
      bundleSha256: "b",
      settingsSha256: "absent",
    };
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        attemptId: "a-1",
        slotKey: started.slotKey,
        task: started.task,
        arm: started.arm,
        maxTurns: 40,
        phase: "intent",
        recordedAtEpochMs: 1,
        attemptStarted: true,
        modelDispatched: false,
        excluded: false,
        usage: null,
        reason: "",
      })}\n`
    );
    mkdirSync(join(runRoot, started.slotKey, "process"), { recursive: true });
    writeFileSync(
      join(runRoot, started.slotKey, "process/grader.log"),
      PASSING_GRADER_LOG
    );

    const summary = summarize(ledgerPath, {
      params: { runRoot },
      manifest: {
        slots: [
          {
            task: "db-wal-recovery",
            image: "i",
            imageDigest: "d",
            maxTurns: 40,
            arm: "arm40",
          },
        ],
      },
      identityFor: (s: ManifestSlot) => identityFor({ task: s.task }),
    } as unknown as Parameters<typeof summarize>[1]);

    assert.equal(
      summary.denominator.attempted,
      1,
      "an unsettled attempt is still attempted"
    );
    assert.equal(
      summary.denominator.interrupted,
      1,
      "an intent with no finalization is interrupted"
    );
    assert.equal(
      summary.spend.usageComplete,
      false,
      "an attempt with no usage is unknown, not zero"
    );
  });
});
describe("the report the real CLI emits (child process, real files)", () => {
  it("reports the denominators with the pre-dispatch gate bucket kept separately visible", async () => {
    const files = newRun(AUDITED_PLAN);
    await materializeRun(files);

    const { report, code } = runCli([...argvFor(files), "--report-only"]);

    assert.equal(code, 0, "a completed audit is a successful command");
    assert.equal(
      report.schemaVersion,
      1,
      "the artifact must state which report shape it is"
    );
    assert.equal(
      report.mode,
      "report-only",
      "the artifact must state which mode produced it"
    );
    assert.deepEqual(
      report.denominator,
      {
        attempted: 2,
        valid: 1,
        invalid: 0,
        interrupted: 1,
        modelAttributable: 1,
        // A gate failure increments BOTH buckets; a preflight exclusion only `excluded`.
        excluded: 2,
        gateFailures: 1,
        policyId: "1219-denominator-v1",
      },
      "every count must come from the lifecycle records, and the gate bucket must stay separate"
    );
    assert.deepEqual(
      report.attempts.map((fact) => [
        fact.slotKey,
        fact.phase,
        fact.usageKnown,
      ]),
      [
        ["db-wal-recovery:arm40:40", "completed", true],
        ["password-recovery:arm40:40", "intent", false],
      ],
      "each attempt must be listed with the phase and whether its usage was readable"
    );
    assert.equal(
      report.countingPolicy.policyId,
      "1219-denominator-v1",
      "the frozen policy must be visible"
    );
    assert.equal(
      report.countingPolicy.unknownUsageIsNotZero,
      true,
      "the artifact must state the unknown-is-not-zero clause it was counted under"
    );
  });

  it("includes cache-creation and cache-read tokens in the spend totals", async () => {
    const files = newRun([{ task: "db-wal-recovery", kind: "valid-attempt" }]);
    await materializeRun(files);

    const { report } = runCli([...argvFor(files), "--report-only"]);

    assert.deepEqual(
      {
        input: report.spend.observed.inputTokens,
        output: report.spend.observed.outputTokens,
        cacheCreation: report.spend.observed.cacheCreationInputTokens,
        cacheRead: report.spend.observed.cacheReadInputTokens,
        total: report.spend.observed.totalTokens,
      },
      {
        input: 15645,
        output: 2100,
        cacheCreation: 3000,
        cacheRead: 179410,
        total: 200155,
      },
      "all four counters must be reported, and the total must include the cache tokens"
    );
    assert.equal(
      report.spend.usage,
      "known",
      "a fully settled attempt's usage is known"
    );
    assert.equal(
      report.spend.totalTokens,
      200155,
      "the headline total must match the measured spend"
    );
    assert.equal(
      report.ceiling.reached,
      false,
      "200155 of a claimed 7000000 is under the ceiling"
    );
    assert.equal(
      report.ceiling.mayDispatch,
      true,
      "a known, under-ceiling run may dispatch more"
    );
    assert.equal(
      report.ceiling.enforcement,
      "observed-between-attempts",
      "the verdict must not imply a live budget guard"
    );
  });

  it("reports unknown usage as unknown, never zero, and blocks the ceiling on it", async () => {
    const files = newRun(AUDITED_PLAN);
    await materializeRun(files);

    const { report } = runCli([...argvFor(files), "--report-only"]);

    assert.equal(
      report.spend.usage,
      "unknown",
      "one unreadable attempt makes the run's usage unknown"
    );
    assert.equal(
      report.spend.usageComplete,
      false,
      "usage completeness must be reported, not assumed"
    );
    assert.equal(
      report.spend.totalTokens,
      null,
      "an unknown total must never print as 0"
    );
    assert.equal(
      report.spend.inputTokens,
      null,
      "an unknown counter must never print as 0"
    );
    assert.equal(
      report.spend.outputTokens,
      null,
      "an unknown counter must never print as 0"
    );
    assert.equal(
      report.spend.cacheCreationInputTokens,
      null,
      "an unknown counter must never print as 0"
    );
    assert.equal(
      report.spend.cacheReadInputTokens,
      null,
      "an unknown counter must never print as 0"
    );
    assert.equal(
      report.spend.unknownUsageAttempts.length,
      1,
      "the artifact must name the attempts whose usage is unknown"
    );
    assert.equal(
      report.spend.observed.cacheReadInputTokens,
      179410,
      "what IS known stays visible"
    );
    assert.equal(
      report.ceiling.reached,
      true,
      "unknown usage must not look like budget left over"
    );
    assert.equal(
      report.ceiling.mayDispatch,
      false,
      "unknown usage must block further dispatch"
    );
    assert.match(
      report.ceiling.reason,
      /unknown is not zero/,
      "the reason must say why it blocks"
    );
  });

  it("retains an identity-bound gate record per slot and selects it by identity, not by presence", async () => {
    const files = newRun(AUDITED_PLAN);
    await materializeRun(files);

    const { report } = runCli([...argvFor(files), "--report-only"]);

    const gatePath = join(
      files.runRoot,
      GATES_DIR,
      "db-wal-recovery:arm40:40.gate.json"
    );
    assert.ok(
      existsSync(gatePath),
      `the gate record must be retained at ${gatePath}`
    );
    const retained = JSON.parse(readFileSync(gatePath, "utf8")) as {
      record: { identity: Record<string, string>; verdict: string };
    };
    for (const [field, value] of Object.entries(retained.record.identity)) {
      assert.ok(
        typeof value === "string" && value.length > 0,
        `the retained gate record must bind identity field ${field}; got ${JSON.stringify(value)}`
      );
    }
    assert.equal(
      retained.record.identity["bundleSha256"],
      files.manifest.bundleSha256,
      "identity must be the manifest's"
    );
    assert.equal(
      retained.record.verdict,
      "OK:oracle-passes-grader",
      "the judged verdict must be the retained one"
    );
    assert.equal(
      report.gate.recordsRetained,
      4,
      "every gate decision the run made must be retained"
    );
    assert.deepEqual(
      report.gate.passed,
      ["db-wal-recovery:arm40:40", "password-recovery:arm40:40"],
      "a fresh passing record selects for its own slot"
    );
    assert.deepEqual(
      report.gate.exclusions.map((outcome) => [
        outcome.slotKey,
        outcome.verdict,
      ]),
      [["sqlite-wal-mode:arm40:40", "EXCLUDE:glibcxx"]],
      "an explicit exclusion stays visible and distinguishable from a gate failure"
    );
    assert.deepEqual(
      report.gate.rejected.map((outcome) => [outcome.slotKey, outcome.verdict]),
      [["custom-memory-heap-crash:arm40:40", "REJECT:stale-identity"]],
      "a record whose identity drifted is rejected even though its file is present: presence is not selection"
    );
    assert.deepEqual(
      report.gate.ledgerRefusals,
      [
        {
          slotKey: "custom-memory-heap-crash:arm40:40",
          reason: "gate:REJECT:stale-identity",
        },
      ],
      "the pre-dispatch refusal must also be countable in the ledger"
    );
  });

  it("writes the same report to <run-root>/run-report.json as it prints", async () => {
    const files = newRun(AUDITED_PLAN);
    await materializeRun(files);

    const { report } = runCli([...argvFor(files), "--report-only"]);

    const persisted = join(files.runRoot, REPORT_FILE);
    assert.ok(
      existsSync(persisted),
      `the report must be persisted at ${persisted}`
    );
    assert.deepEqual(
      JSON.parse(readFileSync(persisted, "utf8")) as unknown,
      JSON.parse(JSON.stringify(report)) as unknown,
      "stdout and the persisted artifact must be one and the same report"
    );
  });

  it("derives the verdict from the checks, never from prose", async () => {
    // Previously this case built a run of ONE gate-excluded slot and asserted
    // `usable === true`, on the reasoning "nothing was attempted, so nothing can have
    // failed". That reasoning IS the defect: every required check passed vacuously over an
    // empty collection, so a run that measured nothing reported itself clean. It was the
    // only way this path could reach `usable`, and it reached it by lying.
    const measured = newRun([
      { task: "db-wal-recovery", kind: "valid-attempt" },
    ]);
    await materializeRun(measured);

    const { report } = runCli([...argvFor(measured), "--report-only"]);

    assert.equal(
      report.checks.usable,
      report.checks.failedCheckIds.length === 0,
      "the usable verdict must be exactly the conjunction of the required checks"
    );
    assert.equal(
      report.checks.unconditional,
      report.checks.usable && report.checks.failedCheckIds.length === 0,
      "an unconditional verdict may only be stated when no required check is red"
    );
    assert.equal(
      report.checks.verdict,
      report.checks.usable ? "usable" : "not-usable",
      "the verdict field must carry the checks' own answer, not a narrative one"
    );
  });

  it("refuses `usable` for a run that measured nothing at all", async () => {
    // The regression this pins: a manifest that declared work, and a run that produced none.
    // A void run must name that fact, not pass every check over an empty collection.
    const voidRun = newRun([
      { task: "sqlite-wal-mode", kind: "gate-exclusion" },
    ]);
    await materializeRun(voidRun);

    const { report } = runCli([...argvFor(voidRun), "--report-only"]);

    assert.equal(
      report.denominator.attempted,
      0,
      "this fixture is the void case: the gate excluded the only declared slot"
    );
    assert.ok(
      report.slots > 0,
      "the manifest declared a slot, so the run had something it failed to measure"
    );
    assert.ok(
      report.checks.failedCheckIds.includes("run-measured" as never),
      `a declared-but-unmeasured run must fail run-measured; got: ${JSON.stringify(report.checks.failedCheckIds)}`
    );
    assert.equal(
      report.checks.usable,
      false,
      "a run that measured nothing may never be usable"
    );
    assert.equal(
      report.checks.unconditional,
      false,
      "and may never state an unconditional verdict"
    );
  });

  it("withholds an unconditional usable verdict while a required check is red", async () => {
    const files = newRun(AUDITED_PLAN);
    await materializeRun(files);

    const { report } = runCli([...argvFor(files), "--report-only"]);

    for (const id of ["clean-stop", "stimuli-settled", "evidence-complete"]) {
      assert.ok(
        report.checks.failedCheckIds.includes(id as never),
        `a run with an unsettled attempt and an unknown trace expectation must fail ${id}; got ${JSON.stringify(report.checks.failedCheckIds)}`
      );
    }
    assert.equal(
      report.checks.usable,
      false,
      "a failed required check forbids the usable verdict"
    );
    assert.equal(
      report.checks.verdict,
      "not-usable",
      "the verdict must name the refusal"
    );
    assert.equal(
      report.checks.unconditional,
      false,
      "no verdict may be stated unconditionally here"
    );
    const cleanStop = report.checks.checks.find(
      (check) => check.id === "clean-stop"
    );
    assert.ok(
      cleanStop !== undefined,
      "every required check must be listed with its detail"
    );
    assert.match(
      cleanStop.detail,
      /unsettled attempt/,
      "the failed check must say what it found"
    );
  });
});

describe("every terminal condition is distinguishable in the emitted report", () => {
  it("reports a completed run with code 0 and its measured spend", async () => {
    const files = newRun([{ task: "db-wal-recovery", kind: "valid-attempt" }]);

    const report = await main(argvFor(files), { runner: fakeRunner() });

    assert.equal(
      report.stopReason,
      "completed",
      "a run that dispatched every slot completed"
    );
    assert.equal(report.code, 0, "a completed run is exit 0");
    assert.equal(
      report.stoppedAt,
      null,
      "a completed run stopped nowhere in particular"
    );
    assert.equal(
      report.denominator.attempted,
      1,
      "the dispatched attempt must be counted"
    );
    assert.equal(
      report.denominator.valid,
      1,
      "validity must come from the retained artifacts"
    );
    assert.equal(
      report.denominator.modelAttributable,
      1,
      "a dispatched attempt is model-attributable"
    );
    assert.equal(
      report.spend.totalTokens,
      2150,
      "spend must be measured from the retained trace"
    );
    assert.ok(
      existsSync(
        join(files.runRoot, GATES_DIR, "db-wal-recovery:arm40:40.gate.json")
      ),
      "a live run must retain its gate record too"
    );
  });

  it("records an explicit gate exclusion as excluded, not as an attempt or a gate failure", async () => {
    const files = newRun([
      { task: "db-wal-recovery", kind: "valid-attempt" },
      { task: "password-recovery", kind: "valid-attempt" },
    ]);

    const report = await main(argvFor(files), {
      runner: fakeRunner({ glibcxxMeasured: "GLIBCXX_3.4.30" }),
    });

    assert.equal(
      report.stopReason,
      "completed",
      "an exclusion skips one slot and the frozen list continues"
    );
    assert.equal(report.code, 0, "an exclusion is not a failure exit");
    assert.equal(
      report.denominator.attempted,
      0,
      "an excluded slot never dispatched a model"
    );
    assert.equal(
      report.denominator.excluded,
      2,
      "both exclusions must be visible in their own count"
    );
    assert.equal(
      report.denominator.gateFailures,
      0,
      "an exclusion is not a pre-dispatch gate failure"
    );
    assert.deepEqual(
      report.gate.exclusions.map((outcome) => [
        outcome.slotKey,
        outcome.verdict,
      ]),
      [
        ["db-wal-recovery:arm40:40", "EXCLUDE:glibcxx"],
        ["password-recovery:arm40:40", "EXCLUDE:glibcxx"],
      ],
      "each exclusion must stay visible with the verdict that produced it"
    );
    assert.deepEqual(
      report.gate.ledgerRefusals,
      [],
      "an exclusion must not be ledgered as a gate refusal"
    );
    assert.equal(
      report.gate.recordsRetained,
      2,
      "a live run must retain what its gate measured"
    );
    assert.ok(
      existsSync(
        join(files.runRoot, GATES_DIR, "db-wal-recovery:arm40:40.gate.json")
      ),
      "the judged verdict must be on disk, identity bound, for a later audit"
    );
  });

  it("stops at the token ceiling and reports the blocking ceiling verdict", async () => {
    const files = newRun([
      { task: "db-wal-recovery", kind: "valid-attempt" },
      { task: "password-recovery", kind: "valid-attempt" },
    ]);

    const report = await main(
      [
        ...argvFor(files),
        "--token-ceiling-input",
        "1",
        "--token-ceiling-output",
        "1",
      ],
      { runner: fakeRunner() }
    );

    assert.equal(
      report.stopReason,
      "ceiling",
      "a claimed budget that is spent must stop the run"
    );
    assert.equal(report.code, 1, "a ceiling stop is a failure exit");
    assert.equal(
      report.stoppedAt,
      "password-recovery:arm40:40",
      "the stop must name the slot it stopped on"
    );
    assert.equal(
      report.ceiling.reached,
      true,
      "the artifact must state the ceiling was reached"
    );
    assert.equal(
      report.ceiling.mayDispatch,
      false,
      "no further dispatch is permitted"
    );
    assert.match(
      report.ceiling.reason,
      /of claimed 2 tokens/,
      "the verdict must name the claimed budget"
    );
    assert.equal(
      report.denominator.gateFailures,
      0,
      "a ceiling stop is not a gate failure"
    );
  });

  it("classifies a contended slot as slot-unavailable instead of an unnamed failure", async () => {
    const files = newRun([
      { task: "db-wal-recovery", kind: "valid-attempt" },
      { task: "password-recovery", kind: "valid-attempt" },
    ]);
    const slotKey = "db-wal-recovery:arm40:40";
    // Another driver already holds this manifest slot: the O_EXCL claim is taken.
    mkdirSync(join(files.runRoot, "slots"), { recursive: true });
    writeFileSync(
      join(files.runRoot, "slots", `${slotKey}.claim`),
      "other-driver@1700000000000-999\n"
    );

    const report = await main(argvFor(files), { runner: fakeRunner() });

    assert.equal(
      report.stopReason,
      "slot-unavailable",
      "a contended slot must be classified, not thrown past the loop as an unnamed failure"
    );
    assert.equal(report.code, 1, "a contended slot is a failure exit");
    assert.equal(
      report.stoppedAt,
      slotKey,
      "the artifact must name the contended slot"
    );
    assert.equal(
      report.denominator.attempted,
      0,
      "a refused claim never began an attempt"
    );
    assert.equal(
      report.denominator.gateFailures,
      0,
      "contention is not a gate failure"
    );
    assert.equal(
      report.checks.unconditional,
      false,
      "a contended run may not be declared clean"
    );
  });

  it("reports a gate failure in its own bucket, separate from the attempt denominator", async () => {
    const files = newRun([
      { task: "custom-memory-heap-crash", kind: "gate-refusal" },
    ]);
    await materializeRun(files);
    const exit: DriverExit = {
      code: 1,
      stopReason: "gate-failure",
      stoppedAt: "custom-memory-heap-crash:arm40:40",
      dispatched: [],
      excluded: [],
    };

    const report = buildReport({
      mode: "run",
      ledgerPath: files.ledgerPath,
      runRoot: files.runRoot,
      manifest: files.manifest,
      ceiling: { inputTokens: 4_000_000, outputTokens: 3_000_000 },
      exit,
      identityFor: (slot) => expectedIdentity(files.manifest, slot),
    });

    assert.equal(
      report.stopReason,
      "gate-failure",
      "an untrustworthy gate record must stop the whole driver"
    );
    assert.equal(
      report.denominator.attempted,
      0,
      "a pre-dispatch refusal is not an attempt"
    );
    assert.equal(
      report.denominator.gateFailures,
      1,
      "the refusal must be visible in its own bucket"
    );
    assert.equal(
      report.denominator.excluded,
      1,
      "a gate failure increments BOTH buckets"
    );
    assert.equal(
      report.spend.totalTokens,
      0,
      "nothing dispatched means no measured spend"
    );
    assert.equal(
      report.ceiling.mayDispatch,
      true,
      "no spend and no unknown usage leaves the budget intact"
    );
  });

  it("distinguishes a signal-interrupted run from a clean stop", async () => {
    const files = newRun([
      { task: "password-recovery", kind: "interrupted-attempt" },
    ]);
    await materializeRun(files);

    const { report } = runCli([...argvFor(files), "--report-only"]);

    assert.equal(
      report.denominator.interrupted,
      1,
      "an intent with no finalization is an interrupted attempt"
    );
    assert.equal(
      report.denominator.valid,
      0,
      "an interrupted attempt is never valid"
    );
    assert.deepEqual(
      report.attempts.map((fact) => fact.retained),
      ["interrupted"],
      "the retained records must show the attempt was interrupted, not missing"
    );
    const cleanStop = report.checks.checks.find(
      (check) => check.id === "clean-stop"
    );
    assert.equal(
      cleanStop?.ok,
      false,
      "an unsettled attempt must fail clean-stop"
    );
  });

  it("gives every terminal condition its own signature in the artifact", async () => {
    const plan = [
      { task: "db-wal-recovery", kind: "valid-attempt" },
      { task: "password-recovery", kind: "valid-attempt" },
    ] as const;
    const signatures: string[] = [];

    const completed = newRun(plan);
    const done = await main(argvFor(completed), { runner: fakeRunner() });
    signatures.push(
      JSON.stringify([
        done.stopReason,
        done.code,
        done.denominator.attempted,
        done.denominator.gateFailures,
        done.ceiling.reached,
      ])
    );

    const ceilingRun = newRun(plan);
    const capped = await main(
      [
        ...argvFor(ceilingRun),
        "--token-ceiling-input",
        "1",
        "--token-ceiling-output",
        "1",
      ],
      { runner: fakeRunner() }
    );
    signatures.push(
      JSON.stringify([
        capped.stopReason,
        capped.code,
        capped.denominator.attempted,
        capped.denominator.gateFailures,
        capped.ceiling.reached,
      ])
    );

    const contendedRun = newRun(plan);
    mkdirSync(join(contendedRun.runRoot, "slots"), { recursive: true });
    writeFileSync(
      join(contendedRun.runRoot, "slots", "db-wal-recovery:arm40:40.claim"),
      "other-driver@1700000000000-999\n"
    );
    const contended = await main(argvFor(contendedRun), {
      runner: fakeRunner(),
    });
    signatures.push(
      JSON.stringify([
        contended.stopReason,
        contended.code,
        contended.denominator.attempted,
        contended.denominator.gateFailures,
        contended.ceiling.reached,
      ])
    );

    const gateRun = newRun([
      { task: "custom-memory-heap-crash", kind: "gate-refusal" },
    ]);
    await materializeRun(gateRun);
    const gateFailed = buildReport({
      mode: "run",
      ledgerPath: gateRun.ledgerPath,
      runRoot: gateRun.runRoot,
      manifest: gateRun.manifest,
      ceiling: { inputTokens: 4_000_000, outputTokens: 3_000_000 },
      exit: {
        code: 1,
        stopReason: "gate-failure",
        stoppedAt: null,
        dispatched: [],
        excluded: [],
      },
      identityFor: (slot) => expectedIdentity(gateRun.manifest, slot),
    });
    signatures.push(
      JSON.stringify([
        gateFailed.stopReason,
        gateFailed.code,
        gateFailed.denominator.attempted,
        gateFailed.denominator.gateFailures,
        gateFailed.ceiling.reached,
      ])
    );

    const interruptedRun = newRun([
      { task: "password-recovery", kind: "interrupted-attempt" },
    ]);
    await materializeRun(interruptedRun);
    const interrupted = runCli([
      ...argvFor(interruptedRun),
      "--report-only",
    ]).report;
    signatures.push(
      JSON.stringify([
        interrupted.stopReason,
        interrupted.denominator.interrupted,
        interrupted.checks.checks.find((check) => check.id === "clean-stop")
          ?.ok,
      ])
    );

    assert.equal(
      new Set(signatures).size,
      signatures.length,
      `every terminal condition must be distinguishable; got ${JSON.stringify(signatures, null, 2)}`
    );
  });
});

describe("report-only identity binding", () => {
  it("derives the same identity as the resolved config, field for field", () => {
    const files = newRun(AUDITED_PLAN);
    const params = {
      datasetRoot: join(files.root, "dataset"),
      bundlePath: files.bundlePath,
      nodeArchivePath: files.nodeArchivePath,
      settingsPath: files.settingsPath,
      runRoot: files.runRoot,
      agentWallSec: 2700,
      graderGraceSec: 600,
      bundleGlibcxxFloor: "GLIBCXX_3.4.31",
      tokenCeiling: { input: 4_000_000, output: 3_000_000 },
    };
    const resolved = resolveConfig(params, files.manifest);

    for (const slot of files.manifest.slots) {
      assert.deepEqual(
        identityForSlot(files.manifest, slot),
        resolved.identityFor(slot),
        `the report-only identity for ${slot.task} must equal the resolved config's, or gate selection would compare against a second instrument`
      );
    }
  });

  it("refuses to invent a run root it was only asked to audit", async () => {
    const files = newRun(AUDITED_PLAN);
    const missing = join(files.root, "runs/never-ran");

    await assert.rejects(
      main([
        "--manifest",
        files.manifestPath,
        "--run-root",
        missing,
        "--report-only",
      ]),
      /existing run root/,
      "an audit must refuse rather than create an empty run root and report zeros for it"
    );
    assert.equal(
      existsSync(missing),
      false,
      "no run root may be created by a refused audit"
    );
  });
});

/** The slot key the driver reserves, mounts and reports from, for the single-slot plan. */
const SLOT_KEY = "db-wal-recovery:arm40:40";

interface DockerLikeRunner extends RunnerPort {
  /** The `outDir` every `provision` saw, in call order. */
  readonly provisionedOutDirs: ReadonlyArray<string>;
  /** The `outDir` every `dispatch` saw, in call order. */
  readonly dispatchedOutDirs: ReadonlyArray<string>;
  /** How many times `reap` ran. */
  reaps(): number;
  /** How many times the ORACLE grade ran: the gate's own measurement path. */
  oracleGrades(): number;
}

interface BindMountRunnerHooks {
  /** Thrown from `grade`, the AGENT path's grader. */
  readonly onGrade?: () => void;
  /** Thrown from `gradeOracle`, the GATE path's grader. */
  readonly onGradeOracle?: () => void;
}

/**
 * A `RunnerPort` whose `provision` does to the host what `docker run -v` does: it CREATES
 * every bind-mount source that is missing. Verified live —
 * `docker run --rm -v $P/out/logs:/logs -v $P/out:/artifacts <img> true` exits 0 and leaves
 * `$P/out/logs` behind.
 *
 * The plain `fakeRunner` above deliberately avoided this, and that avoidance is what let the
 * real path ship broken: on a docker-backed port the gate provisions first, the daemon
 * creates the attempt directory as a side effect of mounting it, and the dispatch's
 * `reserveAttemptDir` then refuses the very attempt it is about to make. Reproducing the
 * side effect here is what makes the collision reachable from a test at all.
 */
function bindMountCreatingRunner(
  hooks: BindMountRunnerHooks = {}
): DockerLikeRunner {
  const provisionedOutDirs: string[] = [];
  const dispatchedOutDirs: string[] = [];
  let reaps = 0;
  let oracleGrades = 0;
  const base = fakeRunner();
  const oracle = base.gradeOracle;
  assert.ok(
    oracle !== undefined,
    "fakeRunner must supply the oracle entry point the gate measures through"
  );
  return {
    version: "fake-docker/1",
    provision: async (spec) => {
      provisionedOutDirs.push(spec.outDir);
      // Recursive, because `sharedMounts` mounts BOTH `<outDir>` and `<outDir>/logs`, and the
      // daemon creates the nested source first.
      mkdirSync(join(spec.outDir, "logs"), { recursive: true });
      return base.provision(spec);
    },
    dispatch: async (spec) => {
      dispatchedOutDirs.push(spec.outDir);
      return base.dispatch(spec, FAKE_DISPATCH_OPTIONS);
    },
    grade: async (spec, wall) => {
      hooks.onGrade?.();
      return base.grade(spec, wall);
    },
    gradeOracle: async (spec, wall) => {
      hooks.onGradeOracle?.();
      oracleGrades += 1;
      return oracle(spec, wall);
    },
    reap: async (spec) => {
      reaps += 1;
      return base.reap(spec);
    },
    provisionedOutDirs,
    dispatchedOutDirs,
    reaps: () => reaps,
    oracleGrades: () => oracleGrades,
  };
}

/**
 * The MEASURED real shape on `alexgshaw/db-wal-recovery:20251031`: an un-applied oracle grades
 * `reward=0` with `7 failed`, while the oracle-applied grade returns `reward=1` with
 * `7 passed`. A runner shaped like this is what makes "the gate measured the oracle" and "the
 * gate measured a pristine workspace" produce two different, observable verdicts.
 */
function pristineFailingRunner(): DockerLikeRunner {
  const base = fakeRunner();
  const oracle = base.gradeOracle;
  assert.ok(
    oracle !== undefined,
    "fakeRunner must supply the oracle entry point the gate measures through"
  );
  const provisionedOutDirs: string[] = [];
  const dispatchedOutDirs: string[] = [];
  let reaps = 0;
  let oracleGrades = 0;
  return {
    version: "fake-docker/2",
    provision: async (spec) => {
      provisionedOutDirs.push(spec.outDir);
      return base.provision(spec);
    },
    dispatch: async (spec) => {
      dispatchedOutDirs.push(spec.outDir);
      return base.dispatch(spec, FAKE_DISPATCH_OPTIONS);
    },
    grade: async () => ({
      exitCode: 1,
      reward: "0",
      ctrfBytes: 2872,
      resultLine: "7 failed",
      networkFailureMarker: false,
    }),
    gradeOracle: async (spec, wall) => {
      oracleGrades += 1;
      return oracle(spec, wall);
    },
    reap: async (spec) => {
      reaps += 1;
      return base.reap(spec);
    },
    provisionedOutDirs,
    dispatchedOutDirs,
    reaps: () => reaps,
    oracleGrades: () => oracleGrades,
  };
}

/**
 * A runner whose oracle entry point REFUSES with `error()`, standing in for the typed refusals
 * `docker.ts` throws: no `solution/solve.sh`, or a `solve.sh` that exited nonzero. Both are
 * thrown before the grader runs, so the fake must never return a grade.
 */
function oracleRefusingRunner(error: () => Error): DockerLikeRunner {
  const base = fakeRunner();
  const provisionedOutDirs: string[] = [];
  const dispatchedOutDirs: string[] = [];
  let reaps = 0;
  let oracleGrades = 0;
  return {
    version: "fake-docker/3",
    provision: async (spec) => {
      provisionedOutDirs.push(spec.outDir);
      return base.provision(spec);
    },
    dispatch: async (spec) => {
      dispatchedOutDirs.push(spec.outDir);
      return base.dispatch(spec, FAKE_DISPATCH_OPTIONS);
    },
    grade: async (spec, wall) => base.grade(spec, wall),
    gradeOracle: async () => {
      oracleGrades += 1;
      throw error();
    },
    reap: async (spec) => {
      reaps += 1;
      return base.reap(spec);
    },
    provisionedOutDirs,
    dispatchedOutDirs,
    reaps: () => reaps,
    oracleGrades: () => oracleGrades,
  };
}

/**
 * A `RunnerPort` with NO `gradeOracle` at all: the shape of a runner that cannot apply a
 * reference solution. Its `grade` PASSES, so a gate that quietly fell back to it would report
 * `OK` — which is exactly the dishonesty this fake exists to make observable.
 */
function runnerWithoutOracle(): RunnerPort {
  const base = fakeRunner();
  return {
    version: base.version,
    provision: (spec) => base.provision(spec),
    dispatch: (spec, options) => base.dispatch(spec, options),
    grade: (spec, wall) => base.grade(spec, wall),
    reap: (spec) => base.reap(spec),
  };
}

/** The gate record `main` retained for `slotKey`; a missing record fails the assertion. */
function retainedGate(files: RunFiles, slotKey: string): GateRecord {
  const path = join(files.runRoot, GATES_DIR, `${slotKey}.gate.json`);
  assert.ok(
    existsSync(path),
    `expected main() to retain a gate record at ${path}`
  );
  const retained = JSON.parse(readFileSync(path, "utf8")) as {
    readonly record?: GateRecord;
  };
  assert.ok(
    retained.record !== undefined,
    `a retained gate file must carry the judged record; got ${JSON.stringify(retained)}`
  );
  return retained.record;
}

/** One real attempt's plan; the collision only shows on a plan that dispatches. */
function oneAttemptPlan(): ReadonlyArray<PlannedSlot> {
  return [{ task: "db-wal-recovery", kind: "valid-attempt" }];
}

describe("the gate and the attempt directory cannot collide", () => {
  it("reaches dispatch through the real main() when provisioning creates the dirs docker creates", async () => {
    const files = newRun(oneAttemptPlan());
    const runner = bindMountCreatingRunner();

    const report = await main(argvFor(files), { runner });

    assert.equal(
      report.stopReason,
      "completed",
      "a gate that passed must let the driver dispatch the slot it gated"
    );
    assert.equal(report.code, 0, "a run that dispatched every slot is exit 0");
    assert.equal(
      report.denominator.attempted,
      1,
      `the attempt must have been dispatched and counted; got stopReason=${report.stopReason}`
    );
    assert.equal(
      runner.dispatchedOutDirs.length,
      1,
      "the dispatch must actually be reached, not merely survived"
    );
  });

  it("probes the gate in a scratch directory, never the attempt directory report.ts reads", async () => {
    const files = newRun(oneAttemptPlan());
    const runner = bindMountCreatingRunner();

    await main(argvFor(files), { runner });

    const gateOutDir = runner.provisionedOutDirs[0];
    const attemptDir = runner.dispatchedOutDirs[0];
    assert.ok(
      gateOutDir !== undefined && attemptDir !== undefined,
      `both phases must have provisioned; got ${JSON.stringify(runner.provisionedOutDirs)}`
    );
    assert.equal(
      attemptDir,
      join(files.runRoot, SLOT_KEY),
      "the attempt directory is the one report.ts re-derives as join(runRoot, slotKey)"
    );
    assert.notEqual(
      gateOutDir,
      join(files.runRoot, SLOT_KEY),
      `the gate must not provision inside the attempt directory; the daemon would create it and reserveAttemptDir would refuse. got ${String(gateOutDir)}`
    );
    assert.ok(
      gateOutDir.startsWith(join(files.runRoot, GATE_SCRATCH_DIR)),
      `the gate must probe under the ${GATE_SCRATCH_DIR} scratch tree; got ${gateOutDir}`
    );
  });

  it("still refuses a second run against the same slot with that same dir-creating runner", async () => {
    const files = newRun(oneAttemptPlan());
    const first = await main(argvFor(files), {
      runner: bindMountCreatingRunner(),
    });
    assert.equal(
      first.stopReason,
      "completed",
      "the first run must have dispatched"
    );

    const secondRunner = bindMountCreatingRunner();
    const second = await main(argvFor(files), { runner: secondRunner });

    assert.equal(
      second.stopReason,
      "slot-unavailable",
      "a second claim of one manifest slot must be refused, not granted"
    );
    assert.equal(second.code, 1, "a contended slot is a failure exit");
    assert.equal(
      second.denominator.attempted,
      1,
      "the refusal must add no attempt: the first run's evidence stands alone"
    );
    assert.equal(
      secondRunner.dispatchedOutDirs.length,
      0,
      "the refused run must never reach dispatch"
    );
  });

  it("refuses a reused attempt directory once the slot claim is released", async () => {
    const files = newRun(oneAttemptPlan());
    await main(argvFor(files), { runner: bindMountCreatingRunner() });
    const dir = join(files.runRoot, SLOT_KEY);
    const startedPath = join(dir, "attempt-started.json");
    const before = readFileSync(startedPath, "utf8");
    // With the claim gone, only the DIRECTORY reservation can still refuse.
    releaseSlot(join(files.runRoot, "slots", `${SLOT_KEY}.claim`));

    await assert.rejects(
      () => main(argvFor(files), { runner: bindMountCreatingRunner() }),
      (error: unknown) => error instanceof AttemptDirReservedError,
      "the directory reservation is an independent guarantee, not a side effect of the claim"
    );
    assert.equal(
      readFileSync(startedPath, "utf8"),
      before,
      "a refused re-run must leave the prior attempt's durable record byte-identical"
    );
  });
});

describe("the gate reaps the container it owns on every path", () => {
  it("reaps the gate's container when the gate's oracle grade throws", async () => {
    const files = newRun(oneAttemptPlan());
    const runner = bindMountCreatingRunner({
      onGradeOracle: () => {
        throw new Error("docker daemon vanished mid-oracle-grade");
      },
    });

    await assert.rejects(
      () => main(argvFor(files), { runner }),
      /daemon vanished mid-oracle-grade/,
      "a throwing oracle grade is the failure this test needs to observe"
    );

    assert.ok(
      runner.reaps() >= 1,
      `the gate owns a container exactly as the attempt does, so a throwing oracle grade must still reap it; reaps=${String(runner.reaps())}`
    );
  });

  it("reaps the attempt's container when the attempt's own grade throws", async () => {
    const files = newRun(oneAttemptPlan());
    const runner = bindMountCreatingRunner({
      onGrade: () => {
        throw new Error("docker daemon vanished mid-grade");
      },
    });

    await assert.rejects(
      () => main(argvFor(files), { runner }),
      /daemon vanished mid-grade/,
      "the agent path's grader is a different call site and must still propagate"
    );

    assert.ok(
      runner.reaps() >= 2,
      `both the gate and the attempt own a container, so both must reap; reaps=${String(runner.reaps())}`
    );
  });
});

describe("the gate measures an ORACLE-APPLIED workspace, never a pristine one", () => {
  it("passes a task whose oracle passes, where a pristine grade fails", async () => {
    const files = newRun(oneAttemptPlan());
    const runner = pristineFailingRunner();

    const report = await main(argvFor(files), { runner });

    const retained = retainedGate(files, SLOT_KEY);
    assert.equal(
      retained.verdict,
      "OK:oracle-passes-grader",
      `the gate must judge the oracle-applied workspace; a pristine grade reads reward=0 on every task, so gating on it can never return OK. retained=${JSON.stringify(retained)}`
    );
    assert.equal(
      retained.measurement.oracleReward,
      "1",
      "the judged reward must come from the oracle-applied workspace"
    );
    assert.equal(
      retained.measurement.resultLine,
      "7 passed",
      `the oracle-applied grader reports a passing result line; retained=${JSON.stringify(retained)}`
    );
    assert.equal(
      runner.oracleGrades(),
      1,
      "the gate must measure through the oracle, exactly once"
    );
    assert.deepEqual(
      report.gate.passed,
      [SLOT_KEY],
      "the artifact must record the slot as a gate pass"
    );
    assert.deepEqual(
      report.gate.exclusions,
      [],
      "a passing oracle is not an exclusion"
    );
    assert.equal(
      report.stopReason,
      "completed",
      "a gate that passed must let the driver dispatch the slot it gated"
    );
    assert.equal(report.code, 0, "a run that dispatched every slot is exit 0");
  });

  it("fails the gate on a task with no reference solution, and never excludes it", async () => {
    const files = newRun(oneAttemptPlan());
    const taskDir = join(files.root, "dataset/tasks/db-wal-recovery");
    const runner = oracleRefusingRunner(
      () => new OracleNotApplicableError(taskDir)
    );

    const report = await main(argvFor(files), { runner });

    assert.equal(
      report.code,
      1,
      "an unmeasurable task is not a successful run"
    );
    assert.equal(
      report.stopReason,
      "gate-failure",
      "a gate that cannot measure must stop the WHOLE driver, as any other gate failure does"
    );
    assert.equal(
      report.stoppedAt,
      SLOT_KEY,
      "the artifact must name the slot it stopped on"
    );
    assert.deepEqual(
      report.gate.exclusions,
      [],
      "an unmeasurable task is NOT a task exclusion: that would charge the task for the harness"
    );
    assert.deepEqual(
      report.gate.passed,
      [],
      "an unmeasured gate is not a pass"
    );
    assert.equal(
      report.denominator.gateFailures,
      1,
      "the refusal belongs in the gate-failure bucket"
    );
    assert.equal(
      report.denominator.attempted,
      0,
      "no attempt began: the gate refused before dispatch"
    );
    assert.equal(
      runner.dispatchedOutDirs.length,
      0,
      "a refused gate must never reach dispatch"
    );
    assert.equal(
      report.checks.unconditional,
      false,
      "a run carrying a gate failure may not read clean"
    );
    const reason = report.gate.ledgerRefusals[0]?.reason ?? "";
    assert.ok(
      reason.startsWith("gate:"),
      `the reason must land in the gate-failure ledger path, not the exclusion path; got ${reason}`
    );
    assert.match(
      reason,
      /oracle-not-applicable/,
      `the refusal must be classified, not merely rejected; got ${reason}`
    );
    assert.match(
      reason,
      /no solution\/solve\.sh/,
      `the reason must say what was missing; got ${reason}`
    );
  });

  it("fails the gate when the reference solution itself fails", async () => {
    const files = newRun(oneAttemptPlan());
    const solvePath = join(
      files.root,
      "dataset/tasks/db-wal-recovery/solution/solve.sh"
    );
    const runner = oracleRefusingRunner(
      () => new OracleFailedError(solvePath, 3)
    );

    const report = await main(argvFor(files), { runner });

    assert.equal(
      report.code,
      1,
      "a failing reference solution is not a passing run"
    );
    assert.equal(
      report.stopReason,
      "gate-failure",
      "a failed oracle is a harness-unmeasurable gate, so the driver stops"
    );
    assert.deepEqual(
      report.gate.exclusions,
      [],
      "a broken reference solution is not the task's fault to be excluded for"
    );
    assert.equal(
      report.denominator.gateFailures,
      1,
      "the refusal belongs in the gate-failure bucket"
    );
    assert.equal(
      runner.dispatchedOutDirs.length,
      0,
      "a failed oracle must never reach dispatch"
    );
    const reason = report.gate.ledgerRefusals[0]?.reason ?? "";
    assert.match(
      reason,
      /oracle-failed/,
      `the refusal must be classified as a failed solution; got ${reason}`
    );
    assert.match(
      reason,
      /exited 3/,
      `the reason must carry the solution's own exit status; got ${reason}`
    );
  });

  it("refuses rather than falling back to a pristine grade when the runner cannot run the oracle", async () => {
    const files = newRun(oneAttemptPlan());
    // `runnerWithoutOracle().grade()` PASSES. A silent fallback to it would report OK and exit
    // 0, which is the defect this whole change exists to remove.
    const runner = runnerWithoutOracle();

    const report = await main(argvFor(files), { runner });

    assert.equal(
      report.code,
      1,
      "a runner that cannot apply a reference solution can never clear the gate"
    );
    assert.equal(
      report.stopReason,
      "gate-failure",
      "the missing oracle capability is a gate failure, not a pass"
    );
    assert.deepEqual(
      report.gate.passed,
      [],
      "grading a pristine workspace proves nothing, so it must not be reported as a pass"
    );
    assert.deepEqual(
      report.gate.exclusions,
      [],
      "an unmeasurable gate is not a task exclusion"
    );
    const reason = report.gate.ledgerRefusals[0]?.reason ?? "";
    assert.ok(
      reason.startsWith("gate:"),
      `the refusal must land in the gate-failure ledger path; got ${reason}`
    );
    assert.match(
      reason,
      /oracle-unavailable/,
      `the refusal must say the runner cannot run the oracle; got ${reason}`
    );
    assert.match(
      reason,
      /reference solution/,
      `the reason must name what is missing; got ${reason}`
    );
  });

  it("reaps the gate's container on every oracle refusal", async () => {
    const cases: ReadonlyArray<readonly [string, () => Error]> = [
      [
        "OracleNotApplicableError",
        () => new OracleNotApplicableError("/dataset/tasks/db-wal-recovery"),
      ],
      [
        "OracleFailedError",
        () =>
          new OracleFailedError(
            "/dataset/tasks/db-wal-recovery/solution/solve.sh",
            7
          ),
      ],
    ];

    for (const [label, error] of cases) {
      const files = newRun(oneAttemptPlan());
      const runner = oracleRefusingRunner(error);

      const report = await main(argvFor(files), { runner });

      assert.equal(
        report.code,
        1,
        `${label} must be a classified failure exit, not a crash`
      );
      assert.ok(
        runner.reaps() >= 1,
        `the gate owns a container on the ${label} path too, so it must reap it; reaps=${String(runner.reaps())}`
      );
    }
  });

  it("propagates an unrelated gate fault instead of laundering it into an oracle verdict", async () => {
    const files = newRun(oneAttemptPlan());
    const runner = oracleRefusingRunner(
      () => new Error("docker daemon vanished mid-oracle-grade")
    );

    await assert.rejects(
      () => main(argvFor(files), { runner }),
      /daemon vanished mid-oracle-grade/,
      "only the two typed oracle refusals are classified; any other fault keeps propagating"
    );
  });
});

describe("the real attempt path refuses a credential-looking --container-env", () => {
  /** A value-shaped placeholder that must never appear in any message this suite observes. */
  const SECRET = "sk-live-PLACEHOLDER0000notarealkey";

  it("refuses a credential-looking variable name and never echoes its value", () => {
    const files = newRun(AUDITED_PLAN);

    const error = captureRefusal(
      ["--container-env", `OPENAI_API_KEY=${SECRET}`],
      files
    );

    assert.match(
      error.message,
      /OPENAI_API_KEY/,
      `the operator must be told WHICH variable was refused; got: ${error.message}`
    );
    assert.ok(
      !error.message.includes(SECRET),
      `the refusal must name the variable and never its value; got: ${error.message}`
    );
  });

  it("refuses a credential-shaped value hidden under an innocent variable name", () => {
    const files = newRun(AUDITED_PLAN);

    const error = captureRefusal(
      ["--container-env", `HTTPS_PROXY=https://user:${SECRET}@proxy.invalid`],
      files
    );

    assert.match(
      error.message,
      /HTTPS_PROXY/,
      `the operator must be told WHICH variable was refused; got: ${error.message}`
    );
    assert.ok(
      !error.message.includes(SECRET),
      `a smuggled credential must not be echoed back; got: ${error.message}`
    );
  });

  it("refuses a value equal to a live credential in the environment", () => {
    const files = newRun(AUDITED_PLAN);
    const previous = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = SECRET;
    try {
      const error = captureRefusal(
        [
          "--container-env",
          `HTTP_PROXY=http://proxy.invalid:7890?upstream_key=${SECRET}`,
        ],
        files
      );

      assert.match(
        error.message,
        /HTTP_PROXY/,
        `the operator must be told WHICH variable was refused; got: ${error.message}`
      );
      assert.ok(
        !error.message.includes(SECRET),
        `the guard must never quote the secret it detected; got: ${error.message}`
      );
    } finally {
      if (previous === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = previous;
    }
  });

  it("still forwards the proxy variables a real run legitimately needs", () => {
    const files = newRun(AUDITED_PLAN);

    const parsed = parseArgs(
      argvFor(files, [
        "--container-env",
        "HTTP_PROXY=http://proxy.invalid:7890",
        "--container-env",
        "HTTPS_PROXY=http://proxy.invalid:7890",
        "--container-env",
        "NO_PROXY=localhost,127.0.0.1",
      ])
    );

    assert.equal(
      dockerRunnerFor(parsed).version,
      "tb2.1-docker/1",
      "a guard that refuses the proxy the runbook documents would break the only real use"
    );
  });

  it("exits nonzero from the real CLI and prints no secret", () => {
    const files = newRun(AUDITED_PLAN);

    const run = spawnCli(
      argvFor(files, ["--container-env", `OPENAI_API_KEY=${SECRET}`])
    );

    assert.equal(
      run.code,
      1,
      `a credential must fail the run before any docker argv exists; stderr=${run.stderr}`
    );
    assert.match(
      run.stderr,
      /OPENAI_API_KEY/,
      `the operator must be told which variable was refused; stderr=${run.stderr}`
    );
    assert.ok(
      !run.stderr.includes(SECRET) && !run.stdout.includes(SECRET),
      `nothing the CLI printed may contain the secret; stdout=${run.stdout} stderr=${run.stderr}`
    );
  });
});

describe("bind mounts stay parseable when the directory name carries colons", () => {
  it("creates a colon-free alias of the attempt directory before provisioning", async () => {
    const files = newRun(oneAttemptPlan());
    const runner = bindMountCreatingRunner();

    await main(argvFor(files), { runner });

    const attemptDir = runner.dispatchedOutDirs[0];
    assert.ok(
      attemptDir !== undefined,
      `the dispatch must have been reached; got ${JSON.stringify(runner.dispatchedOutDirs)}`
    );
    assert.ok(
      attemptDir.includes(":"),
      `this whole regression is about the colons in a slot key; got ${attemptDir}`
    );
    assert.ok(
      resolveAlias(mountBindSource(attemptDir), attemptDir),
      `the driver must create a docker-parseable alias of ${attemptDir} before mounting it`
    );
  });

  it("mounts a colon-free alias that resolves to the real attempt directory", async () => {
    const files = newRun(AUDITED_PLAN);
    const outDir = join(tempRoot("cli-mount-alias"), SLOT_KEY);
    mkdirSync(outDir, { recursive: true });
    ensureMountAlias(outDir);

    // A REAL driver's spec: the colons are in the slot key, so only `outDir` carries one. The
    // dataset, bundle and node paths are operator-supplied and outside the run root.
    const { exec, calls } = recordingExec();
    await dockerRunnerFor(parseArgs(argvFor(files)), exec).provision({
      identity: identityFor(),
      taskDir: join(files.root, "dataset/tasks/db-wal-recovery"),
      outDir,
      bundlePath: files.bundlePath,
      nodeArchivePath: files.nodeArchivePath,
      settingsPath: files.settingsPath,
    });
    const args = calls.find((line) => line[0] === "run" && line.includes("-d"));
    assert.ok(
      args !== undefined,
      `expected a docker run -d line; got: ${JSON.stringify(calls)}`
    );

    assertNoUnparseableVolume(args);
    assert.ok(
      args.some((arg) => arg === `${mountBindSource(outDir)}:/artifacts`),
      `the /artifacts mount must use the alias; got: ${JSON.stringify(args)}`
    );
    assert.ok(
      resolveAlias(mountBindSource(outDir), outDir),
      `the alias must resolve to the attempt directory ${outDir}`
    );
  });

  it("leaves a colon-free caller's bind sources byte-for-byte unchanged", () => {
    const outDir = join(tempRoot("cli-mount-plain"), "attempt-1");

    assert.equal(
      mountBindSource(outDir),
      outDir,
      "a path docker can already parse must be handed over untouched"
    );
  });
});

describe("oracle refusal classification", () => {
  it("returns null for anything that is not one of the typed oracle refusals", () => {
    assert.equal(
      oracleRefusalDecision(new Error("docker daemon vanished")),
      null,
      "an unrelated fault must keep propagating rather than being laundered into a gate verdict"
    );
    assert.equal(
      oracleRefusalDecision("not even an error"),
      null,
      "only typed refusals classify; a string carries no oracle provenance"
    );
  });

  it("classifies each refusal as a gate failure that excludes nothing", () => {
    const cases: ReadonlyArray<readonly [string, unknown, RegExp]> = [
      [
        "oracle-not-applicable",
        new OracleNotApplicableError("/dataset/tasks/db-wal-recovery"),
        /no solution\/solve\.sh/,
      ],
      [
        "oracle-failed",
        new OracleFailedError(
          "/dataset/tasks/db-wal-recovery/solution/solve.sh",
          3
        ),
        /exited 3/,
      ],
      [
        "oracle-unavailable",
        new OracleGateRefusal(
          "oracle-unavailable",
          "runner fake/1 cannot run the oracle"
        ),
        /cannot run the oracle/,
      ],
    ];

    for (const [kind, error, expected] of cases) {
      const decision = oracleRefusalDecision(error);
      assert.ok(
        decision !== null,
        `${kind} must classify as a gate decision, not propagate past runGate`
      );
      assert.equal(
        decision.kind,
        "reject",
        `${kind} says the harness could not measure, which stops the driver`
      );
      assert.equal(
        decision.excluded,
        false,
        `${kind} must never become a task exclusion`
      );
      assert.equal(
        decision.stopDriver,
        true,
        `${kind} must stop the whole driver`
      );
      assert.equal(
        decision.record,
        null,
        `${kind} has no measurement, so no gate record may be retained`
      );
      assert.equal(
        decision.reasons[0],
        kind,
        `the classification must lead the reason the operator reads`
      );
      assert.match(
        decision.reasons[1] ?? "",
        expected,
        `the reason must carry what actually happened: ${JSON.stringify(decision.reasons)}`
      );
    }
  });
});
