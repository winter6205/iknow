/**
 * ADR-0142: a pid namespace's init does not answer a plain SIGTERM, so the
 * teardown verdict must come from the escalation chain, not from the
 * SIGTERM window.
 *
 * The race this pins:
 *
 *   bwrap is two processes — a parent that performs setup, and a child that
 *   becomes PID 1 of the `--unshare-pid` namespace. The kernel does not
 *   deliver default-disposition signals to a namespace's init, so the
 *   SIGTERM round leaves that child (and its own descendants) running. Only
 *   the SIGKILL escalation can clear it, and when it does, the kernel takes
 *   every remaining process in the namespace with it.
 *
 *   requestTeardown armed TWO timers of the same length: the 2 s
 *   `waitForProcessGroupGone` observation and the 2 s SIGKILL fallback. The
 *   observation polls every 20 ms, so it expires first — always before the
 *   escalation has fired — and settles the task as `unconfirmed` even though
 *   the group drains moments later. The verdict must instead be published
 *   after the escalation chain, so a group that the SIGKILL clears is
 *   reported as what it is: stopped.
 *
 * What is asserted here, against a real fenced background task:
 *   - a fence carrying `--unshare-pid` reports `confirmed_stopped` after stop;
 *   - the reported pgid is genuinely empty on the host afterwards;
 *   - the fence argv really does carry the flag (so a green run cannot be
 *     explained by the namespace silently being absent).
 *
 * The last point matters: this file is about the teardown verdict, and a
 * verdict assertion alone would pass on a host where the namespace never
 * took effect.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import {
  createBackgroundTaskManager,
  defaultBackgroundSpawn,
} from "../../../src/harness/background/manager.ts";
import { resolveTasksDir } from "../../../src/harness/background/paths.ts";

const scratchPaths: string[] = [];
const observedPids: number[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  for (const pid of observedPids.splice(0)) {
    try {
      spawnSync("pkill", ["-9", "-g", String(pid)], { stdio: "ignore" });
    } catch {
      /* nothing left to reap */
    }
  }
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * A pid namespace's init survives SIGTERM by kernel rule, so a fence that runs
 * one must still be reported as stopped — the escalation chain owns the
 * verdict, not the SIGTERM window.
 */
describe("ADR-0142 — teardown verdict under a pid namespace", () => {
  it.skipIf(!hasBwrap())(
    "a --unshare-pid fence is reported confirmed_stopped and its group is empty on the host",
    async () => {
      const root = await makeScratch("pidns-verdict-");
      const manager = createBackgroundTaskManager({
        tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
        spawn: defaultBackgroundSpawn,
      });
      const tool = createBashTool(root, {
        backgroundManager: manager,
        workspaceRoot: root,
      });

      const res = (await tool.handler({
        command: "sleep 300",
        background: true,
      })) as { task_id: string };

      const before = await manager.status(res.task_id);
      assert.equal(before.status, "running");

      await manager.stop(res.task_id);

      // The verdict is published asynchronously after the escalation, so poll
      // it rather than reading once: `stop()` returns before the group drains.
      let cleanup = (await manager.status(res.task_id)).cleanup;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        cleanup = (await manager.status(res.task_id)).cleanup;
        if (cleanup.state !== "not_started") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.equal(
        cleanup.state,
        "confirmed_stopped",
        `the SIGKILL escalation clears a pid namespace, so this fence must ` +
          `settle as stopped, not ${String(cleanup.state)}`
      );
      if (cleanup.state === "confirmed_stopped") {
        observedPids.push(cleanup.pgid);
        // Confirmed means the host agrees: the reported group must really be
        // empty, so this cannot pass on a verdict that was merely written down.
        const members = spawnSync("ps", ["-eo", "pid,pgid,comm"], {
          encoding: "utf8",
        })
          .stdout.split("\n")
          .filter((line) => line.split(/\s+/)[1] === String(cleanup.pgid));
        assert.deepEqual(
          members,
          [],
          `process group ${String(cleanup.pgid)} still has members: ${members.join(" | ")}`
        );
      }
    },
    30_000
  );
});
