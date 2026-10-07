#!/usr/bin/env node
/**
 * Thin entry point for the headless terminal-bench-2.1 driver.
 *
 * Why this file is deliberately thin (issue 1219): the #1212 drivers each grew their own gate
 * check, ledger write, ceiling test and loop structure inside one script, which is how the
 * gate's `break` ended up aimed at the inner arm loop instead of the task loop. Here the job
 * is: parse explicit arguments, resolve and validate config, wire the injected seams, run the
 * ordered loop, RETAIN what the gate measured, EMIT the report the retained records support,
 * and exit with its code.
 *
 * The report half of that job lives in `./report.js` and is re-exported from the bottom of
 * this file, so deriving the artifact and running the driver are separate responsibilities
 * while `import … from "./cli.ts"` still resolves every symbol it resolved before.
 *
 * The emitted report is the deliverable. `summarize` existed and was tested, but `main` never
 * called it: an operator ran the driver and got a stop reason with no denominators and no
 * spend — the #1212 failure mode, where the totals were recomputed by hand from a ledger whose
 * last attempt was never ledgered at all. Every number in the JSON is now derived by
 * `computeDenominator` / `aggregateSpend` / `ceilingVerdict` / `evaluateChecks` from the
 * records a run actually left behind. No count in the JSON is a constant.
 *
 * Every path, limit and pinned sha is an explicit argument. There is no machine default:
 *
 *   npx tsx scripts/eval/terminal-bench-2.1/cli.ts \
 *     --manifest <manifest.json> \
 *     --dataset-root <dir> --bundle <tgz> --node-archive <tar.gz> \
 *     --settings <settings.json> --run-root <dir> \
 *     --agent-wall-sec 2700 --grader-grace-sec 600 \
 *     --bundle-glibcxx-floor GLIBCXX_3.4.31 \
 *     --token-ceiling-input 4000000 --token-ceiling-output 3000000
 *
 * `--container-env NAME=VALUE` is repeatable and optional, and forwards one `docker run -e`
 * flag per occurrence. It exists because every task's `test.sh` apt-installs curl and installs
 * uv over the network, so a host that reaches the network only through a proxy cannot run the
 * real attempt path at all. There is deliberately no default proxy and nothing is read from
 * `process.env`: a host address baked into the instrument would make the run irreproducible
 * anywhere else. Omitting the flag emits no `-e` flag at all, byte-for-byte the previous argv.
 * A credential-looking NAME or VALUE is a refusal that names only the variable, because this
 * path forwards verbatim into both the container environment and every `docker` argv on the
 * host; see `assertNotACredential`.
 *
 * `--report-only` emits the same report from a run root's retained records and dispatches
 * nothing: an operator auditing a run that already happened — or was killed — must not have to
 * spend another run to learn what the first one spent. It needs only `--manifest` and
 * `--run-root`, refuses to create a run root it was not given, and selects gate records by
 * identity only. There is deliberately no "look in `preflight`, else try `preflight-retry1`"
 * fallback: in #1212 that is exactly how a stale `EXCLUDE:oracle-or-grader` record was picked
 * for a run it did not describe.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beginAttempt, runAttempt, SlotClaimError } from "./attempt.js";
import {
  ceilingVerdict,
  spendForLedger,
  type TokenCeiling,
} from "./accounting.js";
import {
  declaredVerifierTimeoutSec,
  driverSlotsOf,
  parseManifest,
  resolveConfig,
  type ConfigParams,
  type DriverSlot,
  type EvalManifest,
  type ManifestSlot,
  type ResolvedConfig,
} from "./config.js";
import {
  createDockerRunner,
  defaultExec,
  OracleFailedError,
  OracleNotApplicableError,
  type ExecFn,
} from "./docker.js";
import { runDriver, type DriverExit } from "./driver.js";
import { tallyAttempt } from "./evidence.js";
import type { RunIdentity } from "./identities.js";
import { readLedger, type UsageRecord } from "./ledger.js";
import {
  runGate,
  type GateDecision,
  type PreflightMeasurement,
} from "./preflight.js";
import {
  buildReport,
  persistReport,
  retainGateOutcome,
  type RunReport,
} from "./report.js";
import {
  ensureMountAlias,
  type OracleGradeObservation,
  type ProvisionSpec,
  type RunnerPort,
} from "./runner.js";

/**
 * The report half's public surface, re-exported so every import path that resolved before the
 * split still resolves: `main` is the real entry point and the module a test or a sibling
 * script imports, so this file must keep answering for the artifact it emits. `export … from`
 * binds nothing locally, which is why the import above can name the same symbols.
 */
