/**
 * T5 (plans/worktree-isolation-model-provision.md) — subagents inherit the
 * rebound session root: the spawn factory must be able to start the worker
 * child INSIDE the parent session's rebound root (the task worktree).
 *
 * Contract pinned here (real child processes, no LLM):
 *   1. createDefaultSubAgentSpawn({ traceDir, workspaceRoot, sessionRoot }) →
 *      the child's process.cwd() IS the session root and
 *      IKNOW_WORKSPACE_ROOT is the workspace root — the worker starts in the
 *      same tree the parent session was rebound to (writes and
 *      workspace-relative bash therefore land in the worktree);
 *   2. no sessionRoot argument (or explicit undefined) → the child inherits
 *      the parent process cwd byte-identically to today (unbound sessions,
 *      hard req "OFF 与今日一致" / acceptance 4).
 *
 * T3 (plans/worktree-session-roots.md) adds the split: `projectIdentityRoot`
 * rides along as IKNOW_PRODUCT_ROOT (env var name unchanged — it is the
 * existing parent→child wire) so the worker's 说明书 / skill discovery reads
 * the project identity root while its cwd stays on the tree.
 */
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDefaultSubAgentSpawn } from "../../src/harness/subagent/spawn.ts";

type SpawnFactory = ReturnType<typeof createDefaultSubAgentSpawn>;

const PROBE_SCRIPT =
  "process.stdout.write(JSON.stringify({ cwd: process.cwd(), " +
  "workspaceRoot: process.env.IKNOW_WORKSPACE_ROOT, " +
  "productRootEnv: process.env.IKNOW_PRODUCT_ROOT }))";

/**
 * Spawn a real child whose entry script reports its cwd + workspace env
 * (same trick as spawn-argv.test.ts: point process.argv[1] at a .js probe
 * so resolveSubagentWorkerSpawnArgs keeps the entry unchanged).
 */
async function probeChildCwd(spawnFactory: SpawnFactory): Promise<{
  cwd: string;
  workspaceRoot: string | undefined;
  productRootEnv: string | undefined;
}> {
  const probe = await mkdtemp(join(process.cwd(), "tmp-spawn-cwd-probe-"));
  const script = join(probe, "print-root.js");
  try {
    await writeFile(script, PROBE_SCRIPT);
    const originalArgv1 = process.argv[1];
    process.argv[1] = script;
    let child: ChildProcess;
    try {
      child = spawnFactory({}, "task-id", {} as never);
    } finally {
      process.argv[1] = originalArgv1;
    }
    const output = await new Promise<string>((resolvePromise, reject) => {
      let value = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        value += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("close", () => resolvePromise(value));
    });
    return JSON.parse(output) as {
      cwd: string;
      workspaceRoot: string | undefined;
      productRootEnv: string | undefined;
    };
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

describe("createDefaultSubAgentSpawn — child cwd (T5 root inheritance)", () => {
  it("rebound session root: the worker child starts inside the session root", async () => {
    const wt = await mkdtemp(join(process.cwd(), "tmp-spawn-cwt-"));
    try {
      const { cwd, workspaceRoot } = await probeChildCwd(
        createDefaultSubAgentSpawn({
          traceDir: join(wt, "trace"),
          workspaceRoot: wt,
          sessionRoot: wt,
        })
      );
      // the child cwd IS the rebound root — not the parent process cwd
      expect(cwd).toBe(wt);
      expect(cwd).not.toBe(process.cwd());
      // and the workspace-root env SSOT still rides along
      expect(workspaceRoot).toBe(wt);
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("T3: projectIdentityRoot rides along as IKNOW_PRODUCT_ROOT, distinct from the cwd", async () => {
    const wt = await mkdtemp(join(process.cwd(), "tmp-spawn-prod-tree-"));
    const main = await mkdtemp(join(process.cwd(), "tmp-spawn-prod-main-"));
    try {
      const { cwd, productRootEnv } = await probeChildCwd(
        createDefaultSubAgentSpawn({
          traceDir: join(wt, "trace"),
          workspaceRoot: wt,
          projectIdentityRoot: main,
          sessionRoot: wt,
        })
      );
      // 写跟树，身份跟身份根 —— 两者是不同的值。
      expect(cwd).toBe(wt);
      expect(productRootEnv).toBe(main);
    } finally {
      await rm(wt, { recursive: true, force: true });
      await rm(main, { recursive: true, force: true });
    }
  });

  it("no sessionRoot argument: child inherits the parent cwd (today's behavior)", async () => {
    const { cwd, workspaceRoot } = await probeChildCwd(
      createDefaultSubAgentSpawn()
    );
    expect(cwd).toBe(process.cwd());
    expect(workspaceRoot).toBeUndefined();
  });

  it("explicit undefined sessionRoot: byte-stable baseline (no cwd option)", async () => {
    const { cwd } = await probeChildCwd(
      createDefaultSubAgentSpawn({
        traceDir: undefined,
        workspaceRoot: undefined,
        sessionRoot: undefined,
      })
    );
    expect(cwd).toBe(process.cwd());
  });
});
