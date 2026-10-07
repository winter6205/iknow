/**
 * The runner seam: one mount definition shared by preflight and attempt, instrument
 * integrity checked before spend.
 *
 * Why this matters (issue 1219 requirement 1): `preflight.sh` and `run-attempt.sh` were two
 * shell scripts that both mounted `/logs` but were maintained separately, and
 * `run-attempt.sh` originally OMITTED the `/logs` bind mount. The grader then ran, wrote
 * its verdict to container-local `/logs`, and teardown destroyed it — every attempt was
 * recorded `INVALID:ctrf` despite a real result line in `grader.log`, and no preflight
 * could have caught it because preflight used a different wiring path.
 *
 * The fix is structural: there is exactly ONE mount list, and the preflight plan is
 * asserted here to be the same list, not a parallel implementation that can drift.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import {
  mountArgs,
  retainedCtrfBytes,
} from "../../../../scripts/eval/terminal-bench-2.1/docker.ts";
import {
  preflightMounts,
  sha256File,
  sharedMounts,
  verifyInstrument,
  type ProvisionSpec,
  type RunnerPort,
} from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";
import { cleanupTempRoots, identityFor, tempRoot } from "./fixtures.ts";

afterAll(cleanupTempRoots);

const BUNDLE_BODY = "bundle bytes";
const NODE_BODY = "node dist bytes";

function specWith(root: string): ProvisionSpec {
  const bundlePath = join(root, "bundle.tgz");
  const nodeArchivePath = join(root, "node.tar.gz");
  const settingsPath = join(root, "settings.json");
  writeFileSync(bundlePath, BUNDLE_BODY);
  writeFileSync(nodeArchivePath, NODE_BODY);
  writeFileSync(
    settingsPath,
    JSON.stringify({ llm: { apiKey: "must-never-be-echoed" } })
  );
  const outDir = join(root, "attempt-1");
  mkdirSync(outDir, { recursive: true });
  return {
    identity: identityFor({
      bundleSha256: createHash("sha256").update(BUNDLE_BODY).digest("hex"),
      nodeArchiveSha256: createHash("sha256").update(NODE_BODY).digest("hex"),
    }),
    taskDir: join(root, "dataset/tasks/db-wal-recovery"),
    outDir,
    bundlePath,
    nodeArchivePath,
    settingsPath,
  };
}

describe("one wiring definition for preflight and attempt", () => {
  it("gives the preflight plan the SAME mounts as the attempt plan", () => {
    const spec = specWith(tempRoot("runner-same-wiring"));

    assert.deepEqual(
      preflightMounts(spec),
      sharedMounts(spec),
      "the gate must probe the SAME wiring the attempt uses, not a parallel implementation"
    );
  });

  it("mounts /logs separately and writable in both plans", () => {
    const spec = specWith(tempRoot("runner-logs-mount"));
    const logsIn = (mounts: ReturnType<typeof sharedMounts>) =>
      mounts.find((mount) => mount.containerPath === "/logs");

    for (const mounts of [sharedMounts(spec), preflightMounts(spec)]) {
      const logs = logsIn(mounts);
      assert.ok(
        logs !== undefined,
        "the /logs mount is load-bearing and must be present"
      );
      assert.equal(
        logs.readOnly,
        false,
        "/logs must be writable or the grader's verdict is destroyed"
      );
      assert.equal(
        logs.hostPath,
        join(spec.outDir, "logs"),
        "the /logs mount must be the HOST directory the verifier writes to"
      );
    }
  });

  it("mounts the bundle and node archive read-only in both plans", () => {
    const spec = specWith(tempRoot("runner-ro-mounts"));

    for (const mounts of [sharedMounts(spec), preflightMounts(spec)]) {
      const bundle = mounts.find(
        (mount) => mount.containerPath === "/opt/iknow-bundle.tgz"
      );
      const node = mounts.find(
        (mount) => mount.containerPath === "/opt/node-dist.tar.gz"
      );
      assert.equal(
        bundle?.readOnly,
        true,
        "the bundle must be mounted read-only"
      );
      assert.equal(
        node?.readOnly,
        true,
        "the node archive must be mounted read-only"
      );
    }
  });

  it("mounts the task tests read-only so the dataset is never written back", () => {
    const spec = specWith(tempRoot("runner-tests-ro"));

    const tests = sharedMounts(spec).find(
      (mount) => mount.containerPath === "/tests"
    );

    assert.equal(
      tests?.readOnly,
      true,
      "the dataset tests must be mounted read-only"
    );
  });

  it("renders the mount list as docker -v arguments including the read-only suffix", () => {
    const spec = specWith(tempRoot("runner-mount-args"));

    const args = mountArgs(sharedMounts(spec));

    assert.ok(
      args.includes(`${join(spec.outDir, "logs")}:/logs`),
      `expected a writable /logs mount; got: ${JSON.stringify(args)}`
    );
    assert.ok(
      args.some((arg) => arg.endsWith(":/tests:ro")),
      `expected a read-only /tests mount; got: ${JSON.stringify(args)}`
    );
  });
});

describe("instrument integrity is verified before any dispatch", () => {
  it("accepts a node archive and bundle matching the pinned shas", () => {
    const spec = specWith(tempRoot("runner-integrity-ok"));

    assert.deepEqual(
      verifyInstrument(spec.identity, spec.nodeArchivePath, spec.bundlePath),
      [],
      "matching instruments must pass the pre-spend check"
    );
  });

  it("refuses dispatch when the node archive sha does not match the pin", () => {
    const spec = specWith(tempRoot("runner-integrity-node"));
    writeFileSync(spec.nodeArchivePath, "tampered node bytes");

    const problems = verifyInstrument(
      spec.identity,
      spec.nodeArchivePath,
      spec.bundlePath
    );

    assert.equal(
      problems.length,
      1,
      `expected exactly one problem; got: ${JSON.stringify(problems)}`
    );
    assert.ok(
      problems[0]?.includes("node archive sha256"),
      `the refusal must name the node archive; got: ${JSON.stringify(problems)}`
    );
  });

  it("refuses dispatch when the bundle sha does not match the pin", () => {
    const spec = specWith(tempRoot("runner-integrity-bundle"));
    writeFileSync(spec.bundlePath, "tampered bundle bytes");

    const problems = verifyInstrument(
      spec.identity,
      spec.nodeArchivePath,
      spec.bundlePath
    );

    assert.ok(
      problems.some((problem) => problem.includes("bundle sha256")),
      `the refusal must name the bundle; got: ${JSON.stringify(problems)}`
    );
  });

  it("hashes the archive bytes rather than trusting the file name", () => {
    const root = tempRoot("runner-sha");
    const path = join(root, "node.tar.gz");
    writeFileSync(path, NODE_BODY);

    assert.equal(
      sha256File(path),
      createHash("sha256").update(NODE_BODY).digest("hex"),
      "the digest must be recomputed from the bytes"
    );
  });
});

describe("verifier output survival on the host", () => {
  it("reads the retained CTRF size from the host directory", () => {
    const root = tempRoot("runner-ctrf");
    const dir = join(root, "attempt-1/logs/verifier");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ctrf.json"), "x".repeat(2878));

    assert.equal(
      retainedCtrfBytes(join(root, "attempt-1")),
      2878,
      "the retained CTRF must be measurable"
    );
  });

  it("reports zero bytes when the grader's CTRF never reached the host", () => {
    const root = tempRoot("runner-ctrf-missing");
    mkdirSync(join(root, "attempt-1/logs/verifier"), { recursive: true });

    assert.equal(
      retainedCtrfBytes(join(root, "attempt-1")),
      0,
      "a destroyed container-local verdict must read as 0 retained bytes, not as a pass"
    );
  });
});

/**
 * The oracle entry point is OPTIONAL on the port, and the obligation it creates is the gate's,
 * not the port's. These two tests are the executable form of that decision.
 */
