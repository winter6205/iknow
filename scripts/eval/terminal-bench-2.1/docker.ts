/**
 * The concrete docker implementation of `RunnerPort`.
 *
 * Why it is separate from `runner.ts`: `runner.ts` is the seam contract and the single
 * mount definition, both pure. This module is the only place in the tooling that knows the
 * `docker` command line exists, so the real path can be smoke-tested by a dedicated Docker
 * run without any unit test having to own a container.
 *
 * Every command goes through an injected `exec`, so this module is exercisable with a
 * recording fake. The settings file is `docker cp`'d into the container and hashed on the
 * host — never printed, never returned. The ONE thing read out of it is `llm.model`, the
 * model routing id, because the agent's own output names no model at all; see
 * `readModelRoute`.
 *
 * Four measurement faults are prevented here, all of the same shape: a HARNESS fault must
 * never be published as a TASK verdict. A failed provisioning probe is `PROBE_FAILED`, not an
 * absent library. An oracle measurement is only produced after the task's own reference
 * solution actually ran. An unmeasurable oracle throws rather than grading an untouched
 * workspace into a fabricated `reward=0`. And a dispatch observation that could not READ what
 * the agent published says so, rather than passing a scrape failure off as a measurement.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  sharedMounts,
  type DispatchObservation,
  type DispatchOptions,
  type GradeObservation,
  type MountSpec,
  type ProvisionObservation,
  type ProvisionSpec,
  type RunnerPort,
} from "./runner.js";
import { pinnedImageRef, type RunIdentity } from "./identities.js";
import { PROBE_FAILED } from "./smoke-types.js";

export type ExecFn = (
  file: string,
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs: number }
) => Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}>;

/** Default exec: real `docker`, bounded by a timeout so a hung daemon cannot wedge a run. */
export const defaultExec: ExecFn = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: options.timeoutMs },
      (error, stdout, stderr) => {
        // execFile reports a signal kill as a string code; normalize to a number so callers
        // can compare it against an expected exit status.
        const code =
          typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      }
    );
  });

const RESULT_LINE = /([0-9]+\s+(?:passed|failed|error[s]?))/i;
const NETWORK_MARKER =
  /command not found|Failed to connect|Connection timed out|network timeout/i;
const COMMAND_TIMEOUT_MS = 120_000;
/** Host-relative directory the graders write their verdict into; see `sharedMounts`. */
const VERIFIER_DIR = "logs/verifier";

/**
 * Operator-supplied container environment, forwarded as `docker run -e NAME=VALUE` flags.
 *
 * Why it exists: every task's `test.sh` runs `apt-get install curl` and installs `uv` over the
 * network, so a host that reaches the network only through a proxy cannot run a grader at all
 * without it. `docker exec` inherits the container's `docker run` env, so one `-e` on the
 * provisioning line covers the provision script, the agent and the grader alike.
 *
 * Runbook contract: there is NO default proxy and nothing is read from `process.env`. A host
 * address baked into the instrument would make a run non-reproducible on any other machine
 * (issue 1219: "take paths and pinned identities from explicit parameters"). Omitting the
 * option — or passing an empty map — emits no `-e` flags at all, which is byte-for-byte the
 * previous argv.
 */
export interface DockerRunnerOptions {
  /**
   * `NAME` to `VALUE` pairs forwarded verbatim as `-e` flags on the `docker run` line, placed
   * before the image so `docker run` accepts them. Empty values are dropped: an unset
   * variable must not become an empty `-e NAME=` that shadows an image default.
   *
   * Typical use, supplied by the operator rather than defaulted here:
   * `--container-env HTTP_PROXY=http://<host>:<port> --container-env HTTPS_PROXY=http://<host>:<port>`.
   */
  readonly containerEnv?: Readonly<Record<string, string>>;
}

/** Render the option as `-e` pairs, skipping entries with an empty value. */
function containerEnvArgs(
  containerEnv: Readonly<Record<string, string>> | undefined
): string[] {
  return Object.entries(containerEnv ?? {}).flatMap(([name, value]) =>
    value === "" ? [] : ["-e", `${name}=${value}`]
  );
}

/** Render a mount list as `docker run -v` arguments. Used for both preflight and attempt. */
export function mountArgs(mounts: ReadonlyArray<MountSpec>): string[] {
  return mounts.flatMap((mount) => [
    "-v",
    `${mount.hostPath}:${mount.containerPath}${mount.readOnly ? ":ro" : ""}`,
  ]);
}

function containerName(spec: ProvisionSpec): string {
  return `tb21-${spec.identity.task.replace(/[^a-zA-Z0-9_.-]/g, "-")}-${process.pid}`;
}

