/**
 * git-snapshot module — single git read exit point.
 *
 * TDD: spec `specs/model-prefix-layering.md` §9 / plan B5:
 *   - The git block's text is captured **once at engine-build time** (closure)
 *     and frozen for the session, so adjacent turns produce byte-identical
 *     text → D9 / KV-cache contract.
 *   - Degradation uses the three `EnvDegradeReason` states
 *     (cwd_unavailable | not_a_git_repo | git_unavailable). The provider
 *     returns `undefined` for any degrade state → assembly segment absent.
 *   - Status output truncated via `truncateByCodepoints` (2000 cp cap).
 *   - Tests must not depend on a real git binary unless one is available —
 *     use the injectable `exec` seam; skip cleanly if neither git nor the
 *     seam can produce data.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  createGitSnapshotProvider,
  GIT_SEGMENT_TITLE,
  GIT_SEGMENT_DISCLAIMER,
  GIT_STATUS_MAX_CHARS,
} from "../../../src/harness/identity/git-snapshot.ts";

// -----------------------------------------------------------------------
// Fixtures: real git repo on a temp dir.
// -----------------------------------------------------------------------

let repoDir: string;
let nonRepoDir: string;

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "iknow-git-snap-repo-"));
  nonRepoDir = await mkdtemp(join(tmpdir(), "iknow-git-snap-nonrepo-"));

  // Initialize a git repo with one commit + one dirty file.
  const git = (args: readonly string[]): void => {
    const r = spawnSync("git", [...args], { cwd: repoDir, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${r.stderr || r.stdout || "(no output)"}`
      );
    }
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(repoDir, "README.md"), "initial\n", "utf8");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "first commit"]);
  await writeFile(join(repoDir, "README.md"), "modified\n", "utf8");
});

afterAll(async () => {
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
  if (nonRepoDir) await rm(nonRepoDir, { recursive: true, force: true });
});

/** Returns true if `git` is available on PATH. */
function gitOnPath(): boolean {
  const r = spawnSync("git", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

// -----------------------------------------------------------------------
// createGitSnapshotProvider — provider behavior
// -----------------------------------------------------------------------

describe("createGitSnapshotProvider — provider shape", () => {
  it("returns a frozen GitSnapshot when cwd is a git repo", () => {
    if (!gitOnPath()) return; // skip — tests below need git
    const provider = createGitSnapshotProvider({ cwd: repoDir });
    const snap = provider();
    expect(snap).toBeDefined();
    expect(snap!.branch).toBe("master"); // default branch on this git version
    expect(snap.recentCommits.length).toBeGreaterThan(0);
  });

  it("degrades (undefined) when cwd is not a git repository", () => {
    if (!gitOnPath()) return;
    const provider = createGitSnapshotProvider({ cwd: nonRepoDir });
    const snap = provider();
    expect(snap).toBeUndefined();
  });

  it("degrades (undefined) when cwd is empty string (cwd_unavailable)", () => {
    const provider = createGitSnapshotProvider({ cwd: "" });
    const snap = provider();
    expect(snap).toBeUndefined();
  });

  it("degrades (undefined) when exec is injected to fail (git_unavailable simulation)", () => {
    const provider = createGitSnapshotProvider({
      cwd: "/does-not-matter",
      // Sync exec returning SpawnSyncReturns-shape with a non-zero status →
      // 整体退化（退化即 undefined）。
      exec: () => ({
        pid: 0,
        output: [null, "", "fatal: not a git repository"],
        stdout: "",
        stderr: "fatal: not a git repository",
        status: 128,
        signal: null,
      }),
    });
    const snap = provider();
    expect(snap).toBeUndefined();
  });

  it("captures snapshot ONCE at construction time (closure cache → adjacent-turn deep-equal)", () => {
    if (!gitOnPath()) return;
    const provider = createGitSnapshotProvider({ cwd: repoDir });
    const first = provider();
    // Mutate the underlying repo between calls: provider must NOT re-read.
    spawnSync("git", ["commit", "--allow-empty", "-q", "-m", "second"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    const second = provider();
    expect(second).toBe(first);
  });
});

// -----------------------------------------------------------------------
// Segment rendering constants — SSOT exported, tests reference constants
// -----------------------------------------------------------------------

describe("git-snapshot segment constants", () => {
  it("GIT_SEGMENT_TITLE is a non-empty string", () => {
    expect(GIT_SEGMENT_TITLE).toBeTruthy();
    expect(typeof GIT_SEGMENT_TITLE).toBe("string");
  });

  it("GIT_SEGMENT_DISCLAIMER mentions snapshot semantics", () => {
    expect(GIT_SEGMENT_DISCLAIMER).toMatch(/snapshot/i);
  });

  it("GIT_STATUS_MAX_CHARS is a positive number with a marker-friendly value", () => {
    expect(typeof GIT_STATUS_MAX_CHARS).toBe("number");
    expect(GIT_STATUS_MAX_CHARS).toBeGreaterThan(0);
  });
});