export {
  buildReport,
  GATE_RECORD_VERSION,
  GATES_DIR,
  persistReport,
  readGateRecords,
  recordGateExclusion,
  REPORT_FILE,
  REPORT_SCHEMA_VERSION,
  retainGateRecord,
  summarize,
  type AttemptFact,
  type ChecksSummary,
  type GateOutcome,
  type GateSummary,
  type ReportInput,
  type RunReport,
  type SpendSummary,
} from "./report.js";

/**
 * Grader wall used ONLY when a task declares no verifier timeout of its own.
 *
 * It was previously the wall for every task: a task declaring `timeout_sec = 900.0` was
 * graded under 1800s, twice the budget it claims, and one declaring more was killed early.
 * The declared value now wins wherever the task ships one — see `verifierTimeoutSecFor`.
 */
const FALLBACK_VERIFIER_TIMEOUT_SEC = 1800;

/** Run-root-relative ledger path: the lifecycle records every number is derived from. */
export const LEDGER_FILE = "ledger.jsonl";

/**
 * Run-root-relative scratch tree the MANDATORY gate probes in.
 *
 * Deliberately distinct from the attempt directory: `docker run -v` auto-creates a missing
 * bind source, so a gate that provisioned inside `<runRoot>/<slotKey>` created the directory
 * the dispatch's exclusive `reserveAttemptDir` then refused. See `gateDirFor`.
 */
export const GATE_SCRATCH_DIR = ".preflight";

const FLAGS = [
  "manifest",
  "dataset-root",
  "bundle",
  "node-archive",
  "settings",
  "run-root",
  "agent-wall-sec",
  "grader-grace-sec",
  "bundle-glibcxx-floor",
  "token-ceiling-input",
  "token-ceiling-output",
  "container-env",
] as const;

/**
 * Flags that accumulate instead of overwriting: one occurrence per variable, because a
 * reachable-through-a-proxy host needs HTTP_PROXY, HTTPS_PROXY and NO_PROXY together.
 */
const REPEATABLE_FLAGS = ["container-env"] as const;

/** The subset an operator MUST supply; the repeatable flag is optional and says so here. */
const REQUIRED_FLAGS = FLAGS.filter(
  (flag) => !(REPEATABLE_FLAGS as ReadonlyArray<string>).includes(flag)
);

/** Valueless switches, recognized before the `--flag value` pairing loop. */
const SWITCHES = ["report-only"] as const;

/**
 * A parsed flag surface. A repeatable flag's value is every occurrence, in argv order; every
 * other flag's value is the single string it was given.
 */
export type ParsedArgs = Record<string, string | ReadonlyArray<string>>;

/** The single-valued reading of a flag; a repeatable flag is never read this way. */
function single(parsed: ParsedArgs, flag: string): string | undefined {
  const value = parsed[flag];
  return typeof value === "string" ? value : undefined;
}

/** Record one occurrence: a repeatable flag appends, every other flag overwrites. */
function record(parsed: ParsedArgs, flag: string, value: string): void {
  if (!(REPEATABLE_FLAGS as ReadonlyArray<string>).includes(flag)) {
    parsed[flag] = value;
    return;
  }
  const seen = parsed[flag];
  parsed[flag] = [...(typeof seen === "string" ? [seen] : (seen ?? [])), value];
}

/** Parse `--flag value` pairs plus the valueless switches. An unknown flag is a refusal. */
export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const parsed: ParsedArgs = {};
  const required = `${REQUIRED_FLAGS.join(", ")} (+ ${SWITCHES.map((name) => `--${name}`).join(", ")})`;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    index += 1;
    const flag = token.replace(/^--/, "");
    if ((SWITCHES as ReadonlyArray<string>).includes(flag)) {
      parsed[flag] = "true";
      continue;
    }
    if (!(FLAGS as ReadonlyArray<string>).includes(flag)) {
      throw new Error(`unknown flag --${flag}; required flags: ${required}`);
    }
    const value = argv[index];
    if (value === undefined) {
      throw new Error(
        `missing value for ${token}; required flags: ${required}`
      );
    }
    record(parsed, flag, value);
    index += 1;
  }
  return parsed;
}