async function run(
  exec: ExecFn,
  file: string,
  args: ReadonlyArray<string>,
  timeoutMs: number
) {
  const result = await exec(file, args, { timeoutMs });
  return {
    code: result.code,
    // The two streams stay SEPARATE as well as concatenated. `docker exec` returns them apart
    // and never interleaves them mid-line, so the concatenation is a faithful transcript of
    // the invocation; dispatch retains each half under the artifact names a run's evidence
    // index already uses (`process/ask.stdout`, `process/ask.stderr`).
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
}

async function removeContainer(exec: ExecFn, name: string): Promise<void> {
  await exec("docker", ["rm", "-f", name], { timeoutMs: COMMAND_TIMEOUT_MS });
}

/**
 * The single provisioning script. It runs unchanged for the preflight probe and for the
 * real attempt: probing a different script than the one that will run is how the /logs
 * mount fault got past a green preflight in #1212.
 */
const PROVISION_SCRIPT = [
  "set -uo pipefail",
  "mkdir -p /logs/verifier && echo ok > /logs/verifier/.tb21-probe && echo logs-mount-writable",
  "mkdir -p /opt/node && tar -xzf /opt/node-dist.tar.gz -C /opt/node --strip-components=1",
  "mkdir -p /opt/iknow && tar -xzf /opt/iknow-bundle.tgz -C /opt/iknow",
  "export PATH=/opt/node/bin:$PATH",
  'grep -ao "GLIBCXX_3\\.4\\.[0-9]*" /usr/lib/x86_64-linux-gnu/libstdc++.so.6 2>/dev/null | sort -V | tail -1 || true',
  "node --version",
  "node /opt/iknow/dist/cli.js --version",
  "node -e \"require('/opt/iknow/node_modules/tree-sitter');require('/opt/iknow/node_modules/tree-sitter-bash');console.log('iknow-native-ok')\"",
].join("; ");

/** The agent invocation, identical for every slot: only `--max-turns` varies. */
function dispatchScript(maxTurns: number): string {
  return [
    "set -uo pipefail",
    "cd /app && export PATH=/opt/node/bin:$PATH",
    `node /opt/iknow/dist/cli.js ask "$(cat /artifacts/meta/instruction.md)"` +
      ` --eval-state --max-turns ${maxTurns}` +
      " --workspace-root /app --data-dir /artifacts/session-pool --trace-out /artifacts/trace",
  ].join("; ");
}

/** Where terminal-bench-2.1 keeps a task's instruction: at the task ROOT, beside `task.toml`. */
const TASK_INSTRUCTION = "instruction.md";
/** Where `dispatchScript` reads it in the container: under the `/artifacts` bind mount. */
const ARTIFACT_INSTRUCTION = "meta/instruction.md";
/** The in-container path the prompt is read from, named in the refusal so it can be traced. */
const CONTAINER_INSTRUCTION = `/artifacts/${ARTIFACT_INSTRUCTION}`;

/**
 * The task ships no usable instruction, so there is nothing to ask the agent.
 *
 * `expectedPath` is the path the CONTAINER reads. `cat` on a missing file makes `$(...)` expand
 * to the empty string, and the agent is then invoked as `ask ""` — a real run would measure an
 * agent that received an EMPTY PROMPT, and every verdict it produced would be a statement about
 * the harness rather than about the model. An empty prompt is indistinguishable from a solved
 * task at the reward level, so the run refuses instead.
 */
export class InstructionMissingError extends Error {
  constructor(
    readonly expectedPath: string,
    readonly reason: string
  ) {
    super(`${reason}; ${CONTAINER_INSTRUCTION} would be empty`);
    this.name = "InstructionMissingError";
  }
}

/**
 * Materialize the task's instruction where `dispatchScript` reads it.
 *
 * Why it has to be written HERE rather than mounted: `sharedMounts` mounts only
 * `<taskDir>/tests` (read-only) at `/tests`, because that is what the grader needs. The task's
 * own `instruction.md` lives at the task ROOT and was therefore never visible in the container,
 * so `cat /artifacts/meta/instruction.md` failed on every real attempt. `/artifacts` IS the
 * attempt output directory (the same bind mount that carries `/logs`), so writing the file into
 * `outDir` is what makes it appear at `/artifacts/meta/instruction.md`.
 *
 * Throws `InstructionMissingError` for an unreadable or blank instruction: a prompt that cannot
 * be read is never dispatched.
 */
function materializeInstruction(spec: ProvisionSpec): string {
  const source = join(spec.taskDir, TASK_INSTRUCTION);
  const target = join(spec.outDir, ARTIFACT_INSTRUCTION);
  let text: string;
  try {
    text = readFileSync(source, "utf8");
  } catch {
    throw new InstructionMissingError(
      target,
      `no task instruction at ${source}`
    );
  }
  if (text.trim() === "") {
    throw new InstructionMissingError(target, `${source} is empty`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  return target;
}

/**
 * The ORIGINAL grader, run independently of the agent's stop reason.
 *
 * Its output is TEED to `/artifacts/process/grader.log` (the `/artifacts` bind mount), because
 * that is the path every reader of a run's evidence has always looked at — and until this tee
 * nothing on the production path wrote it, so the report's validity rule read an artifact with
 * no producer. The rule now reads the observation the attempt finalizes with (see
 * `attempt.ts` `FinalRecord`); the tee is retention for a human auditor, not the evidence path.
 *
 * `grader_exit` comes from `PIPESTATUS[0]`, the GRADER's own status: `$?` after a pipe is
 * `tee`'s, so recording `$?` here would silently replace the grader's verdict with the
 * tee's and change the exit code this script reports.
 */
const GRADER_SCRIPT = [
  "set -uo pipefail",
  "mkdir -p /artifacts/logs/verifier /artifacts/process",
  "cd /tests",
  "bash /tests/test.sh 2>&1 | tee /artifacts/process/grader.log",
  'echo "grader_exit=${PIPESTATUS[0]}"',
].join("; ");

/** In-container directory the ORACLE's reference solution is copied into. Never on any PATH. */
const ORACLE_DIR = "/opt/oracle";
/** Host-relative location of a task's own reference solution, inside its task directory. */
const SOLUTION_RELATIVE = "solution/solve.sh";

/**
 * The ORACLE step: apply the task's own reference solution, then nothing else.
 *
 * Why this is a separate script and not a line in `GRADER_SCRIPT`: `solve.sh` is the task
 * author's reference solution and is the ONLY thing that can make the oracle pass. Running
 * the grader against an untouched image measures nothing about the harness — every
 * terminal-bench-2.1 test asserts an artifact the agent is supposed to produce, so an
 * un-applied oracle grades `reward=0` on EVERY task and the gate degenerates into "always
 * exclude", which is exactly the blanket verdict issue 1219 exists to dismantle.
 */
const ORACLE_SCRIPT = [
  "set -uo pipefail",
  "mkdir -p /app",
  'echo "--- applying oracle ---"',
  `cd /app && bash ${ORACLE_DIR}/solve.sh`,
  'echo "oracle_exit=$?"',
].join("; ");

/** How an oracle measurement ended. */
export type OracleState = "applied";

/** What the oracle step itself did, retained beside the grade it produced. */
export interface OracleObservation {
  /**
   * Only `applied` can appear here: every other outcome throws a typed error instead of
   * returning an observation. `GradeObservation` has no way to say "nothing was measured"
   * for `exitCode` (it is a plain `number`), so an unapplied or broken oracle would have to
   * invent one — the same fabrication `retainedHostReward` refuses for the reward.
   */
  readonly state: OracleState;
  /** Host path of the applied reference solution. */
  readonly solvePath: string;
  /** The oracle step's own exit status, never the grader's. */
  readonly exitCode: number;
  /** Retained oracle output, so a reader can see the solution actually ran. */
  readonly stdout: string;
}

/** An oracle measurement: a grade, plus proof of which workspace was graded. */
export interface OracleGradeObservation extends GradeObservation {
  readonly oracle: OracleObservation;
}

/** The task ships no reference solution, so no oracle can be measured for it. */
export class OracleNotApplicableError extends Error {
  constructor(taskDir: string) {
    super(
      `no ${SOLUTION_RELATIVE} under ${taskDir}: the oracle is not applicable to this task`
    );
    this.name = "OracleNotApplicableError";
  }
}

/** The reference solution ran and failed, so the workspace it left is not the oracle's. */
export class OracleFailedError extends Error {
  constructor(
    readonly solvePath: string,
    readonly exitCode: number
  ) {
    super(
      `the task's reference solution ${solvePath} exited ${exitCode}; the grader was not run against its output`
    );
    this.name = "OracleFailedError";
  }
}

/**
 * The run identity carries no usable image digest, so no container can be pinned to it.
 *
 * `imageDigest` is declared as "immutable image content digest; a mutable tag is not an
 * identity", and the dataset only ever ships a mutable tag (`task.toml`'s `docker_image` has no
 * digest beside it). Dispatching an agent on a tag the run cannot pin measures whatever the
 * registry serves TODAY and records it under an identity asserting a frozen image — so a moved
 * tag silently changes the experiment while the report still vouches for it.
 *
 * Raised at dispatch, not at provisioning: provisioning and the oracle gate run for wiring
 * probes that deliberately carry a declared gap (`smoke-tasks.ts`), and what must never happen
 * is a MODEL running against an image the run cannot name exactly.
 */
export class ImageDigestUnusableError extends Error {
  constructor(
    readonly image: string,
    readonly imageDigest: string
  ) {
    super(
      `image ${image} has no usable content digest (imageDigest="${imageDigest}"); ` +
        "refusing to dispatch a model against a mutable tag"
    );
    this.name = "ImageDigestUnusableError";
  }
}

/** Fail closed when the identity cannot pin the image the agent would run in. */
function assertPinnedImage(identity: RunIdentity): void {
  if (pinnedImageRef(identity) === null) {
    throw new ImageDigestUnusableError(identity.image, identity.imageDigest);
  }
}

/**
 * The docker runner plus the oracle entry point.
 *
 * `gradeOracle` is a SEPARATE METHOD, not an option on `grade`, and that separation is the
 * safety property: `grade()` and `dispatch()` are the two paths a real agent attempt and the
 * pristine smoke run take, and neither can reach `solve.sh`. Only a caller that asks for
 * `gradeOracle` by name applies a reference solution.
 */
export interface DockerRunner extends RunnerPort {
  /**
   * Narrows `RunnerPort.dispatch`: the docker path reads the agent's published JSON, so its
   * observation carries the typed parse and the retained output. `RunnerPort` keeps the wider
   * `DispatchObservation` for the callers that only persist `model`/`stopReason` as strings.
   */
  dispatch(
    spec: ProvisionSpec,
    options: DispatchOptions
  ): Promise<AgentDispatchObservation>;
  /**
   * Apply `<taskDir>/solution/solve.sh`, then run the ORIGINAL grader against the result.
   * `graderWallSec` bounds the grader exactly as it does for `grade()`.
   */
  gradeOracle(
    spec: ProvisionSpec,
    graderWallSec: number
  ): Promise<OracleGradeObservation>;
}

/**
 * Build a runner bound to the REAL provisioning path, via the shared mount list.
 *
 * The four phases are separate functions so each stays readable on its own; they share one
 * `ensureContainer` so a container is created the same way for every phase.
 *
 * `options` is an optional trailing argument so every existing caller keeps compiling; it
 * carries `containerEnv` for hosts that need a proxy. See `DockerRunnerOptions` for the
 * runbook contract — notably that an unset proxy means no `-e` flags at all.
 */
export function createDockerRunner(
  exec: ExecFn = defaultExec,
  provisionTimeoutMs = 900_000,
  options: DockerRunnerOptions = {}
): DockerRunner {
  const ensureContainer = containerProvisioner(
    exec,
    containerEnvArgs(options.containerEnv)
  );
  const execIn: ExecIn = (spec, script, timeoutMs) =>
    run(
      exec,
      "docker",
      ["exec", containerName(spec), "bash", "-c", script],
      timeoutMs
    );
  const phases = { exec, ensureContainer, execIn, provisionTimeoutMs };

  return {
    version: "tb2.1-docker/1",
    provision: (spec) => provisionPhase(phases, spec),
    dispatch: (spec, dispatchOptions) =>
      dispatchPhase(execIn, spec, dispatchOptions),
    grade: (spec, graderWallSec) => gradePhase(execIn, spec, graderWallSec),
    gradeOracle: (spec, graderWallSec) =>
      oraclePhase(exec, execIn, spec, graderWallSec),
    reap: (spec) => removeContainer(exec, containerName(spec)),
  };
}

/** One `docker run -d` per spec, with the optional env applied before the mounts. */
function containerProvisioner(exec: ExecFn, envArgs: ReadonlyArray<string>) {
  return async function ensureContainer(spec: ProvisionSpec): Promise<string> {
    const name = containerName(spec);
    await removeContainer(exec, name);
    await exec(
      "docker",
      [
        "run",
        "-d",
        "--name",
        name,
        ...envArgs,
        ...mountArgs(sharedMounts(spec)),
        // Content-addressed when the identity supplies a real digest, so a tag that moves
        // between two runs cannot change what this one executes. The identity field is not
        // decorative: it selects the reference the daemon resolves.
        pinnedImageRef(spec.identity) ?? spec.identity.image,
        "sleep",
        "infinity",
      ],
      { timeoutMs: COMMAND_TIMEOUT_MS }
    );
    return name;
  };
}

type ExecIn = (
  spec: ProvisionSpec,
  script: string,
  timeoutMs: number
) => Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
}>;

/** The shared plumbing every phase needs, bundled to stay inside the parameter budget. */
interface PhaseDeps {
  readonly exec: ExecFn;
  readonly ensureContainer: (spec: ProvisionSpec) => Promise<string>;
  readonly execIn: ExecIn;
  readonly provisionTimeoutMs: number;
}

/**
 * The measured library ceiling — or the honest reason there is not one.
 *
 * A nonzero exit means the probe never completed: no `bash` in the image, a blocked exec, a
 * full tmpfs, a daemon error, a killed container. Every one of those is a HARNESS fault, and
 * publishing the result as `ABSENT` charges it to the TASK as an `EXCLUDE:glibcxx` — the one
 * mis-attribution this tooling exists to prevent. So a failed probe is `PROBE_FAILED`, the
 * word the smoke path already settled on (`smoke-tasks.ts` `imageGlibcxx`), and the shared
 * gate treats it as unresolved rather than excluded.
 *
 * Exit 0 with no match is different and stays `ABSENT`: the pipeline ends in `tail -1`, so an
 * image without libstdc++.so.6 really does exit 0 with nothing on stdout. That is a measured
 * property of the image, which is what a library exclusion is for.
 */
function measuredGlibcxx(probeExit: number, output: string): string {
  return probeExit !== 0
    ? PROBE_FAILED
    : (/GLIBCXX_3\.4\.\d+/.exec(output)?.[0] ?? "ABSENT");
}

async function provisionPhase(
  deps: PhaseDeps,
  spec: ProvisionSpec
): Promise<ProvisionObservation> {
  const name = await deps.ensureContainer(spec);
  await deps.exec("docker", ["exec", name, "mkdir", "-p", "/root/.iknow"], {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  // Copied in, never echoed: this file's contents carry an API key.
  await deps.exec(
    "docker",
    ["cp", spec.settingsPath, `${name}:/root/.iknow/settings.json`],
    {
      timeoutMs: COMMAND_TIMEOUT_MS,
    }
  );
  const result = await deps.execIn(
    spec,
    PROVISION_SCRIPT,
    deps.provisionTimeoutMs
  );
  return {
    exitCode: result.code,
    bootVerified: result.output.includes("iknow-native-ok"),
    logsMountWritable: result.output.includes("logs-mount-writable"),
    // The whole provisioning invocation's exit status, not just the grep's: every failure
    // mode that leaves the ceiling unmeasured fails this line, and a run that did not exit
    // cleanly cannot vouch for anything it flushed to stdout before it died.
    glibcxxMeasured: measuredGlibcxx(result.code, result.output),
    stdout: result.output,
  };
}

/**
 * What the agent PUBLISHED about why it stopped, or that we could not read it.
 *
 * `unreadable` is the whole point of this union. The producer saying nothing and this harness
 * failing to read what it said are different facts, and the previous implementation collapsed
 * both into the string `"unknown"` — so a broken parse was indistinguishable from a run whose
 * agent published nothing at all.
 */
export type DispatchStopReason =
  | { readonly source: "success-envelope"; readonly value: string }
  | { readonly source: "max-turns-envelope"; readonly value: string }
  | { readonly source: "unreadable"; readonly value: null };

/** The four counters `TokenUsage` carries (src/harness/model-adapter/types.ts:171-176). */
export interface DispatchTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
}

/** Why no token spend could be read. Each cause is a DIFFERENT fact about the run. */
export type UsageAbsence =
  /** `lastUsage` was null, and `formatRunJson` DROPS a null key: no model call succeeded. */
  | "dropped-null-last-usage"
  /** The envelope read is the max-turns one, which carries no usage field at all. */
  | "not-in-envelope"
  /** No envelope could be read, so nothing at all is known about spend. */
  | "no-envelope"
  /** A `lastUsage` IS there but is not the `TokenUsage` shape this harness knows. */
  | "malformed";

/** Token spend as the producer reported it, or an explicit absence — never a zero. */
export type DispatchUsage =
  | { readonly state: "reported"; readonly tokens: DispatchTokenUsage }
  | { readonly state: "absent"; readonly because: UsageAbsence };

/** Which model ran, and where that identity came from. */
export type DispatchModel =
  | { readonly source: "settings"; readonly route: string }
  | {
      readonly source: "unavailable";
      readonly route: null;
      /** Why no route could be named. Never the settings file's CONTENTS. */
      readonly detail: string;
    };

/**
 * The dispatch observation, with every parsed fact typed and the raw output kept.
 *
 * `RunnerPort.DispatchObservation` types `model`/`stopReason` as plain strings because files
 * this fix does not own persist them as strings; the two sentinels below are what those
 * columns carry when the value is not a measurement, and the `parsed*` fields carry the truth
 * for every reader that has the real type.
 */
export interface AgentDispatchObservation extends DispatchObservation {
  readonly parsedStopReason: DispatchStopReason;
  readonly parsedModel: DispatchModel;
  readonly usage: DispatchUsage;
  /** stdout+stderr of the agent invocation: the audit trail for everything above. */
  readonly agentOutput: string;
}

/** `stopReason` when no producer document could be read. Not a producer value. */
export const UNREADABLE_STOP_REASON = "unreadable-agent-output";
/** `model` when no model route could be named. Not a model. */
export const MODEL_UNRESOLVED = "unresolved-model";

/** True for a JSON object, so a field read cannot throw on an array or a scalar. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The producer document a dispatch can carry, discriminated by which envelope it is. */
type ProducerEnvelope =
  | {
      readonly kind: "success";
      readonly stopReason: string;
      readonly usage: DispatchUsage;
    }
  | { readonly kind: "max-turns"; readonly stopReason: string };

/** Read one parsed JSON value as the success envelope, else as the max-turns one, else not at all. */
function readEnvelope(candidate: unknown): ProducerEnvelope | null {
  if (!isRecord(candidate)) return null;
  const stopReason = candidate["stopReason"];
  if (
    typeof stopReason === "string" &&
    typeof candidate["turnCount"] === "number"
  ) {
    return {
      kind: "success",
      stopReason,
      usage: readEnvelopeUsage(candidate["lastUsage"]),
    };
  }
  const reason = candidate["reason"];
  if (
    candidate["error"] === "max_turns_exceeded" &&
    typeof reason === "string"
  ) {
    return { kind: "max-turns", stopReason: reason };
  }
  return null;
}

function countOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** The success envelope's `lastUsage`, whose key is DROPPED rather than set to null. */
function readEnvelopeUsage(raw: unknown): DispatchUsage {
  // Absent and null are the same wire shape: `JSON.stringify` drops the null key.
  if (raw === undefined || raw === null) {
    return { state: "absent", because: "dropped-null-last-usage" };
  }
  const input = isRecord(raw) ? raw["inputTokens"] : undefined;
  const output = isRecord(raw) ? raw["outputTokens"] : undefined;
  if (typeof input !== "number" || typeof output !== "number") {
    return { state: "absent", because: "malformed" };
  }
  return {
    state: "reported",
    tokens: {
      inputTokens: input,
      outputTokens: output,
      cacheCreationInputTokens: countOrNull(
        isRecord(raw) ? raw["cacheCreationInputTokens"] : null
      ),
      cacheReadInputTokens: countOrNull(
        isRecord(raw) ? raw["cacheReadInputTokens"] : null
      ),
    },
  };
}

/**
 * Offsets where a JSON document can START: every `{` that opens a line.
 *
 * `ask` writes one JSON document per invocation, and `docker exec` returns the two streams
 * apart, so a document always begins a line in the concatenated transcript. This is also what
 * keeps the scan bounded: an inner `{` (inside `finalText`, inside the trace) is never tried.
 */
function jsonDocumentStarts(output: string): number[] {
  const starts: number[] = [];
  for (let at = 0; at < output.length; at += 1) {
    if (output[at] === "{" && (at === 0 || output[at - 1] === "\n"))
      starts.push(at);
  }
  return starts;
}

/**
 * The index just past the JSON string literal that opens at `quote`, or -1 when it never
 * closes. An escape consumes the character after it, so `\"` inside the text is not the end
 * of the literal.
 */
function stringLiteralEnd(output: string, quote: number): number {
  for (let at = quote + 1; at < output.length; at += 1) {
    const char = output[at];
    if (char === "\\") {
      at += 1;
      continue;
    }
    if (char === '"') return at + 1;
  }
  return -1;
}

/**
 * The exclusive end offset of the JSON document starting at `start`, or -1 when there is
 * none. Depth is counted over `{`/`[` with string literals skipped whole.
 *
 * Needed because the document is not the rest of the output: the eval-state notice follows it
 * on stderr, and a `finalText` may hold braces of its own. Reading "everything to the end"
 * would fail on both counts, and reading only to the first `}` would cut the document in half.
 */
function jsonDocumentEnd(output: string, start: number): number {
  let depth = 0;
  let at = start;
  while (at < output.length) {
    const char = output[at];
    if (char === '"') {
      const past = stringLiteralEnd(output, at);
      if (past < 0) return -1;
      at = past;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      // Negative means the candidate opened nothing: this `{` belongs to some other text.
      if (depth < 0) return -1;
      if (depth === 0) return at + 1;
    }
    at += 1;
  }
  return -1;
}

/**
 * The one producer document in a dispatch transcript, or `null` when there is none.
 *
 * What does NOT parse, or parses into something that is neither envelope, is skipped rather
 * than accepted: that text is the eval-state notice, a stack trace, or a producer that changed
 * shape. A scan that ends with no match is the unreadable case, which the caller reports
 * explicitly instead of guessing a value.
 */
function readProducerDocument(output: string): ProducerEnvelope | null {
  for (const start of jsonDocumentStarts(output)) {
    const end = jsonDocumentEnd(output, start);
    if (end < 0) continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(output.slice(start, end));
    } catch {
      continue;
    }
    const envelope = readEnvelope(candidate);
    if (envelope !== null) return envelope;
  }
  return null;
}

/** Read the stop reason and the token spend out of a dispatch transcript. */
function readDispatchOutput(output: string): {
  readonly stopReason: DispatchStopReason;
  readonly usage: DispatchUsage;
} {
  const envelope = readProducerDocument(output);
  if (envelope === null) {
    return {
      stopReason: { source: "unreadable", value: null },
      usage: { state: "absent", because: "no-envelope" },
    };
  }
  return {
    stopReason: {
      source:
        envelope.kind === "success" ? "success-envelope" : "max-turns-envelope",
      value: envelope.stopReason,
    },
    usage:
      envelope.kind === "success"
        ? envelope.usage
        : { state: "absent", because: "not-in-envelope" },
  };
}

/**
 * The model route the container ran, read from the settings file THIS module copied into it.
 *
 * Why not from the agent's output: `formatRunJson` publishes `finalText`/`stopReason`/
 * `turnCount`/`lastUsage`/`trace`/`runState` and NO model key, and the `LoopTrace` inside it
 * (`src/harness/loop-trace.ts:53-56`) is `{ turns, totals }` — structural metadata with no
 * model field either. So the previous `/model=([^\s]+)/` regex could only ever yield its
 * fallback; #1212 could not recover which model ran for exactly this reason.
 *
 * Why the settings file IS authoritative: `docker cp` puts THIS file at
 * `/root/.iknow/settings.json` (the user layer `loadIknowSettings` reads,
 * src/config/settings.ts:2098-2102), and `settings.llm.model` is the only source of the
 * literal route — the `IKNOW_LLM_MODEL` env path is retired (src/config/env.ts:6-9, 1193-1195),
 * so nothing inside the container can override it.
 *
 * Only the route is taken. This file carries the API key, which is why it is hashed on the
 * host and never returned; the `detail` strings below name the FILE, never its contents, and
 * a `JSON.parse` failure message — which quotes the text it choked on — is deliberately not
 * propagated.
 */
function readModelRoute(settingsPath: string): DispatchModel {
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf8");
  } catch {
    return {
      source: "unavailable",
      route: null,
      detail: `no readable settings file at ${settingsPath}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      source: "unavailable",
      route: null,
      detail: `the settings file at ${settingsPath} is not parsable JSON`,
    };
  }
  const llm = isRecord(parsed) ? parsed["llm"] : undefined;
  const model = isRecord(llm) ? llm["model"] : undefined;
  if (typeof model !== "string" || model.trim() === "") {
    return {
      source: "unavailable",
      route: null,
      detail: `the settings file at ${settingsPath} declares no llm.model route`,
    };
  }
  return { source: "settings", route: model.trim() };
}

/**
 * Keep the agent's own output on the host, under the artifact names a run's evidence index
 * already uses (`process/ask.stdout`, `process/ask.stderr`).
 *
 * Retention, not evidence: the observation carries the same text in memory, but this survives
 * the process, so a reader can check the parse against what the agent actually wrote instead
 * of taking the observation's word for it.
 */
function retainAgentOutput(spec: ProvisionSpec, streams: ExecInResult): void {
  const dir = join(spec.outDir, "process");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ask.stdout"), streams.stdout);
  writeFileSync(join(dir, "ask.stderr"), streams.stderr);
}

/** What every in-container invocation returns: the exit status and BOTH streams, kept apart. */
interface ExecInResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
}

async function dispatchPhase(
  execIn: ExecIn,
  spec: ProvisionSpec,
  options: DispatchOptions
): Promise<AgentDispatchObservation> {
  // Both refusals happen BEFORE any exec: an agent is never invoked with an empty prompt, and
  // never against an image the run identity cannot pin. A model call is the one thing here
  // that costs money and cannot be taken back.
  materializeInstruction(spec);
  assertPinnedImage(spec.identity);
  const result = await execIn(
    spec,
    dispatchScript(options.maxTurns),
    options.agentWallSec * 1000
  );
  retainAgentOutput(spec, result);
  const parsed = readDispatchOutput(result.output);
  const model = readModelRoute(spec.settingsPath);
  return {
    exitCode: result.code,
    stopReason: parsed.stopReason.value ?? UNREADABLE_STOP_REASON,
    model: model.route ?? MODEL_UNRESOLVED,
    parsedStopReason: parsed.stopReason,
    parsedModel: model,
    usage: parsed.usage,
    agentOutput: result.output,
  };
}

async function gradePhase(
  execIn: ExecIn,
  spec: ProvisionSpec,
  graderWallSec: number
): Promise<GradeObservation> {
  const result = await execIn(spec, GRADER_SCRIPT, graderWallSec * 1000);
  return {
    exitCode: Number(
      /grader_exit=(\d+)/.exec(result.output)?.[1] ?? result.code
    ),
    reward: retainedHostReward(spec.outDir),
    ctrfBytes: retainedCtrfBytes(spec.outDir),
    resultLine: RESULT_LINE.exec(result.output)?.[1] ?? "",
    networkFailureMarker: NETWORK_MARKER.test(result.output),
  };
}

/**
 * The ORACLE measurement: the task's own reference solution, then the original grader.
 *
 * `solve.sh` is `docker cp`'d in rather than mounted, so `sharedMounts` stays the single mount
 * definition and the agent's mount surface is unchanged by an oracle run. The grader that runs
 * afterwards is the SAME `GRADER_SCRIPT` the agent path uses, and the reward is read from the
 * same retained host artifact.
 *
 * Both abnormal paths throw instead of returning. Grading a workspace the oracle never touched
 * would report `reward=0` as if it meant "the oracle failed", which is the fabricated verdict
 * this instrument must never produce; and a thrown typed error is the one representation a
 * caller cannot accidentally read as a measurement.
 */
async function oraclePhase(
  exec: ExecFn,
  execIn: ExecIn,
  spec: ProvisionSpec,
  graderWallSec: number
): Promise<OracleGradeObservation> {
  const solvePath = join(spec.taskDir, SOLUTION_RELATIVE);
  if (!existsSync(solvePath)) throw new OracleNotApplicableError(spec.taskDir);

  const name = containerName(spec);
  await exec("docker", ["exec", name, "mkdir", "-p", ORACLE_DIR], {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  await exec("docker", ["cp", solvePath, `${name}:${ORACLE_DIR}/solve.sh`], {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  const applied = await execIn(spec, ORACLE_SCRIPT, graderWallSec * 1000);
  const oracleExit = Number(
    /oracle_exit=(\d+)/.exec(applied.output)?.[1] ?? applied.code
  );
  if (oracleExit !== 0) throw new OracleFailedError(solvePath, oracleExit);

  const grade = await gradePhase(execIn, spec, graderWallSec);
  return {
    ...grade,
    oracle: {
      state: "applied",
      solvePath,
      exitCode: oracleExit,
      stdout: applied.output,
    },
  };
}

/**
 * Size of the CTRF the grader actually retained ON THE HOST. This is the assertion that the
 * /logs bind mount did its job: a container-local file that teardown destroyed reads as 0.
 */
export function retainedCtrfBytes(outDir: string): number {
  try {
    return statSync(join(outDir, VERIFIER_DIR, "ctrf.json")).size;
  } catch {
    return 0;
  }
}

/**
 * The reward the grader actually recorded, read from the HOST `logs/verifier/reward.txt`.
 *
 * Why the host file and not the grader's stdout: every terminal-bench-2.1 `test.sh` writes
 * `reward.txt` and echoes nothing, so scraping `/reward=(\S+)/` out of stdout returned `null`
 * on every measured task while the host file held a real `0`. `judgeMeasurement` gates on
 * `oracleReward === "1"`, so that made EVERY task read `EXCLUDE:oracle-or-grader`, including a
 * task whose oracle genuinely passes — a green-looking exclusion produced by a broken
 * measurement path. The `/logs` bind mount exists precisely so the host can read this file,
 * exactly as `retainedCtrfBytes` already does for the CTRF.
 *
 * A missing, empty or unreadable file reads as `null` and NEVER as `"0"`: `0` is a real
 * grader verdict, and inventing it would make a broken measurement indistinguishable from a
 * legitimately failing oracle.
 */
export function retainedHostReward(outDir: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(outDir, VERIFIER_DIR, "reward.txt"), "utf8");
  } catch {
    return null;
  }
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}
