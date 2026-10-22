/**
 * A setsid-detached grandchild inside the bash fence dies with the fence
 * (ADR-0142).
 *
 * Before this ADR the fence unshared user and network namespaces only, so a
 * fenced command could escape teardown for good:
 *
 *   setsid sh -c 'exec sleep 300' &
 *
 * `setsid` puts the grandchild in a brand-new process group, so the runner's
 * SIGTERM/SIGKILL to the fence's process group never reaches it, and
 * `--die-with-parent` only covers bwrap's *direct* child. The stray kept
 * running on the host after the tool call had already returned, holding its
 * ports and CPU.
 *
 * `--unshare-pid` fixes this at the namespace level: a pid namespace's init
 * (pid 1) is bwrap itself, and the kernel kills every remaining process in
 * the namespace when that init exits — including processes that called
 * `setsid` and left the group. The stray cannot outlive the namespace, so it
 * cannot outlive the fence, whichever way teardown is triggered.
 *
 * What is pinned here, against real processes and the real bwrap fence:
 *
 *   - foreground: a fenced command that launches a setsid grandchild, then
 *     hits its runtime deadline → the stray is gone from the host shortly
 *     after the call returns;
 *   - background: the same command spawned with `background: true`, then
 *     terminated with the real manager's stop (the bash_stop route) → the
 *     stray is gone from the host too.
 *
 * ## Why the stray is located by argv marker, not by a pid file
 *
 * Under `--unshare-pid` the pid a fenced command writes to a file
 * (`echo $$ > f`) is a NAMESPACE pid: on this host it is 4, and the host
 * `kill -0 4` answers ESRCH — for the wrong reason. A test that probed such a
 * pid would pass on a broken fence, i.e. it would be green before the fix.
 * So the fenced command instead renames its grandchild to a unique,
 * host-unique argv marker (`exec -a <marker> sleep 300`), and the assertion
 * resolves the HOST pid with `pgrep -f '^<marker>'`. The marker is derived
 * from this process's pid and a counter, so it cannot collide with anything
 * else on the host, and the pre-condition probe (`the stray is alive and
 * findable`) is asserted before the interrupt: if the marker could not be
 * resolved at all, the test fails loudly instead of passing vacuously.
 *
 * bwrap dependency: same nature as bash-background.test.ts —
 * `skipIf(!hasBwrap())` guards the real-process cases.
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
import {
  uniqueProcessMarker,
  waitForMarkerGone,
  waitForMarkerProcess,
} from "./tools/spawn-test-utils.ts";

const scratchPaths: string[] = [];
/** Host pids of strays observed during a run, killed in teardown whatever the verdict. */
const strayPids: number[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  // Cleanup is unconditional: a RED run leaves live strays behind, and this
  // suite must not leak sleeps onto the host.
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone — the assertion under test passed */
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
 * The fenced command: rename the grandchild to `marker` so the host can find
 * it, then keep the fence alive so teardown has something to interrupt.
 *
 * `setsid` is the point of the case — it detaches the grandchild into its own
 * process group, which is exactly what a process-group signal misses.
 *
 * `bash`, not `sh`: the fence's guest shell is dash on this host and dash's
 * `exec` has no `-a`, so an `sh` spelling fails with `exec: -a: Invalid
 * argument` and the stray never starts — the case would then observe "nothing
 * was ever launched" and pass for the wrong reason.
 */
function strayLaunchCommand(marker: string): string {
  return `setsid bash -c 'exec -a ${marker} sleep 300' & sleep 300`;
}

interface BashPayload {
  readonly code: number;
  readonly deadline_expired?: boolean;
}

/** The bash handler returns the ACI envelope; the JSON payload is its `output` string. */
function parseBashPayload(value: unknown): BashPayload {
  return JSON.parse((value as { output: string }).output) as BashPayload;
}

/** The stray must be alive and host-findable BEFORE teardown, or the test proves nothing. */
async function assertStrayReachable(
  marker: string,
  what: string
): Promise<number> {
  let pids: number[] = [];
  try {
    pids = await waitForMarkerProcess(marker);
  } catch (err) {
    assert.fail(
      `${what}: no host process carries the stray marker ${marker} — ` +
        `the case cannot observe what it means to observe (${String(err)})`
    );
  }
  strayPids.push(...pids);
  return pids[0]!;
}

describe("setsid-detached descendants die with the fence (ADR-0142)", () => {
  it.skipIf(!hasBwrap())(
    "foreground: the runtime deadline takes the fence, and the setsid grandchild with it",
    async () => {
      const cwd = await makeScratch("bash-setsid-fg-");
      const tool = createBashTool(cwd);
      const marker = uniqueProcessMarker("setid-stray");

      // Not awaited yet: the pre-condition probe has to observe the stray
      // WHILE the fence is still up. A foreground call blocks until its
      // deadline tears the fence down, so by the time it returns the correct
      // outcome (the stray is gone) is already true and a probe run after the
      // fact would find nothing even on a healthy fence.
      const call = tool.handler({
        command: strayLaunchCommand(marker),
        timeout_ms: 1_500,
      });

      // The stray existed while the fence was up — otherwise a green verdict
      // would only mean "nothing ever started".
      await assertStrayReachable(marker, "foreground");

      const payload = parseBashPayload(await call);

      // The fence really was torn down by its deadline, not by finishing.
      assert.equal(payload.deadline_expired, true);

      assert.ok(
        await waitForMarkerGone(marker, 2_500),
        `foreground: the setsid grandchild ${marker} survived the fence's ` +
          `teardown; it is still running on the host`
      );
    },
    30_000
  );

  it.skipIf(!hasBwrap())(
    "background: bash_stop takes the fence, and the setsid grandchild with it",
    async () => {
      const root = await makeScratch("bash-setsid-bg-");
      const manager = createBackgroundTaskManager({
        tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
        spawn: defaultBackgroundSpawn,
      });
      const tool = createBashTool(root, {
        backgroundManager: manager,
        workspaceRoot: root,
      });
      const marker = uniqueProcessMarker("setid-stray");

      const res = (await tool.handler({
        command: strayLaunchCommand(marker),
        background: true,
      })) as { task_id: string };

      await assertStrayReachable(marker, "background");

      await manager.stop(res.task_id);

      assert.ok(
        await waitForMarkerGone(marker, 2_500),
        `background: the setsid grandchild ${marker} survived bash_stop; ` +
          `it is still running on the host`
      );
    },
    30_000
  );
});
