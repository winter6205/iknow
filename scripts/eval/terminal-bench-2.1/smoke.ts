#!/usr/bin/env node
/**
 * Disposable-Docker smoke for issue 1219 requirement 3, with ZERO model dispatch.
 *
 * Why it exists: `runner.ts`/`docker.ts` are the ONE provisioning/mount definition, but until
 * now they had only ever been driven by a fake `ExecFn` in unit tests. Requirement 1 forbids
 * growing a second wiring implementation to check them, and requirement 3 demands the real
 * docker path, the real pinned images and the ORIGINAL grader — so this file DRIVES
 * `createDockerRunner` instead of describing a parallel one.
 *
 * What it proves:
 *   1. The REAL `sharedMounts(spec)` deep-equals the mount list the smoke declares
 *      independently of it. Preflight/attempt mount identity is NOT measured: both plans come
 *      from the same function, so it is guaranteed by construction, and the report says so.
 *   2. The ORIGINAL grader runs on a PRISTINE container: reward, retained HOST-side CTRF, a
 *      real pytest result line and the network marker. `dispatch()` is unreachable — the port
 *      is sealed — so "zero model dispatch" is structural, not a promise.
 *   3. An image that genuinely lacks `curl` still provisions, because Node is mounted
 *      host-verified. The image is chosen by PROBING, never assumed.
 *   4. Three negative cases, each of which must be DETECTED: a missing `/logs` mount, a stale
 *      identity fingerprint, and a corrupted Node archive.
 *   5. The COMPLETE task list is preflighted, and every container this run creates is reaped
 *      and then proven absent from `docker ps -a`.
 *
 * This file is the ENTRY point and the composition root only. It was 1571 lines in one file
 * (over the `max-lines` limit) and is now split along its real seams, with behavior unchanged:
 *   - `smoke-types.ts`      shared report/option/context vocabulary and constants
 *   - `smoke-options.ts`    argument parsing and options
 *   - `smoke-exec.ts`       credential guard, exec wrapper, sealed port, container inventory
 *   - `smoke-tasks.ts`      task enumeration and per-task fact collection
 *   - `smoke-oracle.ts`     the oracle/graded case and the curl-gap case
 *   - `smoke-negatives.ts`  the three negative cases
 *   - `smoke-preflight.ts`  the full-list preflight sweep and coverage statement
 *   - `smoke-report.ts`     findings and markdown rendering
 *
 * Usage:
 *   npx tsx scripts/eval/terminal-bench-2.1/smoke.ts \
 *     --dataset <tasks-parent> --bundle <tgz> --node-archive <tar.gz> --out <dir> \
 *     [--tasks a,b] [--node-sha <hex>] [--bundle-sha <hex>] [--glibcxx-floor GLIBCXX_3.4.31] \
 *     [--grader-wall-sec 1800] [--grader-grace-sec 600] [--skip-image-probe]
 *   (--grader-wall-sec caps the grader wall; the real value is the task's declared
 *    [verifier] timeout_sec plus --grader-grace-sec.)
 *
 * It writes ONLY under `--out`, never into the repo or the reference directories.
 *
 * Every public symbol the monolith exported is re-exported below, so an existing importer
 * (including the docs' runbook command line) keeps working unchanged.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createDockerRunner, defaultExec } from "./docker.js";
import { sha256File } from "./runner.js";
import {
  guardedExec,
  installInterruptHandlers,
  listSmokeContainers,
  ownedContainers,
  proxyEnvInjected,
  reapContainers,
  sealedPort,
} from "./smoke-exec.js";
import {
  corruptedArchiveCase,
  missingLogsMountCase,
  staleFingerprintCase,
} from "./smoke-negatives.js";
import { optionsFrom, parseArgs } from "./smoke-options.js";
import {
  curlGapCase,
  curlGapNotFound,
  oracleCase,
  selectCurlGapImage,
} from "./smoke-oracle.js";
import {
  coverageOf,
  crossCheckShasums,
  preflightRows,
} from "./smoke-preflight.js";
import {
  finalize,
  findingsFrom,
  interruptedNote,
  NOTES,
  renderMarkdown,
} from "./smoke-report.js";
import { enumerateTasks } from "./smoke-tasks.js";
import {
  CONTAINER_PREFIX,
  SMOKE_SETTINGS_BODY,
  type ContainerCleanup,
  type CurlGapEvidence,
  type DispatchLedger,
  type NegativeCase,
  type SmokeContext,
  type SmokeOptions,
  type SmokeReport,
  type TaskFacts,
  type TaskVerdict,
} from "./smoke-types.js";

const DEFAULT_GRADED_TASKS = [
  "db-wal-recovery",
  "password-recovery",
  "custom-memory-heap-crash",
];

/** How a run's context is built. The only injection point: the docker port and the exec seam. */
export type ContextFactory = (options: SmokeOptions) => SmokeContext;

