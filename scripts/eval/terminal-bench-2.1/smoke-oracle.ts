/**
 * The oracle/graded case and the curl-gap case: the only places the smoke provisions a real
 * container and runs the ORIGINAL grader.
 *
 * Why the agent is never started here (issue 1219 requirement 3): this is a gate measurement,
 * not an attempt. `dispatch` is unreachable through the sealed port, so a pristine container
 * MUST score a low reward — nobody solved the task. The harness proof is therefore the
 * retained host-side CTRF plus a real pytest result line and a clean `/logs` mount, never the
 * reward alone; asserting the reward would be the reward-only check the issue forbids.
 *
 * Every path reaps its container, including a thrown or timed-out grader.
 */
import { join } from "node:path";

import { classifyValidity } from "./accounting.js";
import { retainedCtrfBytes } from "./docker.js";
import {
  explainVerdict,
  judgeMeasurement,
  type PreflightMeasurement,
} from "./preflight.js";
import { sharedMounts, verifyInstrument } from "./runner.js";
import type { GradeObservation, ProvisionSpec } from "./runner.js";
import {
  curlProbe,
  graderWallFor,
  identityFor,
  mountWiringMatches,
  prepareAttemptDir,
  retainedHostReward,
  retainedVerifierFiles,
  specFor,
  type VerifierListing,
} from "./smoke-tasks.js";
import {
  VERIFIER_DIR,
  type CurlGapEvidence,
  type SmokeContext,
  type TaskFacts,
  type TaskVerdict,
} from "./smoke-types.js";

function measurementFrom(
  provision: {
    readonly glibcxxMeasured: string;
    readonly bootVerified: boolean;
    readonly logsMountWritable: boolean;
  },
  grade: GradeObservation,
  floor: string
): PreflightMeasurement {
  return {
    glibcxxMeasured: provision.glibcxxMeasured,
    bundleGlibcxxFloor: floor,
    runnerWiringOk: provision.bootVerified && provision.logsMountWritable,
    graderExit: grade.exitCode,
    oracleReward: grade.reward,
    ctrfBytes: grade.ctrfBytes,
    resultLine: grade.resultLine,
    networkFailureMarker: grade.networkFailureMarker,
  };
}

/**
 * What a working harness must show, and what it deliberately does NOT require.
 *
 * `graderExit` is recorded but not asserted: every `test.sh` ends in an `if` that writes
 * `reward.txt`, so it exits 0 even when all tests failed. Asserting it would be exactly the
 * reward-only check issue 1219 forbids.
 *
 * The host-side read is a `VerifierListing` rather than a bare file list, so an unreadable
 * verifier directory fails the task as a NAMED harness fault instead of being reported as
 * "ctrf.json not retained", which is a claim the run never established.
 */
function provisionFailures(
  provision: {
    readonly exitCode: number;
    readonly bootVerified: boolean;
    readonly logsMountWritable: boolean;
  },
  hostCtrfBytes: number,
  measurement: PreflightMeasurement,
  verifier: VerifierListing
): string[] {
  const failures: string[] = [];
  if (provision.exitCode !== 0)
    failures.push(`provision_exit=${provision.exitCode}`);
  if (!provision.bootVerified)
    failures.push("boot not verified: no iknow-native-ok");
  if (!provision.logsMountWritable)
    failures.push("/logs mount not writable from the grader's own path");
  if (hostCtrfBytes <= 0) failures.push("host-side ctrf.json absent or empty");
  if (verifier.state === "unreadable")
    failures.push(`host ${VERIFIER_DIR} could not be read: ${verifier.reason}`);
  else if (!verifier.files.includes("ctrf.json"))
    failures.push("ctrf.json not retained on the host");
  if (measurement.resultLine === "")
    failures.push("no real test result line: the tests did not run");
  if (measurement.networkFailureMarker)
    failures.push("network-failure marker present in grader output");
  return failures;
}

