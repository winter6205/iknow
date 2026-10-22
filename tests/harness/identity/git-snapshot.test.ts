/**
 * git-snapshot module — single git read exit point.
 *
 *   - The git block's text is captured **once at provider-factory time** — the
 *     read runs in the background and the first `await` resolves with the
 *     complete result — and is frozen for the session, so adjacent turns
 *     produce byte-identical text → KV-cache contract.
 *   - Degradation uses the three `EnvDegradeReason` states
 *     (cwd_unavailable | not_a_git_repo | git_unavailable). The provider
 *     returns `undefined` for any degrade state → assembly segment absent.
 *   - An unexpected failure (the exec seam rejects / throws) is NOT a
 *     degradation: the capture REJECTS, and the rejection is marked handled at
 *     creation time so a never-awaited provider cannot raise an unhandled
 *     rejection.
 *   - Status output truncated via `truncateByCodepoints` (2000 cp cap).
 *   - Tests must not depend on a real git binary unless one is available —
 *     use the injectable `exec` seam; skip cleanly if neither git nor the
 *     seam can produce data.
 */
import assert from "node:assert/strict";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  createGitSnapshotProvider,
  GIT_SEGMENT_TITLE,
  GIT_SEGMENT_DISCLAIMER,
  GIT_STATUS_MAX_CHARS,
  type GitExec,
} from "../../../src/harness/identity/git-snapshot.ts";

// -----------------------------------------------------------------------
// Fixtures: real git repo on a temp dir.
// -----------------------------------------------------------------------

let repoDir: string;
let nonRepoDir: string;
/** Per-case repo (its own git history) — cleaned up with the shared ones. */
let pinnedRepoDir: string | undefined;

/**
 * Initialize `dir` as a git repo with one commit ("first commit") + one
 * dirty file (README.md modified, not staged). Used for the shared fixture
 * repo and for repos that need a private commit history.
 */
async function initFixtureRepo(dir: string): Promise<void> {
  const git = (args: readonly string[]): void => {
    const r = spawnSync("git", [...args], { cwd: dir, encoding: "utf8" });
    assert.strictEqual(
      r.status,
      0,
      `git ${args.join(" ")} failed: ${r.stderr || r.stdout || "(no output)"}`
    );
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "README.md"), "initial\n", "utf8");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "first commit"]);
  await writeFile(join(dir, "README.md"), "modified\n", "utf8");
}

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "iknow-git-snap-repo-"));
  nonRepoDir = await mkdtemp(join(tmpdir(), "iknow-git-snap-nonrepo-"));
  await initFixtureRepo(repoDir);
});

