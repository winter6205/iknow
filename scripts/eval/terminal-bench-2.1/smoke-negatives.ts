/**
 * The three negative cases. Each one must be DETECTED, not merely run: a negative case that
 * cannot fail proves nothing, so each asserts against an independent signal.
 *
 *   1. Missing `/logs` mount — the real #1212 A4 fault. The verdict dies with the container,
 *      so the retained host CTRF must read 0 and the validity verdict must be explicitly
 *      INVALID even though the grader itself still produced a result line.
 *   2. Stale identity fingerprint — a record that still claims `OK:oracle-passes-grader` must
 *      be rejected, and the container inventory must be unchanged so no work was done.
 *   3. Corrupted Node archive — the sha gate refuses AND, forced through anyway, the archive
 *      cannot boot, proving the refusal is a property of the bytes and not only of ordering.
 *
 * Why they live together (issue 1219, bug 3): they share the credential guard and the
 * container inventory, and they are the block a reviewer reads to judge whether the harness
 * can fail. Splitting them across files would hide that.
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { classifyValidity } from "./accounting.js";
import {
  createDockerRunner,
  retainedCtrfBytes,
  defaultExec,
} from "./docker.js";
import { compareIdentities, type RunIdentity } from "./identities.js";
import { selectGateRecord, type PreflightMeasurement } from "./preflight.js";
import { sha256File, verifyInstrument } from "./runner.js";
import { guardedExec, listSmokeContainers, sealedPort } from "./smoke-exec.js";
import { gradeThenReap } from "./smoke-oracle.js";
import {
  deepEqual,
  graderWallFor,
  identityFor,
  prepareAttemptDir,
  retainedHostReward,
  retainedVerifierFiles,
  specFor,
  type VerifierListing,
} from "./smoke-tasks.js";
import {
  CONTAINER_PREFIX,
  VERIFIER_DIR,
  type NegativeCase,
  type SmokeContext,
  type TaskFacts,
} from "./smoke-types.js";

/**
 * Negative case 1's detection predicate.
 *
 * A function rather than an inline expression, because this is the case that most needs
 * coverage and the one that cannot be driven without Docker: it exists to drop the `/logs`
 * bind mount from a REAL `docker run`, so a fake would prove nothing. The predicate is what
 * decides DETECTED, and it is checked in both directions so it cannot pass by accident.
 *
 * An UNREADABLE verifier directory is explicitly not a detection: it is a harness fault, and
 * reading it as `files.length === 0` is what let a silent catch publish a success-shaped
 * boolean for a run that measured nothing.
 */
export function missingLogsMountDetected(
  hostCtrfBytes: number,
  verifier: VerifierListing,
  valid: boolean
): boolean {
  return (
    verifier.state !== "unreadable" &&
    hostCtrfBytes === 0 &&
    verifier.files.length === 0 &&
    !valid
  );
}

/** Negative case 1: the #1212 A4 fault. The verdict dies with the container, and must read FAILED. */
export async function missingLogsMountCase(
  ctx: SmokeContext,
  facts: TaskFacts
): Promise<NegativeCase> {
  const exec = guardedExec(defaultExec, {
    dropMounts: ["/logs"],
    injectProxyEnv: true,
  });
  const runner = sealedPort(createDockerRunner(exec), ctx.ledger);
  const spec = specFor(ctx, facts, "negative-missing-logs");
  prepareAttemptDir(spec.outDir);
  const graderWallSec = graderWallFor(ctx.options, facts);
  const provision = await runner.provision(spec);
  const grade = await gradeThenReap({ ...ctx, runner }, spec, graderWallSec);
  const hostCtrfBytes = retainedCtrfBytes(spec.outDir);
  const verifier = retainedVerifierFiles(spec.outDir);
  const validity = classifyValidity({
    ctrfBytes: hostCtrfBytes,
    resultLine: grade.resultLine,
    networkFailureMarker: grade.networkFailureMarker,
  });
  return {
    name: "missing-/logs-mount",
    detected: missingLogsMountDetected(hostCtrfBytes, verifier, validity.valid),
    expected:
      "grader output must die with the container: host ctrf 0 bytes, verdict explicitly INVALID",
    observed: [
      `/logs bind mount removed from the docker run line; provision exit=${provision.exitCode}, logs_mount_writable reported=${provision.logsMountWritable}`,
      `grader still ran: grader_exit=${grade.exitCode} result_line="${grade.resultLine}" reward=${String(grade.reward)}`,
      verifierLine(spec.outDir, verifier),
      `host reward.txt: ${JSON.stringify(retainedHostReward(spec.outDir))} (the graders write it here, and nothing survived)`,
      `host-side ctrf bytes: ${hostCtrfBytes} (retainedCtrfBytes reads the HOST path, never the container copy)`,
      `validity: ${validity.label} failed_clauses=${JSON.stringify(validity.failedClauses)}`,
    ],
  };
}