export async function gradeThenReap(
  ctx: SmokeContext,
  spec: ProvisionSpec,
  graderWallSec: number
) {
  try {
    return await ctx.runner.grade(spec, graderWallSec);
  } finally {
    // Reap on every path, including a thrown or timed-out grader.
    await ctx.runner.reap(spec);
  }
}

/**
 * Provision the real container, then run the ORIGINAL grader on it PRISTINE.
 *
 * The agent is never started: no `dispatch`, no API key, no settings contents. That makes this
 * a gate measurement rather than an attempt, and it is why reward is expected to be 0 for a
 * task nobody has solved — the proof that the harness works is the retained CTRF plus a real
 * pytest result line, never the reward.
 */
export async function oracleCase(
  ctx: SmokeContext,
  facts: TaskFacts
): Promise<TaskVerdict> {
  const outDir = prepareAttemptDir(
    join(ctx.options.outRoot, "graded", facts.task)
  );
  const spec = specFor(ctx, facts, "graded");
  const identity = identityFor(ctx, facts);
  const curl = await curlProbe(ctx, facts.image);
  const failures: string[] = [];
  // Measured against the wiring the smoke DECLARES, not against `preflightMounts`: that
  // function is `return sharedMounts(spec)`, so the old comparison was a tautology that could
  // never fail and this field could never contradict the runner.
  const mountsUnified = mountWiringMatches(sharedMounts(spec), spec);
  if (!mountsUnified)
    failures.push(
      "sharedMounts(spec) no longer matches the wiring the smoke declares independently of it"
    );

  const gateProblems = verifyInstrument(
    identity,
    spec.nodeArchivePath,
    spec.bundlePath
  );
  if (gateProblems.length > 0)
    return refusedVerdict(facts, curl, mountsUnified, gateProblems);

  const graderWallSec = graderWallFor(ctx.options, facts);
  const provision = await ctx.runner.provision(spec);
  const grade = await gradeThenReap(ctx, spec, graderWallSec);
  const measurement = measurementFrom(
    provision,
    grade,
    ctx.options.glibcxxFloor
  );
  const hostCtrfBytes = retainedCtrfBytes(outDir);
  const verifier = retainedVerifierFiles(outDir);
  const gateVerdict = judgeMeasurement(measurement);
  failures.push(
    ...provisionFailures(provision, hostCtrfBytes, measurement, verifier)
  );
  return {
    task: facts.task,
    image: facts.image,
    curlInImage: curl,
    mountsUnified,
    provisionExit: provision.exitCode,
    bootVerified: provision.bootVerified,
    logsMountWritable: provision.logsMountWritable,
    glibcxxMeasured: provision.glibcxxMeasured,
    graderWallSec,
    graderExit: grade.exitCode,
    reward: grade.reward,
    hostReward: retainedHostReward(outDir),
    hostCtrfBytes,
    resultLine: grade.resultLine,
    networkFailureMarker: grade.networkFailureMarker,
    validity: classifyValidity(measurement),
    gateVerdict,
    gateReasons: explainVerdict(gateVerdict, measurement),
    retainedFiles: verifier.state === "unreadable" ? [] : verifier.files,
    passed: failures.length === 0,
    failures,
  };
}

function refusedVerdict(
  facts: TaskFacts,
  curl: string,
  mountsUnified: boolean,
  gateProblems: ReadonlyArray<string>
): TaskVerdict {
  return {
    task: facts.task,
    image: facts.image,
    curlInImage: curl,
    mountsUnified,
    provisionExit: -1,
    bootVerified: false,
    logsMountWritable: false,
    glibcxxMeasured: "NOT_REACHED",
    graderWallSec: 0,
    graderExit: -1,
    reward: null,
    hostReward: null,
    hostCtrfBytes: 0,
    resultLine: "",
    networkFailureMarker: false,
    validity: classifyValidity({
      ctrfBytes: 0,
      resultLine: "",
      networkFailureMarker: false,
    }),
    gateVerdict: "EXCLUDE:runner-wiring",
    gateReasons: gateProblems,
    retainedFiles: [],
    passed: false,
    failures: [`refused before any container work: ${gateProblems.join("; ")}`],
  };
}

