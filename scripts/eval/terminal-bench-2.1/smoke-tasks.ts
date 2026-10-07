/**
 * Task enumeration and per-task fact collection, container-free until the caller asks.
 *
 * Why this seam (issue 1219, bug 3): reading the dataset, probing an image's tool chain and
 * building the one `ProvisionSpec` every other module consumes is a distinct responsibility
 * from running a grader, and it is the part a reader wants to audit before trusting any
 * verdict: an undeclared image, a missing grader or an unmeasured library ceiling has to be
 * visible in the report rather than inferred later.
 *
 * Every function here is pure or read-only. The single write is `prepareAttemptDir`, which
 * only creates the host directories the `/logs` bind mount depends on.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { ExecFn } from "./docker.js";
import { mountBindSource } from "./runner.js";
import type { MountSpec, ProvisionSpec } from "./runner.js";
import {
  CONTAINER_PREFIX,
  PROBE_FAILED,
  VERIFIER_DIR,
  type SmokeContext,
  type SmokeOptions,
  type TaskFacts,
} from "./smoke-types.js";
import type { RunIdentity } from "./identities.js";

const PROBE_TIMEOUT_MS = 60_000;

async function dockerImageExists(
  exec: ExecFn,
  image: string
): Promise<boolean | null> {
  return (
    await exec("docker", ["image", "inspect", image], {
      timeoutMs: PROBE_TIMEOUT_MS,
    })
  ).code === 0
    ? true
    : null;
}

const GLIBCXX_PROBE =
  "grep -ao 'GLIBCXX_3\\.4\\.[0-9]*' /usr/lib/x86_64-linux-gnu/libstdc++.so.6 2>/dev/null | sort -V | tail -1";

async function imageGlibcxx(exec: ExecFn, image: string): Promise<string> {
  const run = await exec(
    "docker",
    ["run", "--rm", image, "bash", "-c", GLIBCXX_PROBE],
    { timeoutMs: PROBE_TIMEOUT_MS }
  );
  // A nonzero exit means the probe NEVER RAN — no `bash` in the image, a blocked exec, a full
  // tmpfs, a daemon error — so the ceiling is unknown, and an unknown must not be published as
  // an absent library. Empty stdout on exit 0 is different: the pipeline ends in `tail -1`, so
  // an image without libstdc++.so.6 really does exit 0 with no match, and that IS `ABSENT`.
  return run.code !== 0
    ? PROBE_FAILED
    : (/GLIBCXX_3\.4\.\d+/.exec(run.stdout)?.[0] ?? "ABSENT");
}

/** `command -v curl` plus a tar check: curl is optional, tar is the only tool the path needs. */
export async function probeImageTools(
  exec: ExecFn,
  image: string
): Promise<string> {
  const script =
    "command -v curl || echo ABSENT; command -v tar || echo TAR_ABSENT";
  const run = await exec(
    "docker",
    ["run", "--rm", image, "bash", "-c", script],
    { timeoutMs: PROBE_TIMEOUT_MS }
  );
  return run.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .join(" | ");
}