afterAll(async () => {
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
  if (nonRepoDir) await rm(nonRepoDir, { recursive: true, force: true });
  if (pinnedRepoDir) await rm(pinnedRepoDir, { recursive: true, force: true });
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
  it("returns a frozen GitSnapshot when cwd is a git repo", async () => {
    if (!gitOnPath()) return; // skip — tests below need git
    const provider = createGitSnapshotProvider({ cwd: repoDir });
    const snap = await provider();
    assert.ok(snap !== undefined, "a git repo yields a snapshot");
    expect(snap.branch).toBe("master"); // default branch on this git version
    expect(snap.recentCommits.length).toBeGreaterThan(0);
  });

  it("pins the snapshot content (branch / status / mainBranch / recentCommits)", async () => {
    if (!gitOnPath()) return;
    // Private repo: other cases commit into the shared fixture repo (e.g. the
    // "captures snapshot ONCE" case below adds a commit), which would change
    // the commit count/content this case pins. Owning the repo makes the case
    // independent of the order the cases run in.
    pinnedRepoDir = await mkdtemp(join(tmpdir(), "iknow-git-snap-pinned-"));
    await initFixtureRepo(pinnedRepoDir);
    const provider = createGitSnapshotProvider({ cwd: pinnedRepoDir });
    const snap = await provider();
    assert.ok(snap !== undefined, "a git repo yields a snapshot");
    expect(snap.branch).toBe("master");
    expect(snap.status).toBe(" M README.md");
    expect(snap.mainBranch).toBeNull(); // the fixture repo has no origin
    expect(snap.recentCommits.length).toBe(1);
    expect(snap.recentCommits[0]?.endsWith("first commit")).toBe(true);
  });

  it("degrades (undefined) when cwd is not a git repository", async () => {
    if (!gitOnPath()) return;
    const provider = createGitSnapshotProvider({ cwd: nonRepoDir });
    const snap = await provider();
    expect(snap).toBeUndefined();
  });

  it("degrades (undefined) when cwd is empty string (cwd_unavailable)", async () => {
    const provider = createGitSnapshotProvider({ cwd: "" });
    const snap = await provider();
    expect(snap).toBeUndefined();
  });

  it("degrades (undefined) when exec is injected to fail (git_unavailable simulation)", async () => {
    const provider = createGitSnapshotProvider({
      cwd: "/does-not-matter",
      // Async exec returning a non-zero exit code → degrade as a whole
      // (degrade means undefined).
      exec: async () => ({
        status: 128,
        stdout: "",
        stderr: "fatal: not a git repository",
      }),
    });
    const snap = await provider();
    expect(snap).toBeUndefined();
  });

  it("rejects when the exec seam throws (an unexpected failure is NOT a degradation)", async () => {
    // The capture no longer swallows the failure: a throwing / rejecting exec
    // rejects the pending capture, so the assembly layer's diagnostic can
    // fire. Degradation (non-zero exit / no exit code) is a different path —
    // it resolves to undefined (see the cases above).
    const exec: GitExec = async () => {
      throw new Error("boom");
    };
    const provider = createGitSnapshotProvider({
      cwd: "/does-not-matter",
      exec,
    });
    await expect(provider()).rejects.toThrow("boom");
    // Same promise on every call: the second call rejects too.
    await expect(provider()).rejects.toThrow("boom");
  });

  it("does not raise an unhandled rejection when the provider is created but never awaited", async () => {
    // The capture rejects (unexpected failure), but the rejection is marked
    // handled at creation time → a provider nobody awaits cannot kill the
    // process (Node's default --unhandled-rejections=throw).
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      createGitSnapshotProvider({
        cwd: "/does-not-matter",
        exec: async () => {
          throw new Error("boom");
        },
      });
      // Let the rejection settle and Node's unhandled-rejection detection run
      // (it fires after the microtask queue drains, on a later turn).
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("degrades without a warning when a git command exits non-zero", async () => {
    // Non-zero exit = degradation, not failure: the capture resolves with
    // undefined and nothing is warned about.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const provider = createGitSnapshotProvider({
        cwd: "/does-not-matter",
        exec: async () => ({
          status: 128,
          stdout: "",
          stderr: "fatal: not a git repository",
        }),
      });
      const snap = await provider();
      expect(snap).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("degrades without a warning when the exec reports no exit code (status null)", async () => {
    // status === null = the git binary is missing / the process was killed:
    // same degradation as a non-zero exit → undefined, no warning.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const provider = createGitSnapshotProvider({
        cwd: "/does-not-matter",
        exec: async () => ({
          status: null,
          stdout: null,
          stderr: "spawn git ENOENT",
        }),
      });
      const snap = await provider();
      expect(snap).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("captures snapshot ONCE at construction time (closure cache → adjacent-turn deep-equal)", async () => {
    if (!gitOnPath()) return;
    const provider = createGitSnapshotProvider({ cwd: repoDir });
    const first = await provider();
    // Mutate the underlying repo between calls: provider must NOT re-read.
    spawnSync("git", ["commit", "--allow-empty", "-q", "-m", "second"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    const second = await provider();
    expect(second).toBe(first);
  });

  it("starts the git read at factory time and yields the complete snapshot on first await", async () => {
    // The injected exec blocks on a gate the test controls: the factory must
    // return while the read is still in flight (the read overlaps startup).
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execCalls: string[] = [];
    const exec: GitExec = async (args) => {
      execCalls.push(args.join(" "));
      await gate;
      if (args.includes("status")) {
        return {
          status: 0,
          stdout: "## feature/async\n M README.md\n",
          stderr: "",
        };
      }
      if (args.includes("symbolic-ref")) {
        return { status: 128, stdout: "", stderr: "fatal: not a valid ref" };
      }
      return { status: 0, stdout: "abc1234 first commit\n", stderr: "" };
    };

    const provider = createGitSnapshotProvider({ cwd: "/does-not-matter", exec });
    // The read already started in the background — the factory did not block.
    expect(execCalls).toEqual(["--no-pager status --porcelain=v1 -b"]);

    let settled = false;
    const observed = provider().then((snap) => {
      settled = true;
      return snap;
    });
    await Promise.resolve();
    expect(settled).toBe(false); // still in flight → nothing blocks at factory time

    release();
    const snap = await observed;
    expect(settled).toBe(true);
    expect(snap).toBeDefined();
    expect(snap?.branch).toBe("feature/async");
    expect(snap?.mainBranch).toBeNull();
    expect(snap?.status).toBe(" M README.md");
    expect(snap?.recentCommits).toEqual(["abc1234 first commit"]);
    // The three git commands stay sequential and in order.
    expect(execCalls).toEqual([
      "--no-pager status --porcelain=v1 -b",
      "--no-pager symbolic-ref --short refs/remotes/origin/HEAD",
      "--no-pager log --oneline -5",
    ]);
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