function numberFlag(parsed: ParsedArgs, flag: string): number {
  const raw = single(parsed, flag);
  if (raw === undefined) throw new Error(`missing required flag --${flag}`);
  return Number(raw);
}

/** A flag that must be present and non-blank. Absence is a refusal, never a default. */
function requiredFlag(parsed: ParsedArgs, flag: string): string {
  const value = single(parsed, flag);
  if (value === undefined || value.trim() === "")
    throw new Error(`missing required flag --${flag}`);
  return value;
}

function paramsFrom(parsed: ParsedArgs): ConfigParams {
  return {
    datasetRoot: requiredFlag(parsed, "dataset-root"),
    bundlePath: requiredFlag(parsed, "bundle"),
    nodeArchivePath: requiredFlag(parsed, "node-archive"),
    settingsPath: requiredFlag(parsed, "settings"),
    runRoot: requiredFlag(parsed, "run-root"),
    agentWallSec: numberFlag(parsed, "agent-wall-sec"),
    graderGraceSec: numberFlag(parsed, "grader-grace-sec"),
    bundleGlibcxxFloor: requiredFlag(parsed, "bundle-glibcxx-floor"),
    tokenCeiling: {
      input: numberFlag(parsed, "token-ceiling-input"),
      output: numberFlag(parsed, "token-ceiling-output"),
    },
  };
}

/**
 * The claimed ceiling, or `null` when neither flag was supplied. Half a ceiling is a refusal:
 * silently filling in the missing half would invent a budget the operator never claimed.
 */
function ceilingFrom(parsed: ParsedArgs): TokenCeiling | null {
  const hasInput = single(parsed, "token-ceiling-input") !== undefined;
  const hasOutput = single(parsed, "token-ceiling-output") !== undefined;
  if (!hasInput && !hasOutput) return null;
  if (hasInput !== hasOutput) {
    throw new Error(
      "--token-ceiling-input and --token-ceiling-output must both be given, or neither"
    );
  }
  return {
    inputTokens: numberFlag(parsed, "token-ceiling-input"),
    outputTokens: numberFlag(parsed, "token-ceiling-output"),
  };
}

/** A container variable name `docker run -e` accepts; anything else is a refusal. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A whole-word component that makes a container variable a credential, whatever prefix a
 * provider puts in front of it (`OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`,
 * `DB_PASSWORD`). Deliberately shaped so the proxy variables the runbook documents —
 * `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` — are untouched.
 */
const CREDENTIAL_NAME =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|PRIVATE_?KEY|TOKEN|PASSWO?RD|CREDENTIALS?|AUTH)(?:_|$)/;

/**
 * Well-known provider key shapes, matched inside a VALUE so a key smuggled through an
 * innocent variable name (`HTTPS_PROXY=https://user:sk-…@proxy`) is still caught.
 */
const CREDENTIAL_VALUE =
  /(?:^|[^A-Za-z0-9])(?:sk|pk|rk|ghp|gho|ghu|ghs|xox[abps]|AKIA|AIza)[-_][A-Za-z0-9_-]{8,}/;

/**
 * Environment variables whose live values must never be forwarded, however they are spelled.
 * Read only to COMPARE against a supplied value; the value itself never enters a message.
 */
const CREDENTIAL_ENV_NAMES = [
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
];

/**
 * Refuse a credential-looking `--container-env` before any `docker` argv exists.
 *
 * The REAL attempt path forwards these verbatim as `-e NAME=VALUE`, so
 * `--container-env OPENAI_API_KEY=sk-live-…` landed in the container environment AND in the
 * argv of every `docker` process on the host, visible to `ps` to anything else on the box.
 * The settings file is `docker cp`'d into the container instead, deliberately: that is the
 * one credential route this instrument has.
 *
 * The refusal names the VARIABLE and NEVER its value. This string is what the operator reads
 * on stderr and what CI keeps; a guard that prints the secret it just caught copies that
 * secret into the terminal, the log and every transcript of it.
 */
