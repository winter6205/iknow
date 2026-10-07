/**
 * The standing preflight gate — ONE implementation for both pilot and paired (arms) runs.
 *
 * Why it exists (issue 1219 requirement 1): the #1212 pilot had zero wiring checks and the
 * arms run gated on wiring, so the same harness fault invalidated only part of the study.
 * Here the gate is mandatory for both, and it is bound to an explicit run identity.
 *
 * Two properties this module exists to guarantee:
 *  1. A verdict is only `OK` when measured library compatibility AND the oracle/original
 *     grader all agree — exit statuses, retained CTRF, a real test result line and no
 *     network-failure marker. Reward alone never establishes that tests ran.
 *  2. An `EXCLUDE:*` verdict is an explicit exclusion with a reason, never a green check,
 *     and it is distinguishable from a task failure.
 *
 * A third property follows from the first two: an UNMEASURED input is not an exclusion. A
 * library ceiling the provisioning path could not read is a harness fault, so it gets its own
 * `UNRESOLVED:*` verdict and stops the driver — the same treatment a stale or missing record
 * gets. Reporting it as `EXCLUDE:glibcxx` would charge the task for the harness's failure.
 *
 * A fourth property, and the one the driver depends on: a HARNESS fault and a TASK property
 * must never share a driver consequence, whatever the verdict string is spelled. A gate that
 * could not prove its own wiring says nothing about the task, so it stops the whole driver
 * nonzero; only a measured task/environment property (`glibcxx`, `oracle-or-grader`) skips one
 * slot. See `HARNESS_FAULT_VERDICTS` and `decisionFromRecord`.
 *
 * The docker-executed half is an injected port (`PreflightProbe`): the measurement is
 * supplied by the SAME provisioning path the real attempt uses, so this module never
 * grows a second wiring implementation that can drift from the runner.
 */
import { compareIdentities, type RunIdentity } from "./identities.js";
import { PROBE_FAILED } from "./smoke-types.js";

/** Terminal-bench-style library ceiling, e.g. `GLIBCXX_3.4.31`. */
export type LibraryCeiling = string;

/**
 * The ceiling for this task was never measured, so the gate cannot say OK and must not say
 * EXCLUDE either. `UNRESOLVED:` is a first-class outcome, not a flavour of exclusion.
 */
export const UNRESOLVED_GLIBCXX = "UNRESOLVED:glibcxx-unmeasured";

export type PreflightVerdict =
  | "OK:oracle-passes-grader"
  | "EXCLUDE:glibcxx"
  | "EXCLUDE:oracle-or-grader"
  | "EXCLUDE:runner-wiring"
  | typeof UNRESOLVED_GLIBCXX;

/**
 * Verdicts that report a fault of the HARNESS rather than a measured property of the task.
 *
 * The verdict strings are deliberately explicit per cause — the report has to be able to say
 * WHICH fault occurred — but their DRIVER consequence is a single rule, so it is defined once
 * here instead of being re-derived per branch. Anything in this set stops the whole driver and
 * is charged to no task; everything else that is not `OK:` is an exclusion of that one slot.
 *
 * `EXCLUDE:runner-wiring` belongs here even though it is spelled `EXCLUDE:`: it means the real
 * provisioning path did not prove itself, which says nothing about whether the task is
 * solvable. Judge order in `judgeMeasurement` already treats wiring first for that reason.
 */
const HARNESS_FAULT_VERDICTS: ReadonlySet<PreflightVerdict> = new Set([
  "EXCLUDE:runner-wiring",
]);

/**
 * Everything the gate measured. `runnerWiringOk` and the rest come from the real
 * provisioning path; nothing here is derived from a verdict string written earlier.
 */
export interface PreflightMeasurement {
  /**
   * Measured in-container library ceiling; `ABSENT` when the probe ran and found no
   * library; `PROBE_FAILED` when the probe never completed and the ceiling is UNKNOWN.
   * Those last two are different facts and the gate must never collapse them: `ABSENT` is a
   * measured property of the image, `PROBE_FAILED` is a harness fault with no measurement.
   */
  readonly glibcxxMeasured: LibraryCeiling | "ABSENT" | typeof PROBE_FAILED;
  /** Floor required by the bundle that will actually be mounted. */
  readonly bundleGlibcxxFloor: LibraryCeiling;
  /** The real runner's own wiring verdict from this same provisioning path. */
  readonly runnerWiringOk: boolean;
  /** Exit status of the original grader, as a number. `null` when never observed. */
  readonly graderExit: number | null;
  /** Oracle reward text; `null` when the grader never produced reward.txt. */
  readonly oracleReward: string | null;
  /** Retained CTRF byte length; 0 when the file is absent or empty. */
  readonly ctrfBytes: number;
  /** Real test result line scraped from grader output; `""` when absent. */
  readonly resultLine: string;
  /** True when grader output carries a network-failure marker. */
  readonly networkFailureMarker: boolean;
}

