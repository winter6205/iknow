/**
 * Sole git-read exit for the git block ("## Git").
 *
 * Design principles:
 *   - The assembly layer (`assemble.ts`) consumes it through an injected
 *     seam and never shells out to git directly — preserving assemble.ts's
 *     fs / path-only purity.
 *   - `createGitSnapshotProvider({ cwd })` returns a closure that takes one
 *     snapshot at factory time and freezes it for the session (executed
 *     synchronously during build-engine / worker assembly). The assembly
 *     layer calls the same closure every turn → adjacent turns are
 *     byte-identical (KV cache contract).
 *   - Degraded states (cwd unavailable / not a git repo / git unavailable) →
 *     snapshot = undefined → the whole assembly segment is absent ("absence =
 *     byte change is accepted"). The taxonomy lives in `env-snapshot.ts`;
 *     this module only collapses degradation into undefined.
 *   - status output is truncated via `truncateByCodepoints` (capped at
 *     `GIT_STATUS_MAX_CHARS`, 2000 codepoints, same tier as
 *     `MAX_ENV_DIFF_CHARS`); the four fields + disclaimer all come from SSOT
 *     constants.
 *
 * Data sources:
 *   - branch         ← the `## ...` line of `git --no-pager status --porcelain=v1 -b`
 *                        (same shape as parseBranchLine in env-snapshot.ts).
 *   - mainBranch     ← `git --no-pager symbolic-ref --short refs/remotes/origin/HEAD`
 *                        absent (no origin / offline) → null (rendered as "—").
 *   - status         ← the full porcelain v1 text from the same call (with the
 *                        `## ...` line stripped), truncated at the codepoint cap.
 *   - recentCommits  ← `git --no-pager log --oneline -5` split by line.
 *
 * `spawnSync` is used for reads: a one-shot session-level snapshot keeps cost
 * controlled; the closure returns the frozen value with no further IO.
 * This module is the only place in the repo that spawns `git` (verified by
 * the assemble.ts test suite).
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { truncateByCodepoints } from "../env-snapshot.js";

// ---------------------------------------------------------------------------
// SSOT constants (assembly layer / tests reference only; no copying or slicing)
// ---------------------------------------------------------------------------

/** `## Git` segment heading (same shape as `projectPathSegment` / `coordinatorSegment`). */
export const GIT_SEGMENT_TITLE = "## Git";

/** Disclaimer: states snapshot semantics explicitly — the model must not
 *  treat it as live state. */
export const GIT_SEGMENT_DISCLAIMER =
  "snapshot taken at session start; not refreshed during the session";

/**
 * Codepoint cap for status truncation (`truncateByCodepoints`; the number
 * itself is not locked). 2000 sits at the same tier as `MAX_ENV_DIFF_CHARS`:
 * a typical git status (porcelain v1 + dirty list) is far below it; only
 * worktrees with many untracked/modified files exceed it, and the marker still
 * counts against the budget. The overall assembly budget is unaffected
 * (status is the only truncatable field in the git block).
 */
export const GIT_STATUS_MAX_CHARS = 2000;

/** Codepoint caps for fields other than status (fallback for over-long branch
 *  names / commit lines). */
export const GIT_FIELD_MAX_CHARS = 200;

/** git command execution timeout (seconds). The snapshot is taken once, so
 *  cost is controlled; exceeding this → git_unavailable. */
const DEFAULT_GIT_TIMEOUT_SECONDS = 5;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One frozen git snapshot. Degraded states produce no object (the provider
 *  returns undefined → the whole assembly segment is absent), hence there is
 *  no degradeReason field. */
export interface GitSnapshot {
  /** Current branch name; "HEAD" when detached; degraded → null. */
  readonly branch: string | null;
  /** PR base branch (upstream derived from origin/HEAD); no origin / offline → null. */
  readonly mainBranch: string | null;
  /** `git status --porcelain=v1 -b` text (with the `## ...` line stripped),
   *  truncated by codepoints; clean worktree → ""; degraded → null. */
  readonly status: string | null;
  /** Last 5 commits (`git log --oneline -5` split by line); degraded → []. */
  readonly recentCommits: ReadonlyArray<string>;
}

/** Spawn seam (replaceable in tests; default uses node:child_process.spawnSync). */
export type GitExec = (
  args: readonly string[],
  cwd: string,
  timeoutSeconds?: number
) => SpawnSyncReturns<string>;

/** Options for `createGitSnapshotProvider`. */
export interface CreateGitSnapshotProviderOpts {
  /** cwd source: build-engine passes `projectIdentityRoot` (the stable
   *  root); the worker passes the same value as the parent session;
   *  missing → degraded cwd_unavailable. */
  readonly cwd: string;
  /** Tests may inject exec; defaults to spawnSync. */
  readonly exec?: GitExec;
  /** Per-git-command timeout (seconds); default = 5. */
  readonly timeoutSeconds?: number;
}

// ---------------------------------------------------------------------------
// Default exec (spawnSync git)
// ---------------------------------------------------------------------------

function defaultExec(
  args: readonly string[],
  cwd: string,
  timeoutSeconds?: number
): SpawnSyncReturns<string> {
  return spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: (timeoutSeconds ?? DEFAULT_GIT_TIMEOUT_SECONDS) * 1000,
  });
}

