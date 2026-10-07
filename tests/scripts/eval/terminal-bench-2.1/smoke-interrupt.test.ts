/**
 * An interrupted smoke must still publish what it measured, and must still reap.
 *
 * Why this file exists: `runSmoke` had no `try/finally` and the module installed no
 * `SIGINT`/`SIGTERM` handler at all. Any throw after `gradeSelected`, or a Ctrl-C during a
 * grader wall that defaults to 1800s, exited through a catch that only `console.error`ed. The
 * consequences were all the same class — evidence that existed was destroyed:
 *
 *   - no report was written, so the host-side verdicts the run had already paid for were lost,
 *     against the "retain host-side verdicts" contract;
 *   - no `reap` for a container caught mid-grade, so it stayed on the daemon;
 *   - the after-inventory was never re-read, so `containers.leaked` was never computed and
 *     "zero leaked containers" was evidenced only for a run that finished.
 *
 * Driven through the real `runSmoke`/`main` with an injected context — the docker port is
 * stubbed at its boundary, the filesystem, the report and the process signals are real. The
 * signal is delivered with `process.emit`, not a real Ctrl-C, so the test can observe the
 * handler's cleanup while the re-raised `process.kill` is stubbed; the handler therefore has to
 * be written so that its observable effects happen BEFORE the re-raise.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
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

import { afterAll, afterEach, describe, it } from "vitest";

import type { ExecFn } from "../../../../scripts/eval/terminal-bench-2.1/docker.ts";
import { sha256File } from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";
import {
  installInterruptHandlers,
  ownedContainers,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke-exec.ts";
import {
  main,
  runSmoke,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke.ts";
import {
  optionsFrom,
  parseArgs,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke-options.ts";
import type {
  SmokeContext,
  SmokeOptions,
  SmokeReport,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke-types.ts";
import type {
  GradeObservation,
  RunnerPort,
} from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";

const TASK = "db-wal-recovery";
const SECOND = "password-recovery";
const IMAGE = "alexgshaw/db-wal-recovery:20251031";
/** A container name shaped exactly like the one `docker.ts` builds, owned by this pid. */
const OWNED = `tb21-${TASK}-${process.pid}`;
/** Same prefix, different pid: a CONCURRENT run's container, which this run must not touch. */
const FOREIGN = `tb21-${SECOND}-${process.pid + 1}`;

const roots: string[] = [];
const realKill = process.kill;
/** tsx loader for the real child process — the same resolution the repo's own spawn tests use. */
const tsxLoader = createRequire(import.meta.url).resolve("tsx");
/** The real module under test, by absolute path, so the child exercises the shipped code. */
const SMOKE_EXEC = createRequire(import.meta.url).resolve(
  "../../../../scripts/eval/terminal-bench-2.1/smoke-exec.ts"
);

/** A dataset with two tasks, a real bundle and a real Node archive. */
function dataset(): {
  readonly argv: ReadonlyArray<string>;
  readonly outRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), "iknow-smoke-interrupt-"));
  roots.push(root);
  const outRoot = join(root, "out");
  for (const task of [TASK, SECOND]) {
    const dir = join(root, "dataset", "tasks", task);
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(
      join(dir, "task.toml"),
      [
        "[environment]",
        `docker_image = "${IMAGE}"`,
        "",
        "[verifier]",
        "timeout_sec = 300",
        "",
      ].join("\n")
    );
    writeFileSync(join(dir, "tests", "test.sh"), "#!/bin/sh\nexit 0\n");
  }
  const bundlePath = join(root, "bundle.tgz");
  const nodeArchivePath = join(root, "node-dist.tar.gz");
  writeFileSync(bundlePath, "bundle-bytes");
  writeFileSync(nodeArchivePath, "node-bytes");
  return {
    outRoot,
    // NO `--tasks`: with it, the run would grade exactly one task and never reach the failure
    // these cases are about. Left off, the smoke grades its own default list, which this dataset
    // satisfies in the order the cases need — the first task's verdict lands, THEN the second
    // task's provision throws, so "the host-side verdicts already produced" has real content.
    argv: [
      "--dataset",
      join(root, "dataset"),
      "--bundle",
      bundlePath,
      "--node-archive",
      nodeArchivePath,
      "--out",
      outRoot,
      "--skip-image-probe",
    ],
  };
}

