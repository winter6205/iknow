/**
 * Worker boundary proof for the async git snapshot: the first use of the
 * assembled system prompt carries the COMPLETE `## Git` block (branch + recent
 * commit), and two `system()` calls are byte-identical. The "not blocked at
 * startup" half is proven at the provider level, where the exec seam is
 * injectable: tests/harness/identity/git-snapshot.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { createWorkerDeps } from "../../src/harness/subagent/worker.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { GIT_SEGMENT_TITLE } from "../../src/harness/identity/git-snapshot.ts";
import type { IknowEnv } from "../../src/config/env.ts";

const TEST_ENV = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off" as const,
    thinking: { type: "disabled" as const },
    maxTurns: undefined,
    timeoutMs: undefined,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false, quiet: false },
} as unknown as IknowEnv;

const BRANCH = "worker-snapshot-branch";

let workDir: string;
let repoDir: string;

function gitOnPath(): boolean {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-worker-git-snap-"));
  await mkdir(join(workDir, ".iknow"), { recursive: true });

  repoDir = await mkdtemp(join(tmpdir(), "iknow-worker-git-snap-repo-"));
  if (gitOnPath()) {
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
    git(["commit", "-q", "-m", "worker snapshot commit"]);
    git(["checkout", "-q", "-b", BRANCH]);
  }
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
});

function hermeticOpts(
  extra?: Partial<Parameters<typeof createWorkerDeps>[0]>
): Parameters<typeof createWorkerDeps>[0] {
  return {
    env: TEST_ENV,
    sandboxRoot: workDir,
    cwd: workDir,
    userHome: workDir,
    projectIdentityRoot: workDir,
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    trace: createNoopTraceService(),
    ...extra,
  };
}

describe("worker — async git snapshot", () => {
  it("assembles the ## Git block with the repo branch and the complete recent commits", async () => {
    if (!gitOnPath()) return;
    const deps = await createWorkerDeps(
      hermeticOpts({ projectIdentityRoot: repoDir })
    );
    const system = await deps.system?.();
    expect(system).toBeDefined();
    expect(system).toContain(GIT_SEGMENT_TITLE);
    expect(system).toContain(BRANCH);
    // Complete result on first use — the commit subject is part of the block.
    expect(system).toContain("worker snapshot commit");
  });

  it("keeps the ## Git block byte-stable across two system() calls", async () => {
    if (!gitOnPath()) return;
    const deps = await createWorkerDeps(
      hermeticOpts({ projectIdentityRoot: repoDir })
    );
    const first = await deps.system?.();
    const second = await deps.system?.();
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });
});
