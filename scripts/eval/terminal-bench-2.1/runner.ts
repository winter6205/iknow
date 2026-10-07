/**
 * The runner seam: the ONE provisioning/mount definition and its injectable port.
 *
 * Why this exists (issue 1219 requirement 1): `preflight.sh` and `run-attempt.sh` were two
 * shell scripts that both mounted `/logs` but were maintained separately. `run-attempt.sh`
 * originally omitted the `/logs` bind mount, and the failure was real and expensive — the
 * grader ran, wrote its verdict to container-local `/logs`, teardown destroyed it, and every
 * attempt was recorded `INVALID:ctrf` despite a real result line in `grader.log`. A gate
 * that validated a DIFFERENT wiring path than the attempt could not have caught it.
 *
 * So there is exactly one mount list here (`sharedMounts`), and both the preflight
 * provisioning probe and the real attempt build their plan from it. The docker execution
 * itself is an injected `RunnerPort`, so unit tests drive the lifecycle without Docker and
 * the real Docker path is exercised separately by a dedicated smoke run.
 *
 * Two host-side facts about `docker run -v` are handled here rather than at each call site,
 * because both are invisible until a real daemon is involved:
 *
 *  - it AUTO-CREATES a missing bind source, so provisioning a directory is a side effect of
 *    mounting it; and
 *  - it PARSES the source as `HOST:CONTAINER[:ro]` and refuses more than two colons. A slot
 *    key is `task:arm:maxTurns`, so the attempt directory named after one can never be
 *    mounted directly — verified live:
 *    `docker: invalid spec: …/db-wal-recovery:arm40:40/logs:/logs: too many colons`.
 *    Escaping does not help (a backslash is taken literally), and `--mount` would be a second
 *    mount implementation. A symlink does work: the daemon resolves the source, so a
 *    colon-free alias reaches the very same directory.
 */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type { RunIdentity } from "./identities.js";

export interface MountSpec {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly readOnly: boolean;
}

export interface ProvisionSpec {
  readonly identity: RunIdentity;
  readonly taskDir: string;
  readonly outDir: string;
  readonly bundlePath: string;
  readonly nodeArchivePath: string;
  /** Read-only into the container and hashed; its CONTENTS never enter a record. */
  readonly settingsPath: string;
}

export interface ProvisionObservation {
  readonly exitCode: number;
  /** True only when the agent CLI ran AND its native modules loaded. */
  readonly bootVerified: boolean;
  readonly logsMountWritable: boolean;
  /** Measured in-container library ceiling, or `ABSENT`. */
  readonly glibcxxMeasured: string;
  readonly stdout: string;
}

export interface DispatchOptions {
  readonly maxTurns: number;
  readonly agentWallSec: number;
  readonly graderGraceSec: number;
}

export interface DispatchObservation {
  readonly exitCode: number;
  /**
   * The model ROUTE resolved at dispatch time — NOT a guarantee that a model was identified.
   *
   * Why there is no model key to read it from: `LoopTrace` carries only `turns` and `totals`
   * (`src/harness/loop-trace.ts:53-56`), `TurnTrace` records one turn structurally
   * (`src/harness/loop-trace.ts:20-35`) and `Totals` is durations with cancel and tool-error
   * tallies (`src/harness/loop-trace.ts:37-51`). Neither producer envelope has one either:
   * `formatRunJson` publishes `finalText`/`stopReason`/`turnCount`/`lastUsage`/`trace`/
   * `runState` (`src/cli/format.ts:351-370`), and `maxTurnsEnvelope` publishes
   * `error`/`turnsRan`/`reason`/`message`/`stopSummary` (`src/cli/max-turns.ts:40-60`).
   *
   * So the only honest source is the copied USER-LAYER settings file: the `llm.model` route of
   * `~/.iknow/settings.json`, the user layer `loadIknowSettings` resolves
   * (`src/config/settings.ts:2098`, path built at `:2101`), which `readModelRoute` reads
   * (`docker.ts:787`). That file carries the API key, so only the route is taken — the settings
   * CONTENTS never reach this column, a record, a log or an error message.
   *
   * NAMING, stated plainly: the name is narrower than the value. This column carries EITHER that
   * route OR the `unresolved-model` sentinel (`docker.ts:591`) when the settings file was
   * unreadable, unparsable, or declared no route — so one legal value is not a model. It stays a
   * plain `string` because the port implementations outside this module's ownership construct and
   * consume this shape as a string. Where the difference matters, read the TYPED form,
   * `AgentDispatchObservation.parsedModel`, which the finalization record retains as
   * `dispatchEvidence.model` — never this column.
   */
  readonly model: string;
  /**
   * The agent's own stop reason as published, or `unreadable-agent-output` when no producer
   * document could be read at all (`docker.ts:589`) — which is a fact about OUR read, not a
   * value the agent published. The typed form that tells those apart, against
   * `{source: "unreadable", value: null}`, is `AgentDispatchObservation.parsedStopReason`.
   */
  readonly stopReason: string;
}

