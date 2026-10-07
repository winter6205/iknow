/**
 * The grader wall must be the TASK's declared timeout plus the grace, not a constant.
 *
 * Why this matters (issue 1220): `cli.ts` held `DECLARED_VERIFIER_TIMEOUT_SEC = 1800` and
 * handed it to both the preflight gate's oracle grade and the attempt. Every task in the
 * real dataset declares its own limit — `/home/winner/eval-1189/dataset/tasks/
 * adaptive-rejection-sampler/task.toml` carries
 *
 *     [verifier]
 *     timeout_sec = 900.0
 *     [agent]
 *     timeout_sec = 900.0
 *     [environment]
 *     build_timeout_sec = 600.0
 *
 * so a task declaring 900s was graded under a wall twice as long as the task itself claims,
 * and a task declaring more than 1800s was killed early. The declared value is seconds, as
 * a float, and the grader wall adds `graderGraceSec` on top of it.
 *
 * The repo has no TOML parser dependency and no TOML reader anywhere in `src/` or
 * `scripts/`, so this reads exactly one key out of exactly one section. It FAILS CLOSED:
 * an unreadable, malformed or absent declaration means "no declared limit", and the caller
 * falls back to the global constant rather than inventing a number. It is deliberately not a
 * general TOML parser and no dependency is added.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import { declaredVerifierTimeoutSec } from "../../../../scripts/eval/terminal-bench-2.1/config.ts";
import {
  wireDeps,
  type DriverWiring,
} from "../../../../scripts/eval/terminal-bench-2.1/cli.ts";
import type {
  ConfigParams,
  ManifestSlot,
} from "../../../../scripts/eval/terminal-bench-2.1/config.ts";
import type { RunnerPort } from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";
import { cleanupTempRoots, identityFor, tempRoot } from "./fixtures.ts";

afterAll(cleanupTempRoots);

const GRADER_GRACE_SEC = 600;

/** The real task.toml's shape, copied verbatim where it matters. */
const REAL_TASK_TOML = `schema_version = "1.1"
artifacts = []

[task]
name = "terminal-bench/adaptive-rejection-sampler"
description = "Evaluates the ability to implement an adaptive rejection sampler in R."
keywords = ["applied-statistics", "adaptive-rejection-sampling"]
[[task.authors]]
name = "jvpoulos"
email = "poulos@berkeley.edu"

[verifier]
timeout_sec = 900.0

[agent]
timeout_sec = 900.0

[environment]
build_timeout_sec = 600.0
docker_image = "alexgshaw/adaptive-rejection-sampler:20251031"
cpus = 1
memory_mb = 2048
allow_internet = true
mcp_servers = []

[verifier.env]

[environment.env]

[solution.env]
`;

function taskDirWith(body: string | null): string {
  const root = tempRoot("declared-timeout");
  const taskDir = join(root, "adaptive-rejection-sampler");
  mkdirSync(taskDir, { recursive: true });
  if (body !== null) writeFileSync(join(taskDir, "task.toml"), body);
  return taskDir;
}

function params(root: string): ConfigParams {
  return {
    datasetRoot: join(root, "dataset"),
    bundlePath: join(root, "bundle.tgz"),
    nodeArchivePath: join(root, "node.tar.gz"),
    settingsPath: join(root, "settings.json"),
    runRoot: join(root, "runs"),
    agentWallSec: 2700,
    graderGraceSec: GRADER_GRACE_SEC,
    bundleGlibcxxFloor: "GLIBCXX_3.4.31",
    tokenCeiling: { input: 4_000_000, output: 3_000_000 },
  };
}

function manifest() {
  return {
    runId: "run-1220",
    datasetCommit: "7131e437",
    bundleSha256: "bundle-sha",
    nodeArchiveSha256: "node-sha",
    runnerVersion: "tb2.1-attempt/1",
    outputLayout: "trace/ logs/ process/ meta/",
    frozenBeforeAnyOutcome: true,
    slots: [
      {
        task: "adaptive-rejection-sampler",
        image: "alexgshaw/adaptive-rejection-sampler:20251031",
        imageDigest: "sha256:aaa111",
        maxTurns: 40,
        arm: "arm40",
      },
    ],
  } as unknown as Parameters<typeof wireDeps>[0]["config"]["manifest"];
}

/** A runner that records the wall every grade was given. */
function wallRecordingRunner(walls: number[]): RunnerPort {
  return {
    version: "fake/1",
    provision: async () => ({
      exitCode: 0,
      bootVerified: true,
      logsMountWritable: true,
      glibcxxMeasured: "GLIBCXX_3.4.31",
      stdout: "",
    }),
    dispatch: async () => ({ exitCode: 0, model: "m", stopReason: "done" }),
    grade: async (_spec, timeoutSec) => {
      walls.push(timeoutSec);
      return {
        exitCode: 0,
        reward: "1",
        ctrfBytes: 2878,
        resultLine: "7 passed",
        networkFailureMarker: false,
      };
    },
    gradeOracle: async (_spec, timeoutSec) => {
      walls.push(timeoutSec);
      return {
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
      };
    },
    reap: async () => undefined,
  };
}

