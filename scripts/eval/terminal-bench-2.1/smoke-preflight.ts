/**
 * The full-list preflight sweep: one row per task in the COMPLETE dataset.
 *
 * Why the coverage split is stated rather than implied (issue 1219 requirement 3): only
 * `graded` rows ran real provisioning and the ORIGINAL grader. A `gate-only` row carries the
 * static dataset/image facts plus the measured library ceiling, and says so in both its
 * verdict and the coverage statement — a green-looking row that quietly never ran a grader
 * is the same dishonesty as the `EXCLUDE:oracle-or-grader` defect `docker.ts` carried.
 *
 * The library-compatibility rule is not re-derived here: it lives in `judgeMeasurement`, so
 * the sweep asks that function rather than keeping a second version of a version comparison.
 *
 * A `PROBE_FAILED` row (see `PROBE_FAILED`) is deliberately neither a `GATE:*` gate nor an
 * `EXCLUDE:*` exclusion: it is an unresolved HARNESS fault, and the coverage statement plus the
 * verdict histogram say how many rows are in that state, so it can never be read as a measured
 * ceiling.
 */
import { join } from "node:path";

import { judgeMeasurement, type PreflightMeasurement } from "./preflight.js";
import { readText } from "./smoke-tasks.js";
import {
  PROBE_FAILED,
  type PreflightRow,
  type SmokeReportCoverage,
  type TaskFacts,
  type TaskVerdict,
} from "./smoke-types.js";

/**
 * The library-compatibility rule lives in `judgeMeasurement`, so the sweep asks it rather than
 * re-deriving a version comparison of its own.
 *
 * `PROBE_FAILED` is excluded here for the same reason `NOT_PROBED` is: an unmeasured ceiling
 * is not an incompatible one. Without this guard a failed probe would be judged by
 * `judgeMeasurement` — which reads anything unparseable as below the floor — and would come
 * back as `EXCLUDE:glibcxx`, i.e. a harness fault attributed to the task.
 */
function glibcxxExcluded(facts: TaskFacts, floor: string): boolean {
  if (
    facts.glibcxxMeasured === "NOT_PROBED" ||
    facts.glibcxxMeasured === PROBE_FAILED
  )
    return false;
  const measurement: PreflightMeasurement = {
    glibcxxMeasured: facts.glibcxxMeasured,
    bundleGlibcxxFloor: floor,
    runnerWiringOk: true,
    graderExit: null,
    oracleReward: null,
    ctrfBytes: 0,
    resultLine: "",
    networkFailureMarker: false,
  };
  return judgeMeasurement(measurement) === "EXCLUDE:glibcxx";
}

/**
 * One row per task in the complete dataset.
 *
 * A `gate-only` row is explicitly NOT a preflight verdict: it carries the static facts plus the
 * measured library ceiling, and says so. Only `graded` rows ran the real provisioning path and
 * the ORIGINAL grader, and the coverage summary states that split rather than implying full
 * coverage.
 */
export function preflightRows(
  all: ReadonlyArray<TaskFacts>,
  graded: ReadonlyArray<TaskVerdict>,
  floor: string
): ReadonlyArray<PreflightRow> {
  const byTask = new Map(graded.map((verdict) => [verdict.task, verdict]));
  return all.map((facts) => {
    const run = byTask.get(facts.task);
    if (run === undefined) return staticRow(facts, floor);
    const base = {
      task: facts.task,
      image: facts.image,
      coverage: "graded" as const,
    };
    const reasons = run.failures.length > 0 ? run.failures : run.gateReasons;
    return {
      ...base,
      imageLocal: facts.imageLocal,
      graderPresent: facts.graderPresent,
      glibcxxMeasured: run.glibcxxMeasured,
      verdict: run.gateVerdict,
      reasons,
    };
  });
}