/**
 * The retained host evidence, or the reason it could not be read. An unreadable path must
 * never be rendered as an empty listing, which reads exactly like "nothing survived".
 */
function verifierLine(outDir: string, verifier: VerifierListing): string {
  // The full HOST path, not the container-side `logs/verifier`: this string is the only place a
  // reader learns WHICH directory was unreadable, and a relative fragment cannot be looked up.
  const path = join(outDir, VERIFIER_DIR);
  return verifier.state === "unreadable"
    ? `host ${path} could not be READ (HARNESS_FAULT): ${verifier.reason}; this case cannot be judged`
    : `host ${path} entries: ${JSON.stringify(verifier.files)} (${verifier.state})`;
}

/** A measurement that looks perfect, so the only thing that can reject it is the identity. */
function perfectMeasurement(): PreflightMeasurement {
  return {
    glibcxxMeasured: "GLIBCXX_3.4.33",
    bundleGlibcxxFloor: "GLIBCXX_3.4.31",
    runnerWiringOk: true,
    graderExit: 0,
    oracleReward: "1",
    ctrfBytes: 1024,
    resultLine: "2 passed",
    networkFailureMarker: false,
  };
}

/**
 * Negative case 2's detection predicate: a refusal, a rejected record, and an untouched
 * container inventory. The last term is not decoration — a refusal that still created a
 * container is a different defect from a clean one, and the case must not report DETECTED
 * for the first while describing the second.
 */
export function staleFingerprintDetected(observed: {
  readonly problems: ReadonlyArray<string>;
  readonly gateVerdict: string;
  readonly before: ReadonlyArray<string>;
  readonly after: ReadonlyArray<string>;
}): boolean {
  return (
    observed.problems.length > 0 &&
    observed.gateVerdict === "REJECT:stale-identity" &&
    deepEqual(observed.before, observed.after)
  );
}

/** Negative case 2: a stale pinned sha must refuse before any dispatch or container work. */
export async function staleFingerprintCase(
  ctx: SmokeContext,
  facts: TaskFacts
): Promise<NegativeCase> {
  const current = identityFor(ctx, facts);
  const stale: RunIdentity = {
    ...current,
    nodeArchiveSha256: flipHex(ctx.nodeSha),
    runnerVersion: `${current.runnerVersion}-stale`,
  };
  const before = await listSmokeContainers(ctx.exec);
  const problems = verifyInstrument(
    stale,
    ctx.options.nodeArchivePath,
    ctx.options.bundlePath
  );
  const decision = selectGateRecord(
    [
      {
        identity: stale,
        verdict: "OK:oracle-passes-grader",
        reasons: [],
        measurement: perfectMeasurement(),
        recordedAtEpochMs: 0,
      },
    ],
    current
  );
  const mismatches = compareIdentities(current, stale).mismatches;
  const after = await listSmokeContainers(ctx.exec);
  return {
    name: "stale-identity-fingerprint",
    detected: staleFingerprintDetected({
      problems,
      gateVerdict: decision.verdict,
      before,
      after,
    }),
    expected:
      "verifyInstrument refuses, selectGateRecord returns REJECT:stale-identity, and no container is created",
    observed: [
      `verifyInstrument: ${JSON.stringify(problems)}`,
      `selectGateRecord on a stale record that still claims OK: verdict=${decision.verdict} kind=${decision.kind} stopDriver=${decision.stopDriver}`,
      `identity mismatches: ${JSON.stringify(mismatches)}`,
      `docker ps -a (prefix ${CONTAINER_PREFIX}) before=${JSON.stringify(before)} after=${JSON.stringify(after)} — unchanged, so no container work happened`,
    ],
  };
}

