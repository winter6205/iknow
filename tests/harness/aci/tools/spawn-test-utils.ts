/**
 * Shared helpers for process-oriented tool tests (reused by the bash /
 * helpers process-tree kill assertions).
 *
 * waitForPidFile: the child writes its own pid to a file after startup and
 * the test polls it (fixture convention: sh -c 'echo $$ > <file>; ...').
 * waitForProcessExit: polls process.kill(pid, 0); ESRCH confirms the
 * process is dead.
 * Both cap at 2s so a test can never hang.
 *
 * ## Why argv-marker helpers also exist (ADR-0142)
 *
 * `waitForPidFile` yields a HOST pid, and that is only meaningful when the
 * observed process shares the host's pid namespace. A process inside the
 * bwrap fence does not: since ADR-0142 the fence unshares the pid namespace,
 * so a pid written from inside (`echo $$`, `process.pid`) is a namespace pid.
 * On this host a fenced `$$` is 4, and the host answers `kill -0 4` with
 * ESRCH — for the wrong reason. Asserting on such a pid would go green
 * against a broken fence.
 *
 * So for fenced fixtures, locate the process from the HOST side by a unique
 * argv marker instead. `uniqueProcessMarker` mints one, the fixture puts it at
 * argv[0] (`exec -a <marker> …` / `node <marker>.cjs`), and the helpers below
 * resolve real host pids for it.
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

let markerSeq = 0;

/**
 * A marker unique across this host for the lifetime of the test process.
 *
 * Derived from `process.pid` plus a counter, so two concurrent vitest workers
 * (and two cases in one file) can never mint the same one.
 */
export function uniqueProcessMarker(tag: string): string {
  markerSeq += 1;
  return `iknow-test-marker-${tag}-${process.pid}-${markerSeq}`;
}

/**
 * Host pids of processes whose full command line starts with `marker`.
 *
 * `pgrep -f` matches the whole cmdline; the `^` anchor keeps it from matching a
 * process that merely mentions the marker as a later argument — notably the
 * bwrap line itself, whose argv contains the entire fenced command.
 */
export function hostPidsForMarker(marker: string): number[] {
  const found = spawnSync("pgrep", ["-f", `^${marker}`], { encoding: "utf8" });
  if (found.status !== 0) return [];
  return found.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Wait until at least one host process carries `marker`, then return its pids.
 *
 * Throws on timeout rather than returning an empty list, so a case whose
 * fixture never launched fails loudly instead of asserting "nothing is left".
 */
export async function waitForMarkerProcess(
  marker: string,
  timeoutMs = 5_000
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = hostPidsForMarker(marker);
    if (pids.length > 0) return pids;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for a host process carrying ${marker}`);
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 25));
  }
}

/** Bounded wait until no host process carries `marker` any more. */
export async function waitForMarkerGone(
  marker: string,
  timeoutMs = 5_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (hostPidsForMarker(marker).length === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 25));
  }
}

export async function waitForPidFile(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  throw new Error(`timed out waiting for pid file: ${path}`);
}

export async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  throw new Error(`process ${pid} remained alive`);
}