function rowBase(facts: TaskFacts): Omit<PreflightRow, "verdict" | "reasons"> {
  const base = {
    task: facts.task,
    image: facts.image,
    coverage: "gate-only" as const,
  };
  return {
    ...base,
    imageLocal: facts.imageLocal,
    graderPresent: facts.graderPresent,
    glibcxxMeasured: facts.glibcxxMeasured,
  };
}

function staticRow(facts: TaskFacts, floor: string): PreflightRow {
  if (!facts.graderPresent)
    return {
      ...rowBase(facts),
      verdict: "GATE:no-grader",
      reasons: facts.problems,
    };
  if (facts.imageLocal === null)
    return {
      ...rowBase(facts),
      verdict: "GATE:image-missing",
      reasons: facts.problems,
    };
  if (facts.glibcxxMeasured === PROBE_FAILED)
    return {
      ...rowBase(facts),
      verdict: PROBE_FAILED,
      reasons: [
        "the in-container library probe exited nonzero, so the library ceiling for this row is unknown",
        "this row excludes nothing and is not a task verdict; re-run the sweep before reading it",
      ],
    };
  if (glibcxxExcluded(facts, floor)) {
    return {
      ...rowBase(facts),
      verdict: "EXCLUDE:glibcxx",
      reasons: [
        `glibcxx_measured=${facts.glibcxxMeasured}`,
        `bundle_glibcxx_floor=${floor}`,
      ],
    };
  }
  return {
    ...rowBase(facts),
    verdict: "GATE:static-only",
    reasons: [
      "static dataset/image facts and the measured library ceiling only; provisioning and the ORIGINAL grader were NOT run for this task",
    ],
  };
}

/** Row count per verdict, sorted by verdict so the published order is stable across runs. */
function histogramOf(
  rows: ReadonlyArray<PreflightRow>
): Readonly<Record<string, number>> {
  const histogram: Record<string, number> = {};
  for (const row of rows)
    histogram[row.verdict] = (histogram[row.verdict] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(histogram).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
}

export function coverageOf(
  rows: ReadonlyArray<PreflightRow>
): SmokeReportCoverage {
  const fullyGraded = rows.filter((row) => row.coverage === "graded").length;
  const gateOnly = rows.length - fullyGraded;
  const probeFailed = rows.filter((row) => row.verdict === PROBE_FAILED).length;
  return {
    totalTasks: rows.length,
    fullyGraded,
    gateOnly,
    probeFailed,
    verdictHistogram: histogramOf(rows),
    statement:
      `${fullyGraded} of ${rows.length} task(s) were FULLY GRADED: real container, real provisioning path, ORIGINAL ` +
      `grader on a pristine container. The other ${gateOnly} were GATE-ONLY: dataset/image/library checks with no ` +
      `container and no grader run, so those rows are NOT preflight verdicts and must not be read as passes. ` +
      `${probeFailed} row(s) are ${PROBE_FAILED}: the in-container library probe exited nonzero, so those ceilings are ` +
      `unknown and the rows exclude nothing; re-run the sweep before reading a verdict for them.`,
  };
}

/** Cross-check the measured archive digest against the SHASUMS file shipped beside it. */
export function crossCheckShasums(
  nodeArchivePath: string,
  measured: string
): string {
  const text = readText(join(nodeArchivePath, "..", "SHASUMS256.txt"));
  if (text === "") return `no SHASUMS256.txt beside ${nodeArchivePath}`;
  const row = text
    .split("\n")
    .find((line) => /\s\S*node-v[\d.]+-linux-x64\.tar\.gz$/.test(line));
  const listed = row?.trim().split(/\s+/)[0] ?? "";
  if (listed === "")
    return "SHASUMS256.txt has no node-v*-linux-x64.tar.gz entry to compare against";
  return listed === measured
    ? `SHASUMS256.txt agrees with the measured digest (${measured})`
    : `SHASUMS256.txt lists ${listed} but the measured digest is ${measured}`;
}
