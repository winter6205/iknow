/**
 * The three negative cases, over the signals that decide DETECTED — without Docker.
 *
 * Why this file exists: `smoke-negatives.ts`, `smoke-oracle.ts` and `smoke-options.ts` had no
 * importer anywhere under `tests/`, so the module's headline question — CAN THE HARNESS FAIL? —
 * had zero regression coverage. The only evidence was a manual Docker run transcribed in
 * prose in `docs/guides/eval-runner.md`. A negative case that silently stopped detecting is
 * exactly the regression a smoke exists to catch, and nothing would have caught it in CI.
 *
 * Two of the three cases need no container at all, so they run for real here over real
 * temporary datasets with a fake `ExecFn`: the inventory is the only thing they ask of the
 * daemon. The third deliberately cannot (`missingLogsMountCase` exists to drop the `/logs`
 * bind mount from a REAL `docker run`, and a fake would prove nothing), so its detection
 * predicate and its host-side reads are covered directly.
 *
 * Every predicate is checked in BOTH directions. A `detected` that can only ever be true is
 * the same tautology class as a broken guard: it reports success-shaped evidence for a run
 * that measured nothing.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, it } from "vitest";

import type { ExecFn } from "../../../../scripts/eval/terminal-bench-2.1/docker.ts";
import { sha256File } from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";
import type {
  ProvisionObservation,
  RunnerPort,
} from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";
import {
  corruptedArchiveCase,
  corruptedArchiveDetected,
  missingLogsMountDetected,
  staleFingerprintCase,
  staleFingerprintDetected,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke-negatives.ts";
import {
  retainedVerifierFiles,
  type VerifierListing,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke-tasks.ts";
import type {
  SmokeContext,
  SmokeOptions,
  TaskFacts,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke-types.ts";

const TASK = "db-wal-recovery";
const IMAGE = "alexgshaw/db-wal-recovery:20251031";

const roots: string[] = [];

/** A real dataset root, a real bundle and a real Node archive, so shas are measured. */
function fixtures(): {
  readonly ctx: SmokeContext;
  readonly facts: TaskFacts;
  readonly outRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), "iknow-smoke-neg-"));
  roots.push(root);
  const outRoot = join(root, "out");
  const taskDir = join(root, "dataset", "tasks", TASK);
  mkdirSync(join(taskDir, "tests"), { recursive: true });
  writeFileSync(join(taskDir, "tests", "test.sh"), "#!/bin/sh\nexit 0\n");
  const bundlePath = join(root, "bundle.tgz");
  const nodeArchivePath = join(root, "node-dist.tar.gz");
  writeFileSync(bundlePath, "bundle-bytes");
  writeFileSync(nodeArchivePath, "node-bytes");

  const options: SmokeOptions = {
    datasetRoot: join(root, "dataset"),
    bundlePath,
    nodeArchivePath,
    outRoot,
    tasks: [TASK],
    nodeSha256: null,
    bundleSha256: null,
    glibcxxFloor: "GLIBCXX_3.4.31",
    graderWallSec: 1800,
    graderGraceSec: 600,
    probeEveryImage: false,
  };
  const ctx: SmokeContext = {
    options,
    exec: inventoryExec(),
    runner: refusingPort(),
    ledger: { count: 0 },
    nodeSha: sha256File(nodeArchivePath),
    bundleSha: sha256File(bundlePath),
    settingsPath: join(outRoot, "meta", "smoke-settings.json"),
    toolProbes: new Map<string, string>(),
  };
  return {
    ctx,
    outRoot,
    facts: {
      task: TASK,
      image: IMAGE,
      verifierTimeoutSec: 300,
      graderPresent: true,
      imageLocal: true,
      glibcxxMeasured: "GLIBCXX_3.4.33",
      problems: [],
    },
  };
}

/** The daemon's answer to `docker ps -a`: an empty inventory, which is the honest baseline. */
function inventoryExec(names: ReadonlyArray<string> = []): ExecFn {
  return async (_file, args) => ({
    stdout: args[0] === "ps" ? `${names.join("\n")}\n` : "",
    stderr: "",
    code: 0,
  });
}

