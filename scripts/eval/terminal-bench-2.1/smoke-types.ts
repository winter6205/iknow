/**
 * The disposable-Docker smoke's shared vocabulary: every report/option/context type and the
 * three constants the report shape is quoted by.
 *
 * Why this file exists (issue 1219, bug 3): the smoke was one 1571-line file whose types,
 * argument parsing, guards, task enumeration, cases, sweep and renderer all lived together.
 * Splitting it along those seams keeps the report byte-identical while bringing every
 * resulting file under the `max-lines` limit. Types move FIRST because every other seam
 * depends on them and importing them costs nothing at runtime.
 *
 * Nothing here executes; a reader of any other smoke module finds the shape it returns here.
 */
import type { ExecFn } from "./docker.js";
import type { ValidityVerdict } from "./accounting.js";
import type { RunnerPort } from "./runner.js";

/** Explicit operator inputs. No path, sha or limit falls back to a machine default. */
export interface SmokeOptions {
  readonly datasetRoot: string;
  readonly bundlePath: string;
  readonly nodeArchivePath: string;
  readonly outRoot: string;
  /** Tasks that get the full provision + ORIGINAL-grader treatment. */
  readonly tasks: ReadonlyArray<string>;
  readonly nodeSha256: string | null;
  readonly bundleSha256: string | null;
  readonly glibcxxFloor: string;
  /** Cap on the grader wall; the real value is the declared timeout plus `graderGraceSec`. */
  readonly graderWallSec: number;
  readonly graderGraceSec: number;
  readonly probeEveryImage: boolean;
}

/** One dataset task as declared, plus what is verifiable without a container. */
export interface TaskFacts {
  readonly task: string;
  readonly image: string;
  readonly verifierTimeoutSec: number;
  readonly graderPresent: boolean;
  readonly imageLocal: boolean | null;
  readonly glibcxxMeasured: string;
  readonly problems: ReadonlyArray<string>;
}

/** Everything the smoke observed for one fully graded task. */
export interface TaskVerdict {
  readonly task: string;
  readonly image: string;
  readonly curlInImage: string;
  readonly mountsUnified: boolean;
  readonly provisionExit: number;
  readonly bootVerified: boolean;
  readonly logsMountWritable: boolean;
  readonly glibcxxMeasured: string;
  readonly graderWallSec: number;
  readonly graderExit: number;
  /**
   * What `RunnerPort.grade()` reported, read from the host `logs/verifier/reward.txt`.
   * `null` when that artifact is missing or empty — never `0`, so an unmeasured reward
   * stays distinguishable from a measured one.
   */
  readonly reward: string | null;
  /** Read from the HOST `logs/verifier/reward.txt`, which is what the graders actually write. */
  readonly hostReward: string | null;
  readonly hostCtrfBytes: number;
  readonly resultLine: string;
  readonly networkFailureMarker: boolean;
  readonly validity: ValidityVerdict;
  readonly gateVerdict: string;
  readonly gateReasons: ReadonlyArray<string>;
  readonly retainedFiles: ReadonlyArray<string>;
  readonly passed: boolean;
  readonly failures: ReadonlyArray<string>;
}

/** An observation about the EXISTING tooling. Reported, never fixed here. */
export interface SmokeFinding {
  readonly severity: "high" | "note";
  readonly where: string;
  readonly finding: string;
  readonly evidence: string;
}

export interface NegativeCase {
  readonly name: string;
  readonly detected: boolean;
  readonly expected: string;
  readonly observed: ReadonlyArray<string>;
}

/** A preflight row for every task in the dataset, graded or gate-only. */
export interface PreflightRow {
  readonly task: string;
  readonly image: string;
  readonly coverage: "graded" | "gate-only";
  readonly imageLocal: boolean | null;
  readonly graderPresent: boolean;
  readonly glibcxxMeasured: string;
  readonly verdict: string;
  readonly reasons: ReadonlyArray<string>;
}