/** The fake daemon: an inventory, and a record of every container removal. */
function fakeExec(
  inventory: ReadonlyArray<string>,
  removed: string[] = []
): ExecFn {
  return async (_file, args) => {
    if (args[0] === "rm") removed.push(args[args.length - 1] ?? "");
    return {
      stdout:
        args[0] === "ps"
          ? `${inventory.join("\n")}\n`
          : "ABSENT | /usr/bin/tar\n",
      stderr: "",
      code: 0,
    };
  };
}

function grade(): GradeObservation {
  return {
    exitCode: 0,
    reward: "0",
    ctrfBytes: 0,
    resultLine: "",
    networkFailureMarker: false,
  };
}

/** A port that fails on `failFor`, so the run gets part-way through and then breaks. */
function failingPort(failFor: string, onProvision?: () => void): RunnerPort {
  let current = "";
  return {
    version: "tb2.1-docker/test",
    provision: async (spec) => {
      current = spec.identity.task;
      if (current === failFor)
        throw new Error(`daemon refused the container for ${failFor}`);
      onProvision?.();
      return {
        exitCode: 0,
        bootVerified: true,
        logsMountWritable: true,
        glibcxxMeasured: "GLIBCXX_3.4.33",
        stdout: "",
      };
    },
    dispatch: async () => {
      throw new Error("dispatch is sealed");
    },
    grade: async () => grade(),
    reap: async () => {},
  };
}

/**
 * The context `prepareContext` would build, with the docker port and the exec seam swapped.
 *
 * It mirrors the real factory rather than inventing values: the report measures the bundle and
 * the settings placeholder, and `verifyInstrument` compares the pinned digests against the
 * archive's REAL bytes, so a context with placeholder shas would be refused before any
 * provision and these cases would never reach the window they exist to cover.
 */
function contextFor(
  exec: ExecFn,
  port: RunnerPort
): (options: SmokeOptions) => SmokeContext {
  return (options) => ({
    options,
    exec,
    runner: port,
    ledger: { count: 0 },
    nodeSha: options.nodeSha256 ?? sha256File(options.nodeArchivePath),
    bundleSha: options.bundleSha256 ?? sha256File(options.bundlePath),
    settingsPath: join(options.outRoot, "meta", "smoke-settings.json"),
    toolProbes: new Map<string, string>(),
  });
}

function readReport(outRoot: string): SmokeReport {
  return JSON.parse(
    readFileSync(join(outRoot, "smoke-report.json"), "utf8")
  ) as SmokeReport;
}

/**
 * The listeners this process had before this file installed any. Restored after every case.
 *
 * The interrupt case deliberately starts a run that NEVER settles, so its disposer can never
 * run. Without this, a handler installed by a test would still be listening when the next test
 * in the same process ran — which is precisely the pollution the disposer exists to prevent,
 * and the reason `installInterruptHandlers` has to hand one back at all.
 */
const BASELINE = {
  sigint: process.listeners("SIGINT"),
  sigterm: process.listeners("SIGTERM"),
};

afterEach(() => {
  process.kill = realKill;
  for (const [name, keep] of [
    ["SIGINT", BASELINE.sigint],
    ["SIGTERM", BASELINE.sigterm],
  ] as const) {
    process.removeAllListeners(name);
    for (const listener of keep) process.on(name, listener);
  }
});

afterAll(() => {
  for (const root of roots.splice(0, roots.length))
    rmSync(root, { recursive: true, force: true });
});

