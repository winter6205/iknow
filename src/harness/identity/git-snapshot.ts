/**
 * Sole git-read exit for the git block ("## Git").
 *
 * Design principles:
 *   - The assembly layer (`assemble.ts`) consumes it through an injected
 *     seam and never shells out to git directly — preserving assemble.ts's
 *     fs / path-only purity.
 *   - `createGitSnapshotProvider({ cwd })` returns a closure over one pending
 *     capture. The capture contract (when it starts, that it stays frozen for
 *     the session, how it degrades) is documented on the factory itself.
 *   - Degraded states (cwd unavailable / not a git repo / git unavailable) →
 *     snapshot = undefined → the whole assembly segment is absent ("absence =
 *     byte change is accepted"). The taxonomy lives in `env-snapshot.ts`;
 *     this module only collapses degradation into undefined.
 *   - An unexpected failure (the exec seam rejects / throws) is NOT
 *     degradation: the capture rejects and the assembly layer's diagnostic
 *     fires. See the factory doc below — it is the contract SSOT.
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
 * Reads go through `execFile` (async): one shot per session keeps cost
 * controlled. This module is the sole git-read exit for the `## Git` block —
 * the env segment reads git on its own (see `env-snapshot.ts`).
 */
import { execFile, type ExecFileException } from "node:child_process";
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

/** One git invocation outcome. `status === null` means "no exit code": the git
 *  binary is missing, the process was killed by the timeout, or it died on a
 *  signal. The capture degrades on any non-zero status, so the null case
 *  degrades exactly like the `status === null` a synchronous spawn returned. */
export interface GitExecResult {
  /** Exit code; null = no exit code (missing binary / killed process). */
  readonly status: number | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
}

/** Spawn seam (replaceable in tests; default uses node:child_process.execFile). */
export type GitExec = (
  args: readonly string[],
  cwd: string,
  timeoutSeconds?: number
) => Promise<GitExecResult>;

/** Options for `createGitSnapshotProvider`. */
export interface CreateGitSnapshotProviderOpts {
  /** cwd source: build-engine passes `projectIdentityRoot` (the stable
   *  root); the worker passes the same value as the parent session;
   *  missing → degraded cwd_unavailable. */
  readonly cwd: string;
  /** Tests may inject exec; defaults to execFile. */
  readonly exec?: GitExec;
  /** Per-git-command timeout (seconds); default = 5. */
  readonly timeoutSeconds?: number;
}

// ---------------------------------------------------------------------------
// Default exec (async execFile git)
// ---------------------------------------------------------------------------

function defaultExec(
  args: readonly string[],
  cwd: string,
  timeoutSeconds?: number
): Promise<GitExecResult> {
  return new Promise<GitExecResult>((resolve) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        timeout: (timeoutSeconds ?? DEFAULT_GIT_TIMEOUT_SECONDS) * 1000,
      },
      (error, stdout, stderr) => {
        resolve(toGitExecResult(error, stdout, stderr));
      }
    );
  });
}

/** Map an execFile outcome onto the exec seam's shape: a non-zero exit keeps
 *  its exit code; a missing binary or a killed process has no exit code
 *  (null) and therefore degrades like the old synchronous spawn. */
function toGitExecResult(
  error: ExecFileException | null,
  stdout: string,
  stderr: string
): GitExecResult {
  if (error === null) return { status: 0, stdout, stderr };
  return {
    status: typeof error.code === "number" ? error.code : null,
    stdout,
    stderr,
  };
}

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
 * Factory returning a closure. The git read starts here (the capture promise
 * is created and the first git command is spawned) so it overlaps the rest of
 * the session / worker startup; the closure hands the same pending promise to
 * every caller → the snapshot is frozen for the session (adjacent turns are
 * byte-identical) and the first `await` resolves with the complete result.
 *
 * This doc is the contract SSOT for the capture — other modules point here
 * instead of restating it.
 *
 * Degraded paths — the capture RESOLVES with undefined:
 *   - empty cwd → immediate degradation, git is **not** spawned.
 *   - spawn failure (missing binary) / timeout / non-zero exit → the capture
 *     resolves to undefined (degradation collapses to undefined; no taxonomy
 *     is exposed).
 *
 * Failure paths — the capture REJECTS (failure and degradation are distinct):
 *   - the exec seam rejects or throws, or the capture hits an internal bug →
 *     the pending promise rejects. The rejection is marked handled
 *     SYNCHRONOUSLY at creation time (see below), so a provider that is
 *     created but never awaited cannot raise an unhandled rejection, while
 *     every later awaiter still observes the rejection. The first awaiter is
 *     the assembly layer (`assemble.ts`), whose catch logs
 *     `[identity/assemble] git snapshot resolver failed: …` and degrades to
 *     snapshot = undefined → the segment is absent (no crash, no half render).
 */