/** Where this run's credential-free settings placeholder lives. A path, not a measurement. */
function settingsPathFor(options: SmokeOptions): string {
  return join(options.outRoot, "meta/smoke-settings.json");
}

/**
 * Create the out-root and write the credential-free settings placeholder.
 *
 * Separate from `prepareContext` because it is a FILESYSTEM step the report measures, while the
 * context is what runs work. An injected factory replaces the runner and the exec seam; it must
 * not be able to make `reportBase` measure a settings file that was never written.
 */
function writeSettingsPlaceholder(options: SmokeOptions): void {
  mkdirSync(join(options.outRoot, "meta"), { recursive: true });
  writeFileSync(settingsPathFor(options), SMOKE_SETTINGS_BODY, "utf8");
}

function prepareContext(options: SmokeOptions): SmokeContext {
  const ledger: DispatchLedger = { count: 0 };
  const exec = guardedExec(defaultExec, {
    dropMounts: [],
    injectProxyEnv: true,
  });
  return {
    options,
    exec,
    runner: sealedPort(createDockerRunner(exec), ledger),
    ledger,
    nodeSha: options.nodeSha256 ?? sha256File(options.nodeArchivePath),
    bundleSha: options.bundleSha256 ?? sha256File(options.bundlePath),
    settingsPath: settingsPathFor(options),
    toolProbes: new Map<string, string>(),
  };
}

function reportBase(
  ctx: SmokeContext,
  measuredNode: string
): Omit<SmokeReport, "passed" | "failures"> {
  const pinned = ctx.options.nodeSha256;
  return {
    startedAtIso: new Date().toISOString(),
    nodeArchiveShaMeasured: measuredNode,
    nodeArchiveShaPinned: ctx.nodeSha,
    nodeArchiveShaPinSource:
      pinned === null
        ? "self-pinned (no --node-sha given; the measured value was used)"
        : "--node-sha",
    shasumsCrossCheck: crossCheckShasums(
      ctx.options.nodeArchivePath,
      measuredNode
    ),
    bundleShaMeasured: sha256File(ctx.options.bundlePath),
    runnerVersion: ctx.runner.version,
    modelDispatchCalls: 0,
    settingsSha256: sha256File(ctx.settingsPath),
    settingsNote:
      "smoke-generated credential-free placeholder; no real settings file and no key",
    // Derived from the flags the injector actually produced: with no host proxy variable set
    // nothing is injected, and a report asserting `true` would claim work the run never did.
    proxyEnvInjected: proxyEnvInjected(),
    curlGap: {
      task: "",
      image: "",
      probe: "",
      via: "not-found",
      passed: false,
      detail: "no image without curl was found",
    },
    notes: NOTES,
    tasks: [],
    negatives: [],
    findings: [],
    preflight: [],
    coverage: {
      totalTasks: 0,
      fullyGraded: 0,
      gateOnly: 0,
      probeFailed: 0,
      verdictHistogram: {},
      statement: "",
    },
    containers: { prefix: CONTAINER_PREFIX, before: [], after: [], leaked: [] },
  };
}

function requireTarget(selected: ReadonlyArray<TaskFacts>): TaskFacts {
  const first = selected[0];
  if (first === undefined)
    throw new Error("no task could be read from the dataset; nothing to smoke");
  return first;
}

/**
 * Exported so the report's curl-gap claim is testable: the not-found reason is the one place
 * the run can describe a sweep it did not perform, and it must be pinned at the call site.
 */
export async function probeCurlGap(
  ctx: SmokeContext,
  all: ReadonlyArray<TaskFacts>,
  verdicts: ReadonlyArray<TaskVerdict>
): Promise<CurlGapEvidence> {
  const gap = await selectCurlGapImage(ctx, all);
  return gap === null
    ? {
        task: "",
        image: "",
        probe: "",
        via: "not-found",
        passed: false,
        detail: curlGapNotFound(ctx, all),
      }
    : await curlGapCase(ctx, gap, verdicts);
}

async function runNegatives(
  ctx: SmokeContext,
  target: TaskFacts
): Promise<ReadonlyArray<NegativeCase>> {
  return [
    await missingLogsMountCase(ctx, target),
    await staleFingerprintCase(ctx, target),
    await corruptedArchiveCase(ctx, target),
  ];
}

function cleanupOf(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>
): ContainerCleanup {
  return {
    prefix: CONTAINER_PREFIX,
    before,
    after,
    leaked: after.filter((name) => !before.includes(name)),
  };
}

