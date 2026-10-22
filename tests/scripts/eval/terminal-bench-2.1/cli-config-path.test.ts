/**
 * The CLI's own config path, with model dispatch SEALED (issue 1219 / #1221 audit).
 *
 * Why this file exists: the #1221 headless audit reproduced D1 through a config-only call
 * to `resolveConfig` and noted that "Docker smoke alone is insufficient because it bypasses
 * `resolveConfig`". This file closes the remaining gap from the other side — it drives the
 * REAL `cli.ts` entry (`main`, the exported function the operator's argv reaches) over REAL
 * files in a REAL temp directory, and refuses to let a model be dispatched.
 *
 * The contract proved here is narrow and load-bearing: `main` REACHES config resolution and
 * PROCEEDS PAST IT, and the first thing it reaches after that is the dispatch seam. A config
 * refusal must not be observable at all for an operator who named real artifacts, and a
 * passing config must not be able to spend money.
 *
 * Settings are represented by a real credential-free temp file and are hashed only; their
 * contents never enter an assertion, a snapshot or an artifact.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import {
  LEDGER_FILE,
  main,
} from "../../../../scripts/eval/terminal-bench-2.1/cli.ts";
import {
  sha256File,
  type DispatchOptions,
  type ProvisionSpec,
  type RunnerPort,
} from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";

/**
 * Thrown instead of dispatching. A sentinel rather than a return value, because the point
 * is that NOTHING about a model call is allowed to happen: the assertion is on the
 * exception's identity, so a runner that quietly dispatched could not satisfy it.
 */
class DispatchSealedError extends Error {
  constructor(readonly spec: ProvisionSpec) {
    super("model dispatch is sealed in this test; no model may be dispatched");
    this.name = "DispatchSealedError";
  }
}

/** Credential-free stand-in for the host settings file. Never a real `~/.iknow` path. */
const SETTINGS_BODY =
  '{"_note":"issue-1219 cli config path test; no credentials"}\n';

/** The attempt directory name `driverSlotsOf` builds: `task:arm:maxTurns`. */
const SLOT_KEY = "db-wal-recovery:arm40:40";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface CliWorld {
  readonly root: string;
  readonly manifestPath: string;
  readonly runRoot: string;
  readonly taskDir: string;
  readonly bundlePath: string;
  readonly nodeArchivePath: string;
  readonly settingsPath: string;
  readonly argv: string[];
}

/**
 * Build the on-disk world a headless run reads: a real manifest whose pinned shas are the
 * REAL shas of the temp artifacts, a real dataset task tree, and a run root that does NOT
 * exist yet — `main` creates it only AFTER `resolveConfig` returns, which is what makes its
 * presence evidence that config resolution was passed.
 */
function realWorld(): CliWorld {
  const root = mkdtempSync(join(tmpdir(), "iknow-cli-config-path-"));
  roots.push(root);
  const taskDir = join(root, "dataset/tasks/db-wal-recovery");
  mkdirSync(join(taskDir, "tests"), { recursive: true });
  mkdirSync(join(taskDir, "solution"), { recursive: true });
  writeFileSync(join(taskDir, "tests/test.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(taskDir, "solution/solve.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(
    join(taskDir, "task.toml"),
    'title = "db-wal-recovery"\n[verifier]\ntimeout_sec = 900.0\n'
  );

  const bundlePath = join(root, "bundle.tgz");
  const nodeArchivePath = join(root, "node.tar.gz");
  const settingsPath = join(root, "settings.json");
  writeFileSync(
    bundlePath,
    "bundle bytes for the issue-1219 cli config path test\n"
  );
  writeFileSync(nodeArchivePath, "node archive bytes for the same test\n");
  writeFileSync(settingsPath, SETTINGS_BODY);

  const manifestPath = join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        runId: "run-1219-cli-config-path",
        datasetCommit: "7131e4375048a0e408a8fb404b5f499d726b695b",
        bundleSha256: sha256File(bundlePath),
        nodeArchiveSha256: sha256File(nodeArchivePath),
        runnerVersion: "tb2.1-attempt/1",
        outputLayout: "tb2.1-slot-v1/<task>:<arm>:<maxTurns>",
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
      },
      null,
      2
    )
  );

  const runRoot = join(root, "runs/run-1219");
  return {
    root,
    manifestPath,
    runRoot,
    taskDir,
    bundlePath,
    nodeArchivePath,
    settingsPath,
    argv: [
      "--manifest",
      manifestPath,
      "--dataset-root",
      join(root, "dataset"),
      "--bundle",
      bundlePath,
      "--node-archive",
      nodeArchivePath,
      "--settings",
      settingsPath,
      "--run-root",
      runRoot,
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
    ],
  };
}

const GATE_GRADE = {
  exitCode: 0,
  reward: "1",
  ctrfBytes: 256,
  resultLine: "7 passed",
  networkFailureMarker: false,
} as const;

interface SealedDispatch {
  readonly spec: ProvisionSpec;
  readonly options: DispatchOptions;
}

/**
 * Every attempt to dispatch, recorded. An ARRAY rather than a single `let` so the compiler
 * keeps its type after the async runner closure writes it, and so "dispatched zero times"
 * is distinguishable from "never looked".
 */