describe("a run that throws still publishes a report", () => {
  it("writes both report files, marks the run incomplete, and cannot pass", async () => {
    const { argv, outRoot } = dataset();
    const exec = fakeExec([]);
    const code = await main(argv, contextFor(exec, failingPort(SECOND)));

    assert.notEqual(
      existsSync(join(outRoot, "smoke-report.json")),
      false,
      "a run that measured something must leave its evidence behind, even when it throws"
    );
    assert.ok(
      existsSync(join(outRoot, "smoke-report.md")),
      "the readable report is the artifact an operator opens first"
    );
    const report = readReport(outRoot);

    assert.equal(
      report.passed,
      false,
      "an incomplete run must never report PASS"
    );
    assert.match(
      report.failures.join(" "),
      /run did not complete/,
      `the failure must say the run was cut short; got: ${JSON.stringify(report.failures)}`
    );
    assert.match(
      report.notes.join(" "),
      /RUN DID NOT COMPLETE/,
      "the notes are the first thing a reader sees, so the marker belongs there too"
    );
    assert.match(
      readFileSync(join(outRoot, "smoke-report.md"), "utf8"),
      /RUN DID NOT COMPLETE/,
      "the rendered markdown must carry the marker, or the JSON is the only place it exists"
    );
    assert.equal(code, 1, "a failed run must exit nonzero");
  });

  it("retains the host-side verdicts it had already produced", async () => {
    const { argv, outRoot } = dataset();
    const exec = fakeExec([]);

    await main(argv, contextFor(exec, failingPort(SECOND)));
    const report = readReport(outRoot);

    assert.equal(
      report.tasks.length,
      1,
      `the first task's verdict was already paid for and must survive; got: ${JSON.stringify(report.tasks.map((task) => task.task))}`
    );
    assert.equal(report.tasks[0]?.task, TASK);
  });

  it("re-reads the container inventory, so a leak is still detected on a failed run", async () => {
    const { argv, outRoot } = dataset();
    // A container that exists before the run AND after it is not a leak; the point here is
    // that the after-inventory is READ at all, which a throw used to skip entirely.
    const exec = fakeExec([OWNED, FOREIGN]);

    await main(argv, contextFor(exec, failingPort(SECOND)));
    const report = readReport(outRoot);

    assert.deepEqual(
      report.containers.after,
      // `listSmokeContainers` sorts, and `tb21-db-wal-recovery-<pid>` precedes
      // `tb21-password-recovery-<pid+1>`. Asserting the unsorted order would pass only on a
      // sort that does not exist, and would still pin nothing about what was read.
      [OWNED, FOREIGN],
      `the failure path must still inventory the daemon; got: ${JSON.stringify(report.containers)}`
    );
    assert.deepEqual(
      report.containers.leaked,
      [],
      "containers that existed before the run are not leaks"
    );
  });

  it("reports a container the run created as leaked, from the failure path", async () => {
    const { argv, outRoot } = dataset();
    let inventory: string[] = [];
    const exec: ExecFn = async (_file, args) => {
      if (args[0] === "ps")
        return { stdout: `${inventory.join("\n")}\n`, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    };
    const context = contextFor(
      exec,
      failingPort(SECOND, () => {
        inventory = [OWNED];
      })
    );

    await main(argv, context);
    const report = readReport(outRoot);

    assert.deepEqual(
      report.containers.leaked,
      [OWNED],
      `a container that appeared during a failed run is exactly what the leak proof exists for; got: ${JSON.stringify(report.containers)}`
    );
    assert.match(
      report.failures.join(" "),
      /leaked containers/,
      "and it must fail the run, not sit in a field nobody reads"
    );
  });
});

describe("an interrupt reaps this run's containers and then honours the signal", () => {
  it("removes only the containers this pid created", () => {
    assert.deepEqual(
      ownedContainers([OWNED, FOREIGN, "tb21-other-tool-1"]),
      [OWNED],
      "reaping by the bare `tb21-` prefix would delete a concurrent run's containers"
    );
  });

  it("installs on SIGINT and SIGTERM, and the disposer removes both", () => {
    const before =
      process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");

    const dispose = installInterruptHandlers(() => {});
    const installed =
      process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");

    assert.equal(
      installed,
      before + 2,
      "both signals must be handled, or a CI timeout leaves the run's containers behind"
    );
    dispose();
    assert.equal(
      process.listenerCount("SIGINT") + process.listenerCount("SIGTERM"),
      before,
      "the disposer must leave no listener behind, or every later test inherits this one"
    );
  });

  it("reaps, writes the report, and re-raises the signal rather than swallowing it", async () => {
    const { argv, outRoot } = dataset();
    const removed: string[] = [];
    const exec = fakeExec([OWNED, FOREIGN], removed);
    // Provision never settles, so the run is still mid-grade when the signal arrives —
    // the exact window in which a container is orphaned.
    const hanging = failingPort("never-reached");
    const stalled: RunnerPort = {
      ...hanging,
      provision: () => new Promise<never>(() => {}),
    };
    let raised: NodeJS.Signals | null = null;
    let release: () => void = () => {};
    const killed = new Promise<void>((resolve) => {
      release = resolve;
    });
    process.kill = ((_pid: number, signal?: string | number) => {
      raised = (signal ?? null) as NodeJS.Signals | null;
      release();
      return true;
    }) as never;

    void runSmoke(optionsFrom(parseArgs(argv)), contextFor(exec, stalled));
    // Let the run reach its first await before delivering the signal.
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.emit("SIGINT", "SIGINT");
    await killed;

    assert.deepEqual(
      removed,
      [OWNED],
      `the interrupt must remove this run's container and nothing else; removed: ${JSON.stringify(removed)}`
    );
    assert.equal(
      raised,
      "SIGINT",
      "the handler must re-raise the signal so the process still dies of it; swallowing it would teach CI that interrupting is free"
    );
    assert.ok(
      existsSync(join(outRoot, "smoke-report.json")),
      "the report must be written BEFORE the process dies, or the evidence is lost"
    );
    const report = readReport(outRoot);
    assert.match(
      report.failures.join(" "),
      /run did not complete/,
      "an interrupted run is not a completed one"
    );
    assert.match(
      report.notes.join(" "),
      /SIGINT/,
      `the marker must name the signal the operator sent; got: ${JSON.stringify(report.notes)}`
    );
  });

  /**
   * The REAL exit semantics, in a real process, with a real signal.
   *
   * The in-process case above stubs `process.kill`, so it proves the handler ASKS to re-raise.
   * That is not the same claim: a handler that logged the signal and returned, or one that
   * called `process.exit(0)` after writing its report, would pass every assertion up there and
   * both are the defect — a run that reports success to CI after an operator cancelled it.
   *
   * So this one runs the shipped `installInterruptHandlers` in a child, sends a genuine SIGINT,
   * and reads the child's own termination off the `close` event: dying OF the signal means
   * `signal === "SIGINT"` and no exit code at all. A swallowed signal closes with code 0.
   */
  it("dies OF the signal in a real process, only after its cleanup ran", async () => {
    const root = mkdtempSync(join(tmpdir(), "iknow-smoke-signal-"));
    roots.push(root);
    const marker = join(root, "reaped.txt");
    const entry = join(root, "entry.ts");
    writeFileSync(
      entry,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { installInterruptHandlers } from ${JSON.stringify(SMOKE_EXEC)};`,
        `installInterruptHandlers(async (signal) => {`,
        `  writeFileSync(${JSON.stringify(marker)}, String(signal), "utf8");`,
        `});`,
        // Stay alive: a process with nothing pending would exit before the signal arrives.
        `setInterval(() => {}, 1000);`,
        `process.stdout.write("ready\\n");`,
        "",
      ].join("\n")
    );

    const child = spawn(process.execPath, ["--import", tsxLoader, entry], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await once(child.stdout, "data");

    child.kill("SIGINT");
    const [code, signal] = (await once(child, "close")) as [
      number | null,
      NodeJS.Signals | null,
    ];

    assert.equal(
      signal,
      "SIGINT",
      `the process must die OF the signal, so a CI step that cancelled it is a failure; got code=${String(code)} signal=${String(signal)}`
    );
    assert.equal(
      code,
      null,
      "death by signal reports no exit code; an exit code here means the signal was swallowed or replaced by process.exit"
    );
    assert.equal(
      readFileSync(marker, "utf8"),
      "SIGINT",
      "the cleanup must complete BEFORE the re-raise, or the evidence dies with the process"
    );
  });
});