/**
 * Everything a partial report can be built from, kept LIVE as the run proceeds.
 *
 * Why this is a mutable record rather than a local: the signal handler closes over it, and a
 * Ctrl-C during a grader wall that defaults to 1800s arrives while `runSmoke` is still awaiting
 * the daemon — long after its locals stopped being reachable from anywhere. Without a record the
 * handler could only reap, and the host-side verdicts already paid for would still be lost,
 * which is the whole finding.
 *
 * `negatives` and `curlGap` stay null until reached, so a report can say "not reached" instead of
 * describing a case it never ran.
 */
interface RunProgress {
  readonly ctx: SmokeContext;
  readonly measuredNode: string;
  // Written once each, in run order, as the run advances. Not `readonly` because the record has
  // to stay a snapshot of progress rather than a value the run waits to hand over.
  all: ReadonlyArray<TaskFacts>;
  selected: ReadonlyArray<TaskFacts>;
  before: ReadonlyArray<string>;
  readonly verdicts: TaskVerdict[];
  negatives: NegativeCase[];
  curlGap: CurlGapEvidence | null;
}

/** The curl-gap evidence for a run cut short: the case was never attempted. */
const CURL_GAP_NOT_REACHED: CurlGapEvidence = {
  task: "",
  image: "",
  probe: "",
  via: "not-found",
  passed: false,
  detail: "not reached: the run was cut short before the curl-gap case",
};

function emptyProgress(ctx: SmokeContext, measuredNode: string): RunProgress {
  return {
    ctx,
    measuredNode,
    all: [],
    selected: [],
    before: [],
    verdicts: [],
    negatives: [],
    curlGap: null,
  };
}

/**
 * Build the report from whatever the run retained, then take the after-inventory and reap.
 *
 * Order is the contract, not a style choice: the inventory is read BEFORE the reap, because a
 * reap followed by a re-read would report the containers this run just removed as absent and
 * turn the leak proof into a no-op. `leaked` is only meaningful as "still on the daemon after
 * everything this run did".
 *
 * The reap runs only on a cut-short run. A run that reaches its own `finalize` has already
 * reaped every container it created through `gradeThenReap`, so an extra `docker rm -f` there
 * would be a second behaviour change on the clean path for no new evidence.
 */
async function publish(
  progress: RunProgress,
  interruption: string | null
): Promise<SmokeReport> {
  const { ctx } = progress;
  const after = await listSmokeContainers(ctx.exec);
  if (interruption !== null)
    await reapContainers(ctx.exec, ownedContainers(after));
  const negatives = progress.negatives;
  const rows = preflightRows(
    progress.all,
    progress.verdicts,
    ctx.options.glibcxxFloor
  );
  const base = reportBase(ctx, progress.measuredNode);
  return finalize(
    {
      ...base,
      notes:
        interruption === null
          ? base.notes
          : [...base.notes, interruptedNote(interruption)],
      curlGap: progress.curlGap ?? CURL_GAP_NOT_REACHED,
      tasks: progress.verdicts,
      negatives,
      findings: findingsFrom(progress.verdicts),
      preflight: rows,
      coverage: coverageOf(rows),
      containers: cleanupOf(progress.before, after),
      modelDispatchCalls: ctx.ledger.count,
    },
    negatives,
    interruption
  );
}