function assertNotACredential(name: string, value: string): void {
  if (CREDENTIAL_NAME.test(name)) {
    throw new Error(
      `--container-env ${name} names a credential; the eval container receives provider ` +
        `credentials through the settings file docker cp's in, never through a forwarded -e flag`
    );
  }
  const liveSecret = CREDENTIAL_ENV_NAMES.some(
    (envName) =>
      process.env[envName] !== undefined &&
      value.includes(process.env[envName] as string)
  );
  if (CREDENTIAL_VALUE.test(value) || liveSecret) {
    throw new Error(
      `--container-env ${name} carries a credential-shaped value; refusing to forward it to ` +
        `a container and to the argv of every docker process on this host`
    );
  }
}

/**
 * Parse the repeatable `--container-env NAME=VALUE` flag into the map the docker runner forwards.
 *
 * Only the FIRST `=` separates the name, so a proxy URL carrying credentials and a space stays
 * one value. A malformed entry is a refusal rather than a dropped flag: silently ignoring it
 * would let a run reach the network with an environment the operator never asked for. An empty
 * value is refused for the same reason — the runner drops those, so accepting one here would
 * apply nothing while appearing to succeed. A credential-looking entry is refused as well, so
 * the REAL attempt path carries the guard the smoke path has always carried.
 *
 * `undefined` means the flag was never given, which is what keeps the default run's argv
 * byte-identical to the argv that existed before this flag did.
 */
function containerEnvFrom(
  parsed: ParsedArgs
): Readonly<Record<string, string>> | undefined {
  const raw = parsed["container-env"];
  if (raw === undefined) return undefined;
  const occurrences = typeof raw === "string" ? [raw] : raw;
  const containerEnv: Record<string, string> = {};
  for (const entry of occurrences) {
    const at = entry.indexOf("=");
    const name = entry.slice(0, at < 0 ? 0 : at);
    const value = at < 0 ? "" : entry.slice(at + 1);
    if (at < 0 || !ENV_NAME.test(name)) {
      throw new Error(
        `--container-env needs NAME=VALUE with a shell-style NAME; got ${JSON.stringify(entry)}`
      );
    }
    if (value === "") {
      throw new Error(
        `--container-env ${name}= has an empty value, which docker run would not forward; omit the flag instead`
      );
    }
    assertNotACredential(name, value);
    containerEnv[name] = value;
  }
  return containerEnv;
}

/**
 * The REAL attempt path's runner, wired with whatever container env the operator supplied.
 *
 * `exec` defaults to the real one so `main` needs no seam of its own; a test passes a recording
 * exec instead. `provisionTimeoutMs` is passed as `undefined` so `docker.ts` keeps owning that
 * default: restating `900_000` here would be a second copy of a number this file does not
 * define, free to drift from the one the runner actually uses.
 */
export function dockerRunnerFor(
  parsed: ParsedArgs,
  exec: ExecFn = defaultExec
): RunnerPort {
  return createDockerRunner(exec, undefined, {
    containerEnv: containerEnvFrom(parsed),
  });
}

/**
 * Build the provisioning spec for one slot.
 *
 * `outDir` is a parameter, not a derivation, because the GATE and the ATTEMPT must not share
 * one: `docker run -v` auto-creates a missing bind source, so a gate that provisioned inside
 * the attempt directory would create it and the dispatch's `reserveAttemptDir` would then
 * refuse the very attempt it was about to make. See `gateDirFor` and `attemptDirFor`.
 *
 * The identity comes from the RESOLVED manifest, never from an ad-hoc literal: an identity
 * with empty shas is exactly the placeholder that `identities.isPlaceholder` refuses, and
 * a runner provisioned against one cannot prove which instrument it ran.
 *
 * `ensureMountAlias` runs here, at the single place a spec is built, because a colon-bearing
 * `outDir` is only mountable through an alias and the alias must exist BEFORE `docker run`
 * gets the chance to auto-create a real directory in its place.
 */
function provisionSpecFor(
  params: ConfigParams,
  slot: DriverSlot,
  identity: RunIdentity,
  outDir: string
): ProvisionSpec {
  ensureMountAlias(outDir);
  return {
    identity,
    taskDir: taskDirFor(params, slot),
    outDir,
    bundlePath: params.bundlePath,
    nodeArchivePath: params.nodeArchivePath,
    settingsPath: params.settingsPath,
  };
}

/** Where the task's own files live: its instruction, tests, solution and declaration. */
function taskDirFor(params: ConfigParams, slot: ManifestSlot): string {
  return join(params.datasetRoot, "tasks", slot.task);
}