describe("the port's oracle entry point", () => {
  const base = (): RunnerPort => ({
    version: "fake/1",
    provision: async () => ({
      exitCode: 0,
      bootVerified: true,
      logsMountWritable: true,
      glibcxxMeasured: "GLIBCXX_3.4.31",
      stdout: "",
    }),
    dispatch: async () => ({ exitCode: 0, model: "m", stopReason: "done" }),
    grade: async () => ({
      exitCode: 0,
      reward: "1",
      ctrfBytes: 256,
      resultLine: "7 passed",
      networkFailureMarker: false,
    }),
    reap: async () => undefined,
  });

  it("accepts a runner that cannot apply a reference solution", () => {
    const port: RunnerPort = base();

    assert.equal(
      port.gradeOracle,
      undefined,
      "the method is optional: two port implementations outside this module's ownership " +
        "(smoke-exec.sealedPort and the attempt-suite fakes) construct the literal without it"
    );
    assert.equal(
      typeof port.grade,
      "function",
      "the fallback the gate must NOT use quietly still exists on the port; the refusal is " +
        "what keeps it unreachable from the gate"
    );
  });

  it("accepts a runner that can, and types its result as an oracle-applied grade", async () => {
    const port: RunnerPort = {
      ...base(),
      gradeOracle: async () => ({
        exitCode: 0,
        reward: "1",
        ctrfBytes: 256,
        resultLine: "7 passed",
        networkFailureMarker: false,
        oracle: {
          state: "applied",
          solvePath: "/task/solution/solve.sh",
          exitCode: 0,
          stdout: "oracle_exit=0",
        },
      }),
    };

    const grade = await port.gradeOracle?.({} as ProvisionSpec, 60);

    assert.equal(
      grade?.oracle.state,
      "applied",
      "`applied` is the only state the port admits: a solution that could not be applied is a " +
        "thrown refusal, never an observation with an invented exit code"
    );
    assert.equal(
      grade?.reward,
      "1",
      "the grade is the one the oracle's workspace produced"
    );
  });
});