function observed(
  overrides: Partial<ProvisionObservation> = {}
): ProvisionObservation {
  return {
    exitCode: 1,
    bootVerified: false,
    logsMountWritable: false,
    glibcxxMeasured: "NOT_REACHED",
    stdout: "",
    ...overrides,
  };
}

/** A port that refuses every call, so a test can only observe what the case asked of it. */
function refusingPort(): RunnerPort {
  const refuse = async (): Promise<never> => {
    throw new Error(
      "this case must not reach a container in a Docker-free test"
    );
  };
  return {
    version: "tb2.1-docker/test",
    provision: refuse,
    dispatch: refuse,
    grade: refuse,
    reap: async () => {},
  };
}

function listing(state: VerifierListing["state"]): VerifierListing {
  return state === "unreadable"
    ? { state, reason: "EACCES" }
    : { state, files: state === "absent" ? [] : ["ctrf.json", "reward.txt"] };
}

afterAll(() => {
  for (const root of roots.splice(0, roots.length))
    rmSync(root, { recursive: true, force: true });
});

describe("reading the retained verifier directory distinguishes absent from unreadable", () => {
  it("reports a real listing when the directory holds files", () => {
    const { outRoot } = fixtures();
    mkdirSync(join(outRoot, "logs", "verifier"), { recursive: true });
    writeFileSync(join(outRoot, "logs", "verifier", "ctrf.json"), "{}");

    const read = retainedVerifierFiles(outRoot);

    assert.equal(
      read.state,
      "listed",
      `a directory that reads fine is ` +
        "`listed`" +
        `; got: ${JSON.stringify(read)}`
    );
    assert.deepEqual(
      read.state === "listed" ? read.files : [],
      ["ctrf.json"],
      "the retained file list is the evidence the report publishes"
    );
  });

  it("reports an empty but present directory as listed, not absent", () => {
    const { outRoot } = fixtures();
    mkdirSync(join(outRoot, "logs", "verifier"), { recursive: true });

    const read = retainedVerifierFiles(outRoot);

    assert.equal(
      read.state,
      "listed",
      "an empty directory and a missing one are different findings; got: " +
        JSON.stringify(read)
    );
  });

  it("reports ENOENT as absent, which is the expected outcome of the negative case", () => {
    const { outRoot } = fixtures();

    const read = retainedVerifierFiles(outRoot);

    assert.equal(
      read.state,
      "absent",
      `nothing was retained, and that is a real measurement; got: ${JSON.stringify(read)}`
    );
  });

  it("never reports an unreadable directory as empty", () => {
    const { outRoot } = fixtures();
    // A regular FILE where `logs` belongs makes readdir fail with ENOTDIR: a real
    // read error that is not ENOENT, and permission-independent.
    mkdirSync(outRoot, { recursive: true });
    writeFileSync(join(outRoot, "logs"), "not a directory");

    const read = retainedVerifierFiles(outRoot);

    assert.equal(
      read.state,
      "unreadable",
      `a read error that is not ENOENT means the directory could not be inspected, and ` +
        `collapsing it to an empty list is what made an unreadable path read as DETECTED; got: ${JSON.stringify(read)}`
    );
    assert.notDeepEqual(
      read,
      { state: "absent", files: [] },
      "an unreadable path must never be published as the same finding as a missing one"
    );
  });
});

describe("the missing-/logs-mount predicate needs all three signals", () => {
  it("detects the fault when nothing was retained and the verdict is invalid", () => {
    assert.equal(
      missingLogsMountDetected(0, listing("absent"), false),
      true,
      "this is the #1212 A4 signature: the verdict died with the container"
    );
  });

  it("does not detect when a verdict survived, so the case cannot pass by accident", () => {
    assert.equal(
      missingLogsMountDetected(6475, listing("listed"), true),
      false,
      "a retained CTRF and a valid verdict mean the mount worked; reporting DETECTED would make this case unfalsifiable"
    );
  });

  it("does not detect a retained CTRF alone, or an invalid verdict alone", () => {
    assert.equal(
      missingLogsMountDetected(6475, listing("absent"), false),
      false,
      "an absent listing beside a retained CTRF is contradictory, and must not read as detected"
    );
    assert.equal(
      missingLogsMountDetected(0, listing("listed"), false),
      false,
      "files surviving without a CTRF is not the A4 signature either"
    );
  });

  it("reports NOT detected, never DETECTED, when the directory could not be read", () => {
    assert.equal(
      missingLogsMountDetected(0, listing("unreadable"), false),
      false,
      "an unreadable verifier directory is a HARNESS fault: reading it as DETECTED would " +
        "publish a success-shaped boolean produced by a silent catch"
    );
  });
});

