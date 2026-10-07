/**
 * Where attempt validity comes from: the retained finalization record, on the REAL path.
 *
 * Why this file exists (defect 1, High): `report.ts`'s `evidenceFor` read the grade's result
 * line from `<attemptDir>/process/grader.log`, and NOTHING on the production path wrote that
 * file — the only writer in the repo was a test fixture. The real runner computes the
 * observation (`docker.ts` derives `resultLine` and `networkFailureMarker` from grader output)
 * and then `runStages` kept only `reward`, `graderExit` and `usage`, so `FinalRecord` had no
 * field for it. The consequence was structural: `classifyValidity`'s `result_line` clause
 * ALWAYS failed, and every real attempt — including a perfect one — was published as
 * `INVALID:result_line` in the same report whose attempt row said `phase: "completed"`.
 *
 * So this file drives the whole production chain — `beginAttempt` → `runAttempt` over the REAL
 * `createDockerRunner` behind a recording `ExecFn` → `summarize` — and asserts the two verdicts
 * agree. A unit test of `classifyValidity` with a hand-built `ValidityInput` would have passed
 * while the real path produced structurally invalid attempts; only the real chain can regress
 * here. No docker is involved: every command goes through the injected `exec`.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import {
  beginAttempt,
  readAttemptRecords,
  runAttempt,
  type FinalRecord,
} from "../../../../scripts/eval/terminal-bench-2.1/attempt.ts";
import {
  createDockerRunner,
  type ExecFn,
} from "../../../../scripts/eval/terminal-bench-2.1/docker.ts";
import { classifyValidity } from "../../../../scripts/eval/terminal-bench-2.1/accounting.ts";
import type { EvalManifest } from "../../../../scripts/eval/terminal-bench-2.1/config.ts";
import type { RunIdentity } from "../../../../scripts/eval/terminal-bench-2.1/identities.ts";
import { summarize } from "../../../../scripts/eval/terminal-bench-2.1/report.ts";
import { sha256File } from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";
import { cleanupTempRoots, tempRoot } from "./fixtures.ts";

afterAll(cleanupTempRoots);

const TASK = "db-wal-recovery";
const SLOT_KEY = `${TASK}:arm40:40`;

/** A real content digest: 64 lowercase hex characters, which is what a registry emits. */
const REAL_IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;

/** What a real terminal-bench-2.1 grader prints: a result line, and no `reward=` on stdout. */
const GRADER_STDOUT =
  "grader_exit=0\n=============== 7 passed, 1 skipped in 12.41s ===============\n";

interface RecordedCall {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}

interface RunWorld {
  readonly runRoot: string;
  readonly ledgerPath: string;
  readonly taskDir: string;
  readonly attemptDir: string;
  readonly bundlePath: string;
  readonly nodeArchivePath: string;
  readonly settingsPath: string;
  readonly identity: RunIdentity;
  readonly manifest: EvalManifest;
}

/**
 * A dataset, a frozen manifest and an identity whose pinned shas are the REAL files on disk,
 * so `verifyInstrument` passes exactly as it does on a real run.
 */
function worldFor(basename: string): RunWorld {
  const root = tempRoot(basename);
  const runRoot = join(root, "run");
  const taskDir = join(root, "dataset", "tasks", TASK);
  mkdirSync(join(taskDir, "tests"), { recursive: true });
  mkdirSync(runRoot, { recursive: true });
  // The dataset's own instruction, at task ROOT — where terminal-bench-2.1 really keeps it.
  writeFileSync(
    join(taskDir, "instruction.md"),
    "Recover the corrupted SQLite WAL.\n"
  );
  writeFileSync(join(taskDir, "tests", "test.sh"), "pytest -q\n");
  const bundlePath = join(root, "iknow-bundle.tgz");
  const nodeArchivePath = join(root, "node.tar.gz");
  const settingsPath = join(root, "settings.json");
  writeFileSync(bundlePath, "bundle bytes");
  writeFileSync(nodeArchivePath, "node dist bytes");
  writeFileSync(
    settingsPath,
    '{ "_note": "issue-1220 fixture; no credentials" }\n'
  );
  const identity: RunIdentity = {
    runId: "run-1220",
    task: TASK,
    image: "alexgshaw/db-wal-recovery:20251031",
    imageDigest: REAL_IMAGE_DIGEST,
    datasetCommit: "7131e4375048a0e408a8fb404b5f499d726b695b",
    bundleSha256: sha256File(bundlePath),
    nodeArchiveSha256: sha256File(nodeArchivePath),
    runnerVersion: "tb2.1-attempt/1",
    outputLayout: "trace/ logs/ process/ meta/",
  };
  return {
    runRoot,
    ledgerPath: join(runRoot, "ledger.jsonl"),
    taskDir,
    attemptDir: join(runRoot, SLOT_KEY),
    bundlePath,
    nodeArchivePath,
    settingsPath,
    identity,
    manifest: {
      runId: identity.runId,
      datasetCommit: identity.datasetCommit,
      bundleSha256: identity.bundleSha256,
      nodeArchiveSha256: identity.nodeArchiveSha256,
      runnerVersion: identity.runnerVersion,
      outputLayout: identity.outputLayout,
      frozenBeforeAnyOutcome: true,
      slots: [
        {
          task: TASK,
          image: identity.image,
          imageDigest: identity.imageDigest,
          maxTurns: 40,
          arm: "arm40",
        },
      ],
    },
  };
}