/** A missing or unreadable file reads as absent; the sweep reports it, it never crashes. */
export function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Read `docker_image` and `timeout_sec` from their own TOML section, never across one. */
function sectionValue(
  toml: string,
  section: string,
  key: string
): string | null {
  const lines = toml.split("\n");
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? "";
    if (line.startsWith("[")) break;
    const match = new RegExp(`^${key}\\s*=\\s*"?([^"\\s]+)"?`).exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

function taskNames(datasetRoot: string): ReadonlyArray<string> {
  const entries = readdirSync(join(datasetRoot, "tasks"), {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readTaskFacts(datasetRoot: string, task: string): TaskFacts {
  const dir = join(datasetRoot, "tasks", task);
  const toml = readText(join(dir, "task.toml"));
  const image = sectionValue(toml, "environment", "docker_image") ?? "";
  const timeout = Number(sectionValue(toml, "verifier", "timeout_sec"));
  const problems: string[] = [];
  if (image === "")
    problems.push("environment.docker_image missing or task.toml unreadable");
  if (!Number.isFinite(timeout) || timeout <= 0)
    problems.push("verifier.timeout_sec missing");
  if (!existsSync(join(dir, "tests/test.sh")))
    problems.push("tests/test.sh absent");
  return {
    task,
    image,
    verifierTimeoutSec: Number.isFinite(timeout) ? timeout : 0,
    graderPresent: existsSync(join(dir, "tests/test.sh")),
    imageLocal: null,
    glibcxxMeasured: "NOT_PROBED",
    problems,
  };
}

/** Static, container-free facts for every task: the cheapest gate that can still refuse a run. */
export async function enumerateTasks(
  datasetRoot: string,
  exec: ExecFn,
  probeEveryImage: boolean
): Promise<ReadonlyArray<TaskFacts>> {
  const rows: TaskFacts[] = [];
  for (const task of taskNames(datasetRoot)) {
    const facts = readTaskFacts(datasetRoot, task);
    const imageLocal =
      facts.image === "" ? null : await dockerImageExists(exec, facts.image);
    const measured =
      probeEveryImage && imageLocal === true
        ? await imageGlibcxx(exec, facts.image)
        : "NOT_PROBED";
    const problems =
      imageLocal === null
        ? [...facts.problems, `image not present locally: ${facts.image}`]
        : facts.problems;
    rows.push({ ...facts, imageLocal, glibcxxMeasured: measured, problems });
  }
  return rows;
}

export function identityFor(ctx: SmokeContext, facts: TaskFacts): RunIdentity {
  return {
    runId: `1219-smoke-${CONTAINER_PREFIX}${process.pid}`,
    task: facts.task,
    image: facts.image,
    // A mutable tag is not a content digest, and the smoke must not invent one it cannot
    // resolve without pulling, so the gap is stated in the identity itself.
    imageDigest: `sha256:unresolved-local-tag:${facts.image}`,
    datasetCommit: "sha256:unresolved-local-dataset",
    bundleSha256: ctx.bundleSha,
    nodeArchiveSha256: ctx.nodeSha,
    runnerVersion: ctx.runner.version,
    outputLayout: `smoke/out=${ctx.options.outRoot}`,
  };
}

export function specFor(
  ctx: SmokeContext,
  facts: TaskFacts,
  sub: string
): ProvisionSpec {
  return {
    identity: identityFor(ctx, facts),
    taskDir: join(ctx.options.datasetRoot, "tasks", facts.task),
    outDir: join(ctx.options.outRoot, sub, facts.task),
    bundlePath: ctx.options.bundlePath,
    nodeArchivePath: ctx.options.nodeArchivePath,
    settingsPath: ctx.settingsPath,
  };
}

/**
 * Deep structural equality, so a wiring drift between the DECLARED mount list and the list
 * the runner really builds is a hard failure.
 */
export function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The mount wiring the smoke EXPECTS, declared here instead of read back from `sharedMounts`.
 *
 * Why the declaration is not the function under test: `preflightMounts` in `runner.ts` is
 * literally `return sharedMounts(spec)`, so the smoke's original comparison
 * `deepEqual(preflightMounts(spec), sharedMounts(spec))` compared a function with itself and
 * was structurally always `true`. The severity-high "mount lists diverge" finding could
 * therefore never fire, and a run with drifted wiring published "none observed". `runner.ts`
 * is owned elsewhere, so the smoke cannot change what `preflightMounts` does; this list is
 * the honest replacement — a second, independent statement of the wiring that a change to
 * `sharedMounts` has to disagree with.
 *
 * `mountBindSource` is used rather than re-derived, because a colon-bearing attempt directory
 * is unparsable by `docker run -v` and the alias is a path-sanitising utility, not a wiring
 * decision. Re-implementing it here would be the second wiring implementation issue 1219
 * requirement 1 forbids, and would make this list agree with a drift for the wrong reason.
 *
 * The `/logs` entry is the load-bearing one: every task's `test.sh` writes
 * `/logs/verifier/{reward.txt,ctrf.json}`, and a missing or read-only mount there turns a
 * real grader result into a retained `INVALID` (the #1212 A4 fault).
 */
export function expectedMounts(spec: ProvisionSpec): ReadonlyArray<MountSpec> {
  const artifacts = mountBindSource(spec.outDir);
  return [
    {
      hostPath: `${spec.taskDir}/tests`,
      containerPath: "/tests",
      readOnly: true,
    },
    { hostPath: `${artifacts}/logs`, containerPath: "/logs", readOnly: false },
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
 * Whether the mount list the runner really built matches the wiring the smoke declares.
 *
 * Takes the observed list as an argument so the comparison is a real one: a caller passes
 * what it built, and a drift in either list is visible. Falsifiable in both directions, which
 * is what the `preflightMounts` comparison was not.
 */
export function mountWiringMatches(
  observed: ReadonlyArray<MountSpec>,
  spec: ProvisionSpec
): boolean {
  return deepEqual(observed, expectedMounts(spec));
}

export function prepareAttemptDir(path: string): string {
  mkdirSync(join(path, VERIFIER_DIR), { recursive: true });
  mkdirSync(join(path, "meta"), { recursive: true });
  return path;
}

/**
 * The graders write the reward to a FILE and never echo `reward=` to stdout, so the value is
 * read from the host path. Kept separate from `RunnerPort.grade().reward` on purpose: where
 * the two disagree, the port is not reporting the reward at all.
 */
export function retainedHostReward(outDir: string): string | null {
  const text = readText(join(outDir, VERIFIER_DIR, "reward.txt")).trim();
  return text === "" ? null : text;
}

/**
 * What reading the retained verifier directory actually ESTABLISHED.
 *
 * `absent` and `unreadable` are different findings and used to be one value: every read error
 * collapsed to `[]`, and `missingLogsMountCase` reads an empty list as EVIDENCE that the
 * fault was detected. A verifier directory that exists but cannot be read — permission denied,
 * a path component that is not a directory — therefore published `DETECTED` for the wrong
 * reason: a silent catch feeding a success-shaped boolean. An unknown must not read as a
 * measurement, which is the same rule `PROBE_FAILED` exists for on the probe side.
 */
export type VerifierListing =
  | { readonly state: "listed"; readonly files: ReadonlyArray<string> }
  | { readonly state: "absent"; readonly files: ReadonlyArray<string> }
  | { readonly state: "unreadable"; readonly reason: string };

export function retainedVerifierFiles(outDir: string): VerifierListing {
  try {
    return {
      state: "listed",
      files: readdirSync(join(outDir, VERIFIER_DIR)).sort(),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT is the EXPECTED outcome of the missing-mount negative: the verdict died with the
    // container, and nothing being retained is a real measurement. Every other code means the
    // path could not be inspected, which is a harness fault and must be named as one.
    return code === "ENOENT"
      ? { state: "absent", files: [] }
      : { state: "unreadable", reason: (error as Error).message };
  }
}

/** `command -v curl` for an image, probed at most once per run. */
export async function curlProbe(
  ctx: SmokeContext,
  image: string
): Promise<string> {
  const cached = ctx.toolProbes.get(image);
  if (cached !== undefined) return cached;
  const probed = await probeImageTools(ctx.exec, image);
  ctx.toolProbes.set(image, probed);
  return probed;
}

/**
 * The grader's wall clock, mirroring #1212: the task's DECLARED `[verifier] timeout_sec` plus
 * a grace margin, capped by `--grader-wall-sec` so a task declaring 12000s cannot wedge the run.
 */
export function graderWallFor(options: SmokeOptions, facts: TaskFacts): number {
  const declared =
    facts.verifierTimeoutSec > 0
      ? facts.verifierTimeoutSec
      : options.graderWallSec;
  return Math.min(declared + options.graderGraceSec, options.graderWallSec);
}