/**
 * The verifier timeout for one task, in seconds: the task's own declaration when it ships
 * one, otherwise the global fallback. Callers add `graderGraceSec` on top, so this is the
 * declared budget rather than the wall.
 *
 * Read through the spec rather than re-deriving the task directory, so the gate and the
 * attempt cannot disagree about which task's limit applies.
 */
function verifierTimeoutSecFor(spec: ProvisionSpec): number {
  return (
    declaredVerifierTimeoutSec(spec.taskDir) ?? FALLBACK_VERIFIER_TIMEOUT_SEC
  );
}

/**
 * The ATTEMPT's output directory. Its name is load-bearing and must not change:
 * `report.ts` re-derives it as `join(runRoot, slotKey)` in four places to read the records
 * back, so a "prettier" name here would silently empty every denominator the report prints.
 */
function attemptDirFor(params: ConfigParams, slot: DriverSlot): string {
  return join(params.runRoot, slot.slotKey);
}

/**
 * The GATE's scratch directory, deliberately NOT the attempt directory.
 *
 * `docker run -v` auto-creates a missing host source, so a gate probing in the attempt
 * directory created the very directory the dispatch then found already there — and
 * `reserveAttemptDir`, which exists precisely to refuse accidental reuse, threw
 * `AttemptDirReservedError` after the gate had passed. The reservation is the guarantee, so
 * the probe moves instead of the reservation weakening: the gate gets its own tree, keeps the
 * SAME `sharedMounts` wiring it always used, and leaves the attempt directory untouched.
 */
function gateDirFor(params: ConfigParams, slot: DriverSlot): string {
  return join(params.runRoot, GATE_SCRATCH_DIR, slot.slotKey);
}

/**
 * Usage read back from the retained traces; `null` means UNKNOWN, never zero.
 *
 * Deliberately independent of the evidence-completeness verdict: usage is a measurement,
 * while completeness is a separate question about what else should have been retained.
 * Conflating them would report a measured, real spend as unknown and halt the whole run.
 *
 * Stays here rather than moving to `./report.js` because it is a MEASUREMENT seam, injected
 * into `attempt.runAttempt` as `readUsage`; the report half only ever reads it back.
 */
export function usageFromEvidence(dir: string): UsageRecord | null {
  // An attempt directory that never existed is UNKNOWN usage. An existing directory that
  // retained no traces is a real zero. Conflating the two would let a lost attempt record
  // read as a free dispatch against the budget.
  if (!existsSync(dir)) return null;
  try {
    const tally = tallyAttempt(dir);
    return {
      inputTokens: tally.tokens.input_tokens,
      outputTokens: tally.tokens.output_tokens,
      cacheCreationInputTokens: tally.tokens.cache_creation_input_tokens,
      cacheReadInputTokens: tally.tokens.cache_read_input_tokens,
    };
  } catch {
    // Unreadable traces are unknown usage, which the ceiling then refuses to spend past.
    return null;
  }
}

export interface DriverWiring {
  /** Only what the wiring actually consumes, so a test need not build a whole config. */
  readonly config: Pick<ResolvedConfig, "manifest" | "identityFor">;
  readonly runner: RunnerPort;
  readonly ledgerPath: string;
  readonly params: ConfigParams;
}

/**
 * How the gate's oracle measurement ended when it ended at all.
 *
 * `ok` is not a member: a completed measurement is a `PreflightMeasurement` that `runGate`
 * judges, and only a REFUSAL needs a name here.
 */
export type OracleRefusalKind =
  "oracle-unavailable" | "oracle-not-applicable" | "oracle-failed";

/**
 * The gate cannot measure this slot, because no oracle could be measured.
 *
 * Deliberately a throw and not a returned measurement: a `PreflightMeasurement` cannot say
 * "nothing was measured" without inventing a `graderExit`/`oracleReward` pair, and a
 * fabricated `reward=0` is the one verdict this instrument must never produce.
 */
export class OracleGateRefusal extends Error {
  constructor(
    readonly kind: OracleRefusalKind,
    message: string
  ) {
    super(message);
    this.name = "OracleGateRefusal";
  }
}