const sealedDispatches: SealedDispatch[] = [];

/**
 * A runner with no Docker and NO MODEL behind it. The preflight gate can be measured through
 * it (so the CLI reaches its first post-config step in real order), while `dispatch` records
 * the REAL spec it was handed and throws the sentinel.
 */
function sealedRunner(): RunnerPort {
  return {
    version: "sealed/1",
    provision: async () => ({
      exitCode: 0,
      bootVerified: true,
      logsMountWritable: true,
      glibcxxMeasured: "GLIBCXX_3.4.31",
      stdout: "logs-mount-writable",
    }),
    dispatch: async (spec: ProvisionSpec, options: DispatchOptions) => {
      // Recorded before throwing: a sealed dispatch that quietly succeeded would be
      // indistinguishable from a dispatched one, which is the whole point of sealing it.
      sealedDispatches.push({ spec, options });
      throw new DispatchSealedError(spec);
    },
    grade: async () => GATE_GRADE,
    gradeOracle: async () => ({
      ...GATE_GRADE,
      oracle: {
        state: "applied",
        solvePath: join("solution", "solve.sh"),
        exitCode: 0,
        stdout: "oracle_exit=0",
      },
    }),
    reap: async () => undefined,
  };
}

describe("the CLI reaches config resolution and proceeds past it", () => {
  it("passes config resolution and gets as far as the sealed dispatch", async () => {
    const world = realWorld();
    sealedDispatches.length = 0;

    // The run root does not exist yet: `main` creates it only after `resolveConfig` returns.
    assert.equal(
      existsSync(world.runRoot),
      false,
      "fixture precondition: the run root must not exist before the CLI runs"
    );

    const reached = await main(world.argv, { runner: sealedRunner() }).then(
      () => "report" as const,
      (error: unknown) => error
    );

    assert.ok(
      reached instanceof DispatchSealedError,
      `expected the CLI to pass resolveConfig and reach the sealed dispatch; got: ` +
        `${String(reached)}`
    );
    assert.equal(
      sealedDispatches.length,
      1,
      "the sealed dispatch must have been reached, so no model could have been dispatched"
    );
    const sealed = sealedDispatches[0]!;
    assert.equal(
      sealed.spec.taskDir,
      world.taskDir,
      "the spec reaching dispatch must carry the operator's real dataset root"
    );
    assert.equal(
      sealed.spec.settingsPath,
      world.settingsPath,
      "the spec reaching dispatch must carry the operator's real settings path"
    );
    assert.equal(
      existsSync(world.runRoot),
      true,
      "the run root is created after resolveConfig, so it existing proves config passed"
    );
    assert.equal(
      existsSync(join(world.runRoot, LEDGER_FILE)),
      true,
      "the ledger is written by the real attempt path, so the run really started"
    );
  });

  it("still refuses a config whose path is an unresolved template, before any dispatch", async () => {
    const world = realWorld();

    // Replace one mandatory flag with a template. Nothing on disk changes: this asserts the
    // CLI's OWN arg surface carries the refusal, and that no run root is created for it.
    const argv = world.argv.flatMap((token) =>
      token === world.bundlePath ? ["${BUNDLE_PATH}"] : [token]
    );

    await assert.rejects(
      main(argv, { runner: sealedRunner() }),
      /bundlePath is still a placeholder/,
      "the CLI must refuse an unresolved template in a mandatory flag"
    );
    assert.equal(
      existsSync(world.runRoot),
      false,
      "a refused config must not create the run root it would have written into"
    );
  });

  it("still refuses a blank mandatory flag at the argument boundary", async () => {
    const world = realWorld();
    const argv = world.argv.flatMap((token) =>
      token === world.settingsPath ? ["   "] : [token]
    );

    await assert.rejects(
      main(argv, { runner: sealedRunner() }),
      /missing required flag --settings/,
      "the CLI must refuse a whitespace-only mandatory flag before resolving config"
    );
  });

  it("never lets settings-file content into a retained record, only its hash", async () => {
    const world = realWorld();

    await main(world.argv, { runner: sealedRunner() }).catch(
      (error: unknown) => error
    );

    // The sha belongs on the attempt's `started` record (`attempt.ts` recomputes it from the
    // real file); the body belongs nowhere. Both are checked against every retained file.
    const startedPath = join(world.runRoot, SLOT_KEY, "attempt-started.json");
    assert.equal(
      existsSync(startedPath),
      true,
      "the real attempt path must have retained a started record to inspect"
    );
    const started = readFileSync(startedPath, "utf8");

    assert.match(
      started,
      new RegExp(sha256File(world.settingsPath)),
      "the settings sha256 belongs in the record; the body does not"
    );
    assert.doesNotMatch(
      started,
      /no credentials/,
      "settings contents must never be written into a retained record"
    );

    const ledgerPath = join(world.runRoot, LEDGER_FILE);
    const ledger = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8")
      : "";
    assert.doesNotMatch(
      ledger,
      /no credentials/,
      "settings contents must never reach the ledger either"
    );
  });
});