/**
 * A recording `ExecFn` that answers each phase by the marker its real script carries.
 *
 * `provision` must report a booted agent (`iknow-native-ok`) or `runStages` refuses before
 * dispatching, and the grader line must carry the result line the validity rule reads.
 */
function recordingExec(calls: RecordedCall[]): ExecFn {
  const table: ReadonlyArray<[string, string]> = [
    // The provisioning probe's own markers: a booted agent and a writable /logs.
    ["logs-mount-writable", "logs-mount-writable\nv20.11.0\niknow-native-ok\n"],
    ["grader_exit=", GRADER_STDOUT],
    // The dispatch envelope the observation scrapes the model and stop reason from.
    ["cli.js ask", "model=deepseek/deepseek-chat\nreason=stop\n"],
  ];
  return async (file, args) => {
    calls.push({ file, args: [...args] });
    const script = args.find((arg) => arg.includes(";")) ?? "";
    const hit = table.find(([needle]) => script.includes(needle));
    return { stdout: hit?.[1] ?? "", stderr: "", code: 0 };
  };
}

/** Provision, dispatch and grade one real attempt over `runner`, retaining the host verdict. */
async function runRealAttempt(world: RunWorld): Promise<FinalRecord> {
  const calls: RecordedCall[] = [];
  const runner = createDockerRunner(recordingExec(calls), 1_000);
  const handle = beginAttempt({
    runRoot: world.runRoot,
    slotsDir: join(world.runRoot, "slots"),
    slotKey: SLOT_KEY,
    task: TASK,
    arm: "arm40",
    maxTurns: 40,
    identity: world.identity,
    ledgerPath: world.ledgerPath,
    bundlePath: world.bundlePath,
    settingsPath: world.settingsPath,
    startedAtEpochMs: 1_750_000_000_000,
    pid: 4242,
  });
  // What the grader's bind mount leaves on the HOST when the attempt succeeds.
  mkdirSync(join(handle.dir, "logs/verifier"), { recursive: true });
  writeFileSync(join(handle.dir, "logs/verifier/reward.txt"), "1\n");
  writeFileSync(join(handle.dir, "logs/verifier/ctrf.json"), "x".repeat(2878));

  const result = await runAttempt(handle, world.ledgerPath, {
    runner,
    provisionSpec: {
      identity: world.identity,
      taskDir: world.taskDir,
      outDir: handle.dir,
      bundlePath: world.bundlePath,
      nodeArchivePath: world.nodeArchivePath,
      settingsPath: world.settingsPath,
    },
    maxTurns: 40,
    agentWallSec: 2_700,
    graderGraceSec: 600,
    declaredVerifierTimeoutSec: 300,
    readUsage: () => null,
  });

  assert.equal(
    result.status,
    "completed",
    "a real passing attempt must settle as completed; the chain under test is the real one"
  );
  const final = readAttemptRecords(handle.dir).find(
    (record): record is FinalRecord => record.recordType === "attempt-finalized"
  );
  assert.ok(
    final !== undefined,
    "the attempt must retain a finalization record"
  );
  return final;
}

describe("a genuinely successful real attempt classifies VALID", () => {
  it("counts one valid attempt, not INVALID:result_line", async () => {
    const world = worldFor("validity-real-valid");
    await runRealAttempt(world);

    const { denominator } = summarize(world.ledgerPath, {
      manifest: world.manifest,
      params: { runRoot: world.runRoot },
    });

    assert.deepEqual(
      {
        attempted: denominator.attempted,
        valid: denominator.valid,
        invalid: denominator.invalid,
      },
      { attempted: 1, valid: 1, invalid: 0 },
      "the runner computed a real result line and retained a real CTRF, so the three-clause " +
        "evidence rule must pass; INVALID:result_line here means the observation the runner " +
        "already computed was never persisted anywhere the report reads"
    );
  });

  it("retains the grade observation the runner computed on the finalization record", async () => {
    const world = worldFor("validity-record-fields");
    const final = await runRealAttempt(world);

    assert.equal(
      final.resultLine,
      "7 passed",
      `the grader's result line is computed at grade time and must survive into the record; got: ${JSON.stringify(final.resultLine)}`
    );
    assert.equal(
      final.networkFailureMarker,
      false,
      "the absence of a network failure marker is a measured fact, not an omission"
    );
    assert.deepEqual(
      classifyValidity({
        ctrfBytes: 2878,
        resultLine: final.resultLine ?? "",
        networkFailureMarker: final.networkFailureMarker ?? false,
      }).label,
      "VALID",
      "the retained fields alone must satisfy the evidence rule the report applies"
    );
  });

  it("publishes one verdict for one attempt: the row and the denominator agree", async () => {
    const world = worldFor("validity-two-verdicts");
    const final = await runRealAttempt(world);
    const { denominator } = summarize(world.ledgerPath, {
      manifest: world.manifest,
      params: { runRoot: world.runRoot },
    });

    assert.equal(
      final.status,
      "completed",
      "the attempt row says the attempt completed"
    );
    assert.equal(
      denominator.invalid,
      0,
      "so the denominator must not also report it invalid: two verdicts for one attempt in one " +
        "report is the contradiction this defect produced"
    );
  });
});