/** Proof that the image without curl still provisioned, whichever way it was exercised. */
export interface CurlGapEvidence {
  readonly task: string;
  readonly image: string;
  readonly probe: string;
  readonly via: "graded-run" | "provision-only-run" | "not-found";
  readonly passed: boolean;
  readonly detail: string;
}

export interface SmokeReportCoverage {
  readonly totalTasks: number;
  readonly fullyGraded: number;
  readonly gateOnly: number;
  /** Rows whose library probe exited nonzero: the ceiling is UNKNOWN and excludes nothing. */
  readonly probeFailed: number;
  /** Row count per verdict, sorted by verdict, so unknowns never hide inside exclusions. */
  readonly verdictHistogram: Readonly<Record<string, number>>;
  readonly statement: string;
}

export interface ContainerCleanup {
  readonly prefix: string;
  readonly before: ReadonlyArray<string>;
  readonly after: ReadonlyArray<string>;
  readonly leaked: ReadonlyArray<string>;
}

export interface SmokeReport {
  readonly startedAtIso: string;
  readonly nodeArchiveShaMeasured: string;
  readonly nodeArchiveShaPinned: string;
  readonly nodeArchiveShaPinSource: string;
  readonly shasumsCrossCheck: string;
  readonly bundleShaMeasured: string;
  readonly runnerVersion: string;
  readonly modelDispatchCalls: number;
  readonly settingsSha256: string;
  readonly settingsNote: string;
  readonly proxyEnvInjected: boolean;
  readonly curlGap: CurlGapEvidence;
  readonly notes: ReadonlyArray<string>;
  readonly tasks: ReadonlyArray<TaskVerdict>;
  readonly negatives: ReadonlyArray<NegativeCase>;
  readonly findings: ReadonlyArray<SmokeFinding>;
  readonly preflight: ReadonlyArray<PreflightRow>;
  readonly coverage: SmokeReportCoverage;
  readonly containers: ContainerCleanup;
  readonly passed: boolean;
  readonly failures: ReadonlyArray<string>;
}

/** Immutable record of every dispatch attempt, so a zero-dispatch claim is checkable. */
export interface DispatchLedger {
  count: number;
}

export interface ExecGuards {
  readonly dropMounts: ReadonlyArray<string>;
  readonly injectProxyEnv: boolean;
}

/** Shared run state. One object keeps every helper inside the parameter budget. */
export interface SmokeContext {
  readonly options: SmokeOptions;
  readonly exec: ExecFn;
  readonly runner: RunnerPort;
  readonly ledger: DispatchLedger;
  readonly nodeSha: string;
  readonly bundleSha: string;
  readonly settingsPath: string;
  /** `command -v curl` per image, probed once and reused. */
  readonly toolProbes: Map<string, string>;
}

/** Container names built by `docker.ts`; the cleanup assertion queries exactly this prefix. */
export const CONTAINER_PREFIX = "tb21-";
/** Host-relative directory the retained verifier output must land in. */
export const VERIFIER_DIR = "logs/verifier";
/**
 * Row verdict for a library probe that FAILED, e.g. an image with no `bash`, a blocked exec,
 * a full tmpfs or a daemon error.
 *
 * Why it is a verdict of its own and not `ABSENT`: the ceiling for such a row was never
 * measured, so publishing it as an absent library turns a HARNESS fault into a task exclusion
 * — the one mis-attribution this tooling exists to prevent — and does it silently, because the
 * row still looks measured. A `PROBE_FAILED` row excludes nothing and is reported as an
 * unresolved harness fault by the coverage accounting.
 */
export const PROBE_FAILED = "PROBE_FAILED";
/** Credential-free stand-in `docker cp`'d in, so no real settings file or key is ever used. */
export const SMOKE_SETTINGS_BODY =
  '{\n  "_note": "issue-1219 smoke placeholder; no credentials"\n}\n';
