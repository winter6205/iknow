/**
 * Environment-freshness snapshot computation (git state + diff preview),
 * with size caps and degraded (EXIT) states.
 *
 *   - Pure constructor `parseEnvSnapshot` (no IO / time / randomness): takes
 *     `git status` / `git diff` stdout and produces an EnvSnapshot (branch /
 *     status text / dirty count / diff preview). The human-facing chrome
 *     projects from here and never reads git directly.
 *   - `truncateByCodepoints` counts Unicode codepoints
 *     (`Array.from(s).length`), not UTF-16 units or bytes; over the cap it
 *     appends a `[truncated N chars]` marker (cap locked at 2000 cp; the
 *     number is tunable but the cap may not be removed).
 *   - IO reader `readEnvSnapshot`: `exec` is DI-injected (defaults to node
 *     child processes), running `git status --porcelain=v1 -b` and
 *     `git --no-pager diff --no-color` with a 5s timeout each, and
 *     **never throws** — unresolvable cwd / missing git binary / timeout /
 *     non-git workspace → all git fields null, cwd still preserved
 *     (degraded EXIT: not injected into model context, no throw).
 *
 * Same shape as `agent-status.ts`: pure computation and IO reader separated,
 * failures converge to null fields and never surface into a model turn.
 *
 // (ADR-0028)
 * This module does not touch the status bar or the `agent-status` append
 * path (assembled in a separate chrome slot).
 */
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Shared types and constants
// ---------------------------------------------------------------------------

/**
 * Degraded (EXIT) classification: the chrome layer must project each value
 * separately as `(cwd unavailable)` / `(not a git repo)` /
 * `(git unavailable)` and must not collapse them into one
 * "environment unavailable" message.
 */
export type EnvDegradeReason =
  "cwd_unavailable" | "not_a_git_repo" | "git_unavailable";

/** Environment snapshot: single source of truth for the human-readable chrome (no second ledger in the UI). */
export interface EnvSnapshot {
  /** String form of the working directory; the fallback input string is kept when cwd cannot be resolved. */
  readonly cwd: string;
  /** Git branch name; null for non-git workspaces, git failures, or a missing branch line. */
  readonly gitBranch: string | null;
  /** Full `git status --porcelain=v1 -b` output (helps human-facing diagnostics); null on failure. */
  readonly gitStatus: string | null;
  /** Non-empty porcelain line count; 0 = clean; null for non-git / failure. */
  readonly dirtyCount: number | null;
  /** `git diff` output truncated to the codepoint cap; null on failure or empty diff. */
  readonly diffPreview: string | null;
  /**
   * EXIT classification; null for normal or partial success (including an
   * empty porcelain output = clean). When non-null the chrome must render
   * the matching placeholder string.
   */
  readonly degradeReason: EnvDegradeReason | null;
}

/** Default diff codepoint cap (locked at 2000; tunable but never removed). */
export const MAX_ENV_DIFF_CHARS = 2000;

/** Default git command timeout (seconds); a timeout does not throw — the read failure converges to null fields. */
const DEFAULT_GIT_TIMEOUT_SECONDS = 5;

// ---------------------------------------------------------------------------
// Pure computation: truncate + parse
// ---------------------------------------------------------------------------

/**
 * Truncate by Unicode codepoints; when over `max`, append a
 * `[truncated N chars]` marker (N = codepoints actually dropped, not bytes).
 *
 * Edges:
 *   - `codepoints.length <= max` → returned unchanged.
 *   - Invalid caps (negative / NaN / Infinity) are treated as 0: no body is
 *     kept and the marker reports the true drop count (never under-report
 *     when max is negative).
 *
 * `String.prototype.length` counts UTF-16 units and overstates astral-plane
 * characters, so this function always goes through `Array.from(s)` and
 * counts codepoints.
 */
export function truncateByCodepoints(s: string, max: number): string {
  // NaN / negative → cap = 0 (drop everything); Infinity → unbounded (return
  // as-is); finite positive → cap = max. The contract is that the *total*
  // output length stays ≤ cap and the marker counts against that budget:
  // build the marker from the real drop count first, then shrink the body
  // allowance by the marker length so the assembled total strictly fits.
  const cap =
    !Number.isFinite(max) && max > 0
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Number.isFinite(max) ? max : 0);
  const codepoints = Array.from(s);
  if (codepoints.length <= cap) return s;
  // Cap smaller than the minimum marker: give all the space to the marker, body empty.
  const dropped = codepoints.length;
  const marker = `[truncated ${dropped} chars]`;
  const markerLen = Array.from(marker).length;
  const bodyCap =
    cap === Number.POSITIVE_INFINITY ? dropped : Math.max(0, cap - markerLen);
  const finalDropped = dropped - bodyCap;
  const finalMarker = `[truncated ${finalDropped} chars]`;
  return codepoints.slice(0, bodyCap).join("") + finalMarker;
}