/** Flip the first hex digit so the value stays a valid 64-char sha but cannot match. */
function flipHex(sha: string): string {
  return `${sha.slice(0, 1) === "0" ? "1" : "0"}${sha.slice(1)}`;
}

/** Overwrite the archive's gzip magic in place: a real, unrecoverable corruption. */
function corruptArchive(path: string): void {
  const fd = openSync(path, "r+");
  try {
    const head = Buffer.alloc(8);
    readSync(fd, head, 0, 8, 0);
    for (let i = 0; i < head.length; i += 1) head[i] = head[i] ^ 0xff;
    writeSync(fd, head, 0, 8, 0);
  } finally {
    closeSync(fd);
  }
}

/**
 * Negative case 3's detection predicate: the sha gate must refuse AND the bytes must fail to
 * boot. Either term alone is not this case — a boot failure with an accepting gate is an
 * instrument fault somewhere else, and a refusal with a booting archive means the corruption
 * did not reach the provisioner.
 */
export function corruptedArchiveDetected(observed: {
  readonly problems: ReadonlyArray<string>;
  readonly provision: {
    readonly exitCode: number;
    readonly bootVerified: boolean;
  };
}): boolean {
  return (
    observed.problems.length > 0 &&
    observed.provision.exitCode !== 0 &&
    !observed.provision.bootVerified
  );
}

/** Negative case 3: a corrupted Node archive is refused by the sha gate, and cannot boot. */
export async function corruptedArchiveCase(
  ctx: SmokeContext,
  facts: TaskFacts
): Promise<NegativeCase> {
  const corruptPath = join(ctx.options.outRoot, "tmp/node-corrupt.tar.gz");
  mkdirSync(join(ctx.options.outRoot, "tmp"), { recursive: true });
  copyFileSync(ctx.options.nodeArchivePath, corruptPath);
  const observed: string[] = [];
  try {
    corruptArchive(corruptPath);
    const identity = identityFor(ctx, facts);
    const problems = verifyInstrument(
      identity,
      corruptPath,
      ctx.options.bundlePath
    );
    observed.push(
      `corrupted copy sha256: ${sha256File(corruptPath)} (pinned ${identity.nodeArchiveSha256})`
    );
    observed.push(`verifyInstrument: ${JSON.stringify(problems)}`);
    observed.push(
      `gate refuses, so the refused path creates no container: docker ps -a = ${JSON.stringify(await listSmokeContainers(ctx.exec))}`
    );
    // Defence in depth: force the corrupt archive through provisioning anyway, to show the
    // refusal is a property of the archive and not only of the gate's ordering.
    const spec = {
      ...specFor(ctx, facts, "negative-corrupt-archive"),
      nodeArchivePath: corruptPath,
    };
    prepareAttemptDir(spec.outDir);
    const provision = await ctx.runner.provision(spec);
    try {
      observed.push(
        `forced provision with the corrupt archive: exit=${provision.exitCode} boot_verified=${provision.bootVerified}`
      );
      return {
        name: "corrupted-node-archive",
        detected: corruptedArchiveDetected({ problems, provision }),
        expected:
          "verifyInstrument refuses, provisioning does not proceed, and a forced provision cannot boot",
        observed,
      };
    } finally {
      await ctx.runner.reap(spec);
    }
  } finally {
    rmSync(corruptPath, { force: true });
    observed.push(`temp copy removed: exists=${existsSync(corruptPath)}`);
  }
}