describe("the declared verifier timeout is read from the task's own task.toml", () => {
  it("reads the real dataset's 900.0s verifier timeout", () => {
    assert.equal(
      declaredVerifierTimeoutSec(taskDirWith(REAL_TASK_TOML)),
      900,
      "the declared [verifier] timeout_sec is the grader's budget, in seconds"
    );
  });

  it("reads an integer declaration too", () => {
    assert.equal(
      declaredVerifierTimeoutSec(
        taskDirWith("[verifier]\ntimeout_sec = 1200\n")
      ),
      1200,
      "seconds need not be written as a float"
    );
  });

  it("does not take the agent's or the environment's timeout for the verifier's", () => {
    assert.equal(
      declaredVerifierTimeoutSec(
        taskDirWith(
          "[agent]\ntimeout_sec = 900.0\n\n[environment]\nbuild_timeout_sec = 600.0\n"
        )
      ),
      null,
      "the agent and build limits are different budgets and must not stand in"
    );
  });

  it("stops at the next section header", () => {
    // `[verifier.env]` is a sub-table of verifier; a key under it is not verifier's timeout.
    assert.equal(
      declaredVerifierTimeoutSec(
        taskDirWith("[verifier.env]\ntimeout_sec = 42.0\n")
      ),
      null,
      "a key in a sub-table is not the verifier's timeout"
    );
  });

  it("is case- and whitespace-tolerant on the section and key", () => {
    assert.equal(
      declaredVerifierTimeoutSec(
        taskDirWith("  [ verifier ]  \n  timeout_sec   =   600.0   # seconds\n")
      ),
      600,
      "a hand-edited declaration with spaces and a trailing comment still reads"
    );
  });
});

describe("the declared-timeout reader fails closed", () => {
  const MALFORMED: ReadonlyArray<readonly [string, string]> = [
    ["no such file", ""],
    ["non-numeric value", '[verifier]\ntimeout_sec = "nine hundred"\n'],
    ["zero", "[verifier]\ntimeout_sec = 0\n"],
    ["negative", "[verifier]\ntimeout_sec = -900.0\n"],
    ["not a number at all", "[verifier]\ntimeout_sec = soon\n"],
    ["no timeout key at all", "[verifier]\nmax_retries = 2\n"],
  ];

  for (const [label, body] of MALFORMED) {
    it(`reports no declared limit for ${label}`, () => {
      const taskDir =
        label === "no such file" ? taskDirWith(null) : taskDirWith(body);

      assert.equal(
        declaredVerifierTimeoutSec(taskDir),
        null,
        "an unreadable or malformed declaration means no declared limit, not a guess"
      );
    });
  }
});

describe("the gate grades the oracle under the task's declared timeout plus the grace", () => {
  it("passes 900 + grace instead of the hardcoded 1800 + grace", async () => {
    const root = tempRoot("declared-timeout-gate");
    const datasetTasks = join(root, "dataset", "tasks");
    const taskDir = join(datasetTasks, "adaptive-rejection-sampler");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "task.toml"), REAL_TASK_TOML);
    const walls: number[] = [];
    const wiring: DriverWiring = {
      config: {
        manifest: manifest(),
        identityFor: (slot: ManifestSlot) => identityFor({ task: slot.task }),
      },
      runner: wallRecordingRunner(walls),
      ledgerPath: join(root, "ledger.jsonl"),
      params: params(root),
    };

    const decision = await wireDeps(wiring).gate(wireDeps(wiring).slots[0]!);

    assert.equal(
      decision.kind,
      "pass",
      `the gate must pass: ${JSON.stringify(decision)}`
    );
    assert.deepEqual(
      walls,
      [900 + GRADER_GRACE_SEC],
      `the oracle must be graded under the declared timeout plus grace; got: ${JSON.stringify(walls)}`
    );
  });

  it("falls back to the global constant when the task declares nothing", async () => {
    const root = tempRoot("declared-timeout-fallback");
    const taskDir = join(
      root,
      "dataset",
      "tasks",
      "adaptive-rejection-sampler"
    );
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "task.toml"), "[verifier]\nmax_retries = 2\n");
    const walls: number[] = [];
    const wiring: DriverWiring = {
      config: {
        manifest: manifest(),
        identityFor: (slot: ManifestSlot) => identityFor({ task: slot.task }),
      },
      runner: wallRecordingRunner(walls),
      ledgerPath: join(root, "ledger.jsonl"),
      params: params(root),
    };
    const deps = wireDeps(wiring);

    await deps.gate(deps.slots[0]!);

    assert.deepEqual(
      walls,
      [1800 + GRADER_GRACE_SEC],
      `an undeclared limit falls back to the global constant; got: ${JSON.stringify(walls)}`
    );
  });
});