/** A retained, identity-bound gate record. */
export interface GateRecord {
  readonly identity: RunIdentity;
  readonly verdict: PreflightVerdict;
  readonly reasons: ReadonlyArray<string>;
  readonly measurement: PreflightMeasurement;
  readonly recordedAtEpochMs: number;
}

/** Injectable docker seam: performs the real provisioning and returns measurements. */
export type PreflightProbe = (
  identity: RunIdentity
) => Promise<PreflightMeasurement>;

export interface GateDecision {
  /** `pass` dispatches; every other kind stops this slot before any model dispatch. */
  readonly kind: "pass" | "exclude" | "reject";
  readonly verdict:
    PreflightVerdict | "REJECT:stale-identity" | "REJECT:no-record";
  readonly record: GateRecord | null;
  readonly reasons: ReadonlyArray<string>;
  /** True only for an explicit exclusion — never a task failure, never a pass. */
  readonly excluded: boolean;
  /** Whether this decision must stop the WHOLE driver (identity/gate fault vs exclusion). */
  readonly stopDriver: boolean;
}

const NETWORK_MARKER =
  /command not found|Failed to connect|Connection timed out|network timeout/i;
const RESULT_LINE = /\d+\s+(passed|failed|error)/i;

/** Parse `GLIBCXX_3.4.31` into comparable `[3, 4, 31]`; `null` when unparseable. */
function parseCeiling(value: string): number[] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match === null
    ? null
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Library compatibility: the measured ceiling must be present and at or above the floor.
 *
 * `PROBE_FAILED` is intercepted by `judgeMeasurement` before this runs, because a probe that
 * never completed has nothing to compare: treating it as below-floor would invent an exclusion
 * from an absent measurement.
 */
function libraryCompatible(measured: PreflightMeasurement): boolean {
  if (measured.glibcxxMeasured === "ABSENT") return false;
  const actual = parseCeiling(measured.glibcxxMeasured);
  const floor = parseCeiling(measured.bundleGlibcxxFloor);
  if (actual === null || floor === null) return false;
  for (let i = 0; i < 3; i += 1) {
    const a = actual[i] ?? 0;
    const f = floor[i] ?? 0;
    if (a !== f) return a > f;
  }
  return true;
}

/** The oracle/grader half: exit status, retained CTRF, a real result line, no network marker. */
function oracleAndGraderProven(measurement: PreflightMeasurement): boolean {
  const exitsClean = measurement.graderExit === 0;
  const rewardPasses = measurement.oracleReward === "1";
  const ctrfRetained = measurement.ctrfBytes > 0;
  const realResultLine = RESULT_LINE.test(measurement.resultLine);
  const noNetworkFailure = !measurement.networkFailureMarker;
  return (
    exitsClean &&
    rewardPasses &&
    ctrfRetained &&
    realResultLine &&
    noNetworkFailure
  );
}

function reasonList(measurement: PreflightMeasurement): string[] {
  const reasons: string[] = [];
  if (measurement.graderExit !== 0)
    reasons.push(`grader_exit=${String(measurement.graderExit)}`);
  if (measurement.oracleReward !== "1")
    reasons.push(`oracle_reward=${String(measurement.oracleReward)}`);
  if (measurement.ctrfBytes <= 0) reasons.push("ctrf=absent");
  if (!RESULT_LINE.test(measurement.resultLine))
    reasons.push("result_line=missing");
  if (measurement.networkFailureMarker)
    reasons.push("network_failure_marker=present");
  return reasons;
}

/**
 * Judge one measurement. Order matters and is fixed: wiring first (an infrastructure
 * fault is not a task property), then an UNMEASURED ceiling (which is unresolved, not
 * excluded), then library compatibility, then oracle/grader.
 */
export function judgeMeasurement(
  measurement: PreflightMeasurement
): PreflightVerdict {
  if (!measurement.runnerWiringOk) return "EXCLUDE:runner-wiring";
  // A failed probe is the one input that is neither a pass nor a measured exclusion: the
  // gate cannot know this task's ceiling, so it says exactly that and stops.
  if (measurement.glibcxxMeasured === PROBE_FAILED) return UNRESOLVED_GLIBCXX;
  if (!libraryCompatible(measurement)) return "EXCLUDE:glibcxx";
  if (!oracleAndGraderProven(measurement)) return "EXCLUDE:oracle-or-grader";
  return "OK:oracle-passes-grader";
}