export interface GradeObservation {
  readonly exitCode: number;
  readonly reward: string | null;
  readonly ctrfBytes: number;
  readonly resultLine: string;
  readonly networkFailureMarker: boolean;
}

/**
 * Proof that a reference solution was applied BEFORE the grader that produced this grade.
 *
 * `state` can only ever be `"applied"`: a solution that could not be applied, or that failed,
 * is a thrown typed refusal rather than an observation, because `GradeObservation` has no way
 * to say "nothing was measured" for a plain `exitCode` and would have to invent one.
 */
export interface OracleAppliedProof {
  readonly state: "applied";
  /** Host path of the applied reference solution. */
  readonly solvePath: string;
  /** The oracle step's own exit status, never the grader's. */
  readonly exitCode: number;
  /** Retained oracle output, so a reader can see the solution actually ran. */
  readonly stdout: string;
}

/** An oracle measurement: a grade, plus proof of which workspace was graded. */
export type OracleGradeObservation = GradeObservation & {
  readonly oracle: OracleAppliedProof;
};

/** The injectable docker port. Every method is async so tests can supply a fake. */
export interface RunnerPort {
  readonly version: string;
  provision(spec: ProvisionSpec): Promise<ProvisionObservation>;
  dispatch(
    spec: ProvisionSpec,
    options: DispatchOptions
  ): Promise<DispatchObservation>;
  /** `graderWallSec` bounds the ORIGINAL grader independently of the agent's stop reason. */
  grade(spec: ProvisionSpec, graderWallSec: number): Promise<GradeObservation>;
  /**
   * Apply the task's own reference solution to a PRISTINE workspace, then run the ORIGINAL
   * grader against the result. This is what the preflight gate must measure through: every
   * terminal-bench-2.1 test asserts an artifact the agent is supposed to produce, so a
   * pristine grade reads `reward=0` on EVERY task and a gate built on it can never return
   * `OK:oracle-passes-grader`.
   *
   * OPTIONAL, deliberately. A required method would be the stronger contract, but two port
   * implementations that exist outside this module's ownership — `smoke-exec.sealedPort` and
   * the attempt-suite fakes — construct the object literal without it, and this instrument
   * cannot break a file it does not own to express the requirement.
   *
   * So the method is optional and the OBLIGATION moves to the gate: a runner that cannot
   * apply a reference solution produces an explicit, classified gate failure, never a silent
   * fallback to `grade()`. A fallback would restore, invisibly, exactly the defect this method
   * exists to remove — the gate would report a verdict it never measured.
   */
  gradeOracle?(
    spec: ProvisionSpec,
    graderWallSec: number
  ): Promise<OracleGradeObservation>;
  /** Remove containers/processes this attempt owns. Must be safe to call twice. */
  reap(spec: ProvisionSpec): Promise<void>;
}

/** Sibling directory holding the docker-parseable aliases of colon-bearing bind sources. */
export const MOUNT_ALIAS_DIR = ".mounts";

/**
 * The host path to hand `docker run -v` for an output directory.
 *
 * A colon-free path is returned UNCHANGED, so every caller that docker can already parse —
 * the smoke's `join(outRoot, sub, task)`, every fixture — keeps a byte-for-byte identical
 * argv. Only a path carrying a colon is aliased, and only because it is otherwise unparsable.
 *
 * The alias basename keeps the original readable for an auditor and appends a digest of the
 * FULL path, so two output directories that sanitize to the same name still get their own
 * alias and no attempt's evidence can land in another's directory.
 */