export function createGitSnapshotProvider(
  opts: CreateGitSnapshotProviderOpts
): () => Promise<GitSnapshot | undefined> {
  const exec = opts.exec ?? defaultExec;
  const cwd = opts.cwd;
  const pending = captureSnapshot({
    cwd,
    exec,
    timeoutSeconds: opts.timeoutSeconds,
  });
  // EXIT: an unexpected capture failure (the exec seam threw / rejected, or
  // the capture hit an internal bug) stays OBSERVABLE — the capture rejects
  // instead of degrading to undefined, so the assembly layer's diagnostic can
  // fire. This no-op handler marks that rejection as handled in the same
  // synchronous turn, so a provider that is created but never awaited cannot
  // kill the process with an unhandled rejection; every later awaiter still
  // observes the rejection.
  void pending.catch(() => {});
  return () => pending;
}

/** Porcelain-derived fields of one status read; absent when the status call
 *  did not exit 0 (the whole snapshot degrades). */
interface StatusRead {
  readonly branch: string | null;
  readonly body: string;
}

/** `git status --porcelain=v1 -b` → branch + dirty list; a non-zero exit →
 *  undefined (the whole snapshot degrades). */
async function readStatus(
  exec: GitExec,
  cwd: string,
  timeoutSeconds: number | undefined
): Promise<StatusRead | undefined> {
  const result = await exec(
    ["--no-pager", "status", "--porcelain=v1", "-b"],
    cwd,
    timeoutSeconds
  );
  // EXIT: status did not exit 0 (not a git repo / git unavailable) → the whole snapshot is absent.
  if (result.status !== 0) return undefined;
  const porcelain = result.stdout ?? "";
  return {
    branch: parseBranchFromStatus(porcelain),
    body: cleanStatusBlock(porcelain),
  };
}

/** `git symbolic-ref --short refs/remotes/origin/HEAD` → the PR base branch;
 *  no origin / offline / empty ref → null (soft failure, no degradation). */
async function readMainBranch(
  exec: GitExec,
  cwd: string,
  timeoutSeconds: number | undefined
): Promise<string | null> {
  const result = await exec(
    ["--no-pager", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    cwd,
    timeoutSeconds
  );
  // EXIT: symbolic-ref did not exit 0 (no origin / offline) → mainBranch is null; the snapshot survives.
  if (result.status !== 0) return null;
  const trimmed = (result.stdout ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** `git log --oneline -5` → the recent commit lines; a non-zero exit → an
 *  empty list (soft failure, no degradation). */
async function readRecentCommits(
  exec: GitExec,
  cwd: string,
  timeoutSeconds: number | undefined
): Promise<ReadonlyArray<string>> {
  const result = await exec(
    ["--no-pager", "log", "--oneline", "-5"],
    cwd,
    timeoutSeconds
  );
  // EXIT: log did not exit 0 → recentCommits is empty; the snapshot survives.
  if (result.status !== 0) return [];
  return (result.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => truncateByCodepoints(l, GIT_FIELD_MAX_CHARS));
}

/**
 * One asynchronous IO snapshot capture.
 *
 * - Degradation (non-zero exit / missing binary / timeout / blank cwd) →
 *   resolves with undefined (the `## Git` segment is absent, no warning).
 * - An unexpected failure (the exec seam rejected or threw, or an internal
 *   bug in the capture) → REJECTS. The rejection is deliberately NOT
 *   swallowed here: it is the signal the assembly layer's catch turns into
 *   the diagnostic `[identity/assemble] git snapshot resolver failed: …`.
 */
async function captureSnapshot(args: {
  readonly cwd: string;
  readonly exec: GitExec;
  readonly timeoutSeconds?: number;
}): Promise<GitSnapshot | undefined> {
  const { cwd, exec, timeoutSeconds } = args;
  // EXIT: blank cwd → the capture resolves to undefined; git is never spawned.
  if (cwd.trim() === "") return undefined;

  // 1) status (includes the branch annotation line) — a non-zero exit
  // degrades the whole snapshot (degradation = undefined, no taxonomy).
  const status = await readStatus(exec, cwd, timeoutSeconds);
  // EXIT: the status read degraded → the whole snapshot is absent.
  if (status === undefined) return undefined;

  // 2) mainBranch (origin/HEAD) — soft failure: no origin / offline → null,
  // no whole-snapshot degradation.
  const mainBranch = await readMainBranch(exec, cwd, timeoutSeconds);

  // 3) recent commits — soft failure → empty array.
  const recentCommits = await readRecentCommits(exec, cwd, timeoutSeconds);

  return Object.freeze({
    branch: status.branch,
    mainBranch,
    status:
      status.body === ""
        ? null
        : truncateByCodepoints(status.body, GIT_STATUS_MAX_CHARS),
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