describe("the stale-identity predicate refuses a record that still claims OK", () => {
  const refuses = {
    problems: ["node archive sha256 a… != pinned b…"],
    gateVerdict: "REJECT:stale-identity",
    before: [],
    after: [],
  };

  it("detects a refusal with no container work", () => {
    assert.equal(staleFingerprintDetected(refuses), true);
  });

  it("does not detect when the instrument check found nothing wrong", () => {
    assert.equal(
      staleFingerprintDetected({ ...refuses, problems: [] }),
      false,
      "nothing refused means nothing was detected"
    );
  });

  it("does not detect when the gate still returned OK", () => {
    assert.equal(
      staleFingerprintDetected({
        ...refuses,
        gateVerdict: "OK:oracle-passes-grader",
      }),
      false,
      "a record that still claims OK is exactly the case that must be rejected, so a passing verdict means it was not"
    );
  });

  it("does not detect when the container inventory moved", () => {
    assert.equal(
      staleFingerprintDetected({
        ...refuses,
        after: ["tb21-db-wal-recovery-1"],
      }),
      false,
      "creating a container before refusing is the other half of the fault, and must fail the case"
    );
  });
});

describe("the corrupted-archive predicate needs a refusal AND a boot failure", () => {
  const refuses = {
    problems: ["node archive sha256 … != pinned …"],
    provision: observed(),
  };

  it("detects a refused archive that also cannot boot", () => {
    assert.equal(corruptedArchiveDetected(refuses), true);
  });

  it("does not detect when the archive boots despite the refusal", () => {
    assert.equal(
      corruptedArchiveDetected({
        ...refuses,
        provision: observed({ exitCode: 0, bootVerified: true }),
      }),
      false,
      "a refusing gate plus a booting archive is a contradiction, not a detection"
    );
  });

  it("does not detect when the gate accepted the archive", () => {
    assert.equal(
      corruptedArchiveDetected({ ...refuses, problems: [] }),
      false,
      "a boot failure alone does not prove the sha gate refused, which is what the case checks"
    );
  });
});

describe("the two Docker-free negative cases really run, over real files", () => {
  it("detects a stale fingerprint without creating a container", async () => {
    const { ctx, facts } = fixtures();

    const result = await staleFingerprintCase(ctx, facts);

    assert.equal(
      result.detected,
      true,
      `a stale record that still claims OK must be rejected; got: ${JSON.stringify(result.observed)}`
    );
    assert.match(
      result.observed.join(" "),
      /REJECT:stale-identity/,
      "the report must show the gate's actual verdict"
    );
    assert.match(
      result.observed.join(" "),
      /unchanged/,
      "the no-container-work claim must be evidence, not an assertion"
    );
    assert.equal(
      ctx.ledger.count,
      0,
      "no dispatch may be attempted by any negative case"
    );
  });

  it("detects a corrupted Node archive, and the refusal is a property of the bytes", async () => {
    const { ctx, facts } = fixtures();
    const port: RunnerPort = {
      ...refusingPort(),
      provision: async () => observed({ exitCode: 1, bootVerified: false }),
    };

    const result = await corruptedArchiveCase({ ...ctx, runner: port }, facts);

    assert.equal(
      result.detected,
      true,
      `a corrupted archive must be refused AND unable to boot; got: ${JSON.stringify(result.observed)}`
    );
    const observed_ = result.observed.join(" ");
    assert.match(
      observed_,
      /verifyInstrument/,
      "the sha gate's verdict must be shown"
    );
    assert.match(
      observed_,
      /forced provision with the corrupt archive: exit=1 boot_verified=false/,
      "the defence-in-depth run must be reported, so the refusal is not only an ordering fact"
    );
    assert.match(
      observed_,
      /temp copy removed: exists=false/,
      "the temp copy must be cleaned up"
    );
  });
});