export function mountBindSource(outDir: string): string {
  if (!outDir.includes(":")) return outDir;
  const readable = basename(outDir).replace(/[^A-Za-z0-9._-]/g, "_");
  const digest = createHash("sha256").update(outDir).digest("hex").slice(0, 16);
  return join(dirname(outDir), MOUNT_ALIAS_DIR, `${readable}-${digest}`);
}

/**
 * Create the alias for `outDir` and return it. Idempotent.
 *
 * MUST run before anything mounts the directory, because `docker run -v` auto-creates a
 * missing source: an alias path that already exists as a real DIRECTORY would silently
 * collect this attempt's evidence where no report reads it. So an existing alias is accepted
 * only when it is the symlink this function creates, and anything else is a refusal rather
 * than a silent redirection of a run's evidence.
 */
export function ensureMountAlias(outDir: string): string {
  const alias = mountBindSource(outDir);
  if (alias === outDir) return alias;
  mkdirSync(dirname(alias), { recursive: true });
  try {
    symlinkSync(outDir, alias);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const alreadyAliased =
      lstatSync(alias).isSymbolicLink() && readlinkSync(alias) === outDir;
    if (!alreadyAliased) {
      throw new Error(
        `bind alias ${alias} already exists and does not point at ${outDir}; ` +
          `docker auto-creates a -v source, so a real directory there would collect this ` +
          `run's evidence where no report reads it`
      );
    }
  }
  return alias;
}

/**
 * The single mount list for an attempt.
 *
 * `/logs` is a SEPARATE bind mount and is load-bearing: every task's `test.sh` hardcodes
 * `/logs/verifier/{reward.txt,ctrf.json}`, so without this mount the grader's verdict dies
 * with the container.
 *
 * The two output mounts go through `mountBindSource`, so a colon-bearing attempt directory is
 * reached through an alias. `ensureMountAlias` is the caller's job — see its docblock.
 */
export function sharedMounts(spec: ProvisionSpec): ReadonlyArray<MountSpec> {
  const artifacts = mountBindSource(spec.outDir);
  return [
    {
      hostPath: `${spec.taskDir}/tests`,
      containerPath: "/tests",
      readOnly: true,
    },
    {
      hostPath: `${artifacts}/logs`,
      containerPath: "/logs",
      readOnly: false,
    },
    {
      hostPath: spec.bundlePath,
      containerPath: "/opt/iknow-bundle.tgz",
      readOnly: true,
    },
    {
      hostPath: spec.nodeArchivePath,
      containerPath: "/opt/node-dist.tar.gz",
      readOnly: true,
    },
    { hostPath: artifacts, containerPath: "/artifacts", readOnly: false },
  ];
}

/**
 * The preflight plan is built from the SAME `sharedMounts` as the attempt plan. That is the
 * whole point: a wiring gate that provisions differently from the attempt is not a gate.
 */
export function preflightMounts(spec: ProvisionSpec): ReadonlyArray<MountSpec> {
  return sharedMounts(spec);
}

/** sha256 of a file, streamed as bytes. Used for instrument integrity before spend. */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Verify the host-provided Node archive against the pinned sha BEFORE dispatching.
 *
 * This is the #1212 `run-attempt.sh` exit-90 behaviour kept verbatim in spirit: instrument
 * integrity is checked before any model token is spent, and a mismatch refuses the run
 * rather than recording an attempt that could never have worked.
 */
export function verifyInstrument(
  identity: RunIdentity,
  nodeArchivePath: string,
  bundlePath: string
): string[] {
  const problems: string[] = [];
  const nodeActual = sha256File(nodeArchivePath);
  if (nodeActual !== identity.nodeArchiveSha256) {
    problems.push(
      `node archive sha256 ${nodeActual} != pinned ${identity.nodeArchiveSha256}`
    );
  }
  const bundleActual = sha256File(bundlePath);
  if (bundleActual !== identity.bundleSha256) {
    problems.push(
      `bundle sha256 ${bundleActual} != pinned ${identity.bundleSha256}`
    );
  }
  return problems;
}