/** The two report files, written in one place so every path that ends a run leaves them. */
function writeReport(outRoot: string, report: SmokeReport): void {
  writeFileSync(
    join(outRoot, "smoke-report.md"),
    renderMarkdown(report),
    "utf8"
  );
  writeFileSync(
    join(outRoot, "smoke-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
}

/**
 * Grade the selected tasks sequentially into `sink`; concurrency stays 1 so container work is
 * attributable. Writing into the live record rather than a returned array is what makes a
 * partial report possible: each verdict is retained the moment it exists.
 */
async function gradeSelected(
  ctx: SmokeContext,
  selected: ReadonlyArray<TaskFacts>,
  sink: TaskVerdict[]
): Promise<void> {
  for (const facts of selected) sink.push(await oracleCase(ctx, facts));
}

/**
 * Run the whole smoke, and ALWAYS leave a report behind.
 *
 * The contract this replaces: a throw after `gradeSelected`, or a Ctrl-C during a grader wall,
 * reached a catch that only `console.error`ed. No report, so the host-side verdicts the run had
 * already paid for were destroyed; no `reap` for a container caught mid-grade, so it stayed on
 * the daemon; and no after-inventory, so `containers.leaked` was never computed and "zero
 * leaked containers" was evidenced only for a run that finished. All three are the same defect:
 * evidence that existed was thrown away.
 *
 * So `runSmoke` no longer propagates a mid-run failure. It publishes what it retained, marks
 * the report incomplete, and returns it; `main` then exits nonzero because `passed` is false.
 * The throw still reaches a caller that reads nothing: the reason is IN the report, and
 * `failures` lists it verbatim rather than summarising it away.
 *
 * The one failure with no report is a context that cannot be built at all. There is then no
 * runner, no exec and nothing measured, so there is nothing to retain; that propagates.
 */
export async function runSmoke(
  options: SmokeOptions,
  contextFactory: ContextFactory = prepareContext
): Promise<SmokeReport> {
  // The placeholder is written by the RUN, not by the context, so the report's `settingsSha256`
  // is a measurement of this run's own file whichever factory built the context.
  writeSettingsPlaceholder(options);
  const ctx = contextFactory(options);
  const progress = emptyProgress(ctx, sha256File(options.nodeArchivePath));

  let interrupting = false;
  // Reaped and published BEFORE the signal is re-raised, so the operator's Ctrl-C cannot cost
  // the run its evidence. `installInterruptHandlers` re-raises rather than swallowing, and
  // disposes both listeners, so a run that finishes normally leaves nothing installed.
  const dispose = installInterruptHandlers(async (signal) => {
    // A second SIGINT while the first is still reaping must not publish twice.
    if (interrupting) return;
    interrupting = true;
    writeReport(
      options.outRoot,
      await publish(progress, `interrupted by ${signal}`)
    );
  });

  try {
    progress.all = await enumerateTasks(
      options.datasetRoot,
      ctx.exec,
      options.probeEveryImage
    );
    const wanted =
      options.tasks.length > 0 ? options.tasks : DEFAULT_GRADED_TASKS;
    progress.selected = progress.all.filter((facts) =>
      wanted.includes(facts.task)
    );
    progress.before = await listSmokeContainers(ctx.exec);
    await gradeSelected(ctx, progress.selected, progress.verdicts);
    const target = requireTarget(progress.selected);
    progress.negatives = [...(await runNegatives(ctx, target))];
    progress.curlGap = await probeCurlGap(ctx, progress.all, progress.verdicts);
    return await publish(progress, null);
  } catch (error: unknown) {
    return await publish(progress, String(error));
  } finally {
    dispose();
  }
}

/**
 * Entry point: parse, run, and leave the report on disk.
 *
 * `runSmoke` already wrote the report on the failure and interrupt paths, so writing it again
 * here is idempotent rather than a second behaviour: on a clean run this is the only write, and
 * on a cut-short run it rewrites the identical bytes the handler published.
 */
export async function main(
  argv: ReadonlyArray<string>,
  contextFactory: ContextFactory = prepareContext
): Promise<number> {
  const options = optionsFrom(parseArgs(argv));
  const report = await runSmoke(options, contextFactory);
  writeReport(options.outRoot, report);
  const markdown = renderMarkdown(report);
  process.stdout.write(markdown);
  return report.passed ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith("smoke.ts");
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(String(error));
      process.exitCode = 1;
    });
}

// Re-exported so every symbol the pre-split monolith published is still importable from here.
export { createDockerRunner, defaultExec };
export {
  assertNoCredentials,
  dropMountArgs,
  guardedExec,
  injectProxyEnv,
  installInterruptHandlers,
  listSmokeContainers,
  ownedContainers,
  proxyEnvFlags,
  proxyEnvInjected,
  reapContainers,
  sealedPort,
} from "./smoke-exec.js";
export {
  corruptedArchiveCase,
  missingLogsMountCase,
  staleFingerprintCase,
} from "./smoke-negatives.js";
export { optionsFrom, parseArgs } from "./smoke-options.js";
export {
  curlGapCase,
  curlGapNotFound,
  gradeThenReap,
  oracleCase,
  selectCurlGapImage,
} from "./smoke-oracle.js";
export {
  coverageOf,
  crossCheckShasums,
  preflightRows,
} from "./smoke-preflight.js";
export {
  finalize,
  findingsFrom,
  interruptedNote,
  renderMarkdown,
} from "./smoke-report.js";
export {
  deepEqual,
  enumerateTasks,
  expectedMounts,
  graderWallFor,
  identityFor,
  mountWiringMatches,
  prepareAttemptDir,
  probeImageTools,
  readText,
  retainedHostReward,
  retainedVerifierFiles,
  specFor,
} from "./smoke-tasks.js";
export {
  CONTAINER_PREFIX,
  PROBE_FAILED,
  SMOKE_SETTINGS_BODY,
  VERIFIER_DIR,
} from "./smoke-types.js";
export type {
  ContainerCleanup,
  CurlGapEvidence,
  DispatchLedger,
  ExecGuards,
  NegativeCase,
  PreflightRow,
  SmokeContext,
  SmokeFinding,
  SmokeOptions,
  SmokeReport,
  SmokeReportCoverage,
  TaskFacts,
  TaskVerdict,
} from "./smoke-types.js";