/** Reasons attached to an exclusion; empty for a pass. */
export function explainVerdict(
  verdict: PreflightVerdict,
  measurement: PreflightMeasurement
): string[] {
  if (verdict === "OK:oracle-passes-grader") return [];
  if (verdict === "EXCLUDE:runner-wiring") {
    return ["runner wiring unproven on the real provisioning path"];
  }
  if (verdict === UNRESOLVED_GLIBCXX) {
    return [
      `glibcxx_measured=${measurement.glibcxxMeasured}`,
      `bundle_glibcxx_floor=${measurement.bundleGlibcxxFloor}`,
      "the in-container library probe did not complete, so this task's ceiling is unknown; it excludes nothing and must be re-probed",
    ];
  }
  if (verdict === "EXCLUDE:glibcxx") {
    return [
      `glibcxx_measured=${measurement.glibcxxMeasured}`,
      `bundle_glibcxx_floor=${measurement.bundleGlibcxxFloor}`,
    ];
  }
  return reasonList(measurement);
}

/**
 * Select a gate record for `identity` from the records the caller supplied.
 *
 * Selection is by EXPLICIT identity, never by "search `preflight`, else fall back to
 * `preflight-retry1`". Records whose identity drifted are REJECTED even when their
 * verdict string says `OK:` — that fallback is exactly what silently picked the stale
 * `EXCLUDE:oracle-or-grader` record for `db-wal-recovery` in #1212.
 */
export function selectGateRecord(
  records: ReadonlyArray<GateRecord>,
  identity: RunIdentity
): GateDecision {
  const fresh = records.filter(
    (record) => compareIdentities(identity, record.identity).fresh
  );
  const current = fresh[0];
  if (current === undefined) {
    const rejected = records.map(
      (record) => compareIdentities(identity, record.identity).mismatches
    );
    return {
      kind: "reject",
      verdict:
        records.length === 0 ? "REJECT:no-record" : "REJECT:stale-identity",
      record: null,
      reasons:
        records.length === 0
          ? ["no gate record was supplied for this identity"]
          : [
              `every supplied record is stale; mismatches=${JSON.stringify(rejected)}`,
            ],
      excluded: false,
      stopDriver: true,
    };
  }
  return decisionFromRecord(current);
}

/** Turn a selected record into a decision. Shared by selection and the fresh path. */
export function decisionFromRecord(record: GateRecord): GateDecision {
  if (record.verdict === "OK:oracle-passes-grader") {
    return {
      kind: "pass",
      verdict: record.verdict,
      record,
      reasons: [],
      excluded: false,
      stopDriver: false,
    };
  }
  if (HARNESS_FAULT_VERDICTS.has(record.verdict)) {
    // The instrument did not prove itself. That is a property of the HARNESS, never of the
    // task, so it gets the same treatment as a stale or absent record: stop the whole driver
    // nonzero and charge nothing to the frozen list. Treating it as an exclusion is exactly
    // the #1212 defect in a new costume — the run advanced to the next task and exited 0
    // while reporting itself complete.
    return {
      kind: "reject",
      verdict: record.verdict,
      record,
      reasons: record.reasons,
      excluded: false,
      stopDriver: true,
    };
  }
  if (record.verdict === UNRESOLVED_GLIBCXX) {
    // Neither a pass nor an exclusion: the ceiling was never measured, so nothing about this
    // task is known. It excludes nothing, and a driver must stop on it exactly as it stops on
    // a stale record — dispatching on an unresolved ceiling would grade a task the gate
    // never cleared.
    return {
      kind: "reject",
      verdict: record.verdict,
      record,
      reasons: record.reasons,
      excluded: false,
      stopDriver: true,
    };
  }
  return {
    kind: "exclude",
    verdict: record.verdict,
    record,
    reasons: record.reasons,
    excluded: true,
    // An exclusion is a measured property of this task or its environment, not of the
    // harness: it skips this slot but must not abort the remaining frozen list.
    stopDriver: false,
  };
}

/**
 * Run the gate for one identity: probe through the real provisioning path, judge, and
 * return a decision bound to that identity. The record is returned so the caller can
 * retain it; this function never writes to disk.
 */
export async function runGate(
  identity: RunIdentity,
  probe: PreflightProbe,
  recordedAtEpochMs: number
): Promise<GateDecision> {
  const measurement = await probe(identity);
  const verdict = judgeMeasurement(measurement);
  const record: GateRecord = {
    identity,
    verdict,
    reasons: explainVerdict(verdict, measurement),
    measurement,
    recordedAtEpochMs,
  };
  return decisionFromRecord(record);
}

/** True when grader output carries a network-failure marker. Extracted, not re-parsed. */
export function detectNetworkFailureMarker(graderOutput: string): boolean {
  return NETWORK_MARKER.test(graderOutput);
}