// ---------------------------------------------------------------------------
// Degradation handling (same vocabulary as env-snapshot.ts: degradation
// collapses to undefined — this module no longer exposes the
// EnvDegradeReason taxonomy; env-snapshot.ts owns those details)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pure computation (no IO)
// ---------------------------------------------------------------------------

/** Branch name from the first line of `git status --porcelain=v1 -b` (detached → "HEAD"). */
function parseBranchFromStatus(porcelain: string): string | null {
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("## ")) continue;
    const body = line.slice(3).trim();
    if (body === "") return null;
    if (body.startsWith("HEAD")) return "HEAD";
    const spaceIdx = body.indexOf(" ");
    return spaceIdx >= 0 ? body.slice(0, spaceIdx) : body;
  }
  return null;
}

/** Strip the `## ...` annotation lines from porcelain v1 text to get a clean dirty list. */
function cleanStatusBlock(porcelain: string): string {
  return porcelain
    .split("\n")
    .filter((l) => !l.startsWith("## "))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Factory returning a closure. The closure takes the git snapshot once,
 * synchronously, at factory time and freezes it; the assembly layer calls the
 * same closure every turn → adjacent turns are byte-identical.
 *
 * Degraded paths:
 *   - empty cwd → immediate degradation, git is **not** spawned.
 *   - synchronous spawn failure (ENOENT / EACCES) / timeout / non-zero exit →
 *     the closure returns undefined (degradation collapses to undefined; no
 *     taxonomy is exposed).
 *
 * Once frozen (success or degraded), the closure always returns the same
 * value; no retries, no IO.
 */
export function createGitSnapshotProvider(
  opts: CreateGitSnapshotProviderOpts
): () => GitSnapshot | undefined {
  const exec = opts.exec ?? defaultExec;
  const cwd = opts.cwd;
  const snapshot = captureSnapshot({
    cwd,
    exec,
    timeoutSeconds: opts.timeoutSeconds,
  });
  return (): GitSnapshot | undefined => snapshot;
}

/** One synchronous IO snapshot capture. Failure / degradation → undefined. */
function captureSnapshot(args: {
  readonly cwd: string;
  readonly exec: GitExec;
  readonly timeoutSeconds?: number;
}): GitSnapshot | undefined {
  const { cwd, exec, timeoutSeconds } = args;
  if (cwd.trim() === "") return undefined;

  // 1) status (includes the branch annotation line) — any spawn failure
  // degrades the whole snapshot (degradation = undefined, no taxonomy).
  const statusResult = exec(
    ["--no-pager", "status", "--porcelain=v1", "-b"],
    cwd,
    timeoutSeconds
  );
  if (statusResult.status !== 0) {
    return undefined;
  }
  const porcelain = statusResult.stdout ?? "";
  const branch = parseBranchFromStatus(porcelain);
  const statusBody = cleanStatusBlock(porcelain);

  // 2) mainBranch (origin/HEAD) — soft failure: no origin / offline → null,
  // no whole-snapshot degradation.
  let mainBranch: string | null = null;
  const mainResult = exec(
    ["--no-pager", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    cwd,
    timeoutSeconds
  );
  if (mainResult.status === 0) {
    const trimmed = (mainResult.stdout ?? "").trim();
    mainBranch = trimmed === "" ? null : trimmed;
  }

  // 3) recent commits — soft failure → empty array.
  let recentCommits: ReadonlyArray<string> = [];
  const logResult = exec(
    ["--no-pager", "log", "--oneline", "-5"],
    cwd,
    timeoutSeconds
  );
  if (logResult.status === 0) {
    recentCommits = (logResult.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => truncateByCodepoints(l, GIT_FIELD_MAX_CHARS));
  }

  return Object.freeze({
    branch,
    mainBranch,
    status:
      statusBody === ""
        ? null
        : truncateByCodepoints(statusBody, GIT_STATUS_MAX_CHARS),
    recentCommits,
  });
}

// ---------------------------------------------------------------------------
// Segment rendering (pure function, called by assemble.ts; same shape as
// projectPathSegment)
// ---------------------------------------------------------------------------

/**
 * Render the `## Git` segment: four fields + disclaimer.
 *
 * - snapshot === undefined → undefined (the assembly layer appends nothing,
 *   byte-identical; degradation is already collapsed to undefined on the
 *   provider side, so this function does not re-check).
 * - otherwise: title + four fields + disclaimer.
 *
 * Absent fields (branch / mainBranch === null) render the placeholder "—";
 * clean status renders "(clean)"; empty recentCommits renders "(none)".
 * Tests assert against the SSOT constants.
 */
export function gitSnapshotSegment(
  snapshot: GitSnapshot | undefined
): string | undefined {
  if (snapshot === undefined) return undefined;

  const branch = snapshot.branch ?? "—";
  const mainBranch = snapshot.mainBranch ?? "—";
  const status = snapshot.status ?? "(clean)";
  const commits =
    snapshot.recentCommits.length === 0
      ? "(none)"
      : snapshot.recentCommits.join("\n  ");

  const body = [
    `main-branch: ${branch}`,
    `pr-base: ${mainBranch}`,
    `status:\n${status}`,
    `recent-commits:\n  ${commits}`,
    GIT_SEGMENT_DISCLAIMER,
  ].join("\n");

  return `${GIT_SEGMENT_TITLE}\n${body}`;
}