/**
 * The image that genuinely lacks curl, chosen by PROBING rather than by assumption.
 *
 * A candidate is probed only when it is ALREADY PRESENT LOCALLY and image probing was not
 * switched off, which is the same gate `imageGlibcxx` applies. `probeImageTools` runs
 * `docker run --rm <tag>`, and `docker run` on a tag the daemon does not have PULLS it — so
 * an ungated search spends one 60s probe per task on the whole dataset, in direct
 * contradiction of the stated limitation that these images are deliberately not pulled, and
 * then publishes `imageLocal: null` / `GATE:image-missing` for images it just pulled. The
 * loop only stops at the first ABSENT, so the old cost was bounded by the dataset size rather
 * than by the question being asked. A non-local image is reported `GATE:image-missing` by the
 * preflight sweep instead, which is the honest description of an image this run never pulled.
 */
export async function selectCurlGapImage(
  ctx: SmokeContext,
  candidates: ReadonlyArray<TaskFacts>
): Promise<TaskFacts | null> {
  if (!ctx.options.probeEveryImage) return null;
  for (const facts of candidates) {
    if (facts.imageLocal !== true) continue;
    const probe = await curlProbe(ctx, facts.image);
    if (probe.split(" | ")[0] === "ABSENT" && !probe.includes("TAR_ABSENT"))
      return facts;
  }
  return null;
}

/**
 * Why no gap image was found, stated so the report cannot claim a sweep that never happened.
 *
 * "every probed image ships curl" was true only for a run that probed something. With the
 * candidate gate in place there are three distinct states, and collapsing them would repeat
 * the defect the gate fixes: a `--skip-image-probe` run probed nothing, and a dataset with
 * no local image probed nothing either.
 */
export function curlGapNotFound(
  ctx: SmokeContext,
  candidates: ReadonlyArray<TaskFacts>
): string {
  if (!ctx.options.probeEveryImage)
    return "image probing is switched off (--skip-image-probe), so no image was probed for curl";
  const local = candidates.filter((facts) => facts.imageLocal === true);
  if (local.length === 0)
    return "no image in the dataset is present locally, and probing one would pull it, so nothing was probed";
  return `every locally present image ships curl (${local.length} image(s) probed)`;
}

/** Prove an image without curl still provisions from the host-verified archive. */
export async function curlGapCase(
  ctx: SmokeContext,
  facts: TaskFacts,
  graded: ReadonlyArray<TaskVerdict>
): Promise<CurlGapEvidence> {
  const probe = await curlProbe(ctx, facts.image);
  const reused = graded.find((verdict) => verdict.task === facts.task);
  if (reused !== undefined) {
    return {
      task: facts.task,
      image: facts.image,
      probe,
      via: "graded-run",
      passed:
        reused.provisionExit === 0 &&
        reused.bootVerified &&
        reused.logsMountWritable,
      detail: `reused the graded run: provision_exit=${reused.provisionExit} boot=${reused.bootVerified} logs_writable=${reused.logsMountWritable}`,
    };
  }
  const spec = specFor(ctx, facts, "curl-gap");
  prepareAttemptDir(spec.outDir);
  const provision = await ctx.runner.provision(spec);
  try {
    return {
      task: facts.task,
      image: facts.image,
      probe,
      via: "provision-only-run",
      passed:
        provision.exitCode === 0 &&
        provision.bootVerified &&
        provision.logsMountWritable,
      detail: `provision_exit=${provision.exitCode} boot=${provision.bootVerified} logs_writable=${provision.logsMountWritable} glibcxx=${provision.glibcxxMeasured}`,
    };
  } finally {
    await ctx.runner.reap(spec);
  }
}