/**
 * Branch name from the first line (`## <branch>...`) of
 * `git status --porcelain=v1 -b`. A detached head
 * (`## HEAD (detached at abc123)`) → `"HEAD"`; missing branch line → null.
 */
function parseBranchLine(porcelain: string): string | null {
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("## ")) continue;
    const body = line.slice(3).trim();
    // Detached head "HEAD (detached at <sha>)" → "HEAD"; other forms pass the body through.
    if (body === "") return null;
    if (body.startsWith("HEAD")) return "HEAD";
    // Remote-tracking annotation "main [origin/main]" → "main".
    const spaceIdx = body.indexOf(" ");
    return spaceIdx >= 0 ? body.slice(0, spaceIdx) : body;
  }
  return null;
}

/**
 * Detects the "not a git repository" marker in `git status` output after
 * stderr passthrough (typical form: `fatal: not a git repository (or any of
 * the parent directories): .git`). Treated as a degraded EXIT state: fields
 * all null, so the UI can show `(not a git repo)`.
 */
function isNotAGitRepoMessage(s: string): boolean {
  return s.includes("fatal: not a git repository");
}

/**
 * Pure computation: git / diff strings → EnvSnapshot. No IO, no time or
 * randomness.
 *
 * Behavior:
 *   - Porcelain v1 text is parsed **LF-separated** (readEnvSnapshot omits
 *     `-z` so the human summary and the parser share semantics; NUL-safety
 *     only matters for machine consumers).
 *   - A `fatal: not a git repository` error or empty stdout degrades the git
 *     fields (a non-empty diff preview is still surfaced). The IO layer
 *     already short-circuits a non-zero git exit into a degraded snapshot;
 *     these branches stay for direct-composition callers.
 *   - Missing branch line (`## ...`) → `gitBranch = null`, dirty lines still
 *     counted.
 *   - The return value is frozen (Object.freeze), the same immutability
 *     contract as `parseAgentStatusText`; consumers must not rewrite fields.
 */
export function parseEnvSnapshot(input: {
  readonly cwd: string;
  readonly gitStdout: string;
  readonly diffStdout: string;
}): EnvSnapshot {
  const { cwd, gitStdout } = input;
  const diffPreview = input.diffStdout === "" ? null : input.diffStdout;
  if (isNotAGitRepoMessage(gitStdout)) {
    return Object.freeze({
      cwd,
      gitBranch: null,
      gitStatus: null,
      dirtyCount: null,
      diffPreview,
      degradeReason: "not_a_git_repo" as const,
    });
  }
  if (gitStdout === "") {
    // Empty stdout: equivalent to a clean workspace (no branch header, no dirty lines).
    return Object.freeze({
      cwd,
      gitBranch: null,
      gitStatus: null,
      dirtyCount: 0,
      diffPreview,
      degradeReason: null,
    });
  }
  const branch = parseBranchLine(gitStdout);
  // Dirty lines: skip the branch line ("## ...") and blank lines.
  const dirtyCount = gitStdout
    .split("\n")
    .filter((l) => l.length > 0 && !l.startsWith("## ")).length;
  return Object.freeze({
    cwd,
    gitBranch: branch,
    gitStatus: gitStdout,
    dirtyCount,
    diffPreview,
    degradeReason: null,
  });
}

// ---------------------------------------------------------------------------
// IO reader
// ---------------------------------------------------------------------------

