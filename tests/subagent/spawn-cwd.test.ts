/**
 * T5 (plans/worktree-isolation-model-provision.md) — subagents inherit the
 * rebound session root: the spawn factory must be able to start the worker
 * child INSIDE the parent session's rebound root (the task worktree).
 *
 * Contract pinned here (real child processes, no LLM):
 *   1. createDefaultSubAgentSpawn(traceDir, workspaceRoot, sessionRoot) →
 *      the child's process.cwd() IS the session root and
 *      IKNOW_WORKSPACE_ROOT is the workspace root — the worker starts in the
 *      same tree the parent session was rebound to (its 说明书 discovery,
 *      skill scan and trace fallback therefore read the worktree, not the
 *      main checkout);
 *   2. no sessionRoot argument (or explicit undefined) → the child inherits
 *      the parent process cwd byte-identically to today (unbound sessions,
 *      hard req "OFF 与今日一致" / acceptance 4).
 */
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDefaultSubAgentSpawn } from "../../src/harness/subagent/spawn.ts";

type SpawnFactory = ReturnType<typeof createDefaultSubAgentSpawn>;

const PROBE_SCRIPT =
  "process.stdout.write(JSON.stringify({ cwd: process.cwd(), " +
  "workspaceRoot: process.env.IKNOW_WORKSPACE_ROOT }))";

/**
 * Spawn a real child whose entry script reports its cwd + workspace env
 * (same trick as spawn-argv.test.ts: point process.argv[1] at a .js probe
 * so resolveSubagentWorkerSpawnArgs keeps the entry unchanged).
 */
async function probeChildCwd(
  spawnFactory: SpawnFactory
): Promise<{ cwd: string; workspaceRoot: string | undefined }> {
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
        createDefaultSubAgentSpawn(join(wt, "trace"), wt, wt)
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

  it("no sessionRoot argument: child inherits the parent cwd (today's behavior)", async () => {
    const { cwd, workspaceRoot } = await probeChildCwd(
      createDefaultSubAgentSpawn(undefined)
    );
    expect(cwd).toBe(process.cwd());
    expect(workspaceRoot).toBeUndefined();
  });

  it("explicit undefined sessionRoot: byte-stable baseline (no cwd option)", async () => {
    const { cwd } = await probeChildCwd(
      createDefaultSubAgentSpawn(undefined, undefined, undefined)
    );
    expect(cwd).toBe(process.cwd());
  });
});
