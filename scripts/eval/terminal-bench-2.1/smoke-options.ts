/**
 * Argument parsing for the disposable-Docker smoke.
 *
 * Why separate from `smoke.ts`: parsing, the credential guard and the report rendering are
 * three seams the smoke grew past the `max-lines` limit, and each is independently readable
 * once it is its own module. Behavior is unchanged: the same flag set, the same refusals and
 * the same defaults, because a runbook cites them verbatim.
 */
import type { SmokeOptions } from "./smoke-types.js";

const FLAGS = [
  "dataset",
  "bundle",
  "node-archive",
  "out",
  "tasks",
  "node-sha",
  "bundle-sha",
  "glibcxx-floor",
  "grader-wall-sec",
  "grader-grace-sec",
  "skip-image-probe",
] as const;
const REQUIRED_FLAGS = ["dataset", "bundle", "node-archive", "out"] as const;
const DEFAULT_GRADER_WALL_SEC = 1800;

/** Parse `--flag value` pairs plus the one valueless switch. Unknown flags are a refusal. */
export function parseArgs(argv: ReadonlyArray<string>): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === "--skip-image-probe") {
      parsed["skip-image-probe"] = "true";
      continue;
    }
    const flag = token.replace(/^--/, "");
    const value = argv[i + 1];
    if (
      !(FLAGS as ReadonlyArray<string>).includes(flag) ||
      value === undefined
    ) {
      throw new Error(
        `unusable argument ${JSON.stringify(token)}; flags: ${FLAGS.join(", ")}`
      );
    }
    // A flag in a value slot is a missing value, never a value. Without this, `--out --tasks`
    // parsed cleanly and the whole report was written under a literal `--tasks` directory in
    // the operator's CWD, and `--dataset --bundle /b` consumed the next flag and then blamed
    // `/b` for being unreadable. Issue 1219 requires malformed input to fail without a
    // silent success, so the refusal names the flag that LOST its value rather than the token
    // it would otherwise have swallowed.
    if (value.startsWith("--")) {
      throw new Error(
        `--${flag} needs a value, but the next token is the flag ${JSON.stringify(value)}; ` +
          `pass the value directly after --${flag}`
      );
    }
    parsed[flag] = value;
    i += 1;
  }
  return parsed;
}

function requiredFlag(parsed: Record<string, string>, flag: string): string {
  const value = parsed[flag];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `missing required flag --${flag}; required: ${REQUIRED_FLAGS.join(", ")}`
    );
  }
  return value;
}

/**
 * `--out` is the one path the smoke mounts rather than reads, so it is validated beyond
 * non-emptiness: `docker run -v` parses a bind source as `HOST:CONTAINER[:ro]` and refuses
 * more than two colons, and every attempt directory hangs off this root. A colon here is
 * refused up front instead of being sanitised into a mount alias halfway through a run.
 */
function outFlag(parsed: Record<string, string>): string {
  const out = requiredFlag(parsed, "out");
  if (out.includes(":"))
    throw new Error(
      `--out must be a colon-free path: docker parses a -v source as HOST:CONTAINER[:ro] ` +
        `and refuses more than two colons, so ${JSON.stringify(out)} cannot be mounted as given`
    );
  return out;
}

function numberFlag(
  parsed: Record<string, string>,
  flag: string,
  fallback: number
): number {
  const raw = parsed[flag];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`--${flag} must be a positive number`);
  return value;
}

function shaFlag(parsed: Record<string, string>, flag: string): string | null {
  const raw = parsed[flag];
  if (raw === undefined) return null;
  if (!/^[0-9a-f]{64}$/.test(raw))
    throw new Error(`--${flag} must be 64 lowercase hex characters`);
  return raw;
}

export function optionsFrom(parsed: Record<string, string>): SmokeOptions {
  const tasks = (parsed.tasks ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return {
    datasetRoot: requiredFlag(parsed, "dataset"),
    bundlePath: requiredFlag(parsed, "bundle"),
    nodeArchivePath: requiredFlag(parsed, "node-archive"),
    outRoot: outFlag(parsed),
    tasks,
    nodeSha256: shaFlag(parsed, "node-sha"),
    bundleSha256: shaFlag(parsed, "bundle-sha"),
    glibcxxFloor: parsed["glibcxx-floor"] ?? "GLIBCXX_3.4.31",
    graderWallSec: numberFlag(
      parsed,
      "grader-wall-sec",
      DEFAULT_GRADER_WALL_SEC
    ),
    graderGraceSec: numberFlag(parsed, "grader-grace-sec", 600),
    probeEveryImage: parsed["skip-image-probe"] !== "true",
  };
}