/**
 * The runner's oracle entry point, or a refusal.
 *
 * The absence check is the load-bearing part of the optional port method: falling back to
 * `grade()` here would re-measure a pristine workspace and report it as the gate's verdict,
 * which is the defect this whole path exists to remove — and it would do so invisibly, since a
 * fallback looks exactly like a passing run.
 */
function oracleGraderFor(
  runner: RunnerPort
): (
  spec: ProvisionSpec,
  graderWallSec: number
) => Promise<OracleGradeObservation> {
  const gradeOracle = runner.gradeOracle?.bind(runner);
  if (gradeOracle === undefined) {
    throw new OracleGateRefusal(
      "oracle-unavailable",
      `runner ${runner.version} cannot apply a reference solution; grading a pristine ` +
        `workspace proves nothing about this task, so the gate refuses instead of measuring`
    );
  }
  return gradeOracle;
}

/** Classify a thrown value as an oracle refusal, or `null` for anything else. */
function oracleRefusalKindOf(error: unknown): OracleRefusalKind | null {
  if (error instanceof OracleGateRefusal) return error.kind;
  if (error instanceof OracleNotApplicableError) return "oracle-not-applicable";
  if (error instanceof OracleFailedError) return "oracle-failed";
  return null;
}

/**
 * Turn an oracle refusal into the gate's own verdict: a GATE FAILURE.
 *
 * `kind: "reject"` is the distinction that matters. An exclusion (`kind: "exclude"`) is a
 * property of the task — it skips one slot and the frozen list continues — while a reject is a
 * statement about the harness and stops the WHOLE driver with a nonzero exit. A task with no
 * `solution/solve.sh`, or a broken reference solution, is the harness's inability to measure,
 * never the task's fault, so charging it as an exclusion is exactly what issue 1219 exists to
 * stop. `excluded: false` and the `gate:`-prefixed ledger row `retainGateOutcome` writes for a
 * reject keep it in the gate-failure bucket.
 *
 * `record: null` because there is no measurement: no gate record is retained, so a later
 * `--report-only` pass finds no record for this identity and says `REJECT:no-record` — the very
 * verdict stated here, rather than a stale one. `preflight.ts` owns the `REJECT:*` union and is
 * deliberately not widened by this file, so the specific cause travels in `reasons`, which is
 * what `recordGateFailure` puts in front of the operator.
 */
export function oracleRefusalDecision(error: unknown): GateDecision | null {
  const kind = oracleRefusalKindOf(error);
  if (kind === null) return null;
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: "reject",
    verdict: "REJECT:no-record",
    record: null,
    reasons: [kind, message],
    excluded: false,
    stopDriver: true,
  };
}

/**
 * Measure one slot through the REAL provisioning path. The measurement is produced here and
 * judged by `runGate`; nothing in this function interprets it.
 *
 * The gate owns a container exactly as an attempt does, so it reaps in a `finally` for the same
 * reason `dispatchFor` does: a grade that throws — including either oracle refusal, which is
 * thrown before any grade exists — must not leave the probe's container running.
 */
async function probeMeasurement(
  runner: RunnerPort,
  spec: ProvisionSpec,
  params: ConfigParams
): Promise<PreflightMeasurement> {
  try {
    // Before `provision`: a runner that cannot run the oracle must not create a container.
    const gradeOracle = oracleGraderFor(runner);
    const provision = await runner.provision(spec);
    const grade = await gradeOracle(
      spec,
      verifierTimeoutSecFor(spec) + params.graderGraceSec
    );
    return {
      glibcxxMeasured: provision.glibcxxMeasured,
      bundleGlibcxxFloor: params.bundleGlibcxxFloor,
      runnerWiringOk: provision.bootVerified && provision.logsMountWritable,
      graderExit: grade.exitCode,
      oracleReward: grade.reward,
      ctrfBytes: grade.ctrfBytes,
      resultLine: grade.resultLine,
      networkFailureMarker: grade.networkFailureMarker,
    };
  } finally {
    await runner.reap(spec);
  }
}

/**
 * Run the gate for one slot: measure an ORACLE-APPLIED workspace, or refuse.
 *
 * The refusal path exists because `runGate` has no catch: without it, `OracleNotApplicableError`
 * and `OracleFailedError` would escape `runGate` → `gateFor` → `deps.gate(slot)` as an
 * unhandled crash, with no report, no exit code the operator can act on, and no ledger row —
 * a refusal indistinguishable from a bug. Anything that is not one of those two typed refusals
 * is rethrown unchanged, so a real fault still surfaces as a real fault.
 */
