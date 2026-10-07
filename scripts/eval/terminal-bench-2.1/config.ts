/**
 * Configuration resolution for the headless terminal-bench-2.1 driver.
 *
 * Why it exists (issue 1219 requirement 1): every path, limit and pinned sha the #1212
 * scripts needed was a hardcoded machine default — `/home/winner/eval-1189/dataset`,
 * a specific bundle tarball, a specific node tarball, `BUNDLE_GLIBCXX_FLOOR="3.4.31"`
 * which was not overridable at all, `AGENT_WALL=2700`, `GRADER_GRACE=600`. A driver
 * only functioned from inside one directory (`ROOT = dirname(__file__)`), so the same
 * code could not be pointed at another dataset at all.
 *
 * Every value here comes from an explicit parameter or from a manifest on disk. There
 * are no defaults for the things that vary per machine: a still-placeholder value makes
 * resolution FAIL rather than silently reading one operator's home directory.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isPlaceholder, type RunIdentity } from "./identities.js";

/** One frozen slot in the manifest: a task, and how it is attempted. */
export interface ManifestSlot {
  readonly task: string;
  readonly image: string;
  readonly imageDigest: string;
  readonly maxTurns: number;
  /** `pilot` for a single frozen list, `arms` for the paired study. */
  readonly arm: string;
}

/** A slot plus the key that reserves it. The key is the cross-driver exclusivity unit. */
export interface DriverSlot extends ManifestSlot {
  readonly slotKey: string;
}

/**
 * Slot key: task, arm and turn cap together. Two arms of one task differ here, which is
 * what lets a paired study run both arms without either claiming the other's slot.
 */
export function slotKeyOf(slot: ManifestSlot): string {
  return `${slot.task}:${slot.arm}:${slot.maxTurns}`;
}

/** Expand a manifest into the ordered slot list the driver consumes. */
export function driverSlotsOf(
  manifest: EvalManifest
): ReadonlyArray<DriverSlot> {
  return manifest.slots.map((slot) => ({ ...slot, slotKey: slotKeyOf(slot) }));
}

export interface EvalManifest {
  readonly runId: string;
  readonly datasetCommit: string;
  readonly bundleSha256: string;
  readonly nodeArchiveSha256: string;
  readonly runnerVersion: string;
  readonly outputLayout: string;
  readonly slots: ReadonlyArray<ManifestSlot>;
  /** Frozen before any outcome existed; recorded so a later edit is detectable. */
  readonly frozenBeforeAnyOutcome: boolean;
}

/** Explicit operator inputs. Nothing here has a machine-specific default. */
export interface ConfigParams {
  readonly datasetRoot: string;
  readonly bundlePath: string;
  readonly nodeArchivePath: string;
  /** Settings are hashed only; their contents never enter a fixture or report. */
  readonly settingsPath: string;
  readonly runRoot: string;
  readonly agentWallSec: number;
  readonly graderGraceSec: number;
  /** Measured-library floor the bundle requires. Was a non-overridable literal in #1212. */
  readonly bundleGlibcxxFloor: string;
  readonly tokenCeiling: { readonly input: number; readonly output: number };
}

export interface ResolvedConfig {
  readonly params: ConfigParams;
  readonly manifest: EvalManifest;
  /** Identity of the run as a whole (slot-independent fields). */
  readonly identityFor: (slot: ManifestSlot) => RunIdentity;
}

