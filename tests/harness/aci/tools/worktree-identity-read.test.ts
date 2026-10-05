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
  it("read_file reaches an identity file; writes stay excluded", async () => {
    const { repo, task } = await makeRoots();
    const rebound = createReadFileTool(task, { projectIdentityRoot: repo });
    const taskWithoutIdentityPassthrough = createReadFileTool(task);
    const write = createWriteFileTool(task);

    assert.match(
      String(await rebound.handler({ path: join(repo, "AGENTS.md") })),
      /identity guidance/
    );
    // ADR-0128 T4: the absolute identity path is an ordinary host path, so it
    // is readable through the canonical policy even without the identity-root
    // extra (the passthrough seam now governs the *relative* fallback arm and
    // the containment-arm vintage, not whether host reads reach at all).
    assert.match(
      String(
        await taskWithoutIdentityPassthrough.handler({
          path: join(repo, "AGENTS.md"),
        })
      ),
      /identity guidance/
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

    // grep defaults to output=paths (relative paths only); line content needs
    // an explicit output=content. This case pins "identity root is reachable",
    // not the default output mode.
    const grepResult = String(
      await grep.handler({
        pattern: "identity",
        path: repo,
        output: "content",
      })
    );
    const globResult = String(
      await glob.handler({ pattern: "AGENTS.md", path: repo })
    );
    assert.match(grepResult, /AGENTS\.md:1:identity guidance/);
    assert.match(globResult, /AGENTS\.md/);
  });

  it("identity-root extras arm opens only after the live task root flips", async () => {
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

    // Relative identity names fall back to the identity root only once the
    // live root is a task worktree: pre-flip the extras arm is closed, so
    // the name resolves against `repo` (where it does not exist).
    await assert.rejects(() => read.handler({ path: "AGENTS.md" }));
    const preGrep = String(
      await grep.handler({ pattern: "identity", path: "AGENTS.md" })
    );
    // The binary is stubbed out above, so this grep answers from the Node
    // scan and may carry the degraded-engine notice. The claim under test is
    // that the relative name resolved to nothing, not that output was empty.
    assert.doesNotMatch(preGrep, /AGENTS\.md/);

    writeLiveTaskRoot(liveRoot, task);
    assert.match(
      String(
        await grep.handler({
          pattern: "identity",
          path: "AGENTS.md",
          output: "content",
        })
      ),
      /AGENTS\.md:1:identity guidance/
    );
    assert.match(
      String(await read.handler({ path: "AGENTS.md" })),
      /identity guidance/
    );
    // The absolute identity path, by contrast, reads at BOTH points:
    // ADR-0128 T4 reach is granted by the canonical policy for ordinary host
    // paths, independent of the extras-arm gate (which only adds the relative
    // fallback convenience).
    assert.match(
      String(await read.handler({ path: join(identity, "AGENTS.md") })),
      /identity guidance/
    );
  });
});

describe("no shape fallback: task-worktree-shaped cwd alone grants no identity-root extras arm", () => {
  // Regression (review High): resolveProjectIdentityRoot used to derive
  // mainCheckoutOf(root) purely from a task-worktree-shaped root when no
  // explicit projectIdentityRoot was threaded. That let OFF assembly (SC4)
  // and worker assembly (spec clause 14) silently widen the identity-root
  // extras arm (relative-name fallback). What it never controlled is
  // ADR-0128 host reach: after T4 the absolute main-checkout path reads
  // through the canonical policy regardless of the gate — the pin below
  // therefore distinguishes the two: absolute reach = yes (policy), relative
  // fallback into the main checkout = no (gate closed, no shape derivation).
  it("grep/glob reach an absolute main-checkout path by policy, without granting the relative fallback (allowProjectIdentityRoot: false, OFF surface)", async () => {
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

    const grepOut = String(
      await grep.handler({ pattern: "identity", path: repo, output: "content" })
    );
    assert.match(grepOut, /AGENTS\.md:1:identity guidance/);
    const globOut = String(
      await glob.handler({ pattern: "AGENTS.md", path: repo })
    );
    assert.match(globOut, /AGENTS\.md/);

    assert.doesNotMatch(
      String(await grep.handler({ pattern: "identity", path: "AGENTS.md" })),
      /AGENTS\.md/,
      "relative name must not fall back into the main checkout without an explicit identity-root thread"
    );
  });

  it("grep/glob reach an absolute main-checkout path by policy when allowProjectIdentityRoot is not threaded (worker surface)", async () => {
    const { repo, task } = await makeRoots();
    const grep = createGrepTool(task, { spawn: missingRg().spawn });
    const glob = createGlobTool(task);

    const grepOut = String(
      await grep.handler({ pattern: "identity", path: repo, output: "content" })
    );
    assert.match(grepOut, /AGENTS\.md:1:identity guidance/);
    const globOut = String(
      await glob.handler({ pattern: "AGENTS.md", path: repo })
    );
    assert.match(globOut, /AGENTS\.md/);
  });
});