async function probeGate(
  wiring: DriverWiring,
  slot: DriverSlot
): Promise<GateDecision> {
  const { config, runner, params } = wiring;
  const identity = config.identityFor(slot);
  const outDir = gateDirFor(params, slot);
  // Owned, not left to the daemon: the scratch tree exists because this function made it.
  mkdirSync(outDir, { recursive: true });
  const spec: ProvisionSpec = provisionSpecFor(params, slot, identity, outDir);
  try {
    return await runGate(
      identity,
      async (): Promise<PreflightMeasurement> =>
        probeMeasurement(runner, spec, params),
      Date.now()
    );
  } catch (error) {
    const refusal = oracleRefusalDecision(error);
    if (refusal === null) throw error;
    return refusal;
  }
}

/**
 * Run the MANDATORY preflight gate for one slot, with zero model dispatch, and retain what
 * it measured. `runGate` never writes to disk, so without this step the decision was consumed
 * by the driver and lost: the run left nothing that said which instrument was gated, or how.
 *
 * The retention is handed a narrow projection of the wiring rather than the wiring itself:
 * writing a verdict needs an identity binding and three paths, not a Docker port.
 */
async function gateFor(
  wiring: DriverWiring,
  slot: DriverSlot
): Promise<GateDecision> {
  const decision = await probeGate(wiring, slot);
  retainGateOutcome(
    {
      runRoot: wiring.params.runRoot,
      ledgerPath: wiring.ledgerPath,
      bundlePath: wiring.params.bundlePath,
      settingsPath: wiring.params.settingsPath,
      identityFor: wiring.config.identityFor,
    },
    slot,
    decision
  );
  return decision;
}

/** Dispatch exactly one attempt: ledger intent first, then the runner. */
async function dispatchFor(
  wiring: DriverWiring,
  slot: DriverSlot
): Promise<void> {
  const { config, runner, ledgerPath, params } = wiring;
  const identity = config.identityFor(slot);
  const spec: ProvisionSpec = provisionSpecFor(
    params,
    slot,
    identity,
    attemptDirFor(params, slot)
  );
  const handle = beginAttempt({
    runRoot: params.runRoot,
    slotsDir: join(params.runRoot, "slots"),
    slotKey: slot.slotKey,
    task: slot.task,
    arm: slot.arm,
    maxTurns: slot.maxTurns,
    identity,
    ledgerPath,
    bundlePath: params.bundlePath,
    settingsPath: params.settingsPath,
  });
  try {
    await runAttempt(handle, ledgerPath, {
      runner,
      provisionSpec: spec,
      maxTurns: slot.maxTurns,
      agentWallSec: params.agentWallSec,
      graderGraceSec: params.graderGraceSec,
      declaredVerifierTimeoutSec: verifierTimeoutSecFor(spec),
      readUsage: usageFromEvidence,
    });
  } finally {
    // Reap owned containers on every path, including a thrown dispatch.
    await runner.reap(spec);
  }
}

/** Wire the seams. Every dependency the loop needs is passed in, never imported ad hoc. */
export function wireDeps(wiring: DriverWiring) {
  const ceil: TokenCeiling = {
    inputTokens: wiring.params.tokenCeiling.input,
    outputTokens: wiring.params.tokenCeiling.output,
  };
  const budget = () =>
    // `spendForLedger`, not `aggregateSpend(rows)`: an unreadable ledger has no rows, and
    // no rows are vacuously complete usage. That reading cleared the budget and dispatched
    // real money against a budget the run could no longer account for.
    ceilingVerdict(spendForLedger(readLedger(wiring.ledgerPath)), ceil);
  return {
    slots: driverSlotsOf(wiring.config.manifest),
    identityFor: wiring.config.identityFor,
    gate: (slot: DriverSlot) => gateFor(wiring, slot),
    dispatch: (slot: DriverSlot) => dispatchFor(wiring, slot),
    mayDispatchMore: () => budget().mayDispatch,
    budgetReason: () => budget().reason,
  };
}