export class ConfigError extends Error {
  constructor(readonly problems: ReadonlyArray<string>) {
    super(`unusable eval configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

const PATH_PARAMS = [
  "datasetRoot",
  "bundlePath",
  "nodeArchivePath",
  "settingsPath",
  "runRoot",
] as const;
const LIMIT_PARAMS = ["agentWallSec", "graderGraceSec"] as const;
const GLIBCXX_FLOOR = /^GLIBCXX_\d+\.\d+\.\d+$/;

function pathProblems(params: ConfigParams): string[] {
  return PATH_PARAMS.filter((key) => isPlaceholder(params[key])).map(
    (key) => `${key} is still a placeholder: ${JSON.stringify(params[key])}`
  );
}

function limitProblems(params: ConfigParams): string[] {
  return LIMIT_PARAMS.filter(
    (key) => !Number.isFinite(params[key]) || params[key] <= 0
  ).map((key) => `${key} must be a positive number`);
}

function ceilingProblems(
  ceiling: ConfigParams["tokenCeiling"] | undefined
): string[] {
  if (ceiling === null || ceiling === undefined)
    return ["tokenCeiling must be provided"];
  return ceiling.input > 0 && ceiling.output > 0
    ? []
    : ["tokenCeiling input/output must both be positive"];
}

/** Validate explicit parameters. Returns the problems rather than throwing, to compose. */
export function validateConfigParams(params: ConfigParams): string[] {
  const floor = GLIBCXX_FLOOR.test(params.bundleGlibcxxFloor)
    ? []
    : [
        `bundleGlibcxxFloor must look like GLIBCXX_3.4.31; got ${JSON.stringify(params.bundleGlibcxxFloor)}`,
      ];
  return [
    ...pathProblems(params),
    ...floor,
    ...limitProblems(params),
    ...ceilingProblems(params.tokenCeiling),
  ];
}

/**
 * Slot fields that become PATH SEGMENTS, and therefore must be bare names.
 *
 * `task` is joined into `join(datasetRoot, "tasks", slot.task)` — the bind-mount source for
 * the grader's tests — and both `task` and `arm` are joined by `slotKeyOf` into the
 * `task:arm:maxTurns` directory name under `runRoot`. A `../..` in either escapes the run
 * root; a `/` splits the segment; `\` does the same to any tool that normalises it; and a
 * leading `-` is a flag to any argv that carries it through.
 *
 * `:` is already structurally illegal in both: `slotKeyOf` joins on it, so a colon-bearing
 * task name produces a slot key that cannot be parsed back — which is why the runner has to
 * alias a colon-bearing output directory before it can mount it at all.
 *
 * `image` and `imageDigest` are deliberately NOT in this set: they are OCI references
 * (`alexgshaw/adaptive-rejection-sampler:20251031`, `sha256:…`) that are never joined into a
 * path, and refusing the separator they legitimately contain would refuse every real task.
 */
const PATH_SEGMENT_SLOT_FIELDS = ["task", "arm"] as const;

/** Why one slot field cannot be a path segment; `null` when it is a bare name. */
function slotSegmentProblem(value: string): string | null {
  if (value.trim() === "") return "must be a non-empty string";
  if (value.includes("..")) return 'must not contain ".."';
  if (/[/\\]/.test(value)) return "must not contain a path separator";
  if (value.includes(":")) return 'must not contain ":"';
  if (value.startsWith("-")) return "must not start with a dash";
  return null;
}

/**
 * Validate a parsed manifest. An empty slot list is a refusal, not an empty run: the
 * #1212 pilot's whole value was that its frozen list was explicit.
 */
export function validateManifest(manifest: unknown): string[] {
  if (manifest === null || typeof manifest !== "object")
    return ["manifest must be an object"];
  const doc = manifest as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of [
    "runId",
    "datasetCommit",
    "bundleSha256",
    "nodeArchiveSha256",
    "runnerVersion",
    "outputLayout",
  ]) {
    const value = doc[field];
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`manifest.${field} must be a non-empty string`);
    }
  }
  const slots = doc.slots;
  if (!Array.isArray(slots) || slots.length === 0) {
    problems.push("manifest.slots must be a non-empty array");
    return problems;
  }
  slots.forEach((slot, index) => {
    const entry = slot as Record<string, unknown>;
    for (const field of PATH_SEGMENT_SLOT_FIELDS) {
      const value = entry[field];
      if (typeof value !== "string") {
        problems.push(
          `manifest.slots[${index}].${field} must be a non-empty string`
        );
        continue;
      }
      const problem = slotSegmentProblem(value);
      // The field AND the value, so a refused manifest says which entry to fix.
      if (problem !== null)
        problems.push(
          `manifest.slots[${index}].${field} ${problem}; got ${JSON.stringify(value)}`
        );
    }
    for (const field of ["image", "imageDigest"]) {
      if (
        typeof entry[field] !== "string" ||
        (entry[field] as string).trim() === ""
      ) {
        problems.push(
          `manifest.slots[${index}].${field} must be a non-empty string`
        );
      }
    }
    const maxTurns = entry.maxTurns;
    if (
      typeof maxTurns !== "number" ||
      !Number.isInteger(maxTurns) ||
      maxTurns <= 0
    ) {
      problems.push(
        `manifest.slots[${index}].maxTurns must be a positive integer`
      );
    }
  });
  if (doc.frozenBeforeAnyOutcome !== true) {
    problems.push("manifest.frozenBeforeAnyOutcome must be true");
  }
  return problems;
}

/** Parse and validate manifest JSON. Throws `ConfigError` on malformed or empty input. */
export function parseManifest(text: string): EvalManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError([
      `manifest is not valid JSON: ${(error as Error).message}`,
    ]);
  }
  const problems = validateManifest(parsed);
  if (problems.length > 0) throw new ConfigError(problems);
  return parsed as EvalManifest;
}

/**
 * Resolve configuration. Both the explicit parameters and the manifest are validated;
 * any problem refuses the start rather than defaulting to a machine-specific value.
 */
export function resolveConfig(
  params: ConfigParams,
  manifest: EvalManifest
): ResolvedConfig {
  const problems = [
    ...validateConfigParams(params),
    ...validateManifest(manifest),
  ];
  if (problems.length > 0) throw new ConfigError(problems);
  return {
    params,
    manifest,
    identityFor: (slot) => ({
      runId: manifest.runId,
      task: slot.task,
      image: slot.image,
      imageDigest: slot.imageDigest,
      datasetCommit: manifest.datasetCommit,
      bundleSha256: manifest.bundleSha256,
      nodeArchiveSha256: manifest.nodeArchiveSha256,
      runnerVersion: manifest.runnerVersion,
      outputLayout: manifest.outputLayout,
    }),
  };
}

// ---------------------------------------------------------------------------
// The task's own declared limits
// ---------------------------------------------------------------------------

/** The declaration every terminal-bench task ships beside its instruction and tests. */
const TASK_DECLARATION = "task.toml";

/** A `[table]` or `[[array of tables]]` header; either one ends the section above it. */
const TOML_HEADER = /^\[\[?\s*([A-Za-z0-9_.-]+)\s*\]\]?$/;

/** `timeout_sec = 900.0`, with an optional trailing comment. Only inside `[verifier]`. */
const TOML_TIMEOUT_KEY = /^\s*timeout_sec\s*=\s*([^#\s]+)/;

/**
 * The task's declared verifier timeout in seconds, or `null` when it declares none.
 *
 * It is read from the task's own `task.toml` because that is where the dataset states the
 * grader's budget — `[verifier] timeout_sec = 900.0` — and a constant in this driver both
 * over-runs a task that declares less and kills one that declares more.
 *
 * THIS IS NOT A TOML PARSER. The repo has no TOML dependency and this reads exactly one
 * key out of exactly one section, so nothing here interprets TOML semantics: any header
 * closes the section it follows, so `[verifier.env]` cannot donate a key to `[verifier]`,
 * and only `timeout_sec` is ever read.
 *
 * IT FAILS CLOSED, and that is the whole contract: an absent, unreadable, malformed,
 * zero or negative declaration returns `null`, meaning "no declared limit". The caller then
 * falls back to its global constant. Guessing a limit from a file this reader does not
 * understand would be exactly the silent substitution the rest of this module refuses.
 *
 * `[agent] timeout_sec` is deliberately NOT read here: it is the agent's budget, not the
 * grader's, and `agentWallSec` stays the operator's flag.
 */
export function declaredVerifierTimeoutSec(taskDir: string): number | null {
  let text: string;
  try {
    text = readFileSync(join(taskDir, TASK_DECLARATION), "utf8");
  } catch {
    return null;
  }
  let inVerifier = false;
  for (const line of text.split("\n")) {
    const header = TOML_HEADER.exec(line.trim());
    if (header !== null) {
      inVerifier = header[1] === "verifier";
      continue;
    }
    if (!inVerifier) continue;
    const key = TOML_TIMEOUT_KEY.exec(line);
    if (key === null) continue;
    const seconds = Number(key[1]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }
  return null;
}