/** DI seam: inject a stub `exec`; defaults to `node:child_process.spawn`. */
export type EnvExec = (
  cmd: string,
  args: readonly string[],
  cwd: string
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export interface ReadEnvSnapshotOpts {
  readonly cwd: string;
  /** Test seam; default runs git via a spawn child process. */
  readonly exec?: EnvExec;
  /** Diff truncation codepoint cap; default `MAX_ENV_DIFF_CHARS`. */
  readonly maxDiffChars?: number;
}

/**
 * Default exec: `spawn` git, capture stdout / stderr, kill -9 after 5s.
 *
 * Rejects on a non-zero exit code or spawn failure (ENOENT / EACCES / spawn
 * reject); `readEnvSnapshot` converges these at its top level — **this
 * function only promises to reject with the real failure cause, without
 * enforcing the never-throw wrapper on behalf of the caller**.
 */
function defaultExec(
  cmd: string,
  args: readonly string[],
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, [...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // detached:false lets the child be cleaned up when the parent exits, avoiding hangs.
        detached: false,
      });
    } catch (err) {
      // EXIT: synchronous spawn failure (bad cwd / permission) → reject; readEnvSnapshot converges.
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      reject(
        new Error(`${cmd} timed out after ${DEFAULT_GIT_TIMEOUT_SECONDS}s`)
      );
    }, DEFAULT_GIT_TIMEOUT_SECONDS * 1000);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!timedOut) reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return; // reject already fired inside the timer
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        // Non-zero exit (typically a non-git workspace → "fatal: not a git
        // repository"); stderr goes into the reject message, and
        // readEnvSnapshot catches it → classifyGitStatusError splits
        // not_a_git_repo | git_unavailable.
        reject(
          new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr.trim()}`)
        );
      }
    });
  });
}

/**
 * IO reader: runs the two git commands → projects into an EnvSnapshot.
 * **Never throws** — any git failure (ENOENT / non-zero exit / timeout /
 * spawn reject) converges to all-null git fields, with cwd preserved.
 *
 * Commands:
 *   - `git status --porcelain=v1 -b` (LF-separated + branch header; **no
 *     `-z`** — the human summary is parsed line-wise, NUL-safety only
 *     matters for machine consumers)
 *   - `git --no-pager diff --no-color` (pager off to avoid terminal hang)
 *
 * Degraded EXIT: non-git workspace / git failure → the null fields returned
 * here let the chrome render `(not a git repo)` / `(git unavailable)`.
 */
export async function readEnvSnapshot(
  opts: ReadEnvSnapshotOpts
): Promise<EnvSnapshot> {
  const { cwd } = opts;
  const exec = opts.exec ?? defaultExec;
  const maxDiffChars = opts.maxDiffChars ?? MAX_ENV_DIFF_CHARS;

  // EXIT: unresolvable cwd (blank) → cwd_unavailable placeholder; no git run, no throw.
  if (cwd.trim() === "") {
    return degradedSnapshot("", "cwd_unavailable");
  }

  let gitStdout = "";
  let diffStdout = "";

  try {
    const status = await exec("git", ["status", "--porcelain=v1", "-b"], cwd);
    gitStdout = status.stdout;
  } catch (err) {
    // EXIT: status failed → classify by stderr/message into not_a_git_repo | git_unavailable
    return degradedSnapshot(cwd, classifyGitStatusError(err));
  }

  try {
    const diff = await exec("git", ["--no-pager", "diff", "--no-color"], cwd);
    diffStdout = diff.stdout;
  } catch {
    // EXIT: status succeeded but diff failed → keep git fields, drop only diffPreview (partial degrade).
    return truncateDiff(
      parseEnvSnapshot({ cwd, gitStdout, diffStdout: "" }),
      maxDiffChars
    );
  }

  return truncateDiff(
    parseEnvSnapshot({ cwd, gitStdout, diffStdout }),
    maxDiffChars
  );
}

/** Status failure → EXIT classification (before parse, since the IO catch short-circuits parse). */
function classifyGitStatusError(err: unknown): EnvDegradeReason {
  const msg = err instanceof Error ? err.message : String(err);
  if (isNotAGitRepoMessage(msg)) return "not_a_git_repo";
  return "git_unavailable";
}

function degradedSnapshot(cwd: string, reason: EnvDegradeReason): EnvSnapshot {
  return Object.freeze({
    cwd,
    gitBranch: null,
    gitStatus: null,
    dirtyCount: null,
    diffPreview: null,
    degradeReason: reason,
  });
}

function truncateDiff(snap: EnvSnapshot, max: number): EnvSnapshot {
  if (snap.diffPreview === null) return snap;
  return Object.freeze({
    ...snap,
    diffPreview: truncateByCodepoints(snap.diffPreview, max),
  });
}