/**
 * Run the frozen slot list, classifying a contended slot rather than letting it escape.
 *
 * `claimSlot` throws `SlotClaimError` when another driver already holds the slot. Left to a
 * catch-all it exits 1 with a message and NO stop reason, so an ordinary two-driver race was
 * indistinguishable from a crash — and produced no report at all. `StopReason` already
 * declares the case; this constructs it.
 *
 * The driver's `dispatched`/`excluded` tallies are lost when it throws, so they are reported
 * empty here. The artifact does not restate them: per-attempt truth is derived from the
 * ledger, which still has every row the contended run wrote.
 */
export async function runSlots(wiring: DriverWiring): Promise<DriverExit> {
  try {
    return await runDriver(wireDeps(wiring));
  } catch (error) {
    if (!(error instanceof SlotClaimError)) throw error;
    return {
      code: 1,
      stopReason: "slot-unavailable",
      stoppedAt: error.slotKey,
      dispatched: [],
      excluded: [],
    };
  }
}

/**
 * The identity the manifest requires for a slot, for the paths where no config was resolved.
 *
 * `resolveConfig().identityFor` is the same construction and is what a live run provisions
 * with; it is used whenever a resolved config exists. `--report-only` has no config to
 * resolve, so this reproduces the binding rather than reading an identity back out of a
 * retained record — a record must never be able to vouch for itself. A test pins the two
 * field for field, so the two cannot drift apart silently.
 */
export function identityForSlot(
  manifest: EvalManifest,
  slot: ManifestSlot
): RunIdentity {
  return {
    runId: manifest.runId,
    task: slot.task,
    image: slot.image,
    imageDigest: slot.imageDigest,
    datasetCommit: manifest.datasetCommit,
    bundleSha256: manifest.bundleSha256,
    nodeArchiveSha256: manifest.nodeArchiveSha256,
    runnerVersion: manifest.runnerVersion,
    outputLayout: manifest.outputLayout,
  };
}

/** Injected seams. Only the runner needs one: it is what keeps a test off Docker. */
export interface MainOptions {
  readonly runner?: RunnerPort;
}

/**
 * The audit path: emit the report from what a run retained and dispatch nothing. It refuses
 * to create the run root it was asked to read, so a mistyped path reports a refusal instead of
 * a confident all-zero run.
 */
function reportOnly(
  parsed: ParsedArgs,
  manifest: EvalManifest,
  runRoot: string
): RunReport {
  if (!existsSync(runRoot)) {
    throw new Error(
      `--report-only needs an existing run root to audit; ${runRoot} does not exist`
    );
  }
  const report = buildReport({
    mode: "report-only",
    ledgerPath: join(runRoot, LEDGER_FILE),
    runRoot,
    manifest,
    identityFor: (slot) => identityForSlot(manifest, slot),
    ceiling: ceilingFrom(parsed),
    exit: null,
  });
  return persistReport(runRoot, report);
}

/**
 * Run the frozen list, then emit the report the run's records support. The report is emitted
 * on every exit the driver can return, including a ceiling stop and a contended slot, because
 * a run that stopped early is precisely the run whose totals most need stating.
 */
export async function main(
  argv: ReadonlyArray<string>,
  options: MainOptions = {}
): Promise<RunReport> {
  const parsed = parseArgs(argv);
  const manifest = parseManifest(
    readFileSync(requiredFlag(parsed, "manifest"), "utf8")
  );
  if (parsed["report-only"] !== undefined) {
    return reportOnly(parsed, manifest, requiredFlag(parsed, "run-root"));
  }
  const params = paramsFrom(parsed);
  const config = resolveConfig(params, manifest);
  mkdirSync(params.runRoot, { recursive: true });
  const wiring: DriverWiring = {
    config,
    runner: options.runner ?? dockerRunnerFor(parsed),
    ledgerPath: join(params.runRoot, LEDGER_FILE),
    params,
  };
  const report = buildReport({
    mode: "run",
    ledgerPath: wiring.ledgerPath,
    runRoot: params.runRoot,
    manifest,
    identityFor: config.identityFor,
    ceiling: {
      inputTokens: params.tokenCeiling.input,
      outputTokens: params.tokenCeiling.output,
    },
    exit: await runSlots(wiring),
  });
  return persistReport(params.runRoot, report);
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith("cli.ts");
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((report) => {
      process.exitCode = report.code;
      console.log(JSON.stringify(report));
    })
    .catch((error: unknown) => {
      console.error(String(error));
      process.exitCode = 1;
    });
}
