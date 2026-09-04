/**
 * identity assembly — additive "## Git" segment (spec §9 / plan B5).
 *
 * Renders the closure-cached git snapshot from `git-snapshot.ts` into an
 * additive segment. Like `## Project path`, this segment:
 *   - does NOT touch IKNOW_ASSEMBLY_ORDER (6 LOCKED segments stay locked);
 *   - renders the **stable snapshot** captured once at engine build time;
 *   - renders `undefined` (segment absent, byte-stable) when the seam is
 *     missing OR the snapshot is `undefined` (degraded git env);
 *   - produces byte-identical output across adjacent turns (D9 contract).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  assembleIdentityContext,
  createIknowSystemResolver,
  type AssemblyContext,
} from "../../../src/harness/identity/assemble.ts";
import {
  createGitSnapshotProvider,
  gitSnapshotSegment,
  GIT_SEGMENT_DISCLAIMER,
  GIT_SEGMENT_TITLE,
} from "../../../src/harness/identity/git-snapshot.ts";

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------

let workDir: string;
let repoDir: string;
let nonRepoDir: string;

function gitOnPath(): boolean {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-git-seg-home-"));
  await mkdir(join(workDir, ".iknow"), { recursive: true });

  repoDir = await mkdtemp(join(tmpdir(), "iknow-git-seg-repo-"));
  nonRepoDir = await mkdtemp(join(tmpdir(), "iknow-git-seg-nonrepo-"));

  if (gitOnPath()) {
    const git = (args: readonly string[]): void => {
      const r = spawnSync("git", [...args], {
        cwd: repoDir,
        encoding: "utf8",
      });
      if (r.status !== 0) {
        throw new Error(
          `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`
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
  }
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
  if (nonRepoDir) await rm(nonRepoDir, { recursive: true, force: true });
});

function baseCtx(cwd: string): AssemblyContext {
  return {
    cwd,
    projectIdentityRoot: cwd,
    userHome: workDir,
    bootstrapActive: false,
    memoryEnabled: false,
  };
}

// -----------------------------------------------------------------------
// gitSnapshotSegment — pure renderer
// -----------------------------------------------------------------------

describe("gitSnapshotSegment — pure renderer", () => {
  it("renders the four content elements + the D1 disclaimer when given a real snapshot", () => {
    const seg = gitSnapshotSegment({
      branch: "main",
      mainBranch: "origin/main",
      status: " M foo.ts\n?? bar.ts",
      recentCommits: ["abc1234 first commit"],
      degradeReason: null,
    });
    expect(seg).toBeDefined();
    const text = seg as string;
    expect(text).toContain("main");
    expect(text).toContain("origin/main");
    expect(text).toContain(" M foo.ts");
    expect(text).toContain("abc1234 first commit");
    expect(text).toContain(GIT_SEGMENT_DISCLAIMER);
    expect(text.startsWith(GIT_SEGMENT_TITLE)).toBe(true);
  });

  it("returns undefined when snapshot is undefined (caller owns the absent-segment rule)", () => {
    expect(gitSnapshotSegment(undefined)).toBeUndefined();
  });

  it("returns undefined when degradeReason is non-null (degraded env → segment absent)", () => {
    expect(
      gitSnapshotSegment({
        branch: null,
        mainBranch: null,
        status: null,
        recentCommits: [],
        degradeReason: "not_a_git_repo",
      })
    ).toBeUndefined();
  });
});

// -----------------------------------------------------------------------
// assembleIdentityContext — git segment injection
// -----------------------------------------------------------------------

describe("assembleIdentityContext — git segment injection", () => {
  it("does not touch IKNOW_ASSEMBLY_ORDER (LOCKED 6 segments stay locked)", async () => {
    const { IKNOW_ASSEMBLY_ORDER } =
      await import("../../../src/harness/identity/assemble.ts");
    expect([...IKNOW_ASSEMBLY_ORDER]).toEqual([
      "identity",
      "soul",
      "usage",
      "user_profile",
      "bootstrap",
      "memory_layer",
    ]);
  });

  it("git seam missing → segment absent, byte-equivalent to baseline", async () => {
    const baseline = await assembleIdentityContext(baseCtx("/x"));
    const withSeamAbsent = await assembleIdentityContext({
      ...baseCtx("/x"),
      // intentionally no `git` field
    });
    expect(baseline).toBeDefined();
    expect(withSeamAbsent).toBe(baseline);
    expect(baseline).not.toContain(GIT_SEGMENT_TITLE);
  });

  it("git seam returns undefined snapshot → segment absent, byte-equivalent to baseline", async () => {
    const baseline = await assembleIdentityContext(baseCtx("/x"));
    const withDegraded = await assembleIdentityContext({
      ...baseCtx("/x"),
      git: () => undefined,
    });
    expect(withDegraded).toBe(baseline);
  });

  it("git seam returns snapshot → ## Git segment renders four elements + disclaimer", async () => {
    if (!gitOnPath()) return;
    const provider = createGitSnapshotProvider({ cwd: repoDir });
    const out = await assembleIdentityContext({
      ...baseCtx("/x"),
      git: provider,
    });
    expect(out).toContain(GIT_SEGMENT_TITLE);
    expect(out).toContain(GIT_SEGMENT_DISCLAIMER);
    // four elements present: branch, mainBranch (PR baseline), status, recent commits
    expect(out).toContain("main-branch:");
    expect(out).toContain("pr-base:");
    expect(out).toContain("status:");
    expect(out).toContain("recent-commits:");
  });

  it("non-git cwd → seam returns undefined → segment absent (assembly does NOT throw)", async () => {
    const out = await assembleIdentityContext({
      ...baseCtx("/x"),
      git: () => undefined,
    });
    expect(out).toBeDefined();
    expect(out).not.toContain(GIT_SEGMENT_TITLE);
  });

  it("SC2 / D9: adjacent-turn deep-equal — git segment text is byte-stable across turns", async () => {
    if (!gitOnPath()) return;
    const provider = createGitSnapshotProvider({ cwd: repoDir });
    const resolver = createIknowSystemResolver({
      cwd: "/x",
      projectIdentityRoot: "/x",
      userHome: workDir,
      surface: "ask",
      memoryEnabled: false,
      git: provider,
    });
    const turn0 = await resolver();
    const turn1 = await resolver();
    expect(turn0).toBe(turn1);
    // Sanity: segment IS present
    expect(turn0).toContain(GIT_SEGMENT_TITLE);
  });
});

// -----------------------------------------------------------------------
// createIknowSystemResolver — opts.git seam threading
// -----------------------------------------------------------------------

describe("createIknowSystemResolver — opts.git seam", () => {
  it("opts.git absent → ## Git segment absent", async () => {
    const resolver = createIknowSystemResolver({
      cwd: "/x",
      projectIdentityRoot: "/x",
      userHome: workDir,
      surface: "ask",
      memoryEnabled: false,
    });
    const out = await resolver();
    expect(out).toBeDefined();
    expect(out).not.toContain(GIT_SEGMENT_TITLE);
  });

  it("opts.git provider returning snapshot → ## Git segment rendered", async () => {
    if (!gitOnPath()) return;
    const provider = createGitSnapshotProvider({ cwd: repoDir });
    const resolver = createIknowSystemResolver({
      cwd: "/x",
      projectIdentityRoot: "/x",
      userHome: workDir,
      surface: "ask",
      memoryEnabled: false,
      git: provider,
    });
    const out = await resolver();
    expect(out).toContain(GIT_SEGMENT_TITLE);
  });
});
