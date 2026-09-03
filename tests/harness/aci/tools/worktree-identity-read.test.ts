import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { createGlobTool } from "../../../../src/harness/aci/tools/glob.ts";
import { createGrepTool } from "../../../../src/harness/aci/tools/grep.ts";
import { createReadFileTool } from "../../../../src/harness/aci/tools/read-file.ts";
import { createWriteFileTool } from "../../../../src/harness/aci/tools/write-file.ts";
import {
  createLiveTaskRoot,
  writeLiveTaskRoot,
} from "../../../../src/harness/session-roots.ts";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function makeRoots(): Promise<{ repo: string; task: string }> {
  const repo = await mkdtemp(join(tmpdir(), "worktree-identity-"));
  scratch.push(repo);
  const task = join(repo, ".iknow", "worktrees", "fix-648--conv-1");
  await mkdir(task, { recursive: true });
  await writeFile(join(repo, "AGENTS.md"), "identity guidance\n", "utf8");
  return { repo, task };
}

async function makeSplitRoots(): Promise<{
  repo: string;
  identity: string;
  task: string;
}> {
  const repo = await mkdtemp(join(tmpdir(), "worktree-live-root-"));
  const identity = await mkdtemp(join(tmpdir(), "worktree-identity-root-"));
  scratch.push(repo, identity);
  const task = join(repo, ".iknow", "worktrees", "fix-648--conv-1");
  await mkdir(task, { recursive: true });
  await writeFile(join(identity, "AGENTS.md"), "identity guidance\n", "utf8");
  return { repo, identity, task };
}

function missingRg(): { spawn: () => never } {
  const error = new Error("rg missing") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return {
    spawn: () => {
      throw error;
    },
  };
}

describe("rebound task roots can read the stable project identity root", () => {
  it("read_file reaches an identity file while a main root remains excluded", async () => {
    const { repo, task } = await makeRoots();
    const rebound = createReadFileTool(task, { projectIdentityRoot: repo });
    const taskWithoutIdentityPassthrough = createReadFileTool(task);
    const write = createWriteFileTool(task);

    assert.match(
      String(await rebound.handler({ path: join(repo, "AGENTS.md") })),
      /identity guidance/
    );
    await assert.rejects(() =>
      taskWithoutIdentityPassthrough.handler({ path: join(repo, "AGENTS.md") })
    );
    await assert.rejects(() =>
      write.handler({
        path: join(repo, "AGENTS.md"),
        content: "must stay read-only\n",
      })
    );
  });

  it("grep and glob reach the identity root through their read-only extra root", async () => {
    const { repo, task } = await makeRoots();
    const grep = createGrepTool(task, {
      spawn: missingRg().spawn,
      projectIdentityRoot: repo,
      allowProjectIdentityRoot: true,
    });
    const glob = createGlobTool(task, {
      projectIdentityRoot: repo,
      allowProjectIdentityRoot: true,
      spawnRg: async () => {
        const error = new Error("rg missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    });

    const grepResult = String(
      await grep.handler({ pattern: "identity", path: repo })
    );
    const globResult = String(
      await glob.handler({ pattern: "AGENTS.md", path: repo })
    );
    assert.match(grepResult, /AGENTS\.md:1:identity guidance/);
    assert.match(globResult, /AGENTS\.md/);
  });

  it("opens the identity root only after the live task root flips", async () => {
    const { repo, identity, task } = await makeSplitRoots();
    const liveRoot = createLiveTaskRoot(repo);
    const grep = createGrepTool(liveRoot, {
      spawn: missingRg().spawn,
      projectIdentityRoot: identity,
      allowProjectIdentityRoot: true,
    });
    const read = createReadFileTool(liveRoot, {
      projectIdentityRoot: identity,
      allowProjectIdentityRoot: true,
    });

    await assert.rejects(() =>
      grep.handler({ pattern: "identity", path: identity })
    );
    await assert.rejects(() =>
      read.handler({ path: join(identity, "AGENTS.md") })
    );

    writeLiveTaskRoot(liveRoot, task);
    assert.match(
      String(await grep.handler({ pattern: "identity", path: identity })),
      /AGENTS\.md:1:identity guidance/
    );
    assert.match(
      String(await read.handler({ path: join(identity, "AGENTS.md") })),
      /identity guidance/
    );
  });
});

describe("no shape fallback: task-worktree-shaped cwd alone grants no identity-root read", () => {
  // Regression (review High): resolveProjectIdentityRoot used to derive
  // mainCheckoutOf(root) purely from a task-worktree-shaped root when no
  // explicit projectIdentityRoot was threaded. That let OFF assembly (SC4)
  // and worker assembly (spec clause 14) silently widen grep/glob reads.
  it("grep/glob reject a main-checkout path with allowProjectIdentityRoot: false (OFF surface)", async () => {
    const { repo, task } = await makeRoots();
    const grep = createGrepTool(task, {
      spawn: missingRg().spawn,
      allowProjectIdentityRoot: false,
    });
    const glob = createGlobTool(task, {
      allowProjectIdentityRoot: false,
      spawnRg: async () => {
        const error = new Error("rg missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    });

    await assert.rejects(
      () => grep.handler({ pattern: "identity", path: repo }),
      /path outside workspace/
    );
    await assert.rejects(
      () => glob.handler({ pattern: "AGENTS.md", path: repo }),
      /path outside workspace/
    );
  });

  it("grep/glob reject a main-checkout path when allowProjectIdentityRoot is not threaded (worker surface)", async () => {
    const { repo, task } = await makeRoots();
    const grep = createGrepTool(task, { spawn: missingRg().spawn });
    const glob = createGlobTool(task);

    await assert.rejects(
      () => grep.handler({ pattern: "identity", path: repo }),
      /path outside workspace/
    );
    await assert.rejects(
      () => glob.handler({ pattern: "AGENTS.md", path: repo }),
      /path outside workspace/
    );
  });
});
